import { protectedConfig } from "./protected-config.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { inspectProductionCloudflare } from "./native-production-inspection.mjs";
import { NATIVE_MIGRATION_LATEST } from "./native-migration-inventory.mjs";
import { NATIVE_PRODUCTION_QUEUE } from "./native-production-worker.mjs";
import { CURRENT_PRODUCTION_IMAGE_DIGEST, CURRENT_PRODUCTION_SOURCE_DIGEST } from "./native-production-runtime.mjs";
const database = protectedConfig("resource_1a1378f0d1dc"), queue = "a".repeat(32), version = "11111111-1111-1111-1111-111111111111";
const env = { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "bentbrain/bent-mono", GITHUB_REPOSITORY_ID: protectedConfig("githubRepositoryId"),
    GITHUB_REPOSITORY_OWNER_ID: protectedConfig("githubOwnerId"), GITHUB_REF: "refs/heads/main", GITHUB_SHA: "a".repeat(40), GITHUB_RUN_ID: "123",
    GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_RUN_ATTEMPT: "1", GITHUB_WORKFLOW_REF: "bentbrain/bent-mono/.github/workflows/native-production-identity.yml@refs/heads/main",
    CLOUDFLARE_ACCOUNT_ID: protectedConfig("cloudflareAccountId"), CLOUDFLARE_API_TOKEN: "private-fixture-token", WORKER_URL: "https://forever-tee-api.socialqueue.workers.dev" };
function fixture({ provider, latestVersion = version, changedLatest = false, queueBinding = {}, queueResults, consumerIdentity = { script_name: "forever-tee-api" }, nativeBindingChanges = {}, nativeMissingBinding, nativeQueueChanges = {}, nativeColumns = [{ name: "execution_id" }] } = {}) {
    const calls = [];
    let versionReads = 0;
    const request = async (url, init) => {
        assert.equal(init.headers.Authorization, "Bearer private-fixture-token");
        assert.equal(init.redirect, "error");
        const path = new URL(url).pathname;
        assert.ok(path.startsWith(`/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/`));
        assert.equal(path.includes("development"), false);
        calls.push({ path, method: init.method ?? "GET" });
        let result;
        if (path.endsWith(`/d1/database/${database}`))
            result = { uuid: database, name: "forever-tee-designs-production" };
        else if (path.endsWith("/settings"))
            result = { bindings: [
                    { name: "DB", type: "d1", id: database },
                    { name: "DESIGN_ARTWORK", type: "r2_bucket", bucket_name: "forever-tee-design-artwork-production" },
                    { name: "STORY_VIDEO_JOBS", type: "queue", queue_name: "forever-tee-story-video-production", ...queueBinding },
                    { name: "unrelated-secret", type: "plain_text", text: "must-not-log" },
                    ...(provider ? [{ name: "STORY_VIDEO_PROVIDER", type: "plain_text", text: provider }] : []),
                    ...(provider === "lambda" ? [
                        { name: "STORY_VIDEOS", type: "r2_bucket", bucket_name: "forever-tee-story-videos-production" },
                        { name: "STORY_VIDEO_NOTIFICATIONS", type: "durable_object_namespace", namespace_id: "b".repeat(32) },
                        ...["BENT_SHIRT_OPERATIONS_SECRET", "FOREVER_TEE_API_SHARED_SECRET", "STORY_VIDEO_LAMBDA_ACCESS_KEY_ID", "STORY_VIDEO_LAMBDA_SECRET_ACCESS_KEY", "STORY_VIDEO_GRANT_SECRET"].map(name => ({ name, type: "secret_text" })),
                        ...Object.entries({ STORY_VIDEO_ENVIRONMENT: "production", STORY_VIDEO_LAMBDA_FUNCTION: `arn:aws:lambda:ap-southeast-2:${protectedConfig("awsAccountId")}:function:forever-tee-video-production`,
                            STORY_VIDEO_IMAGE_DIGEST: CURRENT_PRODUCTION_IMAGE_DIGEST, STORY_VIDEO_SOURCE_DIGEST: CURRENT_PRODUCTION_SOURCE_DIGEST,
                            STORY_VIDEO_RELEASE_ID: "native-123", STORY_VIDEO_RELEASE_COMMIT: "a".repeat(40), ...nativeBindingChanges }).map(([name, text]) => ({ name, type: "plain_text", text })),
                    ].filter(item => item.name !== nativeMissingBinding) : []),
                ] };
        else if (path.endsWith("/queues"))
            result = queueResults ?? [{ queue_id: queue, queue_name: "forever-tee-story-video-production" }];
        else if (path.endsWith(`/queues/${queue}`))
            result = { queue_id: queue, queue_name: "forever-tee-story-video-production" };
        else if (path.endsWith(`/queues/${queue}/consumers`))
            result = [{ type: "worker", ...consumerIdentity, settings: provider === "lambda" ? { ...NATIVE_PRODUCTION_QUEUE, ...nativeQueueChanges } : { max_concurrency: 1 } }];
        else if (path.endsWith("/deployments"))
            result = { deployments: [{ versions: [{ version_id: version, percentage: 100 }] }] };
        else if (path.endsWith("/versions"))
            result = { items: [{ id: ++versionReads > 1 && changedLatest ? "changed" : latestVersion }] };
        else if (path.endsWith("/content/v2"))
            return new Response("current-worker-code", { headers: { "Content-Type": "application/javascript" } });
        else if (path.endsWith(`/d1/database/${database}/query`)) {
            assert.equal(init.method, "POST");
            const { sql, params } = JSON.parse(init.body);
            assert.match(sql, /^SELECT /);
            assert.deepEqual(params, []);
            result = [{ success: true, results: sql.includes("d1_migrations") ? [{ name: NATIVE_MIGRATION_LATEST }]
                        : sql.includes("pragma_table_info") ? [{ name: "id" }, ...(provider === "lambda" ? nativeColumns : [])] : [{ status: "ready", count: 3 }] }];
        }
        else
            assert.fail("Unexpected endpoint");
        return Response.json({ success: true, result });
    };
    return { request, calls };
}
test("Production inventory uses fixed reads and reports missing native prerequisites without exposing bindings", async () => {
    const { request, calls } = fixture(), result = await inspectProductionCloudflare(env, request);
    assert.equal(result.provider, "cloudflare");
    assert.equal(result.nativePromotionReady, false);
    assert.equal(result.applicationMutations, false);
    assert.equal(result.missing.length, 6);
    assert.equal(result.workerContent.modules.length, 1);
    assert.equal(JSON.stringify(result).includes("must-not-log"), false);
    assert.equal(JSON.stringify(result).includes(env.CLOUDFLARE_API_TOKEN), false);
    assert.equal(calls.filter(call => call.method === "POST").length, 3);
    assert.ok(calls.every(call => call.method === "GET" || call.path.endsWith("/query")));
});
test("name-based queue resolution rejects foreign names, absent or duplicate results and conflicting IDs", async () => {
    const valid = { queue_id: queue, queue_name: "forever-tee-story-video-production" };
    for (const options of [
        { queueBinding: { queue_name: "forever-tee-story-video-development" } }, { queueBinding: { type: "plain_text" } },
        { queueBinding: { queue_id: "b".repeat(32) } }, { queueResults: [] }, { queueResults: [valid, valid] },
        { queueResults: [{ ...valid, queue_id: "invalid" }] },
    ])
        await assert.rejects(inspectProductionCloudflare(env, fixture(options).request));
});
test("consumer identity accepts documented and legacy names but rejects conflicting identities", async () => {
    for (const consumerIdentity of [{ script_name: "forever-tee-api" }, { service: "forever-tee-api" }, { script: "forever-tee-api" }]) {
        await inspectProductionCloudflare(env, fixture({ consumerIdentity }).request);
    }
    for (const consumerIdentity of [{}, { script_name: "other" }, { script_name: "forever-tee-api", service: "other" }]) {
        await assert.rejects(inspectProductionCloudflare(env, fixture({ consumerIdentity }).request));
    }
});
test("inspection rejects wrong environments, unexpected providers and version races", async () => {
    for (const delta of [{ GITHUB_REF: "refs/heads/perf/story-video-family-experiments" }, { CLOUDFLARE_ACCOUNT_ID: "work" },
        { WORKER_URL: "https://forever-tee-api-development.socialqueue.workers.dev" }]) {
        await assert.rejects(inspectProductionCloudflare({ ...env, ...delta }, () => assert.fail("No network before guard")));
    }
    for (const options of [{ provider: "unknown" }, { latestVersion: "different" }, { changedLatest: true }]) {
        await assert.rejects(inspectProductionCloudflare(env, fixture(options).request));
    }
});

