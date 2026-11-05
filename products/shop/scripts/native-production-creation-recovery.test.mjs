import { protectedConfig } from "./protected-config.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { CREATION_FAILED_RELEASE, executeCreationRecovery, verifyCreationRecoverySnapshot } from "./native-production-creation-recovery.mjs";
import { versionResourcesDigest, workerContentManifest } from "./native-ci-worker.mjs";
import { NATIVE_PRODUCTION_QUEUE, FALLBACK_PRODUCTION_QUEUE } from "./native-production-worker.mjs";
const priorId = "native-" + protectedConfig("resource_2f229d3bccd4"), pausedAt = 1788667485009;
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
async function fixture() {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE story_video_jobs (id TEXT PRIMARY KEY, status TEXT NOT NULL)");
    const schema = await readFile(new URL("../workers/api/sql/native-release-controls.sql", import.meta.url), "utf8");
    for (const statement of schema.split("--> statement-breakpoint"))
        db.exec(statement);
    db.prepare("UPDATE native_video_release_control SET paused=1,release_id=?,current_release_id=?,paused_at=?,updated_at=? WHERE singleton=1")
        .run(CREATION_FAILED_RELEASE, priorId, pausedAt, pausedAt);
    const bytes = Buffer.from("export default {}"), content = await workerContentManifest(new Response(bytes));
    const consumerId = "a".repeat(32), nativeConsumer = { consumerId, settings: NATIVE_PRODUCTION_QUEUE };
    const consumer = { consumerId, settings: FALLBACK_PRODUCTION_QUEUE };
    const previousWorker = { workerVersion: "11111111-1111-4111-8111-111111111111", content, workerBytesVerified: true };
    const fallbackVersion = { id: "22222222-2222-4222-8222-222222222222", resources: { bindings: [] } };
    const fallback = { workerVersion: fallbackVersion.id, content, workerBytesVerified: true,
        versionResourcesSha256: versionResourcesDigest(fallbackVersion), provider: "cloudflare", consumer, cron: "*/15 * * * *" };
    const runtime = { runtimeVerified: true, imageDigest: "unchanged" };
    const baseline = { breaches: 0, breachCohortSha256: "a".repeat(64) };
    const prior = { releaseId: priorId, environment: "production", accountId: protectedConfig("awsAccountId"), worker: { bundleSha256: sha(bytes) },
        artifacts: { previousArtifact: { name: "original" }, candidateArtifact: { name: "prior-bytes" } },
        previous: { worker: { original: true } }, variables: { STORY_VIDEO_PROVIDER: "lambda" } };
    const prepared = { releaseId: CREATION_FAILED_RELEASE, sourceCommit: "bb53fd0bc7e319a93768524546b8b6f305e2872b",
        environment: "production", accountId: protectedConfig("awsAccountId"), region: "ap-southeast-2", runtime,
        worker: { bundleSha256: sha(bytes) }, artifacts: { candidateArtifact: { name: "candidate" } },
        previous: { worker: previousWorker, consumer: nativeConsumer }, monitoringBaseline: baseline };
    const insert = db.prepare("INSERT INTO native_video_release_events (release_id,stage,payload,created_at) VALUES (?,?,?,?)");
    const stages = [
        ["prepared", { ...prepared, preparation: { name: "prepared" } }], ["cloud-pause-verified", {}], ["drained", {}],
        ["runtime-image-verified", { review: { startupVerified: true, runtime } }], ["migration-verified", {}], ["fallback-deploy-started", {}],
        ["creation-recovery-started", { runId: protectedConfig("resource_28a45a0ece57"), intent: { name: "original-intent" } }],
    ];
    stages.forEach(([name, payload], index) => insert.run(CREATION_FAILED_RELEASE, name, JSON.stringify(payload), pausedAt + index));
    insert.run(priorId, "prepared", JSON.stringify({ ...prior, preparation: { name: "prior" } }), 1);
    insert.run(priorId, "fallback-verified", JSON.stringify({ fallback, artifact: { name: "fallback" } }), 2);
    insert.run(priorId, "verified", JSON.stringify({ releaseId: priorId, provider: "lambda", rollbackRehearsed: true,
        native: { ...previousWorker, provider: "lambda", consumer: nativeConsumer, cron: "* * * * *" }, fallback }), 3);
    const schedules = { schedules: [{ cron: "*/15 * * * *" }] };
    const activeContent = { ...content, sha256: protectedConfig("resource_482fde8c090a") };
    const snapshot = { releaseId: CREATION_FAILED_RELEASE, control: [{ paused: 1, release_id: CREATION_FAILED_RELEASE,
                paused_at: pausedAt, current_release_id: priorId }],
        records: db.prepare("SELECT stage,payload,created_at FROM native_video_release_events WHERE release_id=? ORDER BY created_at,stage").all(CREATION_FAILED_RELEASE).map(row => ({ ...row })),
        worker: { activeVersions: [{ version_id: protectedConfig("resource_0ea872585018"), percentage: 100 }],
            latestVersion: protectedConfig("resource_0ea872585018"), content: activeContent,
            versionResources: [{ id: protectedConfig("resource_0ea872585018"), sha256: protectedConfig("resource_0875ba886dc3") }] },
        consumer, schedules, jobs: [{ status: "ready", count: 472 }] };
    const objects = new Map(Object.entries({ prepared, prior, fallback, original: { before: prior.previous.worker, settings: { bindings: [] } } })
        .map(([name, value]) => [name, Buffer.from(JSON.stringify(value))]));
    objects.set("candidate", bytes);
    objects.set("prior-bytes", bytes);
    objects.set("original-intent", Buffer.from(JSON.stringify({ runId: protectedConfig("resource_28a45a0ece57"), sourceCommit: "37c4137244c4e5517ebfd3a913e92552e09d6a7e",
        releaseId: CREATION_FAILED_RELEASE, priorReleaseId: priorId, preparation: { name: "prepared" }, priorReference: { name: "prior" },
        fallbackArtifact: { name: "fallback" }, inspection: { key: "source/releases/native-" + protectedConfig("resource_d24e537c07b2") + "/release-inspection.json",
            version: "ZRzpPG74bKqsWpjPJqb9VcvhJ0gYs_FN", sha256: protectedConfig("resource_e63e06a34dff") } })));
    const operations = [];
    const store = { read: async (ref) => ref.key?.endsWith("release-inspection.json") ? Buffer.from(JSON.stringify(snapshot)) : objects.get(ref.name),
        save: async (name, value) => { assert.equal(objects.has(name), false); operations.push(name); objects.set(name, value); return { name }; } };
    const cf = { query: async (sql, params = []) => {
            const statement = db.prepare(sql);
            if (sql.trim().startsWith("SELECT"))
                return [{ results: statement.all(...params).map(row => ({ ...row })), success: true }];
            const result = statement.run(...params);
            return [{ results: [], meta: { changes: result.changes }, success: true }];
        }, consumers: async () => [{ consumer_id: consumerId, type: "worker", script_name: "forever-tee-api", settings: consumer.settings }],
        schedules: async () => schedules, version: async () => fallbackVersion };
    const args = { cf, store, runtime: async () => runtime,
        monitor: async () => ({ ...baseline, monitoringVerified: true, pauseOverdue: true }),
        runId: "34011000000", sourceCommit: "b".repeat(40), now: () => pausedAt + 3600000,
        inspect: async () => ({ workerVersion: snapshot.worker.latestVersion, content: activeContent,
            versionResourcesSha256: snapshot.worker.versionResources[0].sha256 }),
        switchVersion: async (_cf, owner, target) => {
            assert.equal(owner, CREATION_FAILED_RELEASE);
            assert.deepEqual(target, fallback);
            assert.ok(operations.includes("creation-recovery-continuation-intent.json"));
            operations.push("restore");
            return { workerVersion: target.workerVersion, provider: "cloudflare", resourcesVerified: true, queueConcurrency: 1 };
        },
        verifyVersion: async () => { operations.push("verify-restored"); },
    };
    return { db, args, snapshot, operations, objects, fallback };
}
test("sealed creation recovery restores the prior verified fallback before admission and cannot replay", async () => {
    const f = await fixture();
    try {
        const result = await executeCreationRecovery(f.args);
        assert.equal(result.rollbackVerified, true);
        assert.equal(result.fromReleaseId, priorId);
        assert.equal(result.restored.workerVersion, f.fallback.workerVersion);
        assert.deepEqual(f.operations, ["creation-recovery-continuation-intent.json", "restore", "verify-restored", "creation-recovery-complete.json"]);
        assert.equal(f.db.prepare("SELECT paused FROM native_video_release_control").get().paused, 0);
        await assert.rejects(executeCreationRecovery(f.args), /history changed or recovery already started/);
    }
    finally {
        f.db.close();
    }
});
test("sealed snapshot rejects a different release, pause, stage, version or resource digest", async () => {
    const f = await fixture();
    try {
        verifyCreationRecoverySnapshot(f.snapshot);
        for (const mutate of [s => { s.releaseId = priorId; }, s => { s.control[0].paused_at++; },
            s => { s.records.push({ stage: "native-deploy-started" }); }, s => { s.worker.latestVersion = f.fallback.workerVersion; },
            s => { s.worker.versionResources[0].sha256 = "f".repeat(64); }]) {
            const copy = structuredClone(f.snapshot);
            mutate(copy);
            assert.throws(() => verifyCreationRecoverySnapshot(copy));
        }
    }
    finally {
        f.db.close();
    }
});
test("changed runtime, monitoring, prior fallback or live history stop before recovery intent", async () => {
    for (const mutate of [f => { f.args.runtime = async () => ({ changed: true }); },
        f => { f.args.monitor = async () => ({ monitoringVerified: true, breaches: 1, breachCohortSha256: "f".repeat(64), pauseOverdue: true }); },
        f => { f.objects.set("fallback", Buffer.from(JSON.stringify({ ...f.fallback, workerVersion: "other" }))); },
        f => { f.objects.set("candidate", Buffer.from("changed candidate")); },
        f => { f.objects.set("original-intent", Buffer.from("{}")); },
        f => { f.args.inspect = async () => ({ workerVersion: "other" }); },
        f => { f.args.cf.version = async () => ({ resources: { bindings: [{ name: "changed" }] } }); },
        f => { f.db.prepare("INSERT INTO native_video_release_events VALUES (?,?,?,?)").run(CREATION_FAILED_RELEASE, "later", "{}", pausedAt + 100); },
        f => { f.db.prepare("UPDATE native_video_release_control SET current_release_id='native-999'").run(); },
        f => { f.db.exec("UPDATE native_video_release_control SET paused=0; INSERT INTO story_video_jobs VALUES ('active','rendering'); UPDATE native_video_release_control SET paused=1;"); },
    ]) {
        const f = await fixture();
        try {
            mutate(f);
            await assert.rejects(executeCreationRecovery(f.args));
            assert.deepEqual(f.operations, []);
        }
        finally {
            f.db.close();
        }
    }
});
test("failed post-restoration verification cannot reopen admission", async () => {
    const f = await fixture();
    try {
        f.args.verifyVersion = async () => { throw Error("restored version differs"); };
        await assert.rejects(executeCreationRecovery(f.args), /restored version differs/);
        assert.equal(f.db.prepare("SELECT paused FROM native_video_release_control").get().paused, 1);
        assert.ok(f.operations.includes("restore"));
        assert.ok(!f.operations.includes("creation-recovery-complete.json"));
    }
    finally {
        f.db.close();
    }
});
test("uncertain restoration holds admission and rejects a second mutation attempt", async () => {
    const f = await fixture();
    try {
        f.args.switchVersion = async () => { throw Error("lost acknowledgement"); };
        await assert.rejects(executeCreationRecovery(f.args), /lost acknowledgement/);
        assert.equal(f.db.prepare("SELECT paused FROM native_video_release_control").get().paused, 1);
        await assert.rejects(executeCreationRecovery(f.args), /history changed or recovery already started/);
    }
    finally {
        f.db.close();
    }
});
