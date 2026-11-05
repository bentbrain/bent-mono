import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { projectEditorPlacement } from "../packages/contracts/src/product-projection.ts";
import { productionCloudflare } from "./native-production-cloudflare.mjs";
import { assertProductionContext } from "./native-production-ci.mjs";
const check = (value, reason) => {
    if (!value)
        throw new Error(`Production Product sweep stopped: ${reason}`);
};
const RENDERER_VERSION = "story-video-renderer-v7";
const PRODUCT_COLOR_MODEL = "gpt-5.6-luna";
const SHIRT = "a51b7acf-77e9-4762-83c4-62d96dd8942c";
const TOTE = "97b629d7-1d3b-4d2a-a586-537168141e97";
const MAX_DESIGNS = 250;
const MAX_PRODUCTS = MAX_DESIGNS * 2;
const MAX_VIDEOS = MAX_PRODUCTS * 2;
const POLL_INTERVAL_MS = 15000;
const POLL_TIMEOUT_MS = 30 * 60000;
const COLOR_ROWS_SQL = `SELECT id, owner_id, artwork_key, byte_size, sha256
  FROM designs WHERE status='ready' AND deleted_at IS NULL
    AND default_product_color_status='fallback' ORDER BY id`;
const FAMILY_REPLAY_SQL = `SELECT designs.id, designs.owner_id, designs.version
  FROM designs
  LEFT JOIN products ON products.design_id=designs.id AND products.status='active'
  WHERE designs.status='ready' AND designs.deleted_at IS NULL AND designs.finalized_at IS NOT NULL AND designs.owner_id IS NOT NULL
  GROUP BY designs.id, designs.owner_id, designs.version
  HAVING count(DISTINCT products.base_product_id)<2
  ORDER BY designs.id`;
const LEGACY_PRODUCT_SQL = `SELECT designs.id, designs.placement_x, designs.placement_y, designs.placement_width, designs.depth
  FROM designs LEFT JOIN products AS tote ON tote.design_id=designs.id AND tote.status='active' AND tote.base_product_id=?
  WHERE designs.status='ready' AND designs.deleted_at IS NULL AND designs.finalized_at IS NOT NULL
    AND designs.owner_id IS NULL AND tote.id IS NULL ORDER BY designs.id`;
const VIDEO_GAP_SQL = `SELECT products.id, products.design_revision_id, products.base_product_id,
    group_concat(CASE WHEN jobs.renderer_version=? THEN lower(jobs.colour) END) AS colours
  FROM products LEFT JOIN story_video_jobs AS jobs ON jobs.product_id=products.id
  WHERE products.status='active' AND products.design_id IS NOT NULL AND products.design_revision_id IS NOT NULL
  GROUP BY products.id, products.design_revision_id, products.base_product_id
  HAVING count(CASE WHEN jobs.renderer_version=? THEN 1 END)<2 ORDER BY products.id`;
const INCOMPATIBLE_VIDEO_JOB_SQL = `SELECT jobs.id FROM story_video_jobs AS jobs
  WHERE jobs.renderer_version=? AND jobs.status='failed' AND jobs.attempt_count=3
    AND jobs.last_error='Invalid render grant.' AND length(jobs.id)=39 AND substr(jobs.id,37,3)='-v7'
    AND EXISTS (SELECT 1 FROM products WHERE products.id=jobs.product_id AND products.status='active'
      AND products.design_revision_id=jobs.design_revision_id) ORDER BY jobs.id`;
