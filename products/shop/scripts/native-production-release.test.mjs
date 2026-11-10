import { protectedConfig } from "./protected-config.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { executeProductionPair, verifyProductionPairStatus, waitForProductionPairStatus, completeProductionRehearsal, rollbackProductionPair } from "./native-production-release.mjs";
import { workerContentManifest, workerContentResponse } from "./native-worker-content.mjs";
import { installPauseSchema } from "./native-release-pause.mjs";
import { versionResourcesDigest } from "./native-ci-worker.mjs";
import { NATIVE_PRODUCTION_QUEUE } from "./native-production-worker.mjs";
import { PRODUCTION_DB } from "./native-production-cloudflare.mjs";
import { PRODUCTION_IMAGE_DIGEST, PRODUCTION_SOURCE_DIGEST } from "./native-production-runtime.mjs";

test("Production rollback admits V3 map formatting while preserving historical and immutable checks", async t => {
    for (const example of [
        { name: "V3 reformatted map", schemaVersion: 3, formatting: true, allowed: true },
        { name: "V3 changed map data", schemaVersion: 3, changedMap: true, error: /complete source map data/ },
        { name: "V3 changed executable", schemaVersion: 3, changedCode: true, error: /code bytes/ },
        { name: "V3 changed version resources", schemaVersion: 3, changedResources: true, error: /fallback code\/resources/ },
        { name: "V3 changed immutable raw map", schemaVersion: 3, changedArtifact: true, error: /immutable raw artifact/ },
        { name: "V2 exact decimal map", schemaVersion: 2, decimal: true, allowed: true },
        { name: "V2 reformatted map", schemaVersion: 2, formatting: true, error: /complete content/ },
    ]) await t.test(example.name, async () => {
        const db = new DatabaseSync(":memory:");
        try {
            db.exec("CREATE TABLE story_video_jobs (id TEXT NOT NULL, status TEXT NOT NULL, attempt_count INTEGER NOT NULL DEFAULT 0)");
            const writes = [];
            const resources = { bindings: [], script_runtime: {} };
            const cf = { query: async (sql, params = []) => {
                const statement = db.prepare(sql);
                if (statement.columns().length) return [{ results: statement.all(...params).map(row => ({ ...row })) }];
                writes.push(sql);
                return [{ results: [], meta: statement.run(...params) }];
            }, version: async () => ({ resources: example.changedResources ? { ...resources, bindings: [{ name: "changed" }] } : resources }) };
            await installPauseSchema(cf);
            writes.length = 0;
            const code = Buffer.from('const capability = "owner-artwork-media-v1"; export default {};\n//# sourceMappingURL=index.js.map\n');
            const value = { version: 3, file: "index.js", sources: ["fixture.ts"], sourcesContent: ["export default {}"], names: [], mappings: "", ...(example.decimal ? { extension: 0.5 } : {}) };
            const map = Buffer.from(JSON.stringify(value));
            const formatted = Buffer.from(JSON.stringify(Object.fromEntries(Object.entries(value).reverse()), null, 2));
            const options = { sourceMapData: example.schemaVersion === 3 };
            const content = await workerContentManifest(workerContentResponse({ code, map }), options);
            const review = { schemaVersion: example.schemaVersion, content, bundleSha256: content.modules[0].sha256, bundleBytes: code.length };
            const observed = await workerContentManifest(workerContentResponse({
                code: example.changedCode ? Buffer.from(code.toString().replace("export default {}", "export default { changed: true }")) : code,
                map: example.changedMap ? Buffer.from(JSON.stringify({ ...value, mappings: "AAAA" })) : example.formatting ? formatted : map,
            }), options);
            const fallback = { provider: "cloudflare", workerVersion: "11111111-1111-4111-8111-111111111111", workerBytesVerified: true,
                content: observed, versionResourcesSha256: versionResourcesDigest({ resources }) };
            const previous = { workerVersion: "22222222-2222-4222-8222-222222222222" };
            const artifacts = { candidateArtifact: { key: "code" }, candidateMapArtifact: { key: "map" }, previousArtifact: { key: "previous" } };
            const prepared = { environment: "production", releaseId: "native-200", worker: review, artifacts, previous: { worker: previous } };
            const objects = new Map([["code", code], ["map", example.changedArtifact ? formatted : map],
                ["prepared", Buffer.from(JSON.stringify(prepared))], ["previous", Buffer.from(JSON.stringify({ before: previous }))],
                ["fallback", Buffer.from(JSON.stringify(fallback))]]);
            for (const [stage, payload] of [["prepared", { ...prepared, preparation: { key: "prepared" } }], ["fallback-verified", { fallback, artifact: { key: "fallback" } }]])
                db.prepare("INSERT INTO native_video_release_events(release_id, stage, payload, created_at) VALUES(?,?,?,?)").run(prepared.releaseId, stage, JSON.stringify(payload), 1);
            let runtimeReads = 0;
            const dependencies = { aws: async () => ({ call: async () => { runtimeReads++; throw Error("synthetic runtime read boundary"); } }),
                cloudflare: () => cf, releaseStore: async () => ({ read: async reference => {
                    assert.ok(objects.has(reference.key)); return objects.get(reference.key);
                } }) };
            await assert.rejects(rollbackProductionPair({ NATIVE_OPERATION: "rollback", NATIVE_ROLLBACK_RELEASE: prepared.releaseId, GITHUB_RUN_ID: "300" }, dependencies),
                example.allowed ? /synthetic runtime read boundary/ : example.error);
            assert.equal(runtimeReads, example.allowed ? 1 : 0);
            assert.deepEqual(writes, []);
        } finally { db.close(); }
    });
});

