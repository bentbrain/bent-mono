import { protectedConfig, resolveProtectedTemplate } from "./protected-config.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { compositionContext, verifyCompositionBaseline, verifyCompositionMedia, verifyCompositionPrintResolution, verifyCompositionCleanupIntent } from "./featured-composition-policy.mjs";
const env = { GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted", GITHUB_REPOSITORY: "bentbrain/bent-mono", GITHUB_REPOSITORY_ID: protectedConfig("githubRepositoryId"),
    GITHUB_REPOSITORY_OWNER_ID: protectedConfig("githubOwnerId"), GITHUB_ACTOR_ID: protectedConfig("githubOwnerId"), GITHUB_REF: "refs/heads/main", GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_RUN_ATTEMPT: "1",
    GITHUB_SHA: "a".repeat(40), GITHUB_RUN_ID: "12345", GITHUB_WORKFLOW_REF: "bentbrain/bent-mono/.github/workflows/featured-composition.yml@refs/heads/main",
    COMPOSITION_ENVIRONMENT: "production", COMPOSITION_OPERATION: "create", COMPOSITION_NATIVE_RELEASE: "native-23456", CLOUDFLARE_ACCOUNT_ID: protectedConfig("cloudflareAccountId"),
    CLOUDFLARE_API_TOKEN: "fixture", BENT_SHIRT_OPERATIONS_SECRET: "fixture", RUNNER_TEMP: "/tmp", WORKER_URL: "https://forever-tee-api.socialqueue.workers.dev" };
