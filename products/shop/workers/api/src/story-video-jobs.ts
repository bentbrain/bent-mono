import { safeErrorDetails } from "@forever-tee/contracts/diagnostics";
import { consumeProductImageMessage } from "./product-images";
import { baseProductSlugForId, productProjectionSpecification, type BaseProductSlug, } from "@forever-tee/contracts";
import { consumeRenderResults } from "./story-video-results";
import { notifyStoryVideoReady, type StoryVideoNotificationEnv } from "./story-video-notifications";
import { renderLambdaVideo, validateLambdaStoryVideoEnv, type LambdaStoryVideoEnv } from "./story-video-lambda";
import { hasNativeV5Schema } from "./native-v5-target";
import { serialLegacyVideoReads } from "./story-video-legacy-cache";
import { qualificationLambdaSend, takeQualificationEnqueueFault, takeQualificationFault } from "./story-video-qualification";
export const STORY_VIDEO_RENDERER_VERSION = "story-video-renderer-v7";
export const STORY_VIDEO_RETAINED_RENDERER_VERSIONS: readonly [
    string,
    string
] = [
    STORY_VIDEO_RENDERER_VERSION,
    "story-video-renderer-v6",
];
const STORY_VIDEO_MAX_ATTEMPTS = 3;
// A two-second delayed send measured up to ~15s before consumer invocation.
// Send immediately; each product enqueues its revision, and completed jobs
// are excluded when a later sibling or duplicate message is consumed.
const STORY_VIDEO_QUEUE_DELAY_SECONDS = 0;
const STORY_VIDEO_RECONCILIATION_LIMIT = 250;
// Longer than the 180s transfer grant, including signing/dispatch overhead.
// No execution from the previous attempt can publish after recovery.
const LAMBDA_LEASE_MS = 200000;
// Ready means the MP4 is durable, not that Lambda has exited. Its upload
// acknowledgement can wait 30s, followed by a 5s failure callback. Retain the
// slot through both deadlines plus 5s for runtime shutdown. This also keeps a
// failed invocation from being replaced while its callback is returning.
const LAMBDA_COMPLETION_HOLD_MS = 40000;
export interface StoryVideoQueueMessage {
    readonly designRevisionId: string;
    readonly productImages?: true;
}
interface StoryVideoQueueBinding {
    readonly send: (message: StoryVideoQueueMessage, options?: {
        readonly delaySeconds?: number;
    }) => Promise<unknown>;
}
interface StoryVideoRendererBinding {
    readonly fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}
