import { protectedConfig } from "./protected-config.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { inspectDevelopmentWorker, workerContentManifest, verifyDevelopmentPairStatus, verifyDevelopmentReleaseConfiguration, workerCommandArguments, versionResourcesDigest } from "./native-ci-worker.mjs";
const version = "2fc159fa-8592-4599-9478-9aaf6697537f";
test("native Development releases receive the OpenAI key only during the atomic Worker deploy", async () => {
    const workflow = await readFile(new URL("../.github/workflows/native-development.yml", import.meta.url), "utf8");
    assert.match(workflow, /OPENAI_API_KEY: \$\{\{ secrets\.OPENAI_API_KEY \}\}/);
    assert.equal(workflow.split("\n").filter((line) => line.includes("OPENAI_API_KEY")).length, 1);
});
test("temporary bundle entrypoints cannot redirect Wrangler config discovery away from the reviewed API config", () => {
    const args = workerCommandArguments(["deploy", "/runner/private/bundle/index.js", "--no-bundle", "--env", "development"]);
    assert.equal(args.at(-2), "--config");
    assert.equal(args.at(-1), new URL("../workers/api/wrangler.jsonc", import.meta.url).pathname);
    assert.equal(args.filter(value => value === "--config").length, 1);
});
const content = () => {
    const form = new FormData();
    form.set("index.js", new Blob(["approved bundle"], { type: "application/javascript+module" }), "index.js");
    return new Response(form, { headers: { "cf-entrypoint": "index.js" } });
};
test("Worker evidence hashes the exact downloaded module and binds latest content to active traffic", async () => {
    const manifest = await workerContentManifest(content());
    assert.equal(manifest.modules[0].sha256, createHash("sha256").update("approved bundle").digest("hex"));
    assert.equal(manifest.entrypoint, "index.js");
    const cf = { deployments: async () => ({ deployments: [{ versions: [{ version_id: version, percentage: 100 }] }] }),
        versions: async () => ({ items: [{ id: version }] }), content, version: async () => ({ id: version, resources: { script: { etag: "fixture" } } }) };
    assert.equal((await inspectDevelopmentWorker(cf)).workerVersion, version);
    await assert.rejects(inspectDevelopmentWorker({ ...cf, versions: async () => ({ items: [{ id: "not-active" }] }) }));
    await assert.rejects(inspectDevelopmentWorker({ ...cf, deployments: async () => ({ deployments: [{ versions: [{ version_id: version, percentage: 50 }] }] }) }));
    let reads = 0;
    await assert.rejects(inspectDevelopmentWorker({ ...cf, versions: async () => ({ items: [{ id: ++reads === 1 ? version : "changed" }] }) }));
    const missing = new Response(new FormData(), { headers: { "cf-entrypoint": "index.js" } });
    await assert.rejects(workerContentManifest(missing));
});
test("historical active versions require preserved bytes and matching immutable resources, never latest content", async () => {
    const versionRecord = { id: version, resources: { script: { etag: "original" } } };
    const response = content();
    const artifact = { contentType: response.headers.get("content-type"), entrypoint: "index.js",
        body: Buffer.from(await response.clone().arrayBuffer()).toString("base64"), before: {
            workerVersion: version, content: await workerContentManifest(response), versionResourcesSha256: versionResourcesDigest(versionRecord),
        } };
    const cf = { deployments: async () => ({ deployments: [{ versions: [{ version_id: version, percentage: 100 }] }] }),
        versions: async () => ({ items: [{ id: "c88d21a6-4c18-42a2-be1f-1fc7778bffe0" }] }),
        version: async () => versionRecord, content: () => assert.fail("Latest content is not the historical active version") };
    assert.deepEqual((await inspectDevelopmentWorker(cf, artifact)).content, artifact.before.content);
    await assert.rejects(inspectDevelopmentWorker(cf));
    await assert.rejects(inspectDevelopmentWorker(cf, { ...artifact, body: Buffer.from("corrupt").toString("base64") }));
    await assert.rejects(inspectDevelopmentWorker(cf, { ...artifact, before: { ...artifact.before, workerVersion: "other" } }));
    await assert.rejects(inspectDevelopmentWorker({ ...cf, version: async () => ({ ...versionRecord, resources: { changed: true } }) }, artifact));
    let reads = 0;
    await assert.rejects(inspectDevelopmentWorker({ ...cf, versions: async () => ({ items: [{ id: ++reads === 1 ? "old-latest" : "new-latest" }] }) }, artifact));
});
test("release verification checks actual bindings and watchdog queue limits, not only byte hashes", () => {
    const vars = { STORY_VIDEO_RELEASE_ID: "native-123", STORY_VIDEO_PROVIDER: "lambda" };
    const settings = { bindings: [
            ...Object.entries(vars).map(([name, text]) => ({ name, text, type: "plain_text" })),
            { name: "CART_LINE_CAPABILITY_SECRET", type: "secret_text" },
            { name: "OPENAI_API_KEY", type: "secret_text" },
            { name: "PRINTIFY_ASSET_DELIVERY_SECRET", type: "secret_text" },
            { name: "PRINTIFY_WEBHOOK_SECRET", type: "secret_text" },
            { name: "PRODUCT_IMAGE_RENDERER_BYPASS_SECRET", type: "secret_text" },
        ] };
    const consumer = { settings: { batch_size: 1, max_retries: 100, max_wait_time_ms: 1000, max_concurrency: 2, retry_delay: 10 } };
    assert.doesNotThrow(() => verifyDevelopmentReleaseConfiguration(settings, consumer, vars));
    assert.throws(() => verifyDevelopmentReleaseConfiguration(settings, { settings: { ...consumer.settings, max_retries: 2 } }, vars));
    assert.throws(() => verifyDevelopmentReleaseConfiguration({ bindings: settings.bindings.slice(1) }, consumer, vars));
    assert.throws(() => verifyDevelopmentReleaseConfiguration({ bindings: settings.bindings.slice(0, -1) }, consumer, vars));
    assert.throws(() => verifyDevelopmentReleaseConfiguration(settings, consumer, { ...vars, STORY_VIDEO_PROVIDER: "cloudflare" }));
});
const env = { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "bentbrain/bent-mono", GITHUB_REPOSITORY_ID: protectedConfig("githubRepositoryId"), GITHUB_REPOSITORY_OWNER_ID: protectedConfig("githubOwnerId"),
    GITHUB_REF: "refs/heads/perf/story-video-family-experiments", GITHUB_SHA: "a".repeat(40), GITHUB_EVENT_NAME: "push", GITHUB_RUN_ID: "123",
    GITHUB_WORKFLOW_REF: "bentbrain/bent-mono/.github/workflows/native-development.yml@refs/heads/perf/story-video-family-experiments",
    CLOUDFLARE_ACCOUNT_ID: protectedConfig("cloudflareAccountId"), CLOUDFLARE_API_TOKEN: "fixture-cf", WORKER_URL: "https://forever-tee-api-development.socialqueue.workers.dev",
    BENT_SHIRT_OPERATIONS_SECRET: "fixture-operations" };
