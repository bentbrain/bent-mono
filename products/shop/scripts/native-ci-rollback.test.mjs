import { historicalWorkerUpload } from "./native-worker-content.mjs";
import { protectedConfig } from "./protected-config.mjs";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { beginReleasePause, installPauseSchema } from "./native-release-pause.mjs";
import { executeDevelopmentRollback, loadDevelopmentRollback, previousDevelopmentCandidate, loadActiveDevelopmentRollbackArtifact } from "./native-ci-rollback.mjs";
import { versionResourcesDigest, workerContentManifest } from "./native-ci-worker.mjs";
async function fixture(failAt) {
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE story_video_jobs (id TEXT PRIMARY KEY NOT NULL, status TEXT, attempt_count INTEGER,
    renderer_version TEXT, updated_at INTEGER, last_error TEXT);
    INSERT INTO story_video_jobs VALUES ('retained-ready', 'ready', 1, 'story-video-renderer-v7', 10, NULL)`);
    const calls = [], version = { id: "2fc159fa-8592-4599-9478-9aaf6697537f", resources: { script: { etag: "previous-code" } } };
    const consumer = { consumerId: "a".repeat(32), settings: { max_concurrency: 2, max_retries: 10 } };
    const checkStep = name => {
        assert.equal(db.prepare("SELECT paused FROM native_video_release_control").get().paused, 1);
        calls.push(name);
        if (failAt === name)
            throw new Error(`Uncertain ${name}`);
    };
    const cf = {
        query: async (sql, params = []) => {
            const statement = db.prepare(sql);
            return [{ success: true, results: statement.columns().length ? statement.all(...params).map(row => ({ ...row })) : [],
                    meta: statement.columns().length ? { changes: 0 } : statement.run(...params) }];
        },
        version: async () => version,
        deployments: async () => ({ deployments: [{ versions: [{ version_id: version.id, percentage: 100 }] }] }),
        deployExistingVersion: async (id) => { assert.equal(id, version.id); checkStep("worker"); },
        restoreConsumer: async (id, settings) => { assert.equal(id, consumer.consumerId); assert.deepEqual(settings, consumer.settings); checkStep("consumer"); },
        consumers: async () => [{ type: "worker", script: "forever-tee-api-development", consumer_id: consumer.consumerId, settings: consumer.settings }],
    };
    const runtime = { runtimeVerified: true, environment: "development", renderer: { imageDigest: `sha256:${"b".repeat(64)}`, sourceDigest: "c".repeat(64),
            imageUri: protectedConfig("awsAccountId") + ".dkr.ecr.ap-southeast-2.amazonaws.com/forever-tee-video-development@sha256:" + ("b".repeat(64)) },
        failure: { imageDigest: `sha256:${"b".repeat(64)}` } };
    const worker = { workerVersion: version.id, content: await workerContentManifest(new Response('"owner-artwork-media-v1"; previous code')), versionResourcesSha256: versionResourcesDigest(version) };
    const prepared = { releaseId: "native-123", sourceCommit: "d".repeat(40), planSha256: "e".repeat(64), environment: "development",
        accountId: protectedConfig("awsAccountId"), region: "ap-southeast-2", previous: { runtime, worker, consumer }, candidate: { imageDigest: `sha256:${"f".repeat(64)}` },
        artifacts: { previousArtifact: { key: "previous-worker" } } };
    const artifact = { body: Buffer.from('"owner-artwork-media-v1"; previous code').toString("base64"), contentType: "application/javascript", entrypoint: "index.js", before: worker, consumer };
    const objects = new Map([["prepared", Buffer.from(JSON.stringify(prepared))], ["previous-worker", Buffer.from(JSON.stringify(artifact))]]);
    const store = { save: async (key, bytes) => { objects.set(key, bytes); return { key }; }, read: async (ref) => objects.get(ref.key) };
    await installPauseSchema(cf);
    await beginReleasePause(cf, { ...prepared, preparation: { key: "prepared" } }, 1000);
    const target = previousDevelopmentCandidate(prepared);
    let time = 10000;
    const image = { review: { ...target, updateCount: 2 }, apply: async () => checkStep("image") };
    return { db, calls, objects, cf, store, prepared, input: { cf, store, prepared, target, image, releaseId: "native-456", sourceCommit: "a".repeat(40),
            probeRuntime: async () => { checkStep("startup"); return { startupVerified: true }; },
            now: () => time, wait: async (ms) => { assert.ok(ms <= 15000); time += ms; }, inspectRuntime: async () => runtime } };
}
test("rollback validates the immutable D1/S3 preparation, prior Worker bytes and historical version", async () => {
    const { db, cf, store, objects, prepared } = await fixture();
    try {
        assert.equal((await loadDevelopmentRollback(cf, store, "native-123")).target.imageDigest, prepared.previous.runtime.renderer.imageDigest);
        const artifact = JSON.parse(objects.get("previous-worker"));
        artifact.body = Buffer.from("altered code").toString("base64");
        objects.set("previous-worker", Buffer.from(JSON.stringify(artifact)));
        await assert.rejects(loadDevelopmentRollback(cf, store, "native-123"));
        objects.set("prepared", Buffer.from("{}"));
        await assert.rejects(loadDevelopmentRollback(cf, store, "native-123"));
    }
    finally {
        db.close();
    }
});
test("rollback reacquires a full drain, restores both providers and queue settings, then verifies before resume", async () => {
    const { db, calls, input } = await fixture();
    try {
        assert.equal((await executeDevelopmentRollback(input)).rollbackVerified, true);
        assert.deepEqual(calls, ["image", "startup", "worker", "consumer"]);
        assert.equal(db.prepare("SELECT paused_at FROM native_video_release_control").get().paused_at, 10000);
        assert.equal(db.prepare("SELECT paused FROM native_video_release_control").get().paused, 0);
        assert.equal(db.prepare("SELECT status FROM story_video_jobs").get().status, "ready");
    }
    finally {
        db.close();
    }
});
test("forward release after rollback resolves only the completed rollback's immutable previous artifact", async () => {
    const { db, cf, store, input, prepared } = await fixture();
    try {
        await assert.rejects(loadActiveDevelopmentRollbackArtifact(cf, store));
        await executeDevelopmentRollback(input);
        const artifact = await loadActiveDevelopmentRollbackArtifact(cf, store);
        assert.deepEqual(artifact.before, prepared.previous.worker);
        db.exec("UPDATE native_video_release_control SET current_release_id = 'native-123'");
        await assert.rejects(loadActiveDevelopmentRollbackArtifact(cf, store));
        db.exec("UPDATE native_video_release_control SET current_release_id = 'native-456'");
        const originalQuery = cf.query;
        for (const delta of [{ rollbackVerified: false }, { workerVersion: "wrong" }, { target: {} }, { releaseId: "native-999" }]) {
            cf.query = async (sql, params) => {
                const result = await originalQuery(sql, params);
                if (sql.includes("stage = 'verified'"))
                    result[0].results[0].payload = JSON.stringify({ ...JSON.parse(result[0].results[0].payload), ...delta });
                return result;
            };
            await assert.rejects(loadActiveDevelopmentRollbackArtifact(cf, store));
        }
        cf.query = originalQuery;
        let reads = 0;
        cf.query = async (sql, params) => {
            const result = await originalQuery(sql, params);
            if (sql.startsWith("SELECT paused,") && ++reads === 2)
                result[0].results[0].current_release_id = "native-999";
            return result;
        };
        await assert.rejects(loadActiveDevelopmentRollbackArtifact(cf, store));
    }
    finally {
        db.close();
    }
});
test("rollback uncertainty and competing pause ownership cannot reopen admissions", async () => {
    for (const failAt of ["image", "startup", "worker", "consumer", "owner"]) {
        const { db, input } = await fixture(failAt);
        try {
            if (failAt === "owner")
                db.exec("UPDATE native_video_release_control SET release_id = 'native-999'");
            await assert.rejects(executeDevelopmentRollback(input));
            assert.equal(db.prepare("SELECT paused FROM native_video_release_control").get().paused, 1);
        }
        finally {
            db.close();
        }
    }
});
test("executor rollback restores and verifies before the release event authorizes its historical generation", async () => {
    const { db, calls, input, prepared } = await fixture();
    try {
        prepared.worker = { printExecutor: { releaseId: prepared.releaseId } };
        await assert.rejects(executeDevelopmentRollback(input), /executor rollback verifier/u);
        const record = { releaseId: "native-100", namespaceId: "b".repeat(32), worker: { workerVersion: "historical" } };
        input.restorePrintExecutor = async () => {
            assert.equal(db.prepare("SELECT paused FROM native_video_release_control").get().paused, 1);
            calls.push("executor");
            return { restored: record, retained: null, verify: async () => {
                    assert.ok(calls.includes("worker"));
                    calls.push("executor-verified");
                } };
        };
        const result = await executeDevelopmentRollback(input);
        assert.deepEqual(result.worker.printExecutor, record);
        assert.ok(calls.indexOf("executor") < calls.indexOf("worker"));
        assert.ok(calls.indexOf("worker") < calls.indexOf("executor-verified"));
        const verified = JSON.parse(db.prepare("SELECT payload FROM native_video_release_events WHERE release_id = 'native-456' AND stage = 'verified'").get().payload);
        assert.deepEqual(verified.worker.printExecutor, record);
        assert.equal(db.prepare("SELECT current_release_id FROM native_video_release_control").get().current_release_id, "native-456");
    }
    finally {
        db.close();
    }
});
test("queue rollback retains executor evidence without authorizing it and verification failure keeps admissions paused", async () => {
    for (const fail of [false, true]) {
        const { db, input, prepared } = await fixture();
        try {
            prepared.worker = { printExecutor: { releaseId: prepared.releaseId } };
            const retained = { releaseId: "native-123" };
            input.restorePrintExecutor = async () => ({ restored: null, retained, verify: async () => {
                    if (fail)
                        throw new Error("executor drift");
                } });
            if (fail) {
                await assert.rejects(executeDevelopmentRollback(input), /executor drift/u);
                assert.equal(db.prepare("SELECT paused FROM native_video_release_control").get().paused, 1);
            }
            else {
                const result = await executeDevelopmentRollback(input);
                assert.equal(result.worker, undefined);
                assert.deepEqual(result.retainedPrintExecutor, retained);
            }
        }
        finally {
            db.close();
        }
    }
});
async function failedRollbackFixture() {
    const f = await fixture();
    const { recordReleaseEvent } = await import('./native-release-pause.mjs');
    f.db.exec("UPDATE native_video_release_control SET current_release_id = 'native-123'");
    f.input.image.review.imagePlanVerified = true;
    f.input.image.review.sourceCommit = f.input.sourceCommit;
    const retained = { releaseId: 'native-123', namespaceId: 'b'.repeat(32) };
    f.input.restorePrintExecutor = async () => {
        await recordReleaseEvent(f.cf, 'native-456', 'print-executor-rollback-verified', { restored: null, retained });
        return { restored: null, retained, verify: () => { throw Error('latest settings are not the active version'); } };
    };
    await assert.rejects(executeDevelopmentRollback(f.input), /latest settings/u);
    const ref = { key: 'source/releases/native-456/rollback.json', version: 'sealed', sha256: 'f'.repeat(64) };
    f.objects.set(ref.key, f.objects.get('rollback.json'));
    const env = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'bentbrain/bent-mono', GITHUB_REPOSITORY_ID: protectedConfig("githubRepositoryId"),
        GITHUB_REPOSITORY_OWNER_ID: protectedConfig("githubOwnerId"), GITHUB_REF: 'refs/heads/main', GITHUB_SHA: 'b'.repeat(40), GITHUB_EVENT_NAME: 'workflow_dispatch',
        GITHUB_RUN_ID: '789', GITHUB_RUN_ATTEMPT: '1', GITHUB_WORKFLOW_REF: 'bentbrain/bent-mono/.github/workflows/native-development.yml@refs/heads/main',
        NATIVE_OPERATION: 'recover-rollback', NATIVE_ROLLBACK_RELEASE: 'native-456', NATIVE_ROLLBACK_REFERENCE: JSON.stringify(ref) };
    const originalRun = { id: 456, status: 'completed', conclusion: 'failure', run_attempt: 1, event: 'workflow_dispatch', head_branch: 'main',
        path: '.github/workflows/native-development.yml', repository: { id: Number(protectedConfig("githubRepositoryId")), owner: { id: Number(protectedConfig("githubOwnerId")) } }, head_repository: { id: Number(protectedConfig("githubRepositoryId")) },
        head_sha: 'a'.repeat(40), display_title: `Native development · rollback · full · - · native-123 · main · ${'a'.repeat(40)} · [manual]` };
    let clock = 400000;
    const dependencies = { cf: f.cf, store: f.store, readRun: async () => originalRun,
        inspectWorker: async (_cf, artifact) => { assert.deepEqual(artifact.before, f.prepared.previous.worker); return artifact.before; },
        inspectRuntime: f.input.inspectRuntime, probeRuntime: async () => ({ startupVerified: true }),
        verifyExecutor: async () => ({ restored: null, retained }), now: () => clock, wait: async (ms) => { clock += ms; } };
    f.cf.deployExistingVersion = f.cf.restoreConsumer = () => assert.fail('recovery cannot repeat provider mutation');
    return { ...f, env, dependencies, originalRun, ref, retained };
}
test('paused rollback recovery authenticates original evidence and resumes existing generation without provider restoration', async () => {
    const { recoverPausedDevelopmentRollback } = await import('./native-rollback-recovery.mjs');
    const f = await failedRollbackFixture();
    try {
        const originalJournal = f.db.prepare("SELECT payload FROM native_video_release_events WHERE release_id = 'native-456' AND stage = 'rollback-prepared'").get().payload;
        const result = await recoverPausedDevelopmentRollback(f.env, f.dependencies);
        assert.equal(result.releaseId, 'native-456');
        assert.equal(result.worker, undefined);
        assert.deepEqual(result.retainedPrintExecutor, f.retained);
        assert.equal(f.db.prepare('SELECT current_release_id FROM native_video_release_control').get().current_release_id, 'native-456');
        assert.equal(f.db.prepare('SELECT paused FROM native_video_release_control').get().paused, 0);
        assert.equal(f.db.prepare("SELECT payload FROM native_video_release_events WHERE release_id = 'native-456' AND stage = 'rollback-prepared'").get().payload, originalJournal);
        assert.equal(JSON.parse(f.objects.get('rollback-recovery-review.json')).recoverySourceCommit, f.env.GITHUB_SHA);
        assert.equal((await loadActiveDevelopmentRollbackArtifact(f.cf, f.store)).before.workerVersion, f.prepared.previous.worker.workerVersion);
        assert.equal(f.objects.has('qualification-receipt.json'), false);
        await assert.rejects(recoverPausedDevelopmentRollback({ ...f.env, GITHUB_RUN_ID: '790' }, f.dependencies), /pause ownership/u);
    }
    finally {
        f.db.close();
    }
});
test('recovery fails closed for substituted original evidence, incomplete restoration, version/resource drift and pause changes', async () => {
    const { recoverPausedDevelopmentRollback } = await import('./native-rollback-recovery.mjs');
    const mutations = [
        f => { f.originalRun.conclusion = 'success'; },
        f => { f.originalRun.head_sha = 'c'.repeat(40); },
        f => { f.originalRun.repository.id = 1; },
        f => { f.objects.set(f.ref.key, Buffer.from(JSON.stringify({ ...JSON.parse(f.objects.get(f.ref.key)), target: {} }))); },
        f => { const query = f.cf.query; f.cf.query = async (sql, params) => params?.[1] === 'rollback-startup-verified' ? [{ results: [] }] : query(sql, params); },
        f => { f.dependencies.inspectWorker = async () => ({ ...f.prepared.previous.worker, workerVersion: 'different' }); },
        f => { f.cf.consumers = async () => [{ type: 'worker', script: 'forever-tee-api-development', consumer_id: 'a'.repeat(32), settings: { max_concurrency: 1 } }]; },
        f => { f.dependencies.inspectRuntime = async () => ({ runtimeVerified: true, environment: 'development', renderer: {}, failure: {} }); },
        f => { f.dependencies.verifyExecutor = async () => { throw Error('executor namespace drift'); }; },
        f => { f.dependencies.probeRuntime = async () => { throw Error('startup failure'); }; },
        f => { f.db.exec("UPDATE native_video_release_control SET current_release_id = 'native-999'"); },
        f => {
            const inspect = f.dependencies.inspectWorker;
            f.dependencies.inspectWorker = async (...args) => {
                f.db.exec("UPDATE native_video_release_control SET release_id = 'native-999'");
                return inspect(...args);
            };
        },
    ];
    for (const mutate of mutations) {
        const f = await failedRollbackFixture();
        try {
            mutate(f);
            await assert.rejects(recoverPausedDevelopmentRollback(f.env, f.dependencies));
            assert.equal(f.db.prepare('SELECT paused FROM native_video_release_control').get().paused, 1);
            assert.equal(f.db.prepare("SELECT count(*) AS n FROM native_video_release_events WHERE release_id='native-456' AND stage='verified'").get().n, 0);
        }
        finally {
            f.db.close();
        }
    }
});


test("rollback rejects a historical Worker without owner media before pause or deployment", async () => {
    const { db, calls, input, objects } = await fixture();
    try {
        const artifact = JSON.parse(objects.get("previous-worker"));
        artifact.body = Buffer.from("historical public private-media reads").toString("base64");
        objects.set("previous-worker", Buffer.from(JSON.stringify(artifact)));
        await assert.rejects(executeDevelopmentRollback(input), /Worker rollback requires/);
        assert.deepEqual(calls, []);
        assert.equal(db.prepare("SELECT release_id FROM native_video_release_control").get().release_id, "native-123");
    } finally { db.close(); }
});

test("a source-map capability string cannot authorize rollback of executable code without owner media", async () => {
    const { db, calls, input, objects } = await fixture();
    try {
        const prior = JSON.parse(objects.get("previous-worker"));
        const code = Buffer.from("export default {}"), map = Buffer.from(JSON.stringify({ version: 3, file: "index.js", sources: ["src.ts"],
            sourcesContent: ['export const capability = "owner-artwork-media-v1"'], names: [], mappings: "" }));
        const artifact = { ...prior, ...await historicalWorkerUpload(prior.before, { code, map }) };
        objects.set("previous-worker", Buffer.from(JSON.stringify(artifact)));
        await assert.rejects(executeDevelopmentRollback(input), /Worker rollback requires/);
        assert.deepEqual(calls, []);
        assert.equal(db.prepare("SELECT release_id FROM native_video_release_control").get().release_id, "native-123");
    } finally { db.close(); }
});
