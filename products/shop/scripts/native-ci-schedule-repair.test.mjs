import { protectedConfig } from "./protected-config.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { repairDevelopmentSchedule } from "./native-ci-schedule-repair.mjs";
const env = { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "bentbrain/bent-mono", GITHUB_REPOSITORY_ID: protectedConfig("githubRepositoryId"),
    GITHUB_REPOSITORY_OWNER_ID: protectedConfig("githubOwnerId"), GITHUB_REF: "refs/heads/main", GITHUB_SHA: "a".repeat(40),
    GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_RUN_ID: "456", GITHUB_RUN_ATTEMPT: "1",
    GITHUB_WORKFLOW_REF: "bentbrain/bent-mono/.github/workflows/native-development.yml@refs/heads/main",
    NATIVE_OPERATION: "repair-schedule", NATIVE_VERIFY_RELEASE: "native-123" };
const worker = { workerVersion: "876fcce3-3ef8-408a-952c-bb8d5be6e536", content: { sha256: "b".repeat(64) },
    versionResourcesSha256: "c".repeat(64), workerBytesVerified: true };
function fixture(changes = {}) {
    const events = new Map([["verified", JSON.stringify({ releaseId: "native-123", worker })]]);
    const calls = [];
    const state = { control: { paused: 0, release_id: null, current_release_id: "native-123" }, jobs: 0, fixtures: 0,
        schedules: [{ cron: "* * * * *" }], worker, ...changes };
    const cf = {
        query: async (sql, params) => {
            let results;
            if (sql.includes("INSERT INTO native_video_release_events")) {
                calls.push(`event:${params[1]}`);
                assert.equal(events.has(params[1]), false);
                events.set(params[1], params[2]);
                results = [];
            }
            else if (sql.includes("FROM native_video_release_events")) {
                results = events.has(params[1]) ? [{ payload: events.get(params[1]) }] : [];
            }
            else if (sql.includes("FROM native_video_release_control"))
                results = [state.control];
            else if (sql.includes("FROM story_video_jobs"))
                results = [{ count: state.jobs }];
            else if (sql.includes("FROM storage_test_fixtures"))
                results = [{ count: state.fixtures }];
            else
                assert.fail(sql);
            return [{ results }];
        },
        schedules: async () => ({ schedules: state.schedules }),
        repairSchedule: async () => {
            calls.push("PUT");
            if (state.loseResponse)
                throw Error("Unconfirmed response");
            if (state.replaceWorker)
                state.worker = { ...worker, workerVersion: "changed" };
            return { schedules: state.schedules };
        },
    };
    const store = { save: async (name) => { calls.push(`save:${name}`); return { key: name, version: "saved", sha256: "d".repeat(64) }; } };
    return { cf, store, env, inspectWorker: async () => state.worker, calls, events, state };
}
test("schedule registration preserves the live pair and durable intent precedes the single PUT", async () => {
    const f = fixture();
    const result = await repairDevelopmentSchedule(f);
    assert.equal(result.scheduleRegistered, true);
    assert.equal(result.scheduledExecutionVerified, false);
    assert.deepEqual(f.calls, ["save:schedule-repair-intent.json", "event:schedule-repair-started", "PUT",
        "save:schedule-repair-result.json", "event:schedule-repair-completed"]);
    await assert.rejects(repairDevelopmentSchedule(f), /already attempted/);
    assert.equal(f.calls.filter(call => call === "PUT").length, 1);
});
test("wrong release, pause, active jobs, fixtures, extra schedules and changed Worker stop before registration", async () => {
    for (const change of [{ control: { paused: 1, release_id: null, current_release_id: "native-123" } },
        { control: { paused: 0, release_id: null, current_release_id: "native-999" } }, { jobs: 1 }, { fixtures: 1 },
        { schedules: [] }, { schedules: [{ cron: "* * * * *" }, { cron: "0 * * * *" }] },
        { worker: { ...worker, versionResourcesSha256: "e".repeat(64) } }]) {
        const f = fixture(change);
        await assert.rejects(repairDevelopmentSchedule(f));
        assert.deepEqual(f.calls, []);
    }
});
test("lost registration response consumes the durable intent without a retry or completion claim", async () => {
    const f = fixture({ loseResponse: true });
    await assert.rejects(repairDevelopmentSchedule(f), /Unconfirmed/);
    await assert.rejects(repairDevelopmentSchedule({ ...f, env: { ...env, GITHUB_RUN_ID: "457" } }), /already attempted/);
    assert.equal(f.calls.filter(call => call === "PUT").length, 1);
    assert.equal(f.events.has("schedule-repair-completed"), false);
});
test("a Worker change after registration leaves the operation incomplete", async () => {
    const f = fixture({ replaceWorker: true });
    await assert.rejects(repairDevelopmentSchedule(f), /Worker/);
    assert.equal(f.events.has("schedule-repair-completed"), false);
});
test("repair requires the exact main-only first-attempt Actions operation", async () => {
    for (const change of [{ NATIVE_OPERATION: "release" }, { GITHUB_RUN_ATTEMPT: "2" }, { NATIVE_VERIFY_RELEASE: "" },
        { NATIVE_RELEASE_MODE: "api" }, { GITHUB_EVENT_NAME: "push" }, { GITHUB_ACTIONS: "false" },
        { GITHUB_REF: "refs/heads/perf/story-video-family-experiments",
            GITHUB_WORKFLOW_REF: "bentbrain/bent-mono/.github/workflows/native-development.yml@refs/heads/perf/story-video-family-experiments" }]) {
        const f = fixture();
        await assert.rejects(repairDevelopmentSchedule({ ...f, env: { ...env, ...change } }));
        assert.deepEqual(f.calls, []);
    }
});
