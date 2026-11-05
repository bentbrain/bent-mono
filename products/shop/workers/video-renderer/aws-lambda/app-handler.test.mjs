import { protectedConfig } from "./protected-config.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { APP_ARN, createAppHandler, validateAppJob } from "./app-handler.mjs";
import { handler as entry } from "./app-entry.mjs";
import { sha256 } from "./contract.mjs";
import { ENCODING, VARIANTS } from "./config.mjs";
import { DEFAULT_STORY_MOTION } from "../src/geometry.mjs";
const artwork = Buffer.from("saved artwork"), video = Buffer.from("encoded MP4");
const context = { invokedFunctionArn: APP_ARN, awsRequestId: "test", getRemainingTimeInMillis: () => 120000 };
const settings = { cropX: 0.48, cropY: 0.6, cropZoom: 1.1, placementX: 0.28, placementY: 0.26, placementWidth: 0.4, depth: 5 };
const id = "11111111-1111-1111-1111-111111111111";
function job(variant = VARIANTS["tee-black"]) {
    return { schemaVersion: 1, jobId: id, attempt: 1, artwork: { size: artwork.length, sha256: sha256(artwork) },
        baseProductSlug: variant.baseProductSlug, color: variant.color, settings,
        storyKey: `story-videos/v7/${id}/${id}/${variant.color.toLowerCase()}.mp4`, rendererVersion: "story-video-renderer-v7", grant: "payload.signature" };
}
function dependencies(input = job()) {
    return { apiOrigin: "https://forever-tee-api-development.socialqueue.workers.dev", buildId: "a".repeat(64), readMockup: async (file) => Buffer.from(file),
        render: async () => ({ video, renderTimeMs: 4 }), send: async (url, options) => {
            assert.equal(options.headers.authorization, "Bearer payload.signature");
            assert.equal(options.redirect, "error");
            if (url.endsWith("/claim"))
                return new Response(null, { status: 201 });
            if (url.endsWith("/failure"))
                return new Response(null, { status: 204 });
            if (url.endsWith("/artwork"))
                return new Response(artwork);
            assert.equal(options.method, "PUT");
            assert.deepEqual(options.body, video);
            return Response.json({ key: input.storyKey, size: video.length, sha256: sha256(video) });
        } };
}
test("all four variants retain approved geometry, easing and encoding", async () => {
    for (const variant of Object.values(VARIANTS)) {
        const input = job(variant);
        const handler = createAppHandler({ ...dependencies(input), render: async (scene) => {
                assert.deepEqual(scene.artwork, artwork);
                assert.deepEqual(scene.mockup, Buffer.from(variant.file));
                assert.deepEqual(scene.settings, settings);
                assert.deepEqual(scene.motion, DEFAULT_STORY_MOTION);
                assert.deepEqual(scene.encoding, ENCODING);
                assert.equal(scene.baseProductSlug, variant.baseProductSlug);
                return { video, renderTimeMs: 4 };
            } });
        const result = await handler(input, context);
        assert.equal(result.sha256, sha256(video));
        assert.equal(result.storyKey, input.storyKey);
    }
});
test("duplicate deliveries claim once and skip duplicate encoding", async () => {
    let owner, renders = 0;
    const base = dependencies();
    const handler = createAppHandler({ ...base, render: async () => { renders++; return { video, renderTimeMs: 4 }; },
        send: async (url, init) => {
            if (url.endsWith("/claim")) {
                owner ??= init.headers["x-video-execution-id"];
                return new Response(null, { status: owner === init.headers["x-video-execution-id"] ? 201 : 204 });
            }
            return base.send(url, init);
        } });
    const results = await Promise.all([handler(job(), context), handler(job(), context)]);
    assert.equal(renders, 1);
    assert.equal(results.filter(result => result.status === "skipped").length, 1);
});
test("a lost claim response retries with the same execution identity before rendering", async () => {
    const base = dependencies();
    let owner, claims = 0, renders = 0;
    const handler = createAppHandler({ ...base, render: async () => { renders++; return { video, renderTimeMs: 4 }; },
        send: async (url, init) => {
            if (url.endsWith("/claim")) {
                owner ??= init.headers["x-video-execution-id"];
                assert.equal(init.headers["x-video-execution-id"], owner);
                if (++claims === 1)
                    throw new Error("Claim committed, response lost");
                return new Response(null, { status: 201 });
            }
            return base.send(url, init);
        } });
    await handler(job(), context);
    assert.equal(claims, 2);
    assert.equal(renders, 1);
});
test("a failed owner reports its execution identity, never an unfenced failure", async () => {
    let owner, failure;
    const handler = createAppHandler({ ...dependencies(), render: async () => { throw new Error("Encoder failed"); },
        send: async (url, init) => {
            if (url.endsWith("/claim")) {
                owner = init.headers["x-video-execution-id"];
                return new Response(null, { status: 201 });
            }
            if (url.endsWith("/failure")) {
                failure = init.headers["x-video-execution-id"];
                return new Response(null, { status: 204 });
            }
            return new Response(artwork);
        } });
    await assert.rejects(handler(job(), context), /Encoder failed/);
    assert.equal(owner, failure);
    assert.ok(owner);
});
test("invalid events cannot choose URLs, keys, settings or a different renderer", () => {
    for (const input of [{ ...job(), url: "https://evil.test" }, { ...job(), color: "toString" },
        { ...job(), settings: { ...settings, depth: 100 } }, { ...job(), attempt: 4 },
        { ...job(), storyKey: "../../production.mp4" }, { ...job(), rendererVersion: "v99" },
        { ...job(), artwork: { ...job().artwork, size: 25000001 } }])
        assert.throws(() => validateAppJob(input));
});
test("wrong account, function, aliases and local entry are rejected before I/O", async () => {
    for (const invalid of [undefined, { ...context, invokedFunctionArn: APP_ARN.replace(protectedConfig("awsAccountId"), "111111111111") },
        { ...context, invokedFunctionArn: `${APP_ARN}:alias` }, { ...context, getRemainingTimeInMillis: () => NaN }]) {
        await assert.rejects(entry(job(), invalid), /personal app Lambda/);
    }
});
test("read retries are bounded; upload is single attempt and acknowledgement is required", async () => {
    let reads = 0, writes = 0;
    const handler = createAppHandler({ ...dependencies(), send: async (url) => {
            if (url.endsWith("/claim"))
                return new Response(null, { status: 201 });
            if (url.endsWith("/failure"))
                return new Response(null, { status: 204 });
            if (url.endsWith("/artwork")) {
                reads++;
                return reads < 3 ? new Response(null, { status: 503 }) : new Response(artwork);
            }
            writes++;
            throw new Error("Lost upload response");
        } });
    await assert.rejects(handler(job(), context), /Lost upload/);
    assert.equal(reads, 3);
    assert.equal(writes, 1);
});
test("corrupt/truncated/oversized/unauthorized source bytes never render", async () => {
    for (const response of [new Response("bad"), new Response(Buffer.alloc(artwork.length)),
        new Response(Buffer.alloc(artwork.length + 1)), new Response(null, { status: 403 })]) {
        let renders = 0;
        await assert.rejects(createAppHandler({ ...dependencies(), send: async (url) => url.endsWith("/claim")
                ? new Response(null, { status: 201 }) : response, render: async () => { renders++; } })(job(), context));
        assert.equal(renders, 0);
    }
});
test("mismatched storage acknowledgement cannot become ready", async () => {
    const handler = createAppHandler({ ...dependencies(), send: async (url) => url.endsWith("/claim")
            ? new Response(null, { status: 201 }) : url.endsWith("/artwork") ? new Response(artwork)
            : Response.json({ key: "wrong", size: video.length, sha256: sha256(video) }) });
    await assert.rejects(handler(job(), context), /acknowledge/);
});
test("termination injection requires the trusted Development header, first attempt and valid artwork", async () => {
    let terminations = 0, renders = 0;
    const base = dependencies();
    const create = (environment = "development", header = id, bytes = artwork) => createAppHandler({ ...base, environment,
        apiOrigin: environment === "production" ? "https://forever-tee-api.socialqueue.workers.dev" : base.apiOrigin,
        terminateQualification: async (jobId, executionId, invocation) => {
            assert.equal(jobId, id);
            assert.match(executionId, /^[a-f0-9-]{36}$/);
            assert.equal(invocation, context);
            terminations++;
            throw new Error("Test-only termination sentinel");
        },
        render: async () => { renders++; return { video, renderTimeMs: 4 }; },
        send: async (url, options) => url.endsWith("/artwork")
            ? new Response(bytes, { headers: { "x-native-qualification-terminate": header } }) : base.send(url, options),
    });
    await assert.rejects(create()(job(), context), /termination sentinel/);
    assert.equal(terminations, 1);
    assert.equal(renders, 0);
    await create()({ ...job(), attempt: 2 }, context);
    await create("development", "foreign-job")(job(), context);
    await create("production")(job(), { ...context, invokedFunctionArn: APP_ARN.replace("development", "production") });
    await assert.rejects(create("development", id, Buffer.alloc(artwork.length))(job(), context), /checksum/);
    assert.equal(terminations, 1);
    assert.equal(renders, 3);
});
test("v2 composition fetches and verifies a distinct recursive source using the same execution fence", async () => {
    const nested = Buffer.from("different attachment cutout");
    const input = { ...job(), schemaVersion: 2,
        recursiveSource: { sha256: sha256(nested), size: nested.length, cropX: 0.5, cropY: 0.4, cropZoom: 1.2 } };
    const base = dependencies(input);
    let fence;
    const handler = createAppHandler({ ...base, send: async (url, options) => {
            fence ??= options.headers["x-video-execution-id"];
            assert.equal(options.headers["x-video-execution-id"], fence);
            if (url.endsWith("/recursive-artwork"))
                return new Response(nested);
            return base.send(url, options);
        }, render: async (scene) => {
            assert.deepEqual(scene.artwork, artwork);
            assert.deepEqual(scene.recursiveArtwork, nested);
            assert.deepEqual(scene.recursiveCrop, { cropX: 0.5, cropY: 0.4, cropZoom: 1.2 });
            return { video, renderTimeMs: 1 };
        } });
    await handler(input, context);
    const corrupt = createAppHandler({ ...base, send: async (url, options) => url.endsWith("/recursive-artwork")
            ? new Response(Buffer.alloc(nested.length)) : base.send(url, options),
        render: async () => { throw new Error("Corrupt attachment must not render"); } });
    await assert.rejects(corrupt(input, context), /Recursive artwork checksum/);
    assert.throws(() => validateAppJob({ ...input, schemaVersion: 1 }), /Invalid app job/);
    assert.throws(() => validateAppJob({ ...input, recursiveSource: { ...input.recursiveSource, cropZoom: 3 } }), /cropZoom/);
});
test("v3 carries independent chest placement to the renderer and rejects malformed placement", async () => {
    const nested = Buffer.from("plain shirt cutout");
    const placement = { placementX: 0.267994, placementY: 0.48, placementWidth: 0.455717 };
    const input = { ...job(), schemaVersion: 3,
        recursiveSource: { sha256: sha256(nested), size: nested.length, cropX: 0.507, cropY: 0.6485, cropZoom: 1.375, placement } };
    const base = dependencies(input);
    await createAppHandler({ ...base, send: (url, options) => url.endsWith("/recursive-artwork")
            ? Promise.resolve(new Response(nested)) : base.send(url, options),
        render: async (scene) => {
            assert.deepEqual(scene.recursivePlacement, placement);
            assert.deepEqual(scene.recursiveArtwork, nested);
            return { video, renderTimeMs: 1 };
        } })(input, context);
    for (const invalid of [null, {}, { ...placement, placementY: -0.1 }, { ...placement, placementWidth: 1 },
        { ...placement, placementY: 0.9 }, { ...placement, placementX: NaN }, { ...placement, extra: 1 }]) {
        assert.throws(() => validateAppJob({ ...input, recursiveSource: { ...input.recursiveSource, placement: invalid } }), /recursive placement/);
    }
    assert.throws(() => validateAppJob({ ...input, schemaVersion: 2 }), /recursive source/);
});
