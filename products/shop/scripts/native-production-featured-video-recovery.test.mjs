import { protectedConfig } from "./protected-config.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { FEATURED_PRODUCT_IDS, featuredVideoRecoveryPlan, prepareFeaturedVideos, recoverFeaturedProductVideos, storeFeaturedVideo, } from "./native-production-featured-video-recovery.mjs";
const revision = "c2bf0318-784a-4dda-b82b-9534aed42903";
const artworkSha = protectedConfig("resource_73e91e639e8e");
const variants = [
    [FEATURED_PRODUCT_IDS.shirt, "a51b7acf-77e9-4762-83c4-62d96dd8942c", "Black", "11111111-1111-4111-8111-111111111111-v5-v6-v7"],
    [FEATURED_PRODUCT_IDS.shirt, "a51b7acf-77e9-4762-83c4-62d96dd8942c", "White", "22222222-2222-4222-8222-222222222222-v5-v6-v7"],
    [FEATURED_PRODUCT_IDS.tote, "97b629d7-1d3b-4d2a-a586-537168141e97", "Black", "33333333-3333-4333-8333-333333333333-v5-v6-v7"],
    [FEATURED_PRODUCT_IDS.tote, "97b629d7-1d3b-4d2a-a586-537168141e97", "Cream", "44444444-4444-4444-8444-444444444444-v5-v6-v7"],
];
const failedRows = variants.map(([product_id, base_product_id, colour, id]) => ({
    artwork_key: `designs/${revision}/artwork/${artworkSha}`,
    artwork_sha256: artworkSha,
    artwork_size: 6120149,
    attempt_count: 3,
    base_product_id,
    colour,
    content_type: "image/png",
    crop_x: 0.47,
    crop_y: 0.62,
    crop_zoom: 1.06,
    design_revision_id: revision,
    id,
    last_error: "Invalid render grant.",
    output_byte_size: null,
    placement_depth: 5,
    placement_width: product_id === FEATURED_PRODUCT_IDS.shirt ? 0.48 : 0.440042,
    placement_x: product_id === FEATURED_PRODUCT_IDS.shirt ? 0.27167119387154753 : 0.290678,
    placement_y: product_id === FEATURED_PRODUCT_IDS.shirt ? 0.22145055477692505 : 0.244638,
    product_id,
    renderer_version: "story-video-renderer-v7",
    status: "failed",
    story_key: `story-videos/v7/${revision}/${product_id}/${colour.toLowerCase()}.mp4`,
}));
test("featured recovery admits only the exact exhausted four-video family and supports partial replay", () => {
    const plan = featuredVideoRecoveryPlan(failedRows);
    assert.equal(plan.count, 4);
    assert.equal(plan.pending.length, 4);
    assert.equal(plan.revision, revision);
    const partial = failedRows.map((row, index) => index === 0
        ? { ...row, last_error: null, output_byte_size: 1234, status: "ready" }
        : row);
    assert.equal(featuredVideoRecoveryPlan(partial).pending.length, 3);
    for (const rows of [
        failedRows.slice(1),
        failedRows.map((row, index) => index === 0 ? { ...row, attempt_count: 2 } : row),
        failedRows.map((row, index) => index === 0 ? { ...row, last_error: "private failure" } : row),
        failedRows.map((row, index) => index === 0 ? { ...row, artwork_sha256: "a".repeat(64) } : row),
    ])
        assert.throws(() => featuredVideoRecoveryPlan(rows));
});
test("featured rendering uses each product's stored physical placement without transforming it", async () => {
    const calls = [];
    const prepared = await prepareFeaturedVideos(failedRows, Buffer.from("artwork"), {
        loadMockup: async (file) => Buffer.from(file),
        render: async (input) => {
            calls.push(input);
            return { video: Buffer.from(`video-${calls.length}`) };
        },
    });
    assert.equal(prepared.length, 4);
    assert.deepEqual(calls.map(call => ({ slug: call.baseProductSlug, settings: call.settings })), failedRows.map(row => ({
        slug: row.product_id === FEATURED_PRODUCT_IDS.shirt ? "staple-tee" : "cotton-tote",
        settings: {
            cropX: row.crop_x, cropY: row.crop_y, cropZoom: row.crop_zoom,
            depth: row.placement_depth, placementWidth: row.placement_width,
            placementX: row.placement_x, placementY: row.placement_y,
        },
    })));
    assert.ok(calls.every(call => call.encoding.frameWidth === 720 && call.encoding.scaleBeforeHold === true));
});
test("featured storage is idempotent and accepts only identical immutable bytes", async () => {
    const video = Buffer.from("exact-video");
    const job = { row: failedRows[0], sha256: createHash("sha256").update(video).digest("hex"), video };
    const uploaded = [];
    const missing = { featuredVideo: async (key, bytes) => {
            uploaded.push({ bytes, key });
            return bytes === undefined ? new Response(null, { status: 404 }) : Response.json({
                result: { key, size: String(bytes.length) }, success: true,
            });
        } };
    await storeFeaturedVideo(missing, job);
    assert.equal(uploaded.length, 2);
    assert.equal(uploaded[1].key, job.row.story_key);
    assert.deepEqual(uploaded[1].bytes, video);
    let reads = 0;
    await storeFeaturedVideo({ featuredVideo: async () => { reads += 1; return new Response(video); } }, job);
    assert.equal(reads, 1);
    await assert.rejects(storeFeaturedVideo({ featuredVideo: async () => new Response("different") }, job), /does not match/);
});
test("featured recovery stores and publishes only the pinned failed legacy jobs", async () => {
    const rows = structuredClone(failedRows);
    const queries = [];
    const stored = [];
    const cf = { query: async (sql, params = []) => {
            queries.push({ sql, params });
            if (sql.includes("FROM story_video_jobs AS jobs"))
                return [{ results: structuredClone(rows) }];
            if (sql.includes("UPDATE story_video_jobs SET status='ready'"))
                return [{ meta: { changes: 1 } }];
            throw new Error(`Unexpected SQL: ${sql}`);
        } };
    const result = await recoverFeaturedProductVideos({ NATIVE_OPERATION: "repair-featured-videos" }, { cf, loadArtwork: async () => Buffer.from("artwork"), now: () => 1000,
        prepare: async (pending) => pending.map(row => ({ row, sha256: "a".repeat(64), video: Buffer.from(row.colour) })),
        skipLiveContext: true, store: async (_cf, job) => {
            stored.push({ id: job.row.id, key: job.row.story_key });
            const row = rows.find(value => value.id === job.row.id);
            row.status = "ready";
            row.last_error = null;
            row.output_byte_size = job.video.length;
        }, verifyContext: () => undefined, verifyPublic: async () => undefined });
    assert.equal(result.featuredVideoRecoveryComplete, true);
    assert.equal(result.repaired, 4);
    assert.equal(stored.length, 4);
    assert.equal(queries.filter(({ sql }) => sql.includes("UPDATE story_video_jobs SET status='ready'")).length, 4);
    assert.deepEqual(queries.filter(({ sql }) => sql.includes("UPDATE story_video_jobs SET status='ready'"))
        .map(({ params }) => params.slice(-2)), failedRows.map(row => [revision, row.product_id]));
});
test("featured recovery refuses a paused release before rendering", async () => {
    const cf = {
        query: async (sql) => sql.includes("native_video_release_control")
            ? [{ results: [{ current_release_id: "native-" + protectedConfig("resource_7adca284c1f4"), paused: 1, release_id: "native-other" }] }]
            : [{ results: failedRows }],
    };
    await assert.rejects(recoverFeaturedProductVideos({ NATIVE_OPERATION: "repair-featured-videos" }, { cf, verifyContext: () => undefined }), /unpaused/);
});