const AUDIT_SQL = `SELECT
  (SELECT count(*) FROM designs WHERE status='ready' AND deleted_at IS NULL) AS ready_designs,
  (SELECT count(*) FROM designs WHERE status='ready' AND deleted_at IS NULL AND default_product_color_status='complete' AND default_product_color_model IS NOT NULL) AS complete_colors,
  (SELECT count(*) FROM designs WHERE status='ready' AND deleted_at IS NULL AND finalized_at IS NOT NULL) AS finalized_designs,
  (SELECT count(*) FROM products WHERE status='active' AND design_id IS NOT NULL) AS active_products,
  (SELECT count(*) FROM products JOIN designs ON designs.id=products.design_id WHERE products.status='active' AND products.default_color<>designs.default_product_color) AS default_mismatches,
  (SELECT count(*) FROM (SELECT designs.id FROM designs LEFT JOIN products ON products.design_id=designs.id AND products.status='active'
    WHERE designs.status='ready' AND designs.deleted_at IS NULL AND designs.finalized_at IS NOT NULL GROUP BY designs.id
    HAVING count(DISTINCT products.base_product_id)=2 AND sum(CASE WHEN products.base_product_id IN (?,?) THEN 1 ELSE 0 END)=2)) AS complete_families,
  (SELECT count(*) FROM story_video_jobs AS jobs JOIN products ON products.id=jobs.product_id AND products.status='active' AND products.design_revision_id=jobs.design_revision_id
    WHERE jobs.renderer_version=?) AS video_jobs,
  (SELECT count(*) FROM story_video_jobs AS jobs JOIN products ON products.id=jobs.product_id AND products.status='active' AND products.design_revision_id=jobs.design_revision_id
    WHERE jobs.renderer_version=? AND jobs.status='ready') AS ready_videos,
  (SELECT count(*) FROM story_video_jobs AS jobs JOIN products ON products.id=jobs.product_id AND products.status='active' AND products.design_revision_id=jobs.design_revision_id
    WHERE jobs.renderer_version=? AND jobs.status='failed' AND jobs.attempt_count>=3) AS terminal_videos`;
const VIDEO_ROWS_SQL = `SELECT jobs.product_id, lower(jobs.colour) AS colour
  FROM story_video_jobs AS jobs JOIN products ON products.id=jobs.product_id
    AND products.status='active' AND products.design_revision_id=jobs.design_revision_id
  WHERE jobs.renderer_version=? AND jobs.status='ready' ORDER BY jobs.product_id, jobs.colour`;
