import { protectedConfig } from "./protected-config.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { executeProductionReleaseAbort } from "./native-production-preflight-recovery.mjs";
import { workerContentManifest } from "./native-ci-worker.mjs";
import { NATIVE_MIGRATION_LATEST } from "./native-migration-inventory.mjs";
async function fixture({ extraStage = false, activeJob = false, phase = "early" } = {}) {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE story_video_jobs (id TEXT PRIMARY KEY, status TEXT NOT NULL)");
    const schema = await readFile(new URL("../workers/api/sql/native-release-controls.sql", import.meta.url), "utf8");
    for (const statement of schema.split("--> statement-breakpoint"))
        db.exec(statement);
    const releaseId = "native-33468818579", previousReleaseId = "native-" + protectedConfig("resource_1f80479a3ff7"), pausedAt = 1000;
    if (activeJob) {
        db.prepare("UPDATE native_video_release_control SET paused=0 WHERE singleton=1").run();
        db.prepare("INSERT INTO story_video_jobs VALUES ('job','rendering')").run();
    }
    db.prepare("UPDATE native_video_release_control SET paused=1,release_id=?,current_release_id=?,paused_at=?,updated_at=? WHERE singleton=1")
        .run(releaseId, previousReleaseId, pausedAt, pausedAt);
    const bytes = Buffer.from("export default { fetch() { return new Response('ok') } }");
    const content = await workerContentManifest(new Response(bytes));
    const fallbackWorker = { workerVersion: "11111111-1111-4111-8111-111111111111", content,
        versionResourcesSha256: "d".repeat(64), annotations: {}, workerBytesVerified: true };
    const fallback = { ...fallbackWorker, provider: "cloudflare",
        consumer: { consumerId: "a".repeat(32), settings: { max_concurrency: 1 } }, cron: "*/15 * * * *" };
    const settings = { bindings: [{ name: "STORY_VIDEO_PROVIDER", type: "plain_text", text: "cloudflare" }] };
    const previous = { before: fallbackWorker, consumer: fallback.consumer, settings, schedules: { schedules: [{ cron: fallback.cron }] },
        body: bytes.toString("base64"), contentType: "application/javascript+module", entrypoint: "index.js" };
    const runtime = { runtimeVerified: true, imageDigest: "sha256:" + "a".repeat(64) };
    const targetRuntime = { runtimeVerified: true, imageDigest: "sha256:" + "b".repeat(64) };
    const candidate = { imageDigest: targetRuntime.imageDigest, sourceDigest: "c".repeat(64) };
    const secretNames = ["CART_LINE_CAPABILITY_SECRET", "PRINTIFY_ASSET_DELIVERY_SECRET", "PRINTIFY_WEBHOOK_SECRET"];
    const prepared = { environment: "production", accountId: protectedConfig("awsAccountId"), region: "ap-southeast-2", releaseId,
        sourceCommit: "b".repeat(40), runtime, previous: { worker: fallbackWorker, consumer: fallback.consumer },
        candidate, worker: { secretNames }, imagePlanArtifact: { name: "image-plan" },
        artifacts: { previousArtifact: { name: "previous" } } };
    const objects = new Map([["prepared", Buffer.from(JSON.stringify(prepared))], ["previous", Buffer.from(JSON.stringify(previous))]]);
    const insert = db.prepare("INSERT INTO native_video_release_events (release_id,stage,payload,created_at) VALUES (?,?,?,?)");
    insert.run(releaseId, "prepared", JSON.stringify({ ...prepared, preparation: { name: "prepared" } }), pausedAt);
    insert.run(releaseId, "cloud-pause-verified", JSON.stringify({ invalidRenderingInsertIgnored: true }), pausedAt + 1);
    insert.run(releaseId, "drained", JSON.stringify({ naturalDrainVerified: true, unresolvedAttempts: 0, pausedAt }), pausedAt + 2);
    if (phase === "predeploy") {
        insert.run(releaseId, "runtime-image-verified", JSON.stringify({ plan: prepared.imagePlanArtifact,
            review: { startupVerified: true, runtime: targetRuntime, ...candidate } }), pausedAt + 3);
        insert.run(releaseId, "migration-verified", JSON.stringify({ executionProtocol: "claim-v1", migration: NATIVE_MIGRATION_LATEST }), pausedAt + 4);
        insert.run(releaseId, "secret-install-started", JSON.stringify({ fixedReleaseSecrets: secretNames }), pausedAt + 5);
    }
    if (extraStage)
        insert.run(releaseId, "runtime-image-verified", "{}", pausedAt + 3);
    const cf = { query: async (sql, params = []) => {
            const statement = db.prepare(sql);
            if (sql.trim().startsWith("SELECT"))
                return [{ results: statement.all(...params), success: true }];
            const result = statement.run(...params);
            return [{ results: [], meta: { changes: result.changes }, success: true }];
        } };
    const store = { read: async (reference) => objects.get(reference.name), save: async (name, value) => {
            assert.equal(objects.has(name), false);
            objects.set(name, value);
            return { name };
        } };
    const baseline = { record: { releaseId: previousReleaseId, sourceReleaseId: previousReleaseId, workerVersion: fallback.workerVersion,
            latestVersion: "22222222-2222-4222-8222-222222222222" }, fallback, settings };
    const loadBaseline = async (_cf, _store, options) => {
        const control = db.prepare("SELECT paused,release_id FROM native_video_release_control WHERE singleton=1").get();
        if (control.paused === 1)
            assert.equal(options.pauseOwner, releaseId);
        else
            assert.equal(options, undefined);
        return baseline;
    };
    return { db, releaseId, previousReleaseId, args: { cf, store, releaseId, recoveryRunId: "33470000000", verifierSourceCommit: "c".repeat(40),
            currentRuntime: async () => phase === "predeploy" ? targetRuntime : runtime, loadBaseline, now: () => 9000 } };
}
test("early failed release reopens only its unchanged recorded fallback", async () => {
    const value = await fixture();
    try {
        const result = await executeProductionReleaseAbort(value.args);
        assert.equal(result.releaseAbortComplete, true);
        assert.equal(result.phase, "early");
        assert.equal(result.previousReleaseId, value.previousReleaseId);
        assert.deepEqual({ ...value.db.prepare("SELECT paused,release_id,current_release_id FROM native_video_release_control WHERE singleton=1").get() }, { paused: 0, release_id: null, current_release_id: value.previousReleaseId });
        assert.deepEqual(value.db.prepare("SELECT stage FROM native_video_release_events WHERE release_id=? ORDER BY created_at,stage").all(value.releaseId)
            .map(row => row.stage), ["prepared", "cloud-pause-verified", "drained", "release-abort-started", "release-aborted"]);
    }
    finally {
        value.db.close();
    }
});
test("pre-deployment abort retains the qualified runtime and restores the recorded fallback", async () => {
    const value = await fixture({ phase: "predeploy" });
    try {
        const result = await executeProductionReleaseAbort(value.args);
        assert.equal(result.releaseAbortComplete, true);
        assert.equal(result.phase, "predeploy");
        assert.equal(result.retainedQualifiedRuntime, true);
        assert.equal(value.db.prepare("SELECT paused FROM native_video_release_control WHERE singleton=1").get().paused, 0);
    }
    finally {
        value.db.close();
    }
});
test("release abort rejects any unsupported stage or live rendering work before mutation", async () => {
    const advanced = await fixture({ extraStage: true });
    try {
        await assert.rejects(executeProductionReleaseAbort(advanced.args), /only a verified early or pre-deployment boundary/);
        assert.equal(advanced.db.prepare("SELECT paused FROM native_video_release_control WHERE singleton=1").get().paused, 1);
    }
    finally {
        advanced.db.close();
    }
    const active = await fixture({ activeJob: true });
    try {
        await assert.rejects(executeProductionReleaseAbort(active.args), /no rendering work/);
        assert.equal(active.db.prepare("SELECT paused FROM native_video_release_control WHERE singleton=1").get().paused, 1);
    }
    finally {
        active.db.close();
    }
});
