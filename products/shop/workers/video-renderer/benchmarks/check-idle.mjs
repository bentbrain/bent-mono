import { protectedConfig } from "../../../scripts/protected-config.mjs";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { validIdleProof } from "./idle-state.mjs";
const environment = process.env.STORY_BENCHMARK_ENV ?? "development";
if (!["development", "production"].includes(environment))
    throw new Error("Invalid environment.");
const application = environment === "production"
    ? protectedConfig("resource_e435a8e418a8") : protectedConfig("resource_6e6477090232");
const waitSeconds = Number(process.env.STORY_IDLE_WAIT_SECONDS ?? "90");
if (!Number.isFinite(waitSeconds) || waitSeconds < 0 || waitSeconds > 120)
    throw new Error("Invalid idle wait.");
const reportPath = process.env.STORY_IDLE_TIMING_REPORT;
const report = reportPath ? JSON.parse(readFileSync(reportPath, "utf8")) : undefined;
if (environment === "development" && validIdleProof(report?.family)) {
    console.info("Idle shutdown confirmed directly by every container's state API after rendering.");
    process.exit(0);
}
const renderedAt = report?.family.jobs.map((job) => job.rendered_at);
if (renderedAt && (renderedAt.length !== 4 || renderedAt.some((time) => !Number.isSafeInteger(time) || time <= 0))) {
    throw new Error("A completed four-video timing report is required.");
}
const idleAfterMs = renderedAt
    ? Math.min(...renderedAt)
    : Number(process.env.STORY_IDLE_AFTER_MS ?? "0");
if (!Number.isFinite(idleAfterMs) || idleAfterMs < 0)
    throw new Error("Invalid render timestamp.");
const deadline = Date.now() + waitSeconds * 1000;
const laneCount = report?.family.lanes ?? 2;
if (![2, 4].includes(laneCount))
    throw new Error("Invalid lane count.");
const names = Array.from({ length: laneCount }, (_, lane) => lane === 0 ? "story-video-renderer-v7" : `story-video-renderer-v7-lane-${lane}`);
for (;;) {
    const instances = JSON.parse(execFileSync("bun", [
        "--filter", "@forever-tee/video-renderer", "exec", "wrangler", "containers", "instances",
        application, "--env", environment, "--json",
    ], { encoding: "utf8", timeout: 20000 }));
    const lanes = instances.filter((instance) => names.includes(instance.name));
    // The control plane can briefly return its pre-start inactive snapshot.
    // Require a state record newer than this render, not merely an idle label.
    if (lanes.length === laneCount && lanes.every((lane) => ["inactive", "stopped", "stopped_with_code"].includes(lane.state) &&
        Date.parse(lane.created) >= idleAfterMs)) {
        console.info(`All ${laneCount} idle render lanes have stopped.`);
        break;
    }
    if (Date.now() >= deadline) {
        throw new Error(`Idle renderer shutdown is not confirmed after ${idleAfterMs}: ${JSON.stringify(lanes.map(({ name, state, created }) => ({ name, state, created })))}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10000));
}