test("Production inspection accepts the existing reviewed Lambda Worker without AWS access or provider changes", async () => {
    const { request, calls } = fixture({ provider: "lambda" });
    const result = await inspectProductionCloudflare(env, request);
    assert.equal(result.provider, "lambda");
    assert.deepEqual(result.queueSettings, NATIVE_PRODUCTION_QUEUE);
    assert.deepEqual(result.missing, []);
    assert.equal(result.nativePromotionReady, false);
    assert.equal(result.awsAccessAttempted, false);
    assert.equal(result.applicationMutations, false);
    assert.equal(calls.filter(call => call.method === "POST").length, 3);
    assert.ok(calls.every(call => call.method === "GET" || call.path.endsWith("/query")));
});

test("existing Lambda inspection rejects foreign or incomplete native configuration and unreviewed image pairs", async () => {
    for (const options of [
        { nativeBindingChanges: { STORY_VIDEO_ENVIRONMENT: "development" } },
        { nativeBindingChanges: { STORY_VIDEO_LAMBDA_FUNCTION: "arn:aws:lambda:ap-southeast-2:999999999999:function:forever-tee-video-production" } },
        { nativeBindingChanges: { STORY_VIDEO_IMAGE_DIGEST: "sha256:" + "f".repeat(64) } },
        { nativeBindingChanges: { STORY_VIDEO_SOURCE_DIGEST: "f".repeat(64) } },
        { nativeBindingChanges: { STORY_VIDEO_RELEASE_ID: "unrecorded" } },
        { nativeBindingChanges: { STORY_VIDEO_RELEASE_COMMIT: "invalid" } },
        { nativeMissingBinding: "STORY_VIDEO_LAMBDA_SECRET_ACCESS_KEY" },
        { nativeMissingBinding: "STORY_VIDEO_NOTIFICATIONS" },
        { nativeQueueChanges: { max_concurrency: 1 } },
        { nativeQueueChanges: { max_retries: 2 } },
        { nativeColumns: [] },
    ]) {
        await assert.rejects(inspectProductionCloudflare(env, fixture({ provider: "lambda", ...options }).request));
    }
});
