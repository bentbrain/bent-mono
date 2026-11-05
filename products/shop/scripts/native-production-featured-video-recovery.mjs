import { protectedConfig } from "./protected-config.mjs";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { validateSettings } from "../workers/video-renderer/aws-lambda/contract.mjs";
import { productionCloudflare } from "./native-production-cloudflare.mjs";
import { assertProductionContext } from "./native-production-ci.mjs";
const check = (value, reason) => {
    if (!value)
        throw new Error(`Featured video recovery stopped: ${reason}`);
};
const RENDERER_VERSION = "story-video-renderer-v7";
const MIGRATED_JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-v5-v6-v7$/;
const FEATURED_REVISION = "c2bf0318-784a-4dda-b82b-9534aed42903";
const FEATURED_ARTWORK = Object.freeze({
    contentType: "image/png",
    key: "designs/" + (FEATURED_REVISION) + "/artwork/" + protectedConfig("resource_73e91e639e8e"),
    sha256: protectedConfig("resource_73e91e639e8e"),
    size: 6120149,
});
const REPAIRABLE_FAILURES = new Set(["Invalid render grant.", "LAMBDA_DELIVERY_FAILED", "STALE_RENDER_EXHAUSTED"]);
export const FEATURED_PRODUCT_IDS = Object.freeze({
    shirt: "d2dd07c1-dbbf-4d1a-8df7-9c43b4a7dfc4",
    tote: "55b53491-a09d-4f50-b9f6-73fbd3fabff9",
});
const EXPECTED_JOBS = new Map([
    [`${FEATURED_PRODUCT_IDS.shirt}:black`, { baseProductId: "a51b7acf-77e9-4762-83c4-62d96dd8942c", mockup: "tee-black-cutout-v1.png", slug: "staple-tee" }],
    [`${FEATURED_PRODUCT_IDS.shirt}:white`, { baseProductId: "a51b7acf-77e9-4762-83c4-62d96dd8942c", mockup: "tee-white-cutout-v1.png", slug: "staple-tee" }],
    [`${FEATURED_PRODUCT_IDS.tote}:black`, { baseProductId: "97b629d7-1d3b-4d2a-a586-537168141e97", mockup: "tote-black-print-bar-1001.webp", slug: "cotton-tote" }],
    [`${FEATURED_PRODUCT_IDS.tote}:cream`, { baseProductId: "97b629d7-1d3b-4d2a-a586-537168141e97", mockup: "tote-cream-print-bar-1001.webp", slug: "cotton-tote" }],
]);
function expectedJob(row) {
    return EXPECTED_JOBS.get(`${row.product_id}:${String(row.colour).toLowerCase()}`);
}
export function featuredVideoRecoveryPlan(rows) {
    check(Array.isArray(rows) && rows.length === EXPECTED_JOBS.size, "exactly four Featured Design jobs are required.");
    const observed = new Set();
    const pending = [];
    for (const row of rows) {
        const key = `${row.product_id}:${String(row.colour).toLowerCase()}`;
        const expected = expectedJob(row);
        check(expected?.baseProductId === row.base_product_id && !observed.has(key), "unexpected Featured Design product or colour.");
        check(typeof row.id === "string" && MIGRATED_JOB_ID.test(row.id) && row.design_revision_id === FEATURED_REVISION &&
            row.renderer_version === RENDERER_VERSION && row.attempt_count === 3, "invalid Featured Design job identity.");
        check(row.artwork_key === FEATURED_ARTWORK.key && row.artwork_sha256 === FEATURED_ARTWORK.sha256 &&
            row.artwork_size === FEATURED_ARTWORK.size && row.content_type === FEATURED_ARTWORK.contentType, "Featured Design artwork metadata changed.");
        check(row.story_key === `story-videos/v7/${FEATURED_REVISION}/${row.product_id}/${String(row.colour).toLowerCase()}.mp4`, "Featured Design video key changed.");
        const failed = row.status === "failed" && REPAIRABLE_FAILURES.has(row.last_error);
        const ready = row.status === "ready" && row.last_error === null && Number.isSafeInteger(row.output_byte_size) && row.output_byte_size > 0;
        check(failed || ready, "only the exact exhausted or already-repaired Featured Design jobs are admissible.");
        if (failed)
            pending.push(row);
        observed.add(key);
    }
    check(observed.size === EXPECTED_JOBS.size, "the complete Featured Design family is required.");
    return { count: EXPECTED_JOBS.size, pending, productIds: [FEATURED_PRODUCT_IDS.shirt, FEATURED_PRODUCT_IDS.tote], revision: FEATURED_REVISION };
}
async function verifyRecoveryContext(cf) {
    const rows = (await cf.query("SELECT paused, release_id, current_release_id FROM native_video_release_control WHERE singleton=1"))[0].results;
    const control = rows[0];
    check(rows.length === 1 && control.paused === 0 && control.release_id === null &&
        /^native-[1-9][0-9]+$/.test(control.current_release_id), "Production must be unpaused on a recorded release.");
    const active = (await cf.deployments()).deployments?.[0]?.versions;
    check(active?.length === 1 && active[0].percentage === 100 && /^[0-9a-f-]{36}$/.test(active[0].version_id), "one active Worker version is required.");
    const version = await cf.version(active[0].version_id);
    const binding = name => {
        const matches = version.resources?.bindings?.filter(value => value.name === name);
        check(matches?.length === 1 && matches[0].type === "plain_text", `one ${name} text binding is required.`);
        return matches[0].text;
    };
    check(binding("STORY_VIDEO_PROVIDER") === "lambda" && binding("STORY_VIDEO_ENVIRONMENT") === "production" &&
        binding("STORY_VIDEO_RELEASE_ID") === control.current_release_id, "the active Worker must be the recorded Production Lambda release.");
    return { releaseId: control.current_release_id, workerVersion: version.id };
}
async function loadFeaturedArtwork(cf) {
    const response = await cf.featuredArtwork(FEATURED_ARTWORK.key);
    const bytes = Buffer.from(await response.arrayBuffer());
    check(bytes.length === FEATURED_ARTWORK.size && createHash("sha256").update(bytes).digest("hex") === FEATURED_ARTWORK.sha256, "Featured Design artwork bytes do not match the immutable ledger.");
    return bytes;
}
export async function prepareFeaturedVideos(rows, artwork, dependencies = {}) {
    const render = dependencies.render ?? (await import("../workers/video-renderer/src/renderer.mjs")).renderStoryVideo;
    const loadMockup = dependencies.loadMockup ?? (file => readFile(new URL(`../apps/web/public/mockups/${file}`, import.meta.url)));
    const mockups = new Map();
    const prepared = [];
    for (const row of rows) {
        const expected = expectedJob(row);
        check(expected, "unexpected Featured Design render job.");
        if (!mockups.has(expected.mockup))
            mockups.set(expected.mockup, await loadMockup(expected.mockup));
        const settings = validateSettings({
            cropX: row.crop_x, cropY: row.crop_y, cropZoom: row.crop_zoom,
            depth: row.placement_depth, placementWidth: row.placement_width,
            placementX: row.placement_x, placementY: row.placement_y,
        });
        const result = await render({ artwork, baseProductSlug: expected.slug,
            encoding: { crf: 21, frameRate: 30, frameWidth: 720, scaleBeforeHold: true },
            mockup: mockups.get(expected.mockup), preset: "veryfast", settings, websiteLabel: "shop.bent.build" });
        check(Buffer.isBuffer(result.video) && result.video.length > 0 && result.video.length <= 32000000, "Featured Design renderer returned an invalid video.");
        prepared.push({ row, sha256: createHash("sha256").update(result.video).digest("hex"), video: result.video });
    }
    return prepared;
}
async function readStoredFeaturedVideo(cf, job) {
    const response = await cf.featuredVideo(job.row.story_key);
    if (response.status === 404)
        return false;
    const bytes = Buffer.from(await response.arrayBuffer());
    check(bytes.length === job.video.length && createHash("sha256").update(bytes).digest("hex") === job.sha256, `stored ${String(job.row.colour).toLowerCase()} video does not match the prepared bytes.`);
    return true;
}
export async function storeFeaturedVideo(cf, job) {
    if (await readStoredFeaturedVideo(cf, job))
        return;
    const response = await cf.featuredVideo(job.row.story_key, job.video);
    if (response.status === 412) {
        check(await readStoredFeaturedVideo(cf, job), "concurrent Featured Design video upload was not preserved.");
        return;
    }
    const acknowledgement = await response.json();
    check(acknowledgement?.success === true && acknowledgement.result?.key === job.row.story_key &&
        Number(acknowledgement.result.size) === job.video.length, `stored ${String(job.row.colour).toLowerCase()} video was not acknowledged.`);
}
async function verifyPublicVideos(request = fetch) {
    for (const key of EXPECTED_JOBS.keys()) {
        const [productId, color] = key.split(":");
        const response = await request(`https://shop.bent.build/api/configured-product-video/${productId}/${color}.mp4`, {
            method: "HEAD", redirect: "error", signal: AbortSignal.timeout(30000),
        });
        check(response.ok && response.headers.get("content-type") === "video/mp4", `public ${color} video is unavailable.`);
    }
}
const JOBS_SQL = `SELECT jobs.id, jobs.product_id, jobs.design_revision_id, jobs.colour, jobs.renderer_version,
    jobs.story_key, jobs.status, jobs.attempt_count, jobs.output_byte_size, jobs.last_error,
    products.base_product_id, products.placement_x, products.placement_y, products.placement_width,
    products.placement_depth, revisions.artwork_key, revisions.content_type,
    revisions.byte_size AS artwork_size, revisions.sha256 AS artwork_sha256,
    revisions.crop_x, revisions.crop_y, revisions.crop_zoom
  FROM story_video_jobs AS jobs
  JOIN products ON products.id=jobs.product_id AND products.design_revision_id=jobs.design_revision_id
    AND products.status='active' AND products.placement_x IS NOT NULL AND products.placement_y IS NOT NULL
    AND products.placement_width IS NOT NULL AND products.placement_depth IS NOT NULL
  JOIN design_revisions AS revisions ON revisions.id=jobs.design_revision_id AND revisions.design_id=products.design_id
  WHERE jobs.renderer_version=? AND jobs.product_id IN (?,?) ORDER BY jobs.product_id, jobs.colour`;
