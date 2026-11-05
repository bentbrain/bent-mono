import { protectedConfig } from "../../../scripts/protected-config.mjs";
// Development-only no-op messages isolate queue dispatch from video rendering.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { setTimeout as pause } from "node:timers/promises";
const account = protectedConfig("cloudflareAccountId");
const queueId = protectedConfig("resource_66448984d52e");
const queueName = "forever-tee-story-video-development";
const token = process.env.CLOUDFLARE_API_TOKEN ?? JSON.parse(execFileSync("bun", [
    "--filter", "@forever-tee/api", "exec", "wrangler", "auth", "token", "--json",
], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })).token;
const delay = Number(process.env.STORY_QUEUE_PROBE_DELAY ?? 2);
const samples = Number(process.env.STORY_QUEUE_PROBE_SAMPLES ?? 3);
const idleSeconds = Number(process.env.STORY_QUEUE_PROBE_IDLE_SECONDS ?? 0);
assert.ok(Number.isInteger(delay) && delay >= 0 && delay <= 2);
assert.ok(Number.isInteger(samples) && samples >= 1 && samples <= 6);
assert.ok(Number.isInteger(idleSeconds) && idleSeconds >= 0 && idleSeconds <= 60);
async function request(path, body) {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/queues/${queueId}${path}`, {
        method: body ? "POST" : "GET",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15000),
    });
    assert.ok(response.ok, `Cloudflare request failed: ${response.status}`);
    const value = await response.json();
    assert.ok(value.success, "Cloudflare rejected the queue request");
    return value.result;
}
const queue = await request("");
console.info(JSON.stringify({ queue: queue.queue_name, settings: queue.settings, consumers: queue.consumers }));
assert.equal(queue.queue_name, queueName);
async function waitForEmpty() {
    // Queue metrics are approximate and may briefly retain an acknowledged item.
    for (let attempt = 0; attempt < 10; attempt += 1) {
        if ((await request("/metrics")).backlog_count === 0)
            return;
        await pause(1000);
    }
    throw new Error("Refusing to probe a busy queue");
}
await waitForEmpty();
const tail = spawn("bun", ["--filter", "@forever-tee/api", "exec", "wrangler", "tail", "--env", "development", "--format", "json"], {
    detached: true, stdio: ["ignore", "pipe", "pipe"],
});
let pending = "";
const events = [];
tail.stdout.on("data", (chunk) => {
    pending += chunk.toString();
    // Wrangler prints one pretty-printed JSON invocation per unindented block.
    for (;;) {
        const begin = pending.indexOf("{\n");
        const end = pending.indexOf("\n}", begin);
        if (begin < 0 || end < 0)
            break;
        const block = pending.slice(begin, end + 2);
        pending = pending.slice(end + 2);
        const event = JSON.parse(block);
        if (event.event?.queue === queueName) {
            events.push({ timestamp: event.eventTimestamp, outcome: event.outcome });
        }
    }
});
// Do not echo tail output: unrelated requests can contain private headers.
tail.stderr.resume();
const results = [];
try {
    await pause(5000);
    assert.equal(tail.exitCode, null, "Queue trace failed to start");
    if (idleSeconds) {
        console.info(`Waiting ${idleSeconds}s before the first probe to check idle dispatch.`);
        await pause(idleSeconds * 1000);
    }
    for (let sample = 0; sample < samples; sample += 1) {
        await waitForEmpty();
        const start = Date.now();
        // Text is deliberately not a valid render-job object. The production
        // consumer's existing validation acknowledges it without D1/R2/rendering.
        await request("/messages", { body: `dispatch-probe:${crypto.randomUUID()}`, content_type: "text", delay_seconds: delay });
        const deadline = Date.now() + 40000;
        while (!events.some((event) => event.timestamp >= start) && Date.now() < deadline)
            await pause(100);
        const matches = events.filter((event) => event.timestamp >= start);
        assert.equal(matches.length, 1, "Expected one queue invocation; missing trace or competing traffic");
        assert.equal(matches[0].outcome, "ok");
        const result = { delaySeconds: delay, sample: sample + 1, dispatchMs: matches[0].timestamp - start };
        results.push(result);
        console.info(JSON.stringify(result));
        await pause(1000);
    }
}
finally {
    if (tail.pid)
        process.kill(-tail.pid, "SIGTERM");
}
assert.ok(results.every((result) => result.dispatchMs < 5000), "Queue dispatch exceeded the five-second diagnostic threshold");