test("editorial creation requires a fresh protected owner dispatch and cannot choose an arbitrary account or API", () => {
    assert.equal(compositionContext(env).database, protectedConfig("resource_1a1378f0d1dc"));
    for (const override of [{ GITHUB_RUN_ATTEMPT: "2" }, { GITHUB_ACTOR_ID: "123" }, { COMPOSITION_OPERATION: "overwrite" }, { COMPOSITION_NATIVE_RELEASE: "latest" },
        { WORKER_URL: "https://other.example" }, { GITHUB_WORKFLOW_REF: "other" }, { GITHUB_REPOSITORY_OWNER_ID: "work" }, { CLOUDFLARE_ACCOUNT_ID: "work" }])
        assert.throws(() => compositionContext({ ...env, ...override }));
});
test("publication requires current native code plus the compatible qualified backup and rehearsed retained fallback", () => {
    const context = compositionContext(env), control = { paused: 0, release_id: null, current_release_id: context.releaseId };
    const version = { id: "native-version", resources: { bindings: Object.entries({ STORY_VIDEO_PROVIDER: "lambda", STORY_VIDEO_RELEASE_ID: context.releaseId, STORY_VIDEO_RELEASE_COMMIT: context.sourceCommit }).map(([name, text]) => ({ name, text, type: "plain_text" })) } };
    const backup = { schemaVersion: 1, environment: "production", sourceCommit: context.sourceCommit, qualified: true, cleaned: true, contract: "two-source-v2", workerVersion: "backup-version" };
    const fallback = { workerVersion: "fallback-version", provider: "cloudflare", content: { sha256: "b".repeat(64) } };
    const verified = { rollbackRehearsed: true, sourceCommit: context.sourceCommit, provider: "lambda", native: { workerVersion: version.id, content: { ...fallback.content } }, fallback: { ...fallback, content: { ...fallback.content } } };
    verifyCompositionBaseline(context, control, version, backup, backup.workerVersion, verified, fallback);
    for (const mutate of [v => v.control.paused = 1, v => v.backup.contract = "two-source-v1", v => v.verified.rollbackRehearsed = false,
        v => v.fallback.content.sha256 = "different", v => v.version.resources.bindings[2].text = "old"]) {
        const v = structuredClone({ control, version, backup, verified, fallback });
        mutate(v);
        assert.throws(() => verifyCompositionBaseline(context, v.control, v.version, v.backup, backup.workerVersion, v.verified, v.fallback));
    }
});
test("ready ledger rows alone cannot qualify media without checksummed two-source objects and every product's purchase readiness", () => {
    const manifest = JSON.parse(resolveProtectedTemplate(readFileSync(new URL("./fixtures/content/featured-398-approved.json", import.meta.url))));
    const snapshot = { committed: true, readiness: [{ ready: true }, { ready: true }], assets: manifest.products.map(p => ({ configured_product_id: p.id, status: "ready", width_px: 2400, height_px: 3000, sha256: "c".repeat(64), storage_key: "print-assets/fixture.png" })),
        videos: manifest.jobs.map(j => ({ id: j.id, product_id: j.productId, colour: j.colour, status: "ready", execution_id: "execution", attempt_count: 1, output_byte_size: 100,
            object: { size: 100, metadata: { jobId: j.id, sourceSha256: manifest.sources[0].sha256, recursiveSourceSha256: manifest.sources[1].sha256, compositionVersion: "two-source-v2", rendererVersion: "story-video-renderer-v7", sha256: "d".repeat(64) } } })) };
    verifyCompositionMedia(manifest, snapshot, { firstAttempt: true });
    for (const mutate of [v => v.readiness[0].ready = false, v => v.videos[0].object.metadata.compositionVersion = "two-source-v1",
        v => v.videos[0].object.size = 99, v => v.videos[0].attempt_count = 2, v => v.assets.pop(), v => v.videos[0].object = null]) {
        const value = structuredClone(snapshot);
        mutate(value);
        assert.throws(() => verifyCompositionMedia(manifest, value, { firstAttempt: true }));
    }
});
test("approved smaller portrait passes every print geometry while the previous size fails the largest", () => {
    const manifest = JSON.parse(resolveProtectedTemplate(readFileSync(new URL("./fixtures/content/featured-398-approved.json", import.meta.url))));
    const geometries = [{ productId: manifest.products[1].id, rows: [[3619, 4089], [4150, 4690], [4682, 5291]].map(([print_width, print_height]) => ({ print_width, print_height, geometry_key: `dtg:${print_width}x${print_height}` })) },
        { productId: manifest.products[0].id, rows: [{ print_width: 2835, print_height: 3425, geometry_key: "dtg:2835x3425" }] }];
    const result = verifyCompositionPrintResolution(manifest, geometries);
    assert.equal(result.length, 4);
    assert.ok(Math.min(...result.map(row => row.ppi)) > 150);
    manifest.sources[0].crop.cropZoom = 1.6594002207087934;
    assert.throws(() => verifyCompositionPrintResolution(manifest, geometries), /4682x5291 is 137.77 PPI/);
});
test("cleanup cannot select Production, another intent source, a changed live pair or customer artwork", () => {
    const input = { ...env, COMPOSITION_ENVIRONMENT: "development", COMPOSITION_OPERATION: "cleanup", COMPOSITION_CLEANUP_SOURCE: "b".repeat(40), WORKER_URL: "https://forever-tee-api-development.socialqueue.workers.dev" };
    const context = compositionContext(input), before = { nativeVersion: "native-version", backupVersion: "backup-version", releaseId: context.releaseId };
    const intent = { schemaVersion: 1, ...context, operation: "create", sourceCommit: context.cleanupSource, before, manifest: { approval: "Synthetic Preview fixture; no customer artwork copied." } };
    verifyCompositionCleanupIntent(context, intent, before);
    for (const override of [{ COMPOSITION_ENVIRONMENT: "production", WORKER_URL: env.WORKER_URL }, { COMPOSITION_OPERATION: "create" }, { COMPOSITION_CLEANUP_SOURCE: "" }])
        assert.throws(() => compositionContext({ ...input, ...override }));
    for (const mutate of [v => v.sourceCommit = "c".repeat(40), v => v.environment = "production", v => v.before.nativeVersion = "changed", v => v.manifest.original = {}, v => v.manifest.transfer = {}, v => v.database = "other"]) {
        const changed = structuredClone(intent);
        mutate(changed);
        assert.throws(() => verifyCompositionCleanupIntent(context, changed, before));
    }
});
test("publication can pin the unchanged qualified runtime while recording newer editorial tooling", () => {
    const source = "b".repeat(40);
    const context = compositionContext({ ...env, COMPOSITION_QUALIFIED_SOURCE: source });
    assert.equal(context.sourceCommit, source);
    assert.equal(context.toolingCommit, env.GITHUB_SHA);
    assert.throws(() => compositionContext({ ...env, COMPOSITION_QUALIFIED_SOURCE: "main" }));
    assert.throws(() => compositionContext({ ...env, COMPOSITION_ENVIRONMENT: "development", COMPOSITION_QUALIFIED_SOURCE: source }));
});
