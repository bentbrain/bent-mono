import { protectedConfig } from "./protected-config.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { createHandler } from "./handler-core.mjs";
import { handler as entry } from "./entry.mjs";
import { BUCKET, NAME, REGION, ENCODING, FUNCTION_ARN, VARIANTS, runtimeClientConfig } from "./config.mjs";
import { jobIdentity, sha256, validateJob } from "./contract.mjs";
import { DEFAULT_STORY_MOTION } from "../src/geometry.mjs";
const artwork = Buffer.from("saved background removed artwork");
const mockup = Buffer.from("accurate garment cutout");
const video = Buffer.from("MP4 encoded once");
const buildId = "a".repeat(64);
const context = { invokedFunctionArn: FUNCTION_ARN, awsRequestId: "request-a", memoryLimitInMB: "8192", getRemainingTimeInMillis: () => 120000 };
const settings = { cropX: 0.48, cropY: 0.61, cropZoom: 1.17, depth: 5, placementX: 0.27, placementY: 0.22, placementWidth: 0.48 };
function job(variantId = "tee-black", customerId = "customer-a") {
    return { schemaVersion: 1, runId: "11111111-1111-1111-1111-111111111111", variantId, customerId, settings,
        artwork: { key: `inputs/artwork/${sha256(artwork)}.png`, sha256: sha256(artwork), size: artwork.length },
        mockup: { key: `inputs/mockups/${variantId}/${sha256(mockup)}.${VARIANTS[variantId].file.split(".").at(-1)}`, sha256: sha256(mockup), size: mockup.length } };
}
const encoded = { video, encoding: { crf: 21, frameWidth: 720, frameHeight: 1280, frameRate: 30 }, uniqueFrameCount: 91,
    renderTimeMs: 5, assetLoadTimeMs: 1, canvasTimeMs: 2, pipeTimeMs: 1, encoderDrainTimeMs: 1 };
const storage = { read: async (ref) => ref.key.includes("artwork") ? artwork : mockup,
    write: async ({ sha256 }) => ({ etag: "stored", sha256 }) };