test("live protocol verification requires the exact candidate, commit, environment and owned pause", async () => {
    const candidate = { imageDigest: `sha256:${"b".repeat(64)}`, sourceDigest: "c".repeat(64) };
    const value = { ...candidate, executionProtocol: "claim-v1", rendererVersion: "story-video-renderer-v7", sourceCommit: env.GITHUB_SHA,
        releaseId: "native-123", environment: "development", functionArn: "arn:aws:lambda:ap-southeast-2:" + protectedConfig("awsAccountId") + ":function:forever-tee-video-development",
        paused: true, pauseOwner: "native-123" };
    const request = async (url, options) => {
        assert.equal(url, `${env.WORKER_URL}/v2/internal/operations/native-video-release`);
        assert.equal(options.redirect, "error");
        assert.equal(options.headers["x-bent-shirt-operations-secret"], "fixture-operations");
        return Response.json(value);
    };
    assert.equal((await verifyDevelopmentPairStatus(env, candidate, "native-123", request)).protocolVerified, true);
    for (const delta of [{ paused: false }, { pauseOwner: "native-999" }, { executionProtocol: "legacy" }, { imageDigest: "other" },
        { sourceDigest: "other" }, { sourceCommit: "other" }, { environment: "production" }, { releaseId: "native-999" }]) {
        await assert.rejects(verifyDevelopmentPairStatus(env, candidate, "native-123", async () => Response.json({ ...value, ...delta })));
    }
});
test('active settings use immutable serving version even when script settings describe a newer upload', async () => {
    const { activeWorkerSettings } = await import('./native-ci-worker.mjs');
    const record = { id: version, resources: { script_runtime: { compatibility_date: '2026-08-12' }, bindings: [] } };
    const expected = { workerVersion: version, versionResourcesSha256: versionResourcesDigest(record) };
    const cf = { settings: () => assert.fail('latest-upload settings must not determine active bindings'),
        deployments: async () => ({ deployments: [{ versions: [{ version_id: version, percentage: 100 }] }] }), version: async () => record };
    assert.deepEqual(await activeWorkerSettings(cf, expected), { compatibility_date: '2026-08-12', bindings: [] });
    await assert.rejects(activeWorkerSettings(cf, { ...expected, versionResourcesSha256: 'wrong' }));
    await assert.rejects(activeWorkerSettings({ ...cf, version: async () => ({ ...record, resources: {} }) }));
    let reads = 0;
    await assert.rejects(activeWorkerSettings({ ...cf, deployments: async () => ({ deployments: [{ versions: [{ version_id: ++reads === 1 ? version : 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', percentage: 100 }] }] }) }, expected));
});
