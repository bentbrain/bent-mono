import { isDeepStrictEqual } from "node:util";
import { developmentOperation } from "./native-ci-operation.mjs";
import { inspectDevelopmentWorker } from "./native-ci-worker.mjs";
import { recordReleaseEvent } from "./native-release-pause.mjs";

const check = (value, reason) => { if (!value) throw Error(`Development schedule repair stopped: ${reason}`); };
const exactSchedule = value => {
  check(value?.schedules?.length === 1 && value.schedules[0].cron === "* * * * *", "expected the existing single one-minute schedule.");
  return value.schedules;
};

export async function repairDevelopmentSchedule({ cf, store, env, inspectWorker = inspectDevelopmentWorker }) {
  check(developmentOperation(env) === "repair-schedule", "explicit repair operation required.");
  const releaseId = env.NATIVE_VERIFY_RELEASE;
  const rows = async (sql, params = []) => (await cf.query(sql, params))[0].results;
  const prior = await rows("SELECT payload FROM native_video_release_events WHERE release_id = ? AND stage = ?",
    [releaseId, "schedule-repair-started"]);
  check(prior.length === 0, "registration already attempted for this release; inspect its saved evidence, do not replay.");
  const verified = await rows("SELECT payload FROM native_video_release_events WHERE release_id = ? AND stage = ?", [releaseId, "verified"]);
  check(verified.length === 1, "completed release evidence required.");
  const saved = JSON.parse(verified[0].payload);
  check(saved.releaseId === releaseId && saved.worker?.workerBytesVerified === true, "recorded Worker identity required.");
  const inspect = async () => {
    const control = await rows("SELECT paused, release_id, current_release_id FROM native_video_release_control WHERE singleton = 1");
    check(control.length === 1 && control[0].paused === 0 && control[0].release_id === null &&
      control[0].current_release_id === releaseId, "the exact completed release must remain live and unpaused.");
    const worker = await inspectWorker(cf);
    check(isDeepStrictEqual(worker, saved.worker), "live Worker differs from the completed release.");
    return { control: control[0], worker, schedules: exactSchedule(await cf.schedules()) };
  };
  const idle = async () => {
    const jobs = await rows("SELECT COUNT(*) AS count FROM story_video_jobs WHERE status IN ('queued', 'rendering')");
    const fixtures = await rows("SELECT COUNT(*) AS count FROM storage_test_fixtures WHERE purpose = 'native-qualification'");
    check(jobs.length === 1 && jobs[0].count === 0 && fixtures.length === 1 && fixtures[0].count === 0,
      "active jobs or qualification fixtures must finish before schedule registration.");
  };
  const before = await inspect();
  await idle();
  const intent = { schemaVersion: 1, operation: "repair-schedule", environment: "development", releaseId,
    runId: env.GITHUB_RUN_ID, sourceCommit: env.GITHUB_SHA, before,
    request: { method: "PUT", worker: "forever-tee-api-development", schedules: [{ cron: "* * * * *" }] } };
  const intentArtifact = await store.save("schedule-repair-intent.json", Buffer.from(JSON.stringify(intent)));
  // A different run cannot replace this immutable per-release intent. A lost
  // PUT response consumes the attempt; there is no retry or automatic reset.
  await recordReleaseEvent(cf, releaseId, "schedule-repair-started", { ...intent, intentArtifact });
  check(isDeepStrictEqual(await inspect(), before), "live state changed after intent was saved.");
  await idle();
  exactSchedule(await cf.repairSchedule());
  const after = await inspect();
  const result = { schemaVersion: 1, releaseId, runId: env.GITHUB_RUN_ID, intentArtifact, before, after,
    scheduleRegistered: true, scheduledExecutionVerified: false };
  const resultArtifact = await store.save("schedule-repair-result.json", Buffer.from(JSON.stringify(result)));
  await recordReleaseEvent(cf, releaseId, "schedule-repair-completed", { ...result, resultArtifact });
  return { ...result, resultArtifact };
}
