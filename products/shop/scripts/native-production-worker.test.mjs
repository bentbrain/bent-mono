import { resolveProtectedTemplate } from "./protected-config.mjs";
import { protectedConfig } from "./protected-config.mjs";
import { PREVIOUS_PRODUCTION_IMAGE_DIGEST, PREVIOUS_PRODUCTION_SOURCE_DIGEST } from "./native-production-runtime.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { classifyProductionBaseline, loadRecordedProductionWorkerBaseline, productionReleaseConfig, verifyProductionReleaseSettings, FALLBACK_PRODUCTION_QUEUE, NATIVE_PRODUCTION_QUEUE } from "./native-production-worker.mjs";
import { productionCloudflare, inspectProductionConsumer, PRODUCTION_DB } from "./native-production-cloudflare.mjs";
import { waitProductionNaturalDrain } from "./native-production-drain.mjs";
import { backfillProductColors, createLegacyProducts, createMissingVideoJobs } from "./native-production-product-sweep.mjs";
import { versionResourcesDigest, workerContentManifest } from "./native-ci-worker.mjs";
const env = { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "bentbrain/bent-mono", GITHUB_REPOSITORY_ID: protectedConfig("githubRepositoryId"), GITHUB_REPOSITORY_OWNER_ID: protectedConfig("githubOwnerId"),
    GITHUB_REF: "refs/heads/main", GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_RUN_ATTEMPT: "1", GITHUB_SHA: "a".repeat(40), GITHUB_RUN_ID: "1234",
    GITHUB_WORKFLOW_REF: "bentbrain/bent-mono/.github/workflows/native-production.yml@refs/heads/main", NATIVE_OPERATION: "prepare-worker",
    CLOUDFLARE_ACCOUNT_ID: protectedConfig("cloudflareAccountId"), WORKER_URL: "https://forever-tee-api.socialqueue.workers.dev", CLOUDFLARE_API_TOKEN: "fixture" };