test("all four products pass the exact approved scene and bytes to the unchanged renderer", async () => {
    assert.deepEqual(DEFAULT_STORY_MOTION, { easing: { x1: 0, x2: 0.216191724829368, y1: 0, y2: 0.9941066261156346 },
        finishedScale: 0.64, openingScale: 19988, zoomDurationSeconds: 3 });
    for (const variantId of Object.keys(VARIANTS)) {
        const handler = createHandler({ storage, buildId, render: async (input) => {
                assert.deepEqual(input.artwork, artwork);
                assert.deepEqual(input.mockup, mockup);
                assert.deepEqual(input.settings, settings);
                assert.equal(input.baseProductSlug, VARIANTS[variantId].baseProductSlug);
                assert.deepEqual(input.motion, DEFAULT_STORY_MOTION);
                assert.deepEqual(input.encoding, ENCODING);
                assert.equal(input.preset, "veryfast");
                assert.equal(input.websiteLabel, "shop.bent.build");
                return encoded;
            } });
        const result = await handler(job(variantId), context);
        assert.equal(result.object.sha256, sha256(video));
        assert.equal(result.uniqueFrameCount, 91);
        assert.equal(result.runtime.firstInvocationInProcess, true);
    }
});
test("no result becomes ready before storage finishes", async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let ready = false;
    const handler = createHandler({ buildId, render: async () => encoded, storage: { ...storage,
            write: async (input) => { assert.deepEqual(input.video, video); await gate; return { etag: "stored", sha256: input.sha256 }; },
        } });
    const result = handler(job(), context).then((value) => { ready = true; return value; });
    await new Promise(setImmediate);
    assert.equal(ready, false);
    release();
    assert.equal((await result).object.etag, "stored");
});
test("rejects malformed settings, output overrides, external URLs and excessive recursion before any I/O", async () => {
    for (const input of [
        { ...job(), encoding: { frameWidth: 1 } }, { ...job(), storyKey: "production.mp4" },
        { ...job(), settings: { ...settings, depth: 9 } }, { ...job(), settings: { ...settings, cropX: NaN } },
        { ...job(), settings: { ...settings, placementX: 0.9 } }, { ...job(), customerId: "../../production" },
        { ...job(), artwork: { ...job().artwork, key: "https://evil.invalid/asset" } },
        { ...job(), artwork: { ...job().artwork, size: 25000001 } },
        { ...job(), mockup: { ...job().mockup, key: job("tee-white").mockup.key } },
        { ...job(), variantId: "toString" },
    ]) {
        let calls = 0;
        const handler = createHandler({ buildId, render: async () => { calls++; }, storage: { read: async () => { calls++; } } });
        await assert.rejects(handler(input, context));
        assert.equal(calls, 0);
    }
});
test("wrong account, function, alias, expired deadline and local entry cannot access storage", async () => {
    for (const invalid of [undefined, { ...context, invokedFunctionArn: FUNCTION_ARN.replace(protectedConfig("awsAccountId"), "111111111111") },
        { ...context, invokedFunctionArn: `${FUNCTION_ARN}:production` },
        { ...context, getRemainingTimeInMillis: () => 1 },
        { ...context, getRemainingTimeInMillis: () => NaN },
        { ...context, getRemainingTimeInMillis: () => Infinity },
        { ...context, awsRequestId: "" }]) {
        let calls = 0;
        const handler = createHandler({ buildId, render: async () => { calls++; }, storage: { read: async () => { calls++; } } });
        await assert.rejects(handler(job(), invalid), /isolated personal Lambda/);
        assert.equal(calls, 0);
    }
    // Entry imports no SDK/default credentials or native renderer before this rejection.
    await assert.rejects(entry(job(), undefined), /isolated personal Lambda/);
});
test("asset corruption, renderer failures and failed/checksum-mismatched writes never report success", async () => {
    let renders = 0;
    let writes = 0;
    const broken = createHandler({ buildId, render: async () => { renders++; },
        storage: { read: async () => Buffer.from("wrong"), write: async () => { writes++; } } });
    await assert.rejects(broken(job(), context), /checksum/);
    assert.equal(renders, 0);
    assert.equal(writes, 0);
    await assert.rejects(createHandler({ buildId, storage, render: async () => { throw new Error("encode failed"); } })(job(), context), /encode failed/);
    for (const write of [async () => { throw new Error("S3 failed"); }, async () => ({ etag: "ok", sha256: "wrong" })]) {
        await assert.rejects(createHandler({ buildId, render: async () => encoded, storage: { ...storage, write } })(job(), context));
    }
});
test("warm invocations reuse process identity, but never reuse per-customer inputs", async () => {
    const seen = [];
    const handler = createHandler({ buildId, storage, render: async (input) => { seen.push(input); return encoded; } });
    const first = await handler(job(), context);
    const second = await handler({ ...job("tote-cream", "customer-b"), settings: { ...settings, depth: 3 } }, { ...context, awsRequestId: "request-b" });
    assert.equal(first.runtime.instanceId, second.runtime.instanceId);
    assert.equal(second.runtime.invocationSequence, 2);
    assert.equal(second.runtime.firstInvocationInProcess, false);
    assert.equal(seen[0].settings.depth, 5);
    assert.equal(seen[1].settings.depth, 3);
    assert.notEqual(first.object.key, second.object.key);
});
test("output identity is canonical and changes with build, settings, artwork and variant", () => {
    const normalized = validateJob(job());
    const identity = jobIdentity(normalized, buildId);
    assert.deepEqual(jobIdentity(validateJob({ ...job(), settings: Object.fromEntries(Object.entries(settings).reverse()) }), buildId), identity);
    assert.notEqual(jobIdentity(normalized, "b".repeat(64)).digest, identity.digest);
    assert.notEqual(jobIdentity(validateJob({ ...job(), settings: { ...settings, depth: 4 } }), buildId).digest, identity.digest);
    assert.notEqual(jobIdentity(validateJob(job("tee-white")), buildId).digest, identity.digest);
    assert.notEqual(jobIdentity({ ...normalized, artwork: { ...normalized.artwork, sha256: "b".repeat(64) } }, buildId).digest, identity.digest);
});
test("runtime credentials are explicit, account-scoped, image-bound and cannot fall back", async () => {
    const env = { AWS_LAMBDA_FUNCTION_NAME: NAME, AWS_REGION: REGION, STORY_BUCKET: BUCKET,
        AWS_LAMBDA_RUNTIME_API: "runtime.internal", STORY_BUILD_ID: buildId, STORY_IMAGE_BUILD_ID: buildId,
        AWS_ACCESS_KEY_ID: "runtime-key", AWS_SECRET_ACCESS_KEY: "runtime-secret", AWS_SESSION_TOKEN: "runtime-token",
        AWS_PROFILE: "forbidden-work", AWS_ENDPOINT_URL_S3: "https://forbidden.invalid" };
    const config = runtimeClientConfig(env);
    assert.equal(config.endpoint, `https://s3.${REGION}.amazonaws.com`);
    assert.equal(config.maxAttempts, 1);
    assert.deepEqual(await config.credentials(), { accessKeyId: "runtime-key", secretAccessKey: "runtime-secret", sessionToken: "runtime-token" });
    for (const changes of [{ STORY_IMAGE_BUILD_ID: "wrong" }, { AWS_REGION: "us-east-1" }, { STORY_BUCKET: "work" }, { AWS_SESSION_TOKEN: "" }]) {
        assert.throws(() => runtimeClientConfig({ ...env, ...changes }), /isolated Lambda/);
    }
    delete env.AWS_SESSION_TOKEN;
    await assert.rejects(config.credentials(), /unavailable/);
});
test("failed asset reads cancel and settle the sibling before returning", async () => {
    let cancelled = false;
    const handler = createHandler({ buildId, render: async () => { throw new Error("must not render"); }, storage: {
            read: async (ref, { signal }) => {
                if (ref.key.includes("artwork"))
                    throw new Error("artwork unavailable");
                await new Promise((resolve) => signal.addEventListener("abort", () => { cancelled = true; resolve(); }, { once: true }));
                throw new Error("cancelled sibling");
            },
        } });
    await assert.rejects(handler(job(), context), /artwork unavailable/);
    assert.equal(cancelled, true);
});
