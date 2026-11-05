import { spawn } from "node:child_process";
import { setTimeout as pause } from "node:timers/promises";

// Persist only numeric readiness diagnostics and bounded render-error messages.
// Raw HTTP events contain service credentials and must never be retained.
export async function captureQueueTrace(environment) {
  if (!["development", "production"].includes(environment)) throw new Error("Invalid trace environment");
  let failure;
  const records = [];
  const failures = [];
  const children = ["api", "video-renderer"].map((service) => {
    const child = spawn("bun", ["--filter", `@forever-tee/${service}`, "exec", "wrangler", "tail", "--env", environment, "--format", "json"], {
      detached: true, stdio: ["ignore", "pipe", "pipe"],
    });
    let pending = "";
    child.on("error", () => { failure = "Could not start pipeline trace"; });
    child.stderr.resume();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      pending += chunk;
      if (pending.length > 1_000_000) { pending = ""; failure = "Trace exceeded buffer limit"; return; }
      for (;;) {
        const begin = pending.indexOf("{\n");
        const end = pending.indexOf("\n}", begin);
        if (begin < 0 || end < 0) break;
        const block = pending.slice(begin, end + 2);
        pending = pending.slice(end + 2);
        let event;
        try { event = JSON.parse(block); } catch { failure = "Invalid pipeline trace"; continue; }
        for (const log of event.logs ?? []) {
          const kind = log.message?.[0];
          if (kind !== "Story video ready" && kind !== "Story video render failed") continue;
          let value = log.message[1];
          if (typeof value === "string") { try { value = JSON.parse(value); } catch { continue; } }
          if (!value) continue;
          if (service === "video-renderer" && kind === "Story video render failed" &&
            typeof value.batchId === "string" && typeof value.error === "string") {
            failures.push({ batchId: value.batchId, key: value.key,
              error: value.error.slice(0, 500).replace(/Bearer\s+\S+/gi, "Bearer <REDACTED>") });
            if (failures.length > 64) failures.shift();
            continue;
          }
          if (service !== "api" || event.event?.queue !== `forever-tee-story-video-${environment}` ||
            kind !== "Story video ready" || typeof value.productId !== "string" || typeof value.colour !== "string") continue;
          const timings = Object.fromEntries(Object.entries(value.timings ?? {}).filter(([key, number]) =>
            /^[a-zA-Z][a-zA-Z0-9]{0,47}$/.test(key) && typeof number === "number" && Number.isFinite(number) && number >= 0,
          ).slice(0, 40));
          records.push({ productId: value.productId, color: value.colour.toLowerCase(), consumerStartedAt: event.eventTimestamp, timings });
          if (records.length > 256) records.shift();
        }
      }
    });
    return child;
  });
  await pause(5_000);
  return {
    async results(productIds) {
      for (let attempt = 0; attempt < 75; attempt += 1) {
        const matching = records.filter((record) => productIds.includes(record.productId));
        if (matching.length === 4 && matching.every((record) => record.timings.renderMs > 0)) return matching;
        if (failure || children.some((child) => child.exitCode !== null)) break;
        await pause(200);
      }
      throw new Error(failure ?? "Missing stage diagnostics for four benchmark videos");
    },
    failures(batchId) { return failures.filter((record) => record.batchId === batchId); },
    stop() {
      for (const child of children) {
        if (!child.pid) continue;
        try { process.kill(-child.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
      }
    },
  };
}
