import { protectedConfig } from "./protected-config.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { verifyReviewedForwardSnapshot, verifyReviewedIssue209Snapshot, verifyReviewedRehearsalSnapshot, recoverProductionRehearsal } from "./native-production-rehearsal-recovery.mjs";
test("rehearsal recovery is sealed to the reviewed pause, stage boundary and two existing versions", () => {
    const snapshot = { releaseId: "native-" + protectedConfig("resource_df582621cced"), control: [{ paused: 1, release_id: "native-" + protectedConfig("resource_df582621cced"), current_release_id: null, paused_at: 1787960796008 }],
        records: ["prepared", "cloud-pause-verified", "drained", "migration-verified", "secret-install-started", "fallback-deploy-started", "fallback-verified", "native-deploy-started", "native-verified"].map(stage => ({ stage })),
        worker: { activeVersions: [{ version_id: protectedConfig("resource_b4efc1b4ee71"), percentage: 100 }], latestVersion: protectedConfig("resource_030ac180b0a9") } };
    verifyReviewedRehearsalSnapshot(snapshot);
    for (const mutate of [s => { s.control[0].paused = 0; }, s => { s.control[0].paused_at++; }, s => { s.control[0].current_release_id = "other"; },
        s => { s.records.push({ stage: "rehearsal-recovery-started" }); }, s => { s.records.pop(); }, s => { s.worker.latestVersion = "other"; },
        s => { s.worker.activeVersions[0].percentage = 50; }]) {
        const changed = structuredClone(snapshot);
        mutate(changed);
        assert.throws(() => verifyReviewedRehearsalSnapshot(changed));
    }
});
test("recovery cannot target another release or run outside the guarded Actions context", async () => {
    await assert.rejects(recoverProductionRehearsal({ NATIVE_OPERATION: "recover-rehearsal", NATIVE_VERIFY_RELEASE: "native-123" }), /reviewed release/);
    await assert.rejects(recoverProductionRehearsal({ NATIVE_OPERATION: "recover-rehearsal", NATIVE_VERIFY_RELEASE: "native-" + protectedConfig("resource_df582621cced") }), /exact main-only/);
    await assert.rejects(recoverProductionRehearsal({ NATIVE_OPERATION: "recover-rehearsal", NATIVE_VERIFY_RELEASE: "native-" + protectedConfig("resource_1f80479a3ff7") }), /exact main-only/);
    await assert.rejects(recoverProductionRehearsal({ NATIVE_OPERATION: "recover-rehearsal", NATIVE_VERIFY_RELEASE: "native-" + protectedConfig("resource_14950b570946") }), /exact main-only/);
});
test("monitor recovery is sealed to the exact forward-rehearsed held snapshot", () => {
    const stages = ["prepared", "cloud-pause-verified", "drained", "runtime-image-verified", "migration-verified", "secret-install-started",
        "fallback-deploy-started", "fallback-verified", "native-deploy-started", "native-verified", "rollback-rehearsed", "forward-rehearsed"];
    const snapshot = { releaseId: "native-" + protectedConfig("resource_1f80479a3ff7"), control: [{ paused: 1, release_id: "native-" + protectedConfig("resource_1f80479a3ff7"), current_release_id: "native-" + protectedConfig("resource_5c5e5c63a22e"),
                paused_at: 1788230352102 }], records: stages.map(stage => ({ stage })), worker: { activeVersions: [{ version_id: protectedConfig("resource_9053a89f6361"),
                    percentage: 100 }], latestVersion: protectedConfig("resource_9053a89f6361") }, consumer: { settings: { max_concurrency: 2 } },
        canaryAssets: Array(4).fill({ status: "ready", error: null }), jobs: [{ status: "queued", count: 1 }] };
    verifyReviewedForwardSnapshot(snapshot);
    for (const mutate of [value => { value.control[0].paused = 0; }, value => { value.control[0].current_release_id = "other"; },
        value => { value.records.pop(); }, value => { value.worker.latestVersion = "other"; }, value => { value.canaryAssets[0].status = "failed"; },
        value => { value.jobs.push({ status: "rendering", count: 1 }); }]) {
        const changed = structuredClone(snapshot);
        mutate(changed);
        assert.throws(() => verifyReviewedForwardSnapshot(changed));
    }
});
test("Issue 209 recovery is sealed to the exact post-deploy propagation boundary", () => {
    const stages = ["prepared", "cloud-pause-verified", "drained", "runtime-image-verified", "migration-verified",
        "fallback-deploy-started", "fallback-verified", "native-deploy-started"];
    const version = protectedConfig("resource_6d9bdeb32755");
    const bindings = ["STORY_VIDEO_TRANSPORT", "STORY_VIDEO_WARM_ON_CONFIRM", "STORY_VIDEO_PROVIDER", "STORY_VIDEO_ENVIRONMENT",
        "STORY_VIDEO_LAMBDA_FUNCTION", "STORY_VIDEO_FAMILY_CONFIGURATION", "STORY_VIDEO_LANES", "STORY_VIDEO_NOTIFICATION_MODE",
        "STORY_VIDEO_RELEASE_ID", "STORY_VIDEO_RELEASE_COMMIT", "STORY_VIDEO_IMAGE_DIGEST", "STORY_VIDEO_SOURCE_DIGEST"];
    const snapshot = { releaseId: "native-" + protectedConfig("resource_14950b570946"), control: [{ paused: 1, release_id: "native-" + protectedConfig("resource_14950b570946"),
                current_release_id: "native-" + protectedConfig("resource_7adca284c1f4"), paused_at: 1788252457709 }], records: stages.map(stage => ({ stage })),
        worker: { activeVersions: [{ version_id: version, percentage: 100 }], latestVersion: version,
            content: { entrypoint: "index.js", sha256: protectedConfig("resource_98b9cc41d14e"),
                modules: [{ name: "index.js", bytes: 2089891, sha256: protectedConfig("resource_cc505cba05ae") }] },
            versionResources: [{ id: version, sha256: protectedConfig("resource_23a19465abe4"),
                    bindings: bindings.map(name => ({ name, count: 1, type: "plain_text", textMatches: true })) }] },
        consumer: { settings: { batch_size: 1, max_retries: 100, max_wait_time_ms: 1000, max_concurrency: 2, retry_delay: 10 } },
        schedules: { schedules: [{ cron: "* * * * *" }] }, migrations: [{ name: "0024_story_video_renderer_v7.sql" }],
        jobs: [{ status: "failed", count: 104 }, { status: "ready", count: 128 }],
        canaryAssets: Array(4).fill({ status: "ready", error: null }) };
    verifyReviewedIssue209Snapshot(snapshot);
    for (const mutate of [value => { value.control[0].paused = 0; }, value => { value.records.pop(); },
        value => { value.worker.latestVersion = "other"; }, value => { value.worker.versionResources[0].bindings[0].textMatches = false; },
        value => { value.jobs.push({ status: "rendering", count: 1 }); }, value => { value.canaryAssets[0].status = "failed"; }]) {
        const changed = structuredClone(snapshot);
        mutate(changed);
        assert.throws(() => verifyReviewedIssue209Snapshot(changed));
    }
});