const productionOrigin = "https://forever-tee-api.socialqueue.workers.dev";
test("Development and Production attach release secrets only to the atomic Worker deployment", async () => {
    for (const path of ["./native-ci-worker.mjs", "./native-production-worker.mjs"]) {
        const source = await readFile(new URL(path, import.meta.url), "utf8");
        assert.match(source, /"--secrets-file", secretsPath/);
        assert.doesNotMatch(source, /installSecrets|\.setSecret\(/);
    }
    for (const path of ["./native-ci-cloudflare.mjs", "./native-production-cloudflare.mjs"]) {
        const source = await readFile(new URL(path, import.meta.url), "utf8");
        assert.doesNotMatch(source, /workers\/scripts\/\$\{WORKER\}\/secrets/);
    }
    const workflow = await readFile(new URL("../.github/workflows/native-production.yml", import.meta.url), "utf8");
    assert.match(workflow, /OPENAI_API_KEY: \$\{\{ secrets\.OPENAI_API_KEY \}\}/);
    assert.equal(workflow.split("\n").filter((line) => line.includes("OPENAI_API_KEY")).length, 1);
});
test("cloud Worker configuration changes only reviewed Production video bindings and preserves other settings", async () => {
    const source = resolveProtectedTemplate(await readFile(new URL("../workers/api/wrangler.jsonc", import.meta.url), "utf8"));
    const config = productionReleaseConfig(source, "native-1234", "a".repeat(40), productionOrigin);
    const original = JSON.parse(resolveProtectedTemplate(source).replace(/^\s*\/\/.*$/gm, "")).env.production;
    assert.equal(config.name, "forever-tee-api");
    assert.equal(config.d1_databases[0].database_id, PRODUCTION_DB);
    assert.equal(config.vars.DAILY_PAID_OPERATION_BUDGET, undefined);
    assert.equal(config.vars.DAILY_OWNER_PAID_OPERATION_BUDGET, undefined);
    assert.deepEqual(config.services, original.services);
    assert.deepEqual(config.ratelimits, original.ratelimits);
    assert.deepEqual(config.images, original.images);
    assert.deepEqual(config.r2_buckets.map(item => item.bucket_name), ["forever-tee-design-artwork-production", "forever-tee-story-videos-production"]);
    assert.equal(config.vars.STORY_VIDEO_ENVIRONMENT, "production");
    assert.equal(config.queues.consumers[0].max_retries, 100);
    assert.equal(config.vars.PRINTIFY_ASSET_ORIGIN, productionOrigin);
    assert.equal(config.queues.consumers[0].max_concurrency, 2);
    assert.deepEqual(config.triggers.crons, ["* * * * *"]);
    assert.equal(config.queues.consumers[1].max_concurrency, 5);
    assert.throws(() => productionReleaseConfig(source.replaceAll('"max_concurrency": 5', '"max_concurrency": 16'), "native-1234", "a".repeat(40), productionOrigin));
    assert.throws(() => productionReleaseConfig(source.replaceAll(PRODUCTION_DB, "wrong"), "native-1234", "a".repeat(40), productionOrigin));
    assert.throws(() => productionReleaseConfig(source, "unbound", "a".repeat(40), productionOrigin));
    assert.throws(() => productionReleaseConfig(source, "native-1234", "a".repeat(40), "https://other.invalid"));
});
test("Production preparation cannot write D1 or queue settings and never targets Development", async () => {
    const calls = [], cf = productionCloudflare(env, async (url, options) => {
        calls.push(url);
        assert.ok(url.startsWith("https://api.cloudflare.com/client/v4/accounts/" + protectedConfig("cloudflareAccountId") + "/"));
        assert.equal(options.redirect, "error");
        assert.equal(options.headers.Authorization, "Bearer fixture");
        return Response.json({ success: true, result: [{ success: true, results: [] }] });
    });
    await cf.query("SELECT name FROM d1_migrations ORDER BY name");
    assert.ok(calls[0].includes(PRODUCTION_DB));
    for (const sql of ["DELETE FROM story_video_jobs", "UPDATE story_video_jobs SET status='queued'", "SELECT 1; DELETE FROM story_video_jobs"])
        await assert.rejects(cf.query(sql));
    assert.equal(cf.setSecret, undefined);
    assert.throws(() => cf.restoreConsumer("a".repeat(32), { ...NATIVE_PRODUCTION_QUEUE, max_concurrency: 1 }));
    assert.equal(calls.length, 1);
    assert.throws(() => productionCloudflare({ ...env, WORKER_URL: "https://forever-tee-api-development.socialqueue.workers.dev" }));
});
test("Production release exposes no standalone Worker secret or historical-job mutation", () => {
    const cf = productionCloudflare({ ...env, NATIVE_OPERATION: "release" }, async () => Response.json({ success: true, result: {} }));
    assert.equal(cf.setSecret, undefined);
    assert.equal(cf.enqueueRecoveryRevision, undefined);
});
test("creation recovery dispatch permits only its sealed fallback version, queue and schedule", async () => {
    const calls = [], recoveryEnv = { ...env, NATIVE_OPERATION: "recover-release", NATIVE_VERIFY_RELEASE: "native-" + protectedConfig("resource_0c384d07e61b") };
    const request = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return Response.json({ success: true, result: {} }); };
    const cf = productionCloudflare(recoveryEnv, request);
    await cf.deployExistingVersion(protectedConfig("resource_85e4b96e18fd"));
    await cf.restoreConsumer(protectedConfig("resource_64de39452cce"), FALLBACK_PRODUCTION_QUEUE);
    await cf.setSchedule("*/15 * * * *");
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[0].body.versions, [{ version_id: protectedConfig("resource_85e4b96e18fd"), percentage: 100 }]);
    assert.throws(() => cf.deployExistingVersion(protectedConfig("resource_0ea872585018")));
    assert.throws(() => cf.restoreConsumer("a".repeat(32), FALLBACK_PRODUCTION_QUEUE));
    assert.throws(() => cf.restoreConsumer(protectedConfig("resource_64de39452cce"), NATIVE_PRODUCTION_QUEUE));
    assert.throws(() => cf.setSchedule("* * * * *"));
    const other = productionCloudflare({ ...recoveryEnv, NATIVE_VERIFY_RELEASE: "native-999" }, request);
    assert.throws(() => other.deployExistingVersion(protectedConfig("resource_85e4b96e18fd")));
    assert.equal(calls.length, 3);
});
test("Featured Design recovery permits only its exact reviewed publication and objects", async () => {
    const requests = [];
    const cf = productionCloudflare({ ...env, NATIVE_OPERATION: "repair-featured-videos" }, async (url, init) => {
        requests.push({ url, init });
        return Response.json({ success: true, result: [{ success: true, meta: { changes: 4 } }] });
    });
    await assert.rejects(cf.query("DELETE FROM story_video_jobs"), /reviewed statements/);
    await cf.query(`UPDATE story_video_jobs SET status='ready', output_byte_size=?, last_error=NULL, execution_id=NULL,
    updated_at=?, rendered_at=?
    WHERE id=? AND renderer_version=? AND status='failed' AND attempt_count=3 AND last_error=?
      AND design_revision_id=? AND product_id=?`, [123, 1, 1, "job", "story-video-renderer-v7", "known", "revision", "shirt"]);
    assert.equal(requests.length, 1);
    assert.match(requests[0].url, /\/d1\/database\//);
    assert.equal(cf.enqueueFeaturedRecoveryRevision, undefined);
    await assert.rejects(cf.featuredArtwork("designs/other/artwork"), /exact Featured Design artwork/);
    await cf.featuredArtwork("designs/" + "c2bf0318-784a-4dda-b82b-9534aed42903" + "/artwork/" + protectedConfig("resource_73e91e639e8e"));
    assert.match(requests[1].url, /\/r2\/buckets\/forever-tee-design-artwork-production\/objects\/designs\/c2bf0318/);
    assert.equal(requests[1].init.method, "GET");
    await assert.rejects(cf.featuredVideo("story-videos/v7/other/video.mp4"), /exact Featured Design video/);
    const videoKey = "story-videos/v7/" + "c2bf0318-784a-4dda-b82b-9534aed42903" + "/" + "d2dd07c1-dbbf-4d1a-8df7-9c43b4a7dfc4" + "/black.mp4";
    await cf.featuredVideo(videoKey, Buffer.from("video"));
    assert.match(requests[2].url, /\/r2\/buckets\/forever-tee-story-videos-production\/objects\/story-videos\/v7\/c2bf0318/);
    assert.equal(requests[2].init.method, "PUT");
});
test("Product sweep permits only its bounded ledger repairs, artwork reads and queue deliveries", async () => {
    const writes = [];
    const artwork = Buffer.from("artwork"), digest = createHash("sha256").update(artwork).digest("hex");
    const capture = { productSweepArtwork: async () => new Response(artwork), query: async (sql, params) => {
            writes.push({ sql, params });
            return [{ meta: { changes: 1 } }];
        } };
    await backfillProductColors(capture, [{ id: "11111111-1111-4111-8111-111111111111", owner_id: "a".repeat(64),
            artwork_key: `designs/11111111-1111-4111-8111-111111111111/artwork/${digest}`, byte_size: artwork.length, sha256: digest }], { OPENAI_API_KEY: "secret" }, { preparePreview: async () => Buffer.from("preview"), analyze: async () => ({ color: "Black", model: "model-v1" }) });
    await createLegacyProducts(capture, [{ id: "11111111-1111-4111-8111-111111111111", placement_x: 0.39,
            placement_y: 0.43, placement_width: 0.22, depth: 5 }], { now: () => 1, uuid: () => "22222222-2222-4222-8222-222222222222" });
    await createMissingVideoJobs(capture, [{ id: "22222222-2222-4222-8222-222222222222",
            design_revision_id: "33333333-3333-4333-8333-333333333333", base_product_id: "97b629d7-1d3b-4d2a-a586-537168141e97", colours: "" }], { now: () => 1, uuid: () => "44444444-4444-4444-8444-444444444444" });
    const requests = [];
    const cf = productionCloudflare({ ...env, NATIVE_OPERATION: "sweep-products" }, async (url, init) => {
        requests.push({ url, init });
        return Response.json({ success: true, result: [{ success: true, meta: { changes: 1 } }] });
    });
    for (const write of writes)
        await cf.query(write.sql, write.params);
    await cf.query(`UPDATE products SET default_color=(SELECT designs.default_product_color FROM designs WHERE designs.id=products.design_id)
    WHERE status='active' AND design_id IS NOT NULL
      AND default_color<>(SELECT designs.default_product_color FROM designs WHERE designs.id=products.design_id)`);
    await cf.query(`UPDATE story_video_jobs SET status='queued', attempt_count=0,
    last_error='PRODUCT_SWEEP_RETRY', execution_id=NULL, updated_at=?
    WHERE renderer_version=? AND status='failed' AND attempt_count>=3
      AND EXISTS (SELECT 1 FROM products WHERE products.id=story_video_jobs.product_id
        AND products.status='active' AND products.design_revision_id=story_video_jobs.design_revision_id)`, [1, "story-video-renderer-v7"]);
    await cf.query(`UPDATE story_video_jobs SET id=?, status='queued', attempt_count=0,
    last_error='PRODUCT_SWEEP_ID_REPAIR', execution_id=NULL, updated_at=?
    WHERE id=? AND renderer_version=? AND status='failed' AND attempt_count=3
      AND last_error='Invalid render grant.' AND length(id)=39 AND substr(id,37,3)='-v7'`, ["55555555-5555-4555-8555-555555555555", 1, "44444444-4444-4444-8444-444444444444-v7", "story-video-renderer-v7"]);
    await assert.rejects(cf.query("UPDATE story_video_jobs SET id=? WHERE id=?", ["new", "old"]), /reviewed statements/);
    await assert.rejects(cf.query("UPDATE products SET status='deleted'"), /reviewed statements/);
    await cf.productSweepArtwork("designs/11111111-1111-4111-8111-111111111111/artwork");
    await cf.productSweepArtwork(`designs/11111111-1111-4111-8111-111111111111/artwork/${digest}`);
    await cf.productSweepArtwork("designs/11111111-1111-4111-8111-111111111111/native-production-canary.png");
    await assert.rejects(cf.productSweepArtwork("designs/11111111-1111-4111-8111-111111111111/private"), /bounded/);
    await cf.productSweepDelivery("33333333-3333-4333-8333-333333333333");
    assert.equal(requests.filter(({ url }) => url.includes(`/d1/database/${PRODUCTION_DB}/query`)).length, writes.length + 3);
    assert.ok(requests.at(-1).url.endsWith("/messages"));
});
test("Featured Design recovery alone installs its required local encoder", async () => {
    const workflow = await readFile(new URL("../.github/workflows/native-production.yml", import.meta.url), "utf8");
    assert.match(workflow, /name: Install the Featured Design repair encoder\n\s+if: inputs\.operation == 'repair-featured-videos'\n\s+run: sudo apt-get update --quiet && sudo apt-get install --yes --no-install-recommends ffmpeg/);
    assert.equal(workflow.match(/apt-get install/g)?.length, 1);
});
test("Production drain uses only natural completion and never rewrites attempts", async () => {
    let now = 1000, count = 1;
    const statements = [];
    const cf = { query: async (sql) => {
            statements.push(sql);
            assert.ok(sql.startsWith("SELECT "));
            if (sql.includes("story_video_jobs"))
                assert.match(sql, /WHERE status = 'rendering'$/);
            return [{ results: sql.includes("release_control") ? [{ paused: 1, release_id: "native-1234", paused_at: 1000 }] : [{ count }] }];
        } };
    const result = await waitProductionNaturalDrain(cf, "native-1234", async (delay) => { now += delay; if (now >= 31000)
        count = 0; }, () => now);
    assert.equal(result.naturalDrainVerified, true);
    assert.ok(result.quietMs >= 60000);
    assert.ok(now >= 301000);
    now = 1000;
    count = 1;
    await assert.rejects(waitProductionNaturalDrain(cf, "native-1234", async (delay) => { now += delay; }, () => now), /admissions remain paused/);
    assert.ok(!statements.some(sql => /UPDATE|DELETE/.test(sql)));
});
test("live settings allow only the reviewed creation burst limits and reject unrelated changes", () => {
    const bindings = [
        { name: "DB", type: "d1", id: PRODUCTION_DB }, { name: "DESIGN_ARTWORK", type: "r2_bucket", bucket_name: "forever-tee-design-artwork-production" },
        { name: "STORY_VIDEO_JOBS", type: "queue", queue_name: "forever-tee-story-video-production" },
        ...["BENT_SHIRT_OPERATIONS_SECRET", "FOREVER_TEE_API_SHARED_SECRET"].map(name => ({ name, type: "secret_text" }))
    ];
    bindings.push({ name: "OWNER_MUTATION_RATE_LIMIT", type: "ratelimit", namespace_id: "3101", simple: { limit: 60, period: 60 } }, { name: "IMAGE_PROCESS_RATE_LIMIT", type: "ratelimit", namespace_id: "3102", simple: { limit: 6, period: 60 } });
    const previous = { bindings: structuredClone(bindings) };
    bindings.find(item => item.name === "OWNER_MUTATION_RATE_LIMIT").simple.limit = 600;
    bindings.find(item => item.name === "IMAGE_PROCESS_RATE_LIMIT").simple.limit = 30;
    bindings.push({ name: "STORY_VIDEOS", type: "r2_bucket", bucket_name: "forever-tee-story-videos-production" }, { name: "STORY_VIDEO_NOTIFICATIONS", type: "durable_object_namespace" }, ...["STORY_VIDEO_LAMBDA_ACCESS_KEY_ID", "STORY_VIDEO_LAMBDA_SECRET_ACCESS_KEY", "STORY_VIDEO_GRANT_SECRET", "CART_LINE_CAPABILITY_SECRET", "OPENAI_API_KEY", "PRINTIFY_ASSET_DELIVERY_SECRET", "PRINTIFY_WEBHOOK_SECRET"].map(name => ({ name, type: "secret_text" })), { name: "STORY_VIDEO_PROVIDER", type: "plain_text", text: "lambda" });
    verifyProductionReleaseSettings({ bindings }, { settings: NATIVE_PRODUCTION_QUEUE }, { STORY_VIDEO_PROVIDER: "lambda" }, previous);
    assert.throws(() => verifyProductionReleaseSettings({ bindings }, { settings: NATIVE_PRODUCTION_QUEUE }, { STORY_VIDEO_PROVIDER: "lambda" }, previous, NATIVE_PRODUCTION_QUEUE, undefined, { requireProtectedConfig: true }), /protected runtime configuration/);
    const configured = [...bindings, { name: "SHOP_PROTECTED_CONFIG_JSON", type: "secret_text" }];
    verifyProductionReleaseSettings({ bindings: configured }, { settings: NATIVE_PRODUCTION_QUEUE }, { STORY_VIDEO_PROVIDER: "lambda" }, previous, NATIVE_PRODUCTION_QUEUE, undefined, { requireProtectedConfig: true });
    assert.throws(() => verifyProductionReleaseSettings({ bindings: [...configured, configured.at(-1)] }, { settings: NATIVE_PRODUCTION_QUEUE }, { STORY_VIDEO_PROVIDER: "lambda" }, previous, NATIVE_PRODUCTION_QUEUE, undefined, { requireProtectedConfig: true }), /protected runtime configuration/);
    for (const mutate of [value => { value[0].id = "development"; }, value => { value.pop(); }, value => { value[3].type = "plain_text"; },
        value => { value.find(item => item.name === "IMAGE_PROCESS_RATE_LIMIT").simple.limit = 31; },
        value => { value.find(item => item.name === "IMAGE_PROCESS_RATE_LIMIT").namespace_id = "2102"; },
        value => { value.push(structuredClone(value[3])); },
    ]) {
        const copy = structuredClone(bindings);
        mutate(copy);
        assert.throws(() => verifyProductionReleaseSettings({ bindings: copy }, { settings: NATIVE_PRODUCTION_QUEUE }, { STORY_VIDEO_PROVIDER: "lambda" }, previous));
    }
});
test("Production baseline accepts only the reviewed initial or already-native state", () => {
    const base = [
        { name: "DB", type: "d1", id: PRODUCTION_DB }, { name: "DESIGN_ARTWORK", type: "r2_bucket", bucket_name: "forever-tee-design-artwork-production" },
        { name: "STORY_VIDEO_JOBS", type: "queue", queue_name: "forever-tee-story-video-production" },
        ...["BENT_SHIRT_OPERATIONS_SECRET", "FOREVER_TEE_API_SHARED_SECRET"].map(name => ({ name, type: "secret_text" }))
    ];
    const legacy = { workerVersion: protectedConfig("resource_087c90849ed5"), content: { modules: [{ sha256: protectedConfig("resource_420d60c753d3") }] } };
    assert.equal(classifyProductionBaseline({ bindings: base }, { settings: FALLBACK_PRODUCTION_QUEUE }, legacy), "initial");
    const native = [...base,
        { name: "STORY_VIDEOS", type: "r2_bucket", bucket_name: "forever-tee-story-videos-production" }, { name: "STORY_VIDEO_NOTIFICATIONS", type: "durable_object_namespace" },
        ...["STORY_VIDEO_LAMBDA_ACCESS_KEY_ID", "STORY_VIDEO_LAMBDA_SECRET_ACCESS_KEY", "STORY_VIDEO_GRANT_SECRET"].map(name => ({ name, type: "secret_text" })),
        ...Object.entries({ STORY_VIDEO_PROVIDER: "lambda", STORY_VIDEO_ENVIRONMENT: "production",
            STORY_VIDEO_LAMBDA_FUNCTION: "arn:aws:lambda:ap-southeast-2:" + protectedConfig("awsAccountId") + ":function:forever-tee-video-production",
            STORY_VIDEO_IMAGE_DIGEST: PREVIOUS_PRODUCTION_IMAGE_DIGEST,
            STORY_VIDEO_SOURCE_DIGEST: PREVIOUS_PRODUCTION_SOURCE_DIGEST,
            STORY_VIDEO_RELEASE_ID: "native-" + protectedConfig("resource_df582621cced"), STORY_VIDEO_RELEASE_COMMIT: "a".repeat(40) }).map(([name, text]) => ({ name, type: "plain_text", text }))];
    const current = { workerVersion: protectedConfig("resource_030ac180b0a9"), content: { modules: [{ sha256: "b".repeat(64) }] } };
    assert.equal(classifyProductionBaseline({ bindings: native }, { settings: NATIVE_PRODUCTION_QUEUE }, current), "forward");
    assert.equal(classifyProductionBaseline({ bindings: [...native, { name: "PRINTIFY_ASSET_DELIVERY_SECRET", type: "secret_text" }] }, { settings: NATIVE_PRODUCTION_QUEUE }, current), "forward");
    assert.equal(classifyProductionBaseline({ bindings: [...native, { name: "PRINTIFY_ASSET_DELIVERY_SECRET", type: "secret_text" },
            { name: "PRINTIFY_WEBHOOK_SECRET", type: "secret_text" }] }, { settings: NATIVE_PRODUCTION_QUEUE }, current), "forward");
    assert.throws(() => classifyProductionBaseline({ bindings: native }, { settings: FALLBACK_PRODUCTION_QUEUE }, current));
    assert.throws(() => classifyProductionBaseline({ bindings: native.filter(item => item.name !== "STORY_VIDEO_GRANT_SECRET") }, { settings: NATIVE_PRODUCTION_QUEUE }, current));
});
test("recorded Cloudflare fallback is a reusable release baseline", async () => {
    const releaseId = "native-" + protectedConfig("resource_1f80479a3ff7"), fallbackId = "11111111-1111-4111-8111-111111111111", latestId = "22222222-2222-4222-8222-222222222222";
    const bytes = Buffer.from("export default { fetch() { return new Response('ok') } }");
    const content = await workerContentManifest(new Response(bytes));
    const shared = [
        { name: "DB", type: "d1", id: PRODUCTION_DB }, { name: "DESIGN_ARTWORK", type: "r2_bucket", bucket_name: "forever-tee-design-artwork-production" },
        { name: "STORY_VIDEO_JOBS", type: "queue", queue_name: "forever-tee-story-video-production" },
        { name: "STORY_VIDEOS", type: "r2_bucket", bucket_name: "forever-tee-story-videos-production" },
        { name: "STORY_VIDEO_NOTIFICATIONS", type: "durable_object_namespace" },
        ...["BENT_SHIRT_OPERATIONS_SECRET", "FOREVER_TEE_API_SHARED_SECRET", "STORY_VIDEO_LAMBDA_ACCESS_KEY_ID", "STORY_VIDEO_LAMBDA_SECRET_ACCESS_KEY", "STORY_VIDEO_GRANT_SECRET",
            "CART_LINE_CAPABILITY_SECRET", "OPENAI_API_KEY", "PRINTIFY_ASSET_DELIVERY_SECRET", "PRINTIFY_WEBHOOK_SECRET"].map(name => ({ name, type: "secret_text" })),
        ...Object.entries({ STORY_VIDEO_PROVIDER: "cloudflare", STORY_VIDEO_ENVIRONMENT: "production",
            STORY_VIDEO_LAMBDA_FUNCTION: "arn:aws:lambda:ap-southeast-2:" + protectedConfig("awsAccountId") + ":function:forever-tee-video-production",
            STORY_VIDEO_IMAGE_DIGEST: PREVIOUS_PRODUCTION_IMAGE_DIGEST,
            STORY_VIDEO_SOURCE_DIGEST: PREVIOUS_PRODUCTION_SOURCE_DIGEST,
            STORY_VIDEO_RELEASE_ID: releaseId, STORY_VIDEO_RELEASE_COMMIT: "a".repeat(40),
            PRINTIFY_ASSET_ORIGIN: productionOrigin }).map(([name, text]) => ({ name, type: "plain_text", text })),
    ];
    const version = { id: fallbackId, resources: { bindings: shared } };
    const fallback = { workerVersion: fallbackId, content, versionResourcesSha256: versionResourcesDigest(version), workerBytesVerified: true,
        provider: "cloudflare", consumer: { consumerId: "a".repeat(32), settings: FALLBACK_PRODUCTION_QUEUE }, cron: "*/15 * * * *" };
    const previous = { workerVersion: "33333333-3333-4333-8333-333333333333" };
    const variables = Object.fromEntries(shared.filter(binding => binding.type === "plain_text").map(binding => [binding.name, binding.text]));
    variables.STORY_VIDEO_PROVIDER = "lambda";
    const prepared = { environment: "production", accountId: protectedConfig("awsAccountId"), region: "ap-southeast-2", releaseId, sourceCommit: "a".repeat(40),
        candidate: { imageDigest: variables.STORY_VIDEO_IMAGE_DIGEST, sourceDigest: variables.STORY_VIDEO_SOURCE_DIGEST }, variables,
        worker: { bundleSha256: content.modules[0].sha256 }, previous: { worker: previous },
        artifacts: { candidateArtifact: { name: "candidate" }, previousArtifact: { name: "previous" } } };
    const events = {
        prepared: { ...prepared, preparation: { name: "prepared" } },
        "fallback-verified": { fallback, artifact: { name: "fallback" } },
        verified: { releaseId, provider: "cloudflare", fallback, rollbackRehearsed: true },
        "backlog-recovery-rolled-back": { provider: "cloudflare", cohort: { families: 27, count: 108, sha256: "c".repeat(64) } },
    };
    let paused = 0, pauseRelease = null, terminalStage = "verified";
    const cf = {
        deployments: async () => ({ deployments: [{ versions: [{ version_id: fallbackId, percentage: 100 }] }] }),
        versions: async () => ({ items: [{ id: latestId }] }), version: async (id) => { assert.equal(id, fallbackId); return version; },
        query: async (sql, params) => {
            if (sql.includes("release_control"))
                return [{ results: [{ paused, release_id: pauseRelease, current_release_id: releaseId }] }];
            assert.equal(params[0], releaseId);
            if (sql.includes("backlog-recovery-rolled-back"))
                return [{ results: [{ stage: terminalStage, payload: JSON.stringify(events[terminalStage]) }] }];
            return [{ results: ["fallback-verified", "prepared"].map(stage => ({ stage, payload: JSON.stringify(events[stage]) })) }];
        },
        consumers: async () => [{ type: "worker", script_name: "forever-tee-api", consumer_id: fallback.consumer.consumerId, settings: fallback.consumer.settings }],
        schedules: async () => ({ schedules: [{ cron: fallback.cron }] }),
    };
    const original = { before: previous, settings: { bindings: shared.filter(binding => !binding.name.startsWith("STORY_VIDEO")) } };
    const objects = new Map([["prepared", Buffer.from(JSON.stringify(prepared))], ["fallback", Buffer.from(JSON.stringify(fallback))], ["candidate", bytes],
        ["previous", Buffer.from(JSON.stringify(original))]]);
    const result = await loadRecordedProductionWorkerBaseline(cf, { read: async (reference) => objects.get(reference.name) });
    assert.equal(result.record.releaseId, releaseId);
    assert.equal(result.historicalArtifact.before.workerVersion, fallbackId);
    assert.deepEqual(result.settings.bindings, shared);
    assert.equal(classifyProductionBaseline(result.settings, fallback.consumer, fallback, result.record), "fallback");
    terminalStage = "backlog-recovery-rolled-back";
    const recovered = await loadRecordedProductionWorkerBaseline(cf, { read: async (reference) => objects.get(reference.name) });
    assert.equal(recovered.record.terminalStage, "backlog-recovery-rolled-back");
    events[terminalStage].cohort.count = 107;
    await assert.rejects(loadRecordedProductionWorkerBaseline(cf, { read: async (reference) => objects.get(reference.name) }), /fallback recovery completion/);
    events[terminalStage].cohort.count = 108;
    paused = 1;
    pauseRelease = "native-9999";
    await assert.rejects(loadRecordedProductionWorkerBaseline(cf, { read: async (reference) => objects.get(reference.name) }), /current pause owner/);
    await assert.rejects(loadRecordedProductionWorkerBaseline(cf, { read: async (reference) => objects.get(reference.name) }, { pauseOwner: "native-8888" }), /current pause owner/);
    assert.equal((await loadRecordedProductionWorkerBaseline(cf, { read: async (reference) => objects.get(reference.name) }, { pauseOwner: pauseRelease })).record.releaseId, releaseId);
    paused = 0;
    pauseRelease = null;
    objects.set("candidate", Buffer.from("changed"));
    await assert.rejects(loadRecordedProductionWorkerBaseline(cf, { read: async (reference) => objects.get(reference.name) }), /recorded fallback bytes/);
});
test("single Production queue accepts the actual script-name schema and rejects other consumers", async () => {
    const value = { type: "worker", script_name: "forever-tee-api", consumer_id: "a".repeat(32), settings: NATIVE_PRODUCTION_QUEUE };
    assert.equal((await inspectProductionConsumer({ consumers: async () => [value] })).consumerId, value.consumer_id);
    for (const values of [[{ ...value, script_name: "other" }], [value, value], []])
        await assert.rejects(inspectProductionConsumer({ consumers: async () => values }));
});
test("Production natural drain includes running print work without expiring its lease", async () => {
    let now = 1000, runningPrints = 1;
    const cf = { query: async (sql) => {
            assert.ok(sql.startsWith("SELECT "));
            if (sql.includes("release_control"))
                return [{ results: [{ paused: 1, release_id: "native-1234", paused_at: 1000 }] }];
            if (sql.includes("sqlite_schema"))
                return [{ results: [{ name: "print_asset_jobs" }] }];
            return [{ results: [{ count: sql.includes("print_asset_jobs") ? runningPrints : 0 }] }];
        } };
    const result = await waitProductionNaturalDrain(cf, "native-1234", async (delay) => {
        now += delay;
        if (now >= 601000)
            runningPrints = 0;
    }, () => now);
    assert.equal(result.naturalDrainVerified, true);
    assert.ok(now >= 661000);
    now = 1000;
    runningPrints = 1;
    await assert.rejects(waitProductionNaturalDrain(cf, "native-1234", async (delay) => { now += delay; }, () => now), /admissions remain paused/);
});
test("qualified print configuration binds the separate Production namespace without migrating it in the API", async () => {
    const source = resolveProtectedTemplate(await readFile(new URL("../workers/api/wrangler.jsonc", import.meta.url), "utf8"));
    const legacy = productionReleaseConfig(source, "native-1234", "a".repeat(40), productionOrigin);
    const config = productionReleaseConfig(source, "native-1234", "a".repeat(40), productionOrigin, { printExecutor: true });
    assert.equal(legacy.vars.PRINT_EXECUTION_MODE, undefined);
    assert.equal(config.vars.PRINT_EXECUTION_MODE, "durable-object");
    assert.deepEqual(config.durable_objects.bindings, [...legacy.durable_objects.bindings,
        { name: "PRINT_EXECUTIONS", class_name: "PrintAssetExecution", script_name: "forever-tee-print-executor-production" }]);
    assert.deepEqual(config.migrations, legacy.migrations);
    assert.deepEqual(config.r2_buckets, legacy.r2_buckets);
    assert.deepEqual(config.queues, legacy.queues);
});