async function rows(cf, sql, params = []) {
    const result = await cf.query(sql, params);
    check(result.length === 1 && Array.isArray(result[0].results), "one confirmed query result is required.");
    return result[0].results;
}
export function validateAudit(audit) {
    for (const key of ["ready_designs", "complete_colors", "finalized_designs", "active_products", "default_mismatches",
        "complete_families", "video_jobs", "ready_videos", "terminal_videos"]) {
        check(Number.isSafeInteger(audit[key]) && audit[key] >= 0, `invalid ${key} count.`);
    }
    check(audit.ready_designs <= MAX_DESIGNS && audit.finalized_designs <= audit.ready_designs, "bounded ready design cohort.");
    check(audit.active_products <= MAX_PRODUCTS && audit.video_jobs <= MAX_VIDEOS, "bounded product and video cohort.");
    const expectedProducts = audit.finalized_designs * 2;
    const expectedVideos = expectedProducts * 2;
    return {
        ...audit,
        complete: audit.complete_colors === audit.ready_designs && audit.complete_families === audit.finalized_designs &&
            audit.active_products === expectedProducts && audit.default_mismatches === 0 && audit.video_jobs === expectedVideos &&
            audit.ready_videos === expectedVideos && audit.terminal_videos === 0,
        expectedProducts,
        expectedVideos,
    };
}
export async function analyzeProductColor(preview, ownerId, apiKey, request = fetch) {
    check(Buffer.isBuffer(preview) && preview.length > 0 && preview.length <= 512 * 1024, "bounded colour preview.");
    check(/^[a-f0-9]{64}$/.test(ownerId) && typeof apiKey === "string" && apiKey.length > 0, "colour analysis identity and key.");
    const response = await request("https://api.openai.com/v1/responses", {
        body: JSON.stringify({
            input: [{ content: [{ text: [
                                "Choose the default blank product colour from the clothing worn by the primary person.",
                                "Use Black when their T-shirt or top is predominantly dark.",
                                "Use White when it is predominantly light.",
                                "Use White when the clothing is missing, obscured, mixed, ambiguous, or uncertain.",
                            ].join(" "), type: "input_text" }, { detail: "low", image_url: `data:image/jpeg;base64,${preview.toString("base64")}`, type: "input_image" }], role: "user" }],
            max_output_tokens: 32, model: PRODUCT_COLOR_MODEL, reasoning: { effort: "none" }, safety_identifier: ownerId,
            store: false, text: { format: { name: "product_default_color", schema: { additionalProperties: false,
                        properties: { color: { enum: ["Black", "White"], type: "string" } }, required: ["color"], type: "object" }, strict: true, type: "json_schema" } },
        }),
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        method: "POST", redirect: "error", signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`colour analysis returned HTTP ${response.status}.`);
    }
    const payload = await response.json();
    check(payload?.status === "completed" && typeof payload.model === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(payload.model), "colour analysis returned invalid metadata.");
    for (const item of payload.output ?? [])
        for (const content of item?.content ?? []) {
            if (content?.type !== "output_text" || typeof content.text !== "string")
                continue;
            let parsed;
            try {
                parsed = JSON.parse(content.text);
            }
            catch { /* checked below */ }
            if (["Black", "White"].includes(parsed?.color))
                return { color: parsed.color, model: payload.model };
        }
    throw new Error("colour analysis returned an invalid decision.");
}
async function defaultPreview(bytes) {
    const { default: sharp } = await import("sharp");
    return sharp(bytes).rotate().flatten({ background: "#ffffff" })
        .resize({ width: 512, height: 512, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 75 }).toBuffer();
}
export async function backfillProductColors(cf, colorRows, env, dependencies = {}) {
    check(colorRows.length <= MAX_DESIGNS, "colour cohort exceeds the reviewed bound.");
    const preparePreview = dependencies.preparePreview ?? defaultPreview;
    const analyze = dependencies.analyze ?? analyzeProductColor;
    let changed = 0;
    for (const row of colorRows) {
        check(/^[a-f0-9-]{36}$/.test(row.id) && (row.owner_id === null || /^[a-f0-9]{64}$/.test(row.owner_id)) && /^[a-f0-9]{64}$/.test(row.sha256) &&
            /^designs\/[a-f0-9-]{36}\/(?:artwork(?:\/[a-f0-9]{64})?|native-production-canary\.png)$/.test(row.artwork_key) &&
            Number.isSafeInteger(row.byte_size) && row.byte_size > 0 && row.byte_size <= 25000000, "invalid colour-backfill ledger row.");
        const response = await cf.productSweepArtwork(row.artwork_key);
        const artwork = Buffer.from(await response.arrayBuffer());
        check(artwork.length === row.byte_size && createHash("sha256").update(artwork).digest("hex") === row.sha256, "colour-backfill artwork does not match its ledger.");
        const preview = await preparePreview(artwork);
        let decision;
        for (let attempt = 1; attempt <= 3; attempt++) {
            const safetyIdentifier = row.owner_id ?? createHash("sha256").update(`legacy:${row.id}`).digest("hex");
            try {
                decision = await analyze(preview, safetyIdentifier, env.OPENAI_API_KEY);
                break;
            }
            catch (error) {
                if (attempt === 3)
                    throw error;
            }
        }
        const update = await cf.query(`UPDATE designs SET default_product_color=?, default_product_color_model=?,
      default_product_color_status='complete' WHERE id=? AND status='ready' AND deleted_at IS NULL
      AND default_product_color_status='fallback' AND artwork_key=? AND sha256=?`, [decision.color, decision.model, row.id, row.artwork_key, row.sha256]);
        check(update.length === 1 && update[0].meta?.changes === 1, "one unchanged design must accept each colour decision.");
        changed += 1;
    }
    return changed;
}
export async function configureMissingFamilies(families, env, request = fetch) {
    check(families.length <= MAX_DESIGNS, "family replay exceeds the reviewed bound.");
    let replayed = 0;
    for (const family of families) {
        check(/^[a-f0-9-]{36}$/.test(family.id) && /^[a-f0-9]{64}$/.test(family.owner_id) &&
            Number.isSafeInteger(family.version) && family.version >= 0, "invalid family replay row.");
        const response = await request(`${env.WORKER_URL}/v2/configured-product-families`, {
            body: JSON.stringify({ baseProductIds: [SHIRT, TOTE], designId: family.id, expectedVersion: family.version }),
            headers: { "content-type": "application/json", "x-forever-tee-owner-id": family.owner_id,
                "x-forever-tee-service-secret": env.FOREVER_TEE_API_SHARED_SECRET },
            method: "POST", redirect: "error", signal: AbortSignal.timeout(30000),
        });
        if (!response.ok) {
            await response.body?.cancel();
            throw new Error(`family replay returned HTTP ${response.status}.`);
        }
        const payload = await response.json();
        check(Array.isArray(payload?.products) && payload.products.length === 2 &&
            new Set(payload.products.map(product => product.baseProductId)).size === 2 &&
            payload.products.every(product => product.designId === family.id && [SHIRT, TOTE].includes(product.baseProductId) &&
                ["Black", "White"].includes(product.defaultColor)), "family replay returned an invalid product family.");
        replayed += 1;
    }
    return replayed;
}
export async function createLegacyProducts(cf, legacyRows, dependencies = {}) {
    check(legacyRows.length <= MAX_DESIGNS, "legacy product cohort exceeds the reviewed bound.");
    const now = dependencies.now ?? Date.now;
    const uuid = dependencies.uuid ?? randomUUID;
    const ids = [];
    for (const row of legacyRows) {
        check(/^[a-f0-9-]{36}$/.test(row.id) && [row.placement_x, row.placement_y, row.placement_width].every(Number.isFinite) &&
            Number.isSafeInteger(row.depth), "invalid legacy product row.");
        const placement = projectEditorPlacement({ depth: row.depth, placementWidth: row.placement_width,
            placementX: row.placement_x, placementY: row.placement_y }, "cotton-tote");
        const productId = uuid();
        check(/^[a-f0-9-]{36}$/.test(productId), "invalid generated product identifier.");
        const result = await cf.query(`INSERT INTO products (id, base_product_id, design_id, design_revision_id, shopify_handle,
      placement_x, placement_y, placement_width, placement_depth, projection_version, default_color, status, created_at, deleted_at)
      SELECT ?, ?, designs.id, source.design_revision_id, base.shopify_handle, ?, ?, ?, ?, 'safe-margin-v1',
        designs.default_product_color, 'active', ?, NULL
      FROM designs JOIN products AS source ON source.design_id=designs.id AND source.status='active' AND source.base_product_id=?
      JOIN products AS base ON base.id=? AND base.status='active' AND base.design_id IS NULL
      WHERE designs.id=? AND designs.owner_id IS NULL AND designs.status='ready' AND designs.deleted_at IS NULL
        AND designs.finalized_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM products AS existing
          WHERE existing.design_id=designs.id AND existing.status='active' AND existing.base_product_id=?)`, [productId, TOTE, placement.x, placement.y, placement.width, placement.depth, now(), SHIRT, TOTE, row.id, TOTE]);
        check(result.length === 1 && result[0].meta?.changes === 1, "one unchanged legacy family must accept its tote product.");
        ids.push(productId);
    }
    return ids;
}
export async function createMissingVideoJobs(cf, gaps, dependencies = {}) {
    check(gaps.length <= MAX_PRODUCTS, "video gap cohort exceeds the reviewed bound.");
    const now = dependencies.now ?? Date.now;
    const uuid = dependencies.uuid ?? randomUUID;
    let inserted = 0;
    for (const gap of gaps) {
        check(/^[a-f0-9-]{36}$/.test(gap.id) && /^[a-f0-9-]{36}$/.test(gap.design_revision_id) && [SHIRT, TOTE].includes(gap.base_product_id), "invalid video gap row.");
        const observed = new Set(String(gap.colours ?? "").split(",").filter(Boolean));
        const expected = gap.base_product_id === SHIRT ? ["black", "white"] : ["black", "cream"];
        for (const colour of expected.filter(value => !observed.has(value))) {
            const timestamp = now(), jobId = uuid();
            const key = `story-videos/v7/${gap.design_revision_id}/${gap.id}/${colour}.mp4`;
            const result = await cf.query(`INSERT INTO story_video_jobs (id, product_id, design_revision_id, colour, renderer_version,
        story_key, status, attempt_count, output_byte_size, last_error, created_at, updated_at, rendered_at)
        SELECT ?, products.id, products.design_revision_id, ?, ?, ?, 'queued', 0, NULL, NULL, ?, ?, NULL
        FROM products WHERE products.id=? AND products.status='active' AND products.design_revision_id=?
        ON CONFLICT (product_id, colour, renderer_version) DO NOTHING`, [jobId, colour[0].toUpperCase() + colour.slice(1), RENDERER_VERSION, key, timestamp, timestamp, gap.id, gap.design_revision_id]);
            check(result.length === 1 && [0, 1].includes(result[0].meta?.changes), "video job insertion was not confirmed.");
            inserted += result[0].meta.changes;
        }
    }
    return inserted;
}
export async function normalizeIncompatibleVideoJobIds(cf, jobs, dependencies = {}) {
    check(jobs.length <= MAX_VIDEOS, "incompatible video job cohort exceeds the reviewed bound.");
    const now = dependencies.now ?? Date.now;
    const uuid = dependencies.uuid ?? randomUUID;
    let changed = 0;
    for (const job of jobs) {
        check(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-v7$/.test(job.id), "invalid incompatible video job identifier.");
        const replacement = uuid();
        check(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(replacement), "invalid replacement video job identifier.");
        const result = await cf.query(`UPDATE story_video_jobs SET id=?, status='queued', attempt_count=0,
      last_error='PRODUCT_SWEEP_ID_REPAIR', execution_id=NULL, updated_at=?
      WHERE id=? AND renderer_version=? AND status='failed' AND attempt_count=3
        AND last_error='Invalid render grant.' AND length(id)=39 AND substr(id,37,3)='-v7'`, [replacement, now(), job.id, RENDERER_VERSION]);
        check(result.length === 1 && result[0].meta?.changes === 1, "one unchanged incompatible video job must accept its replacement identity.");
        changed += 1;
    }
    return changed;
}
async function audit(cf) {
    return validateAudit((await rows(cf, AUDIT_SQL, [SHIRT, TOTE, RENDERER_VERSION, RENDERER_VERSION, RENDERER_VERSION]))[0]);
}
export async function waitForCompleteProducts(cf, dependencies = {}) {
    const now = dependencies.now ?? Date.now;
    const sleep = dependencies.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
    const timeout = dependencies.timeoutMs ?? POLL_TIMEOUT_MS;
    const interval = dependencies.intervalMs ?? POLL_INTERVAL_MS;
    const started = now();
    let state = await audit(cf);
    while (!state.complete) {
        check(state.terminal_videos === 0, "a video exhausted its retry budget during the sweep.");
        check(now() - started < timeout, "video completion timed out.");
        console.info(JSON.stringify({ productSweepProgress: true, readyVideos: state.ready_videos, expectedVideos: state.expectedVideos }));
        await sleep(interval);
        state = await audit(cf);
    }
    return state;
}
async function verifyPublicVideos(videoRows, request = fetch) {
    check(videoRows.length <= MAX_VIDEOS, "public video cohort exceeds the reviewed bound.");
    for (let offset = 0; offset < videoRows.length; offset += 8)
        await Promise.all(videoRows.slice(offset, offset + 8).map(async (row) => {
            check(/^[a-f0-9-]{36}$/.test(row.product_id) && ["black", "cream", "white"].includes(row.colour), "invalid public video row.");
            const response = await request(`https://shop.bent.build/api/configured-product-video/${row.product_id}/${row.colour}.mp4`, {
                method: "HEAD", redirect: "error", signal: AbortSignal.timeout(30000),
            });
            check(response.ok && response.headers.get("content-type") === "video/mp4", "a public product video is unavailable.");
            await response.body?.cancel();
        }));
}
export async function sweepProductionProducts(env, dependencies = {}) {
    (dependencies.verifyContext ?? assertProductionContext)(env);
    check(env.NATIVE_OPERATION === "sweep-products" && typeof env.OPENAI_API_KEY === "string" && env.OPENAI_API_KEY.length > 0 &&
        typeof env.FOREVER_TEE_API_SHARED_SECRET === "string" && env.FOREVER_TEE_API_SHARED_SECRET.length >= 32, "explicit operation and protected analysis/service credentials are required.");
    const cf = dependencies.cf ?? productionCloudflare(env);
    const colors = await rows(cf, COLOR_ROWS_SQL);
    const families = await rows(cf, FAMILY_REPLAY_SQL);
    const legacyProducts = await rows(cf, LEGACY_PRODUCT_SQL, [TOTE]);
    const before = await audit(cf);
    console.info(JSON.stringify({ productSweepPlan: true, colorBackfills: colors.length, familyReplays: families.length, legacyProducts: legacyProducts.length,
        activeProducts: before.active_products, readyVideos: before.ready_videos, expectedVideos: before.expectedVideos }));
    const colorBackfills = await backfillProductColors(cf, colors, env, dependencies);
    await cf.query(`UPDATE products SET default_color=(SELECT designs.default_product_color FROM designs WHERE designs.id=products.design_id)
    WHERE status='active' AND design_id IS NOT NULL
      AND default_color<>(SELECT designs.default_product_color FROM designs WHERE designs.id=products.design_id)`);
    const familyReplays = await configureMissingFamilies(families, env, dependencies.request);
    const createdLegacyProducts = await createLegacyProducts(cf, legacyProducts, dependencies);
    const videoGaps = await rows(cf, VIDEO_GAP_SQL, [RENDERER_VERSION, RENDERER_VERSION]);
    const createdVideoJobs = await createMissingVideoJobs(cf, videoGaps, dependencies);
    const incompatibleVideoJobs = await rows(cf, INCOMPATIBLE_VIDEO_JOB_SQL, [RENDERER_VERSION]);
    const normalizedVideoJobIds = await normalizeIncompatibleVideoJobIds(cf, incompatibleVideoJobs, dependencies);
    const retry = await cf.query(`UPDATE story_video_jobs SET status='queued', attempt_count=0,
    last_error='PRODUCT_SWEEP_RETRY', execution_id=NULL, updated_at=?
    WHERE renderer_version=? AND status='failed' AND attempt_count>=3
      AND EXISTS (SELECT 1 FROM products WHERE products.id=story_video_jobs.product_id
        AND products.status='active' AND products.design_revision_id=story_video_jobs.design_revision_id)`, [Date.now(), RENDERER_VERSION]);
    check(retry.length === 1 && Number.isSafeInteger(retry[0].meta?.changes), "video retry update was not confirmed.");
    const revisions = await rows(cf, `SELECT DISTINCT jobs.design_revision_id FROM story_video_jobs AS jobs
    JOIN products ON products.id=jobs.product_id AND products.status='active' AND products.design_revision_id=jobs.design_revision_id
    WHERE jobs.renderer_version=? AND jobs.status<>'ready' ORDER BY jobs.design_revision_id`, [RENDERER_VERSION]);
    check(revisions.length <= MAX_DESIGNS && revisions.every(row => /^[a-f0-9-]{36}$/.test(row.design_revision_id)), "invalid retry revision cohort.");
    for (const row of revisions)
        await cf.productSweepDelivery(row.design_revision_id);
    const after = await waitForCompleteProducts(cf, dependencies);
    const videos = await rows(cf, VIDEO_ROWS_SQL, [RENDERER_VERSION]);
    check(videos.length === after.expectedVideos, "ready video inventory changed before public verification.");
    await (dependencies.verifyPublic ?? verifyPublicVideos)(videos, dependencies.request);
    return { productSweepComplete: true, colorBackfills, familyReplays, createdLegacyProducts: createdLegacyProducts.length,
        createdVideoJobs, normalizedVideoJobIds, retriedVideos: retry[0].meta.changes,
        queuedRevisions: revisions.length, readyDesigns: after.ready_designs, finalizedDesigns: after.finalized_designs,
        products: after.active_products, videos: after.ready_videos };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        console.info(JSON.stringify(await sweepProductionProducts(process.env)));
    }
    catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