export interface StoryVideoEnv extends StoryVideoNotificationEnv, LambdaStoryVideoEnv {
    readonly STORY_VIDEO_TRANSPORT?: string;
    readonly STORY_VIDEO_WARM_ON_CONFIRM?: string;
    readonly STORY_VIDEO_LANES?: string;
    readonly STORY_VIDEO_MAX_INFLIGHT?: string;
    readonly DB: D1Database;
    readonly DESIGN_ARTWORK: R2Bucket;
    readonly STORY_VIDEO_JOBS?: StoryVideoQueueBinding;
    readonly STORY_VIDEO_RENDERER?: StoryVideoRendererBinding;
}
interface ProductRevisionRow {
    readonly base_product_id: string;
    readonly design_revision_id: string;
    readonly product_id: string;
}
interface RenderJobRow {
    readonly recursive_key: string | null;
    readonly recursive_sha256: string | null;
    readonly recursive_size: number | null;
    readonly recursive_type: string | null;
    readonly recursive_crop_x: number | null;
    readonly recursive_crop_y: number | null;
    readonly recursive_crop_zoom: number | null;
    readonly recursive_placement_x: number | null;
    readonly recursive_placement_y: number | null;
    readonly recursive_placement_width: number | null;
    readonly attempt_count: number;
    readonly artwork_key: string;
    readonly artwork_sha256: string;
    readonly artwork_size: number;
    readonly base_product_id: string;
    readonly colour: string;
    readonly content_type: string;
    readonly crop_x: number;
    readonly crop_y: number;
    readonly crop_zoom: number;
    readonly design_revision_id: string;
    readonly job_id: string;
    readonly placement_depth: number;
    readonly placement_width: number;
    readonly placement_x: number;
    readonly placement_y: number;
    readonly product_id: string;
    readonly story_key: string;
}
interface ReconciliationRow {
    readonly design_revision_id: string;
}
export async function ensureStoryVideoJobs(env: StoryVideoEnv, productId: string | readonly string[], context?: Pick<ExecutionContext, "waitUntil">) {
    const startedAt = Date.now();
    const productIds = [...new Set(typeof productId === "string" ? [productId] : productId)];
    if (productIds.length < 1 || productIds.length > 2)
        throw new Error("A supported product family is required.");
    const products = await env.DB.prepare(`
    SELECT id AS product_id, base_product_id, COALESCE(video_design_revision_id, design_revision_id) AS design_revision_id
    FROM products
    WHERE id IN (${productIds.map(() => "?").join(",")}) AND status = 'active' AND COALESCE(video_design_revision_id, design_revision_id) IS NOT NULL
      AND placement_depth > 0
  `).bind(...productIds).all<ProductRevisionRow>();
    if (products.results.length === 0)
        return;
    const now = Date.now();
    const statements = products.results.flatMap((product) => {
        const baseProductSlug = baseProductSlugForId(product.base_product_id);
        if (!baseProductSlug)
            return [];
        return productProjectionSpecification(baseProductSlug).colors.map((colour) => env.DB.prepare(`
      INSERT INTO story_video_jobs (
        id, product_id, design_revision_id, colour, renderer_version,
        story_key, status, attempt_count, output_byte_size, last_error,
        created_at, updated_at, rendered_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, NULL, NULL, ?, ?, NULL)
      ON CONFLICT (product_id, colour, renderer_version) DO NOTHING
    `).bind(crypto.randomUUID(), product.product_id, product.design_revision_id, colour, STORY_VIDEO_RENDERER_VERSION, storyVideoKey(product.design_revision_id, product.product_id, colour), now, now));
    });
    if (statements.length === 0)
        return;
    await env.DB.batch(statements);
    console.info("Story video outbox persisted", { jobCount: statements.length, durationMs: Date.now() - startedAt });
    const deliveries: Promise<unknown>[] = [];
    for (const revisionId of new Set(products.results.map((product) => product.design_revision_id))) {
        deliveries.push(enqueueRevision(env, revisionId));
        if (env.STORY_VIDEO_PROVIDER === "lambda" && context) {
            // AWS acceptance and queue acceptance proceed independently, through the
            // same atomic claims. Encoding is outside this request's background work.
            deliveries.push(renderStoryVideoRevisionBatch(env, revisionId, { directDispatch: 1 }).catch((error: unknown) => {
                console.error("Story video direct dispatch failed", safeErrorDetails(error));
            }));
        }
    }
    const delivery = Promise.allSettled(deliveries).then(() => undefined);
    if (context)
        context.waitUntil(delivery);
    else
        await delivery;
}
export async function reconcileStoryVideoJobs(env: StoryVideoEnv) {
    await recoverExpiredRenders(env);
    if (!env.STORY_VIDEO_JOBS)
        return;
    const pending = await env.DB.prepare(`
    SELECT DISTINCT jobs.design_revision_id
    FROM story_video_jobs AS jobs
    JOIN products ON products.id = jobs.product_id AND COALESCE(products.video_design_revision_id, products.design_revision_id) = jobs.design_revision_id
      AND products.status = 'active' AND products.placement_depth > 0
    WHERE jobs.renderer_version = ?
      AND jobs.status IN ('queued', 'failed')
      AND jobs.attempt_count < ?
    ORDER BY jobs.updated_at ASC
    LIMIT ?
  `).bind(STORY_VIDEO_RENDERER_VERSION, STORY_VIDEO_MAX_ATTEMPTS, STORY_VIDEO_RECONCILIATION_LIMIT).all<ReconciliationRow>();
    for (const row of pending.results) {
        await enqueueRevision(env, row.design_revision_id);
    }
}
async function recoverExpiredRenders(env: StoryVideoEnv, revisionId?: string) {
    const staleBefore = Date.now() - (env.STORY_VIDEO_PROVIDER === "lambda" ? LAMBDA_LEASE_MS : 15 * 60000);
    await env.DB.prepare(`
    UPDATE story_video_jobs
    SET status = 'queued', updated_at = ?, last_error = 'STALE_RENDER_RECOVERED'
    WHERE status = 'rendering' AND updated_at < ?
      AND attempt_count < ? AND (? IS NULL OR design_revision_id = ?)
  `).bind(Date.now(), staleBefore, STORY_VIDEO_MAX_ATTEMPTS, revisionId ?? null, revisionId ?? null).run();
    await env.DB.prepare(`
    UPDATE story_video_jobs
    SET status = 'failed', updated_at = ?, last_error = 'STALE_RENDER_EXHAUSTED'
    WHERE status = 'rendering' AND updated_at < ? AND attempt_count >= ?
      AND (? IS NULL OR design_revision_id = ?)
  `).bind(Date.now(), staleBefore, STORY_VIDEO_MAX_ATTEMPTS, revisionId ?? null, revisionId ?? null).run();
}
export async function consumeStoryVideoQueue(batch: MessageBatch, env: StoryVideoEnv) {
    for (const message of batch.messages) {
        if (await consumeProductImageMessage(message, env))
            continue;
        const revisionId = validRevisionId(message.body)
            ? message.body.designRevisionId
            : undefined;
        if (!revisionId) {
            message.ack();
            continue;
        }
        try {
            await renderStoryVideoRevisionBatch(env, revisionId, {
                queueWaitMs: Math.max(0, Date.now() - message.timestamp.getTime()),
            });
            if (env.STORY_VIDEO_PROVIDER === "lambda") {
                // Acceptance is not completion. Keep the durable watchdog alive even
                // when a racing direct dispatcher owns every job and has not returned.
                const unfinished = await env.DB.prepare(`SELECT jobs.id FROM story_video_jobs AS jobs
          JOIN products ON products.id = jobs.product_id AND COALESCE(products.video_design_revision_id, products.design_revision_id) = jobs.design_revision_id
            AND products.status = 'active'
          WHERE jobs.design_revision_id = ? AND jobs.renderer_version = ?
            AND (jobs.status = 'rendering' OR (jobs.status IN ('queued', 'failed') AND jobs.attempt_count < ?)) LIMIT 1`)
                    .bind(revisionId, STORY_VIDEO_RENDERER_VERSION, STORY_VIDEO_MAX_ATTEMPTS).first();
                if (unfinished) {
                    message.retry({ delaySeconds: 5 });
                    continue;
                }
            }
            message.ack();
        }
        catch (error) {
            console.error("bent.shop story-video batch failed", {
                attempt: message.attempts,
                designRevisionId: revisionId,
                ...safeErrorDetails(error),
            });
            message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
        }
    }
}
export async function renderStoryVideoRevisionBatch(env: StoryVideoEnv, revisionId: string, dispatchTimings: Readonly<Record<string, number>> = {}) {
    const batchStartedAt = Date.now();
    if (env.STORY_VIDEO_PROVIDER !== "lambda" && !env.STORY_VIDEO_RENDERER) {
        throw new Error("STORY_VIDEO_RENDERER is not configured.");
    }
    if (env.STORY_VIDEO_PROVIDER && !["lambda", "cloudflare"].includes(env.STORY_VIDEO_PROVIDER))
        throw new Error("Unknown video provider.");
    if (env.STORY_VIDEO_PROVIDER === "lambda") {
        validateLambdaStoryVideoEnv(env);
        await recoverExpiredRenders(env, revisionId);
    }
    const pending = await pendingRenderJobs(env.DB, revisionId);
    if (pending.length === 0)
        return;
    const first = pending[0];
    for (const job of pending) {
        recursiveVideoSource(job);
        if (job.recursive_key !== first?.recursive_key)
            throw new Error("A revision batch must share its recursive source.");
    }
    if (first && dispatchTimings["directDispatch"] === 1 &&
        await takeQualificationFault(env, first.artwork_key, first.job_id, "direct-dispatch")) {
        throw new Error("Qualification stopped the initial direct dispatch before claiming work.");
    }
    const now = Date.now();
    const timings: Record<string, number> = {
        ...dispatchTimings,
        apiLoadJobsMs: now - batchStartedAt,
        renderLanes: env.STORY_VIDEO_PROVIDER === "lambda" || env.STORY_VIDEO_LANES === "4" ? 4 : 2,
    };
    const capacity = Number(env.STORY_VIDEO_MAX_INFLIGHT ?? "8");
    // This ceiling must move with the reviewed Lambda reservation. An optional
    // lower limit can slow admission, but cannot overload the deployed function.
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 8) {
        throw new Error("Invalid video admission capacity.");
    }
    const nativeSchema = env.STORY_VIDEO_PROVIDER === "lambda" && await hasNativeV5Schema(env.DB);
    const lambdaImage = nativeSchema ? "(renderer_version<>'product-images-v5' OR dispatch_provider IS 'native-v5' OR EXISTS(SELECT 1 FROM native_v5_dispatches native WHERE native.job_id=product_image_jobs.id))" : "renderer_version<>'product-images-v5'";
    const claims = await env.DB.batch(pending.map((job) => env.DB.prepare(`
    UPDATE story_video_jobs
    SET status = 'rendering', attempt_count = attempt_count + 1,
      last_error = NULL, execution_id = NULL, updated_at = ?
    WHERE id = ? AND status IN ('queued', 'failed') AND attempt_count = ?
      AND (? = 0 OR status = 'queued' OR execution_id IS NULL OR updated_at <= ?)
      AND (? = 0 OR (SELECT count(*) FROM (
        SELECT id FROM story_video_jobs
        WHERE status = 'rendering' OR
          (status IN ('ready', 'failed') AND execution_id IS NOT NULL AND updated_at > ?)
        LIMIT ?
      )) + (SELECT count(*) FROM (SELECT id FROM product_image_jobs WHERE ${lambdaImage} AND status='rendering' UNION ALL SELECT id FROM product_image_jobs WHERE ${lambdaImage} AND status IN ('ready','failed') AND execution_id IS NOT NULL AND updated_at > ? LIMIT 8)) < ?)
  `).bind(now, job.job_id, job.attempt_count, env.STORY_VIDEO_PROVIDER === "lambda" ? 1 : 0, now - LAMBDA_COMPLETION_HOLD_MS, env.STORY_VIDEO_PROVIDER === "lambda" ? 1 : 0, now - LAMBDA_COMPLETION_HOLD_MS, capacity, now - LAMBDA_COMPLETION_HOLD_MS, capacity)));
    const jobs = pending.filter((_job, index) => claims[index]?.meta.changes === 1);
    const artworkMetadata = jobs[0];
    if (!artworkMetadata)
        return;
    timings["apiClaimJobsMs"] = Date.now() - now;
    if (env.STORY_VIDEO_PROVIDER === "lambda") {
        // Legacy adoption hashes bounded MP4 bytes. Read one at a time per family
        // so four maximum-size old objects do not occupy the Worker heap together.
        // Normal cache misses and Lambda invocations remain parallel.
        const readLegacy = serialLegacyVideoReads();
        const outcomes = await Promise.allSettled(jobs.map(async (job) => {
            try {
                const recursiveSource = recursiveVideoSource(job);
                const result = await renderLambdaVideo(env, {
                    ...renderJobInput(job), jobId: job.job_id, attempt: job.attempt_count + 1,
                    artwork: { sha256: job.artwork_sha256, size: job.artwork_size },
                    ...(recursiveSource ? { recursiveSource } : {}),
                }, STORY_VIDEO_RENDERER_VERSION, qualificationLambdaSend(env, job.artwork_key, job.job_id, fetch), readLegacy);
                if (result.status === "ready") {
                    const persisted = await env.DB.prepare(`
            UPDATE story_video_jobs SET status = 'ready', output_byte_size = ?, last_error = NULL, updated_at = ?, rendered_at = ?
            WHERE id = ? AND status = 'rendering' AND attempt_count = ? AND renderer_version = ?
          `).bind(result.size, Date.now(), Date.now(), job.job_id, job.attempt_count + 1, STORY_VIDEO_RENDERER_VERSION).run();
                    if (persisted.meta.changes !== 1)
                        throw new Error("Render attempt was superseded.");
                    // Ready state is durable even if notification delivery fails.
                    await notifyStoryVideoReady(env, revisionId).catch(() => false);
                }
                console.info("Story video dispatched", { productId: job.product_id, colour: job.colour,
                    provider: "lambda", outcome: result.status, timings: { ...timings, ...result.timings, dispatchedAt: Date.now(), batchStartedAt } });
            }
            catch (error) {
                // An accepted sibling remains rendering. Retrying this queue message
                // must not invalidate its grant or start a duplicate encode.
                await env.DB.prepare(`UPDATE story_video_jobs SET status = 'failed', last_error = ?, updated_at = ?
          WHERE id = ? AND status = 'rendering' AND attempt_count = ? AND execution_id IS NULL`)
                    .bind(errorMessage(error), Date.now(), job.job_id, job.attempt_count + 1).run();
                throw error;
            }
        }));
        const failure = outcomes.find(outcome => outcome.status === "rejected");
        if (failure?.status === "rejected") {
            // Preserve the actionable boundary error, never invocation payloads or grants.
            throw new Error(`Lambda render failed: ${errorMessage(failure.reason)}`);
        }
        return;
    }
    if (!env.STORY_VIDEO_RENDERER)
        throw new Error("STORY_VIDEO_RENDERER is not configured.");
    try {
        // Direct mode validates the same immutable bytes in the container. Keep
        // the original transport available without changing jobs or media keys.
        const artworkInput = env.STORY_VIDEO_TRANSPORT === "direct"
            ? { artworkRef: {
                    key: artworkMetadata.artwork_key,
                    sha256: artworkMetadata.artwork_sha256,
                    size: artworkMetadata.artwork_size,
                } }
            : { artwork: await verifiedArtwork(env, artworkMetadata, timings) };
        const recursiveSource = recursiveVideoSource(artworkMetadata);
        const recursiveInput = recursiveSource && artworkMetadata.recursive_key && artworkMetadata.recursive_type
            ? { recursiveCrop: { cropX: recursiveSource.cropX, cropY: recursiveSource.cropY, cropZoom: recursiveSource.cropZoom },
                ...(recursiveSource.placement ? { recursivePlacement: recursiveSource.placement } : {}),
                ...(env.STORY_VIDEO_TRANSPORT === "direct"
                    ? { recursiveArtworkRef: { key: artworkMetadata.recursive_key, sha256: recursiveSource.sha256, size: recursiveSource.size } }
                    : { recursiveArtwork: await verifiedArtwork(env, { artwork_key: artworkMetadata.recursive_key,
                            artwork_sha256: recursiveSource.sha256, artwork_size: recursiveSource.size, content_type: artworkMetadata.recursive_type }, timings) }) }
            : {};
        const serializeStartedAt = Date.now();
        const payload = JSON.stringify({
            batchId: revisionId,
            concurrency: env.STORY_VIDEO_LANES === "4" ? 4 : 2,
            jobs: jobs.map((job) => renderJobInput(job)),
            shared: {
                ...artworkInput,
                ...recursiveInput,
                encoding: { crf: 21, frameRate: 30, frameWidth: 720, scaleBeforeHold: true },
                preset: "veryfast",
                websiteLabel: "shop.bent.build",
            },
            shutdownAfterBatch: false,
        });
        timings["apiSerializeMs"] = Date.now() - serializeStartedAt;
        const response = await env.STORY_VIDEO_RENDERER.fetch("https://story-video.internal/render-batch", {
            body: payload,
            headers: {
                accept: "application/x-ndjson", "content-type": "application/json",
                "x-story-video-timings": JSON.stringify(timings),
            },
            method: "POST",
        });
        const jobsByKey = new Map(jobs.map((job) => [job.story_key, job]));
        const completed = new Set<string>();
        await consumeRenderResults(response, async (result) => {
            const job = jobsByKey.get(result.key);
            if (!job || completed.has(result.key))
                throw new Error("Unexpected renderer result key.");
            const renderedAt = Date.now();
            const persisted = await env.DB.prepare(`
        UPDATE story_video_jobs
        SET status = 'ready', output_byte_size = ?, last_error = NULL,
          updated_at = ?, rendered_at = ?
        WHERE id = ? AND renderer_version = ? AND status = 'rendering' AND attempt_count = ?
      `).bind(result.size, renderedAt, renderedAt, job.job_id, STORY_VIDEO_RENDERER_VERSION, job.attempt_count + 1).run();
            if (persisted.meta.changes !== 1)
                throw new Error("Render attempt was superseded.");
            completed.add(result.key);
            const persistedAt = Date.now();
            const notified = await notifyStoryVideoReady(env, revisionId);
            console.info("Story video ready", {
                productId: job.product_id,
                colour: job.colour,
                renderBatchElapsedMs: renderedAt - now,
                timings: {
                    ...timings,
                    ...result.timings,
                    apiReadyPersistMs: persistedAt - renderedAt,
                    apiNotificationMs: Date.now() - persistedAt,
                    notificationPush: env.STORY_VIDEO_NOTIFICATION_MODE === "push" ? 1 : 0,
                    notificationDelivered: notified ? 1 : 0,
                    readyAt: renderedAt,
                    batchStartedAt,
                },
            });
        });
        if (completed.size !== jobs.length)
            throw new Error("The renderer omitted pending videos.");
    }
    catch (error) {
        const message = errorMessage(error).slice(0, 500);
        await env.DB.batch(jobs.map((job) => env.DB.prepare(`
      UPDATE story_video_jobs
      SET status = 'failed', last_error = ?, updated_at = ?
      WHERE id = ? AND status = 'rendering' AND attempt_count = ?
    `).bind(message, Date.now(), job.job_id, job.attempt_count + 1)));
        throw error;
    }
}
async function verifiedArtwork(env: StoryVideoEnv, metadata: Pick<RenderJobRow, "artwork_key" | "artwork_size" | "artwork_sha256" | "content_type">, timings: Record<string, number>) {
    const startedAt = Date.now();
    const object = await env.DESIGN_ARTWORK.get(metadata.artwork_key);
    if (object?.size !== metadata.artwork_size)
        throw new Error("The revision artwork object is unavailable.");
    const bytes = new Uint8Array(await object.arrayBuffer());
    timings["apiArtworkReadMs"] = Date.now() - startedAt;
    const digestStartedAt = Date.now();
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    if (hexDigest(digest) !== metadata.artwork_sha256)
        throw new Error("The revision artwork checksum does not match.");
    timings["apiChecksumMs"] = Date.now() - digestStartedAt;
    return dataUrl(metadata.content_type, bytes);
}
async function pendingRenderJobs(db: D1Database, revisionId: string) {
    const result = await db.prepare(`
    SELECT jobs.id AS job_id, jobs.attempt_count, jobs.product_id, jobs.design_revision_id,
      jobs.colour, jobs.story_key, products.base_product_id,
      products.placement_x, products.placement_y, products.placement_width,
      products.placement_depth, revisions.artwork_key,
      revisions.content_type, revisions.byte_size AS artwork_size,
      revisions.sha256 AS artwork_sha256, revisions.crop_x,
      revisions.crop_y, revisions.crop_zoom,
      recursive.artwork_key AS recursive_key, recursive.sha256 AS recursive_sha256,
      recursive.byte_size AS recursive_size, recursive.content_type AS recursive_type,
      recursive.crop_x AS recursive_crop_x, recursive.crop_y AS recursive_crop_y, recursive.crop_zoom AS recursive_crop_zoom,
      recursive.video_placement_x AS recursive_placement_x, recursive.video_placement_y AS recursive_placement_y,
      recursive.video_placement_width AS recursive_placement_width
    FROM story_video_jobs AS jobs
    JOIN products ON products.id = jobs.product_id
      AND COALESCE(products.video_design_revision_id, products.design_revision_id) = jobs.design_revision_id
      AND products.status = 'active'
    JOIN design_revisions AS revisions ON revisions.id = jobs.design_revision_id AND revisions.design_id = products.design_id
    LEFT JOIN design_revisions AS recursive ON recursive.id = products.video_recursive_revision_id
      AND recursive.design_id = products.design_id
    WHERE jobs.design_revision_id = ? AND jobs.renderer_version = ?
      AND jobs.status IN ('queued', 'failed')
      AND jobs.attempt_count < ?
      AND products.placement_x IS NOT NULL
      AND products.placement_y IS NOT NULL
      AND products.placement_width IS NOT NULL
      AND products.placement_depth > 0
    ORDER BY products.base_product_id, jobs.colour
    LIMIT 4
  `).bind(revisionId, STORY_VIDEO_RENDERER_VERSION, STORY_VIDEO_MAX_ATTEMPTS).all<RenderJobRow>();
    return result.results;
}
function renderJobInput(job: RenderJobRow) {
    const baseProductSlug = baseProductSlugForId(job.base_product_id);
    if (!baseProductSlug || !validColour(baseProductSlug, job.colour)) {
        throw new Error("The story-video product variant is invalid.");
    }
    return {
        baseProductSlug,
        color: job.colour,
        settings: {
            cropX: job.crop_x,
            cropY: job.crop_y,
            cropZoom: job.crop_zoom,
            depth: job.placement_depth,
            placementWidth: job.placement_width,
            placementX: job.placement_x,
            placementY: job.placement_y,
        },
        storyKey: job.story_key,
    };
}
async function enqueueRevision(env: StoryVideoEnv, designRevisionId: string) {
    if (!env.STORY_VIDEO_JOBS)
        return;
    try {
        if (await takeQualificationEnqueueFault(env, designRevisionId))
            throw new Error("Qualification rejected the initial queue send.");
        await env.STORY_VIDEO_JOBS.send({ designRevisionId }, { delaySeconds: STORY_VIDEO_QUEUE_DELAY_SECONDS });
    }
    catch (error) {
        console.error("bent.shop story-video enqueue failed", {
            designRevisionId,
            ...safeErrorDetails(error),
        });
    }
}
function storyVideoKey(revisionId: string, productId: string, colour: string) {
    return [
        "story-videos/v7",
        revisionId,
        productId,
        `${colour.toLowerCase()}.mp4`,
    ].join("/");
}
function validColour(baseProductSlug: BaseProductSlug, colour: string) {
    return productProjectionSpecification(baseProductSlug).colors.includes(colour);
}
function validRevisionId(value: unknown): value is StoryVideoQueueMessage {
    return typeof value === "object" && value !== null &&
        "designRevisionId" in value &&
        typeof value.designRevisionId === "string" &&
        /^[0-9a-f-]{36}$/.test(value.designRevisionId);
}
function dataUrl(contentType: string, bytes: Uint8Array) {
    let binary = "";
    const chunkSize = 8192;
    for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return `data:${contentType};base64,${btoa(binary)}`;
}
function hexDigest(value: ArrayBuffer) {
    return Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function retryDelaySeconds(attempt: number) {
    return Math.min(60, Math.max(5, attempt * 10));
}
function errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
}
function recursiveVideoSource(job: RenderJobRow) {
    if (job.recursive_key === null)
        return undefined;
    if (!job.recursive_type || !/^image\/[a-z0-9.+-]+$/.test(job.recursive_type) || !job.recursive_sha256 || !/^[a-f0-9]{64}$/.test(job.recursive_sha256) ||
        job.recursive_size === null || !Number.isSafeInteger(job.recursive_size) || job.recursive_size < 1 ||
        job.recursive_size + job.artwork_size > 25000000 ||
        job.recursive_crop_x === null || job.recursive_crop_x < 0 || job.recursive_crop_x > 1 ||
        job.recursive_crop_y === null || job.recursive_crop_y < 0 || job.recursive_crop_y > 1 ||
        job.recursive_crop_zoom === null || job.recursive_crop_zoom < 0.65 || job.recursive_crop_zoom > 2.6) {
        throw new Error("Invalid immutable recursive source.");
    }
    const x = job.recursive_placement_x, y = job.recursive_placement_y, width = job.recursive_placement_width;
    const placement = x === null && y === null && width === null ? undefined : (() => {
        if (x === null || y === null || width === null || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) ||
            x < 0 || y < 0 || width <= 0 || width >= 1 || x + width > 1 || y + width > 1) {
            throw new Error("Invalid immutable recursive placement.");
        }
        return { placementX: x, placementY: y, placementWidth: width };
    })();
    return { sha256: job.recursive_sha256, size: job.recursive_size,
        ...(placement ? { placement } : {}),
        cropX: job.recursive_crop_x, cropY: job.recursive_crop_y, cropZoom: job.recursive_crop_zoom };
}