export async function recoverFeaturedProductVideos(env, dependencies = {}) {
    (dependencies.verifyContext ?? assertProductionContext)(env);
    check(env.NATIVE_OPERATION === "repair-featured-videos", "explicit repair operation is required.");
    const cf = dependencies.cf ?? productionCloudflare(env);
    const context = dependencies.skipLiveContext ? undefined : await verifyRecoveryContext(cf);
    const readRows = async () => (await cf.query(JOBS_SQL, [RENDERER_VERSION, FEATURED_PRODUCT_IDS.shirt, FEATURED_PRODUCT_IDS.tote]))[0].results;
    const plan = featuredVideoRecoveryPlan(await readRows());
    const artwork = plan.pending.length > 0 ? await (dependencies.loadArtwork ?? loadFeaturedArtwork)(cf) : Buffer.alloc(0);
    const prepared = await (dependencies.prepare ?? prepareFeaturedVideos)(plan.pending, artwork);
    for (const job of prepared) {
        const updatedAt = (dependencies.now ?? Date.now)();
        await (dependencies.store ?? storeFeaturedVideo)(cf, job);
        const published = await cf.query(`UPDATE story_video_jobs SET status='ready', output_byte_size=?, last_error=NULL,
      execution_id=NULL, updated_at=?, rendered_at=?
      WHERE id=? AND renderer_version=? AND status='failed' AND attempt_count=3 AND last_error=? AND design_revision_id=? AND product_id=?`, [
            job.video.length, updatedAt, updatedAt, job.row.id, RENDERER_VERSION, job.row.last_error, FEATURED_REVISION, job.row.product_id,
        ]);
        check(published.length === 1 && published[0].meta?.changes === 1, "the exact Featured Design video job was not published.");
    }
    const finalPlan = featuredVideoRecoveryPlan(await readRows());
    check(finalPlan.pending.length === 0, "not all four Featured Design videos reached ready state.");
    await (dependencies.verifyPublic ?? verifyPublicVideos)();
    return { featuredVideoRecoveryComplete: true, releaseId: context?.releaseId, revision: plan.revision,
        videos: plan.count, repaired: prepared.length, workerVersion: context?.workerVersion };
}