function fixture(failNative = false, interruptRehearsal = false, monitoringChanged = false, withPrintExecutor = false, failPrintVerification = false) {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE story_video_jobs (id TEXT NOT NULL, status TEXT NOT NULL, attempt_count INTEGER NOT NULL DEFAULT 0)");
    let clock = 1000, active, latest, consumer, cron;
    const calls = [], files = new Map();
    const shared = [{ name: "DB", type: "d1", id: PRODUCTION_DB },
        { name: "DESIGN_ARTWORK", type: "r2_bucket", bucket_name: "forever-tee-design-artwork-production" },
        { name: "STORY_VIDEO_JOBS", type: "queue", queue_name: "forever-tee-story-video-production" },
        { name: "STORY_VIDEOS", type: "r2_bucket", bucket_name: "forever-tee-story-videos-production" },
        { name: "STORY_VIDEO_NOTIFICATIONS", type: "durable_object_namespace" },
        ...["BENT_SHIRT_OPERATIONS_SECRET", "FOREVER_TEE_API_SHARED_SECRET", "STORY_VIDEO_LAMBDA_ACCESS_KEY_ID", "STORY_VIDEO_LAMBDA_SECRET_ACCESS_KEY", "STORY_VIDEO_GRANT_SECRET", "CART_LINE_CAPABILITY_SECRET", "OPENAI_API_KEY", "PRINTIFY_ASSET_DELIVERY_SECRET", "PRINTIFY_WEBHOOK_SECRET"].map(name => ({ name, type: "secret_text" }))];
    const printExecutor = { releaseId: "native-1234", sourceCommit: "a".repeat(40), namespaceId: "e".repeat(32) };
    if (withPrintExecutor)
        shared.push({ name: "PRINT_EXECUTION_MODE", type: "plain_text", text: "durable-object" }, { name: "PRINT_EXECUTIONS", type: "durable_object_namespace", namespace_id: printExecutor.namespaceId,
            class_name: "PrintAssetExecution", script_name: "forever-tee-print-executor-production" });
    const settings = provider => ({ bindings: [...shared, { name: "STORY_VIDEO_PROVIDER", type: "plain_text", text: provider }] });
    const versions = new Map();
    for (const [id, provider] of [["11111111-1111-4111-8111-111111111111", "cloudflare"], ["22222222-2222-4222-8222-222222222222", "lambda"]]) {
        const version = { id, resources: settings(provider) };
        versions.set(id, { version, record: { workerVersion: id, versionResourcesSha256: versionResourcesDigest(version), workerBytesVerified: true, provider, ...(withPrintExecutor ? { printExecutor } : {}),
                consumer: { consumerId: "a".repeat(32), settings: provider === "lambda" ? NATIVE_PRODUCTION_QUEUE : { ...NATIVE_PRODUCTION_QUEUE, max_concurrency: 1, max_retries: 2 } },
                cron: provider === "lambda" ? "* * * * *" : "*/15 * * * *" } });
    }
    const cf = {
        query: async (sql, params = []) => {
            const statement = db.prepare(sql);
            if (sql.trim().startsWith("SELECT"))
                return [{ results: statement.all(...params), success: true }];
            const result = statement.run(...params);
            return [{ results: [], meta: { changes: result.changes }, success: true }];
        },
        deployments: async () => ({ deployments: [{ versions: [{ version_id: active, percentage: 100 }] }] }),
        version: async (id) => versions.get(id).version,
        // Cloudflare script settings describe the latest uploaded version, even
        // when a historical fallback is active. Real Production exposed this seam.
        settings: async () => settings(versions.get(latest).record.provider),
        consumers: async () => [{ consumer_id: consumer.consumerId, settings: consumer.settings, type: "worker", script_name: "forever-tee-api" }],
        schedules: async () => {
            if (interruptRehearsal && active !== latest) {
                interruptRehearsal = false;
                throw Error("interrupted fallback verification");
            }
            return { schedules: [{ cron }] };
        },
        deployExistingVersion: async (id) => { assert.equal(db.prepare("SELECT paused FROM native_video_release_control").get().paused, 1); calls.push(`switch:${versions.get(id).record.provider}`); active = id; },
        restoreConsumer: async (id, value) => { consumer = { consumerId: id, settings: value }; }, setSchedule: async (value) => { cron = value; },
    };
    const store = { save: async (name, bytes) => { assert.equal(files.has(name), false); files.set(name, bytes); return { name }; }, read: async (ref) => files.get(ref.name) };
    const worker = { review: { sourceCommit: "a".repeat(40), bundleSha256: "b".repeat(64) }, settings: settings("cloudflare"), variables: { STORY_VIDEO_PROVIDER: "lambda" }, secretNames: ["CART_LINE_CAPABILITY_SECRET", "OPENAI_API_KEY", "PRINTIFY_ASSET_DELIVERY_SECRET", "PRINTIFY_WEBHOOK_SECRET"],
        verifyPrevious: async () => { calls.push("previous"); }, migrate: async () => { calls.push("migrate"); },
        deploy: async (provider) => {
            calls.push(`deploy:${provider}`);
            if (failNative && provider === "lambda")
                throw Error("unconfirmed deployment");
            const item = [...versions.values()].find(value => value.record.provider === provider);
            active = item.version.id;
            latest = active;
            consumer = item.record.consumer;
            cron = item.record.cron;
            return item.record;
        } };
    if (withPrintExecutor) {
        worker.review.printExecutor = { releaseId: printExecutor.releaseId };
        worker.variables.PRINT_EXECUTION_MODE = "durable-object";
        worker.deployPrintExecutor = async () => {
            assert.equal(db.prepare("SELECT paused FROM native_video_release_control").get().paused, 1);
            calls.push("deploy:print");
            return printExecutor;
        };
        worker.verifyPrintExecutor = async () => {
            calls.push("verify:print");
            if (failPrintVerification)
                throw Error("print executor changed");
            return printExecutor;
        };
    }
    const runtime = { runtimeVerified: true };
    const image = { review: { imagePlanVerified: true, updateCount: 2 }, verifyBefore: async () => runtime,
        apply: async () => { calls.push("image"); return { applied: true, runtime }; } };
    const monitoringBaseline = { breaches: 20, breachCohortSha256: "c".repeat(64) };
    const prepared = { environment: "production", accountId: protectedConfig("awsAccountId"), region: "ap-southeast-2", releaseId: "native-1234", sourceCommit: "a".repeat(40),
        candidate: { imageDigest: PRODUCTION_IMAGE_DIGEST, sourceDigest: PRODUCTION_SOURCE_DIGEST }, worker: worker.review, image: image.review,
        imagePlanArtifact: {}, planSha256: createHash("sha256").update(JSON.stringify({ worker: worker.review, image: image.review })).digest("hex"),
        runtime, monitoringBaseline };
    const hooks = { runtime: async () => runtime,
        status: async () => { calls.push("status"); assert.equal(versions.get(active).record.provider, "lambda"); return { protocolVerified: true }; },
        monitor: async () => ({ monitoringVerified: true, breaches: 20, breachCohortSha256: monitoringChanged ? "d".repeat(64) : "c".repeat(64),
            pauseOverdue: false, evidence: {} }) };
    return { db, calls, run: () => executeProductionPair({ cf, store, prepared, image, worker, ...hooks, wait: async (ms) => { clock += ms; }, now: () => clock }),
        recover: () => completeProductionRehearsal({ cf, prepared, variables: worker.variables, previousSettings: worker.settings, ...hooks,
            native: [...versions.values()].find(value => value.record.provider === "lambda").record,
            fallback: [...versions.values()].find(value => value.record.provider === "cloudflare").record }) };
}
test("real SQLite admission triggers stay closed through compatible fallback, native release and rollback rehearsal", async () => {
    const { db, calls, run } = fixture();
    try {
        const result = await run();
        assert.equal(result.rollbackRehearsed, true);
        assert.deepEqual(result.monitoringBaseline, { breaches: 20, breachCohortSha256: "c".repeat(64) });
        assert.deepEqual(calls.filter(value => /image|migrate|deploy:|switch:/.test(value)), ["image", "migrate", "deploy:cloudflare", "deploy:lambda", "switch:cloudflare", "switch:lambda"]);
        assert.equal(db.prepare("SELECT COUNT(*) AS count FROM story_video_jobs").get().count, 0);
        assert.equal(db.prepare("SELECT paused FROM native_video_release_control").get().paused, 0);
        assert.equal(db.prepare("SELECT COUNT(*) AS count FROM native_video_release_events WHERE stage='rollback-rehearsed'").get().count, 1);
    }
    finally {
        db.close();
    }
});
test("a changed historical breach cohort retains the pause instead of rewriting failed jobs", async () => {
    const { db, run } = fixture(false, false, true);
    try {
        await assert.rejects(run(), /pre-existing breach cohort changed/);
        assert.equal(db.prepare("SELECT paused FROM native_video_release_control").get().paused, 1);
        assert.equal(db.prepare("SELECT COUNT(*) AS count FROM story_video_jobs").get().count, 0);
    }
    finally {
        db.close();
    }
});
test("unconfirmed native deployment retains pause and the already preserved compatible fallback", async () => {
    const { db, calls, run } = fixture(true);
    try {
        await assert.rejects(run(), /unconfirmed deployment/);
        assert.equal(db.prepare("SELECT paused FROM native_video_release_control").get().paused, 1);
        assert.equal(db.prepare("SELECT COUNT(*) AS count FROM native_video_release_events WHERE stage='fallback-verified'").get().count, 1);
        assert.ok(!calls.includes("switch:lambda"));
    }
    finally {
        db.close();
    }
});
test("interrupted rehearsal resumes with preserved versions and no migration, upload or secret replay", async () => {
    const { db, calls, run, recover } = fixture(false, true);
    try {
        await assert.rejects(run(), /interrupted fallback/);
        assert.equal(db.prepare("SELECT paused FROM native_video_release_control").get().paused, 1);
        assert.equal(db.prepare("SELECT COUNT(*) AS count FROM native_video_release_events WHERE stage='native-verified'").get().count, 1);
        const before = calls.length;
        assert.equal((await recover()).rollbackRehearsed, true);
        assert.deepEqual(calls.slice(before).filter(value => /migrate|secrets|deploy:|switch:/.test(value)), ["switch:cloudflare", "switch:lambda"]);
        assert.equal(db.prepare("SELECT paused FROM native_video_release_control").get().paused, 0);
    }
    finally {
        db.close();
    }
});
test("live protocol verification rejects the wrong environment, image, pause owner or incomplete response", async () => {
    const value = { executionProtocol: "claim-v1", rendererVersion: "story-video-renderer-v7", releaseId: "native-1234", sourceCommit: "a".repeat(40),
        imageDigest: PRODUCTION_IMAGE_DIGEST, sourceDigest: PRODUCTION_SOURCE_DIGEST, environment: "production",
        functionArn: "arn:aws:lambda:ap-southeast-2:" + protectedConfig("awsAccountId") + ":function:forever-tee-video-production", paused: true, pauseOwner: "native-1234" };
    const env = { BENT_SHIRT_OPERATIONS_SECRET: "fixture" };
    assert.equal((await verifyProductionPairStatus(env, "native-1234", "a".repeat(40), true, async () => Response.json(value))).protocolVerified, true);
    for (const changed of [{ environment: "development" }, { imageDigest: "other" }, { paused: false }, { pauseOwner: "other" }])
        await assert.rejects(verifyProductionPairStatus(env, "native-1234", "a".repeat(40), true, async () => Response.json({ ...value, ...changed })));
});
test("live protocol verification tolerates only bounded read-after-deploy propagation", async () => {
    const value = { executionProtocol: "claim-v1", rendererVersion: "story-video-renderer-v7", releaseId: "native-1234", sourceCommit: "a".repeat(40),
        imageDigest: PRODUCTION_IMAGE_DIGEST, sourceDigest: PRODUCTION_SOURCE_DIGEST, environment: "production",
        functionArn: "arn:aws:lambda:ap-southeast-2:" + protectedConfig("awsAccountId") + ":function:forever-tee-video-production", paused: true, pauseOwner: "native-1234" };
    let reads = 0, waits = 0;
    const result = await waitForProductionPairStatus({ BENT_SHIRT_OPERATIONS_SECRET: "fixture" }, "native-1234", "a".repeat(40), true, {
        request: async () => Response.json(reads++ === 0 ? { ...value, releaseId: "native-old" } : value),
        delay: async (milliseconds) => { waits++; assert.equal(milliseconds, 10); }, attempts: 2, intervalMs: 10,
    });
    assert.equal(result.protocolVerified, true);
    assert.equal(reads, 2);
    assert.equal(waits, 1);
    await assert.rejects(waitForProductionPairStatus({}, "native-1234", "a".repeat(40), true, {
        request: async () => Response.json(value), delay: async () => assert.fail("credential failures are not retried"), attempts: 2, intervalMs: 0,
    }), /operations credential/);
    await assert.rejects(waitForProductionPairStatus({ BENT_SHIRT_OPERATIONS_SECRET: "fixture" }, "native-1234", "a".repeat(40), true, {
        request: async () => new Response(null, { status: 503 }), delay: async () => assert.fail("HTTP failures are not retried"), attempts: 2, intervalMs: 0,
    }), /live Worker protocol response/);
});
test("Production authorizes the same print generation only after both video-provider versions are rehearsed", async () => {
    const { db, calls, run } = fixture(false, false, false, true);
    try {
        const result = await run();
        assert.equal(result.worker.printExecutor.releaseId, "native-1234");
        assert.ok(calls.indexOf("deploy:print") < calls.indexOf("deploy:cloudflare"));
        assert.equal(calls.filter(call => call === "verify:print").length, 2);
        const row = db.prepare("SELECT json_extract(payload, '$.worker.printExecutor.releaseId') AS generation FROM native_video_release_events WHERE stage='verified'").get();
        assert.equal(row.generation, "native-1234");
        assert.equal(db.prepare("SELECT paused FROM native_video_release_control").get().paused, 0);
    }
    finally {
        db.close();
    }
});
test("executor drift keeps Production admission paused before rollback rehearsal", async () => {
    const { db, calls, run } = fixture(false, false, false, true, true);
    try {
        await assert.rejects(run(), /print executor changed/);
        assert.equal(db.prepare("SELECT paused FROM native_video_release_control").get().paused, 1);
        assert.equal(db.prepare("SELECT count(*) AS count FROM native_video_release_events WHERE stage='verified'").get().count, 0);
        assert.ok(!calls.includes("switch:cloudflare"));
    }
    finally {
        db.close();
    }
});
test('quiet drain retains active work and pause ownership without expiring any attempt', async () => {
    const { waitUnchangedRendererDrain } = await import('./native-production-drain.mjs');
    const db = new DatabaseSync(':memory:');
    let clock = 1000;
    db.exec("CREATE TABLE native_video_release_control(singleton INTEGER,paused INTEGER,release_id TEXT,paused_at INTEGER); INSERT INTO native_video_release_control VALUES(1,1,'native-100',1000); CREATE TABLE story_video_jobs(id TEXT,status TEXT); INSERT INTO story_video_jobs VALUES('active','rendering');");
    const cf = { query: async (sql, params = []) => [{ results: db.prepare(sql).all(...params).map(row => ({ ...row })) }] };
    const proof = { kind: 'reuse-live-image-v1', updateCount: 0, drainPolicy: 'unchanged-render-handlers-v1', renderingInputsDigest: 'a'.repeat(64) };
    try {
        await assert.rejects(waitUnchangedRendererDrain(cf, 'native-100', () => { }, {}, () => clock), /preparation/);
        const result = await waitUnchangedRendererDrain(cf, 'native-100', async (ms) => {
            clock += ms;
            if (clock >= 91000)
                db.exec("UPDATE story_video_jobs SET status='ready'");
        }, proof, () => clock);
        assert.equal(result.quietMs, 60000);
        assert.equal(clock, 151000);
        assert.equal(db.prepare("SELECT status FROM story_video_jobs").get().status, 'ready');
        assert.equal(db.prepare("SELECT paused FROM native_video_release_control").get().paused, 1);
        db.exec("UPDATE native_video_release_control SET release_id='native-200'");
        await assert.rejects(waitUnchangedRendererDrain(cf, 'native-100', () => { }, proof, () => clock), /ownership/);
    }
    finally {
        db.close();
    }
});
