import { protectedConfig } from "./protected-config";
import { artworkPreviewKey } from "./artwork-preview";
import { baseProductSlugForId, productProjectionSpecification } from "@forever-tee/contracts";
import { AwsClient } from "aws4fetch";
import { createStoryVideoGrant, verifyStoryVideoGrant } from "./story-video-grants";
import { invokeQualifiedNativeV5, validateLambdaStoryVideoEnv, type LambdaStoryVideoEnv } from "./story-video-lambda";
import { acceptedNativeV5Grant, admittedNativeV5Target, canonicalNativeIdentity, hasNativeV5Schema, nativeIdentityDigest,
    nativeV5AcceptanceStatement, prepareNativeV5Acceptance, retainedNativeV5Dispatch, type NativeV5Acceptance, type NativeV5Target, type NativeV5TargetEnv } from "./native-v5-target";
import { isAuthenticatedServiceRequest } from "./service-auth";
const PRODUCT_IMAGE_VERSION = "product-images-v4";
const VERCEL_IMAGE_VERSION = "product-images-v5";
function imageVersion(env: ProductImageEnv) { return env.SHOP_NATIVE_V5_TARGET_JSON !== undefined || env.PRODUCT_IMAGE_PROVIDER === "vercel" ? VERCEL_IMAGE_VERSION : PRODUCT_IMAGE_VERSION; }
function rendererOrigin(env: ProductImageEnv) {
    if (env.STORY_VIDEO_ENVIRONMENT !== "development" || !env.PRODUCT_IMAGE_RENDERER_BYPASS_SECRET || !env.FOREVER_TEE_API_SHARED_SECRET)
        throw new Error("Vercel image renderer is not configured for Preview.");
    return protectedConfig("previewRendererOrigin");
}
const rendererChecks = new Map<string, number>();
async function vercelAvailable(env: ProductImageEnv, send: typeof fetch) {
    const origin = rendererOrigin(env), key = origin + (env.FOREVER_TEE_API_SHARED_SECRET ?? "");
    if ((rendererChecks.get(key) ?? 0) > Date.now() - 5000)
        return true;
    const response = await send(`${origin}/api/internal/product-image-render`, { headers: vercelHeaders(env), redirect: "manual", signal: AbortSignal.timeout(5000) }).catch(() => undefined);
    const value: unknown = await response?.json().catch(() => undefined);
    if (response?.status !== 200 || typeof value !== "object" || value === null || !("rendererVersion" in value) || value.rendererVersion !== VERCEL_IMAGE_VERSION)
        return false;
    rendererChecks.clear();
    rendererChecks.set(key, Date.now());
    return true;
}
function vercelHeaders(env: ProductImageEnv) { return { "content-type": "application/json", "x-forever-tee-service-secret": env.FOREVER_TEE_API_SHARED_SECRET ?? "", "x-vercel-protection-bypass": env.PRODUCT_IMAGE_RENDERER_BYPASS_SECRET ?? "" }; }
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const LEASE = 200000;
const HOLD = 40000;
export interface ProductImageEnv extends LambdaStoryVideoEnv, NativeV5TargetEnv {
    readonly DB: D1Database;
    readonly DESIGN_ARTWORK: R2Bucket;
    readonly IMAGES?: ImagesBinding;
    readonly FOREVER_TEE_API_SHARED_SECRET?: string;
    readonly STORY_VIDEO_MAX_INFLIGHT?: string;
    readonly PRODUCT_IMAGE_PROVIDER?: "lambda" | "vercel";
    readonly PRODUCT_IMAGE_MAX_INFLIGHT?: string;
    readonly PRODUCT_IMAGE_RENDERER_BYPASS_SECRET?: string;
    readonly STORY_VIDEO_JOBS?: {
        send(message: {
            designRevisionId: string;
            productImages?: true;
        }): Promise<unknown>;
    };
}
interface Product {
    id: string;
    design_id: string;
    design_revision_id: string;
    base_product_id: string;
}
interface Job extends Product {
    job_id: string;
    colour: string;
    view: "flat" | "lifestyle";
    storage_key: string;
    status: string;
    renderer_version: string;
    attempt_count: number;
    execution_id: string | null;
    artwork_key: string;
    source_sha256: string;
    source_size: number;
    crop_x: number;
    crop_y: number;
    crop_zoom: number;
    placement_x: number;
    placement_y: number;
    placement_width: number;
    placement_depth: number;
    print_mode: "recursive" | "base-image-only";
    sha256: string | null;
    byte_size: number | null;
    created_at: number;
}
const JOB_SELECT = `SELECT jobs.id AS job_id, jobs.colour, jobs.view, jobs.storage_key, jobs.status, jobs.attempt_count,
  jobs.renderer_version, jobs.execution_id, jobs.sha256, jobs.byte_size, jobs.created_at, products.id, products.design_id, products.design_revision_id,
  products.base_product_id, products.placement_x, products.placement_y, products.placement_width,
  products.placement_depth, products.print_mode, revisions.artwork_key, revisions.sha256 AS source_sha256,
  revisions.byte_size AS source_size, revisions.crop_x, revisions.crop_y, revisions.crop_zoom
  FROM product_image_jobs jobs JOIN products ON products.id = jobs.product_id
    AND products.status = 'active' AND products.design_revision_id = jobs.design_revision_id
  JOIN designs ON designs.id = products.design_id AND designs.status = 'ready'
  JOIN design_revisions revisions ON revisions.id = jobs.design_revision_id AND revisions.design_id = products.design_id`;
function nativeJobIdentity(job: Job) {
    return { jobId: job.job_id, productId: job.id, designId: job.design_id, revisionId: job.design_revision_id,
        baseProductId: job.base_product_id, colour: job.colour, view: job.view, storageKey: job.storage_key, rendererVersion: job.renderer_version,
        artworkKey: job.artwork_key, sourceSha256: job.source_sha256, sourceSize: job.source_size,
        cropX: job.crop_x, cropY: job.crop_y, cropZoom: job.crop_zoom, placementX: job.placement_x,
        placementY: job.placement_y, placementWidth: job.placement_width, depth: job.placement_depth, printMode: job.print_mode };
}
interface NativeImageSource { readonly key: string; readonly size: number; readonly sha256: string; readonly contentType: string }
const UNRETAINED_LEGACY_WORK = `NOT EXISTS(SELECT 1 FROM native_v5_dispatches accepted WHERE accepted.job_id=legacy.id)
  AND (legacy.status='rendering' OR (legacy.status IN ('queued','failed') AND legacy.attempt_count<3
    AND (legacy.dispatch_provider IS NULL OR legacy.attempt_count>0))
    OR (legacy.execution_id IS NOT NULL AND legacy.updated_at>?))`;
async function assertNativeImageAdmission(env: ProductImageEnv) {
    if (!await hasNativeV5Schema(env.DB)) throw new Error("Install the additive native dispatch schema before admitting its target.");
    if (await env.DB.prepare(`SELECT id FROM product_image_jobs legacy WHERE ${UNRETAINED_LEGACY_WORK} LIMIT 1`).bind(Date.now() - HOLD).first())
        throw new Error("Legacy image work lacks retained historical transport and grant identity. Resume its original configured runtime before native target admission.");
}
async function nativeImageSource(env: ProductImageEnv, job: Job): Promise<NativeImageSource> {
    const previewKey = artworkPreviewKey(job.design_id, job.source_sha256), preview = await env.DESIGN_ARTWORK.get(previewKey);
    const object = preview ?? await env.DESIGN_ARTWORK.get(job.artwork_key);
    if (!object || object.size < 1 || object.size > 25000000 || (!preview && object.size !== job.source_size)) throw new Error("Native image source is unavailable.");
    const bytes = new Uint8Array(await object.arrayBuffer());
    const sha256 = await nativeIdentityDigest(bytes), storedDigest = preview?.customMetadata?.["sha256"];
    if (bytes.length !== object.size || (!preview && sha256 !== job.source_sha256) || (storedDigest !== undefined && sha256 !== storedDigest)) throw new Error("Native image source checksum changed before acceptance.");
    return { key: preview ? previewKey : job.artwork_key, size: bytes.length, sha256, contentType: preview ? "image/webp" : "image/png" };
}
function acceptedNativeImageInput(acceptance: NativeV5Acceptance, job: Job): NativeImageSource | undefined {
    const value: unknown = JSON.parse(acceptance.input_json);
    if (typeof value !== "object" || value === null || !("job" in value) || canonicalNativeIdentity(value.job) !== canonicalNativeIdentity(nativeJobIdentity(job)) ||
        !("source" in value) || typeof value.source !== "object" || value.source === null) return undefined;
    const source = value.source;
    if (!("key" in source) || typeof source.key !== "string" || !("size" in source) || typeof source.size !== "number" || !Number.isSafeInteger(source.size) || source.size < 1 || source.size > 25000000 ||
        !("sha256" in source) || typeof source.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(source.sha256) ||
        !("contentType" in source) || (source.contentType !== "image/png" && source.contentType !== "image/webp")) return undefined;
    return { key: source.key, size: source.size, sha256: source.sha256, contentType: source.contentType };
}
async function retainedNativeSourceResponse(env: ProductImageEnv, source: NativeImageSource, status = 200, recipe?: object) {
    const object = await env.DESIGN_ARTWORK.get(source.key);
    if (object?.size !== source.size) return new Response(null, { status: 409 });
    const bytes = new Uint8Array(await object.arrayBuffer());
    if (await nativeIdentityDigest(bytes) !== source.sha256) return new Response(null, { status: 409 });
    const headers = new Headers({ "content-type": source.contentType, "content-length": String(bytes.length), "cache-control": "no-store", "x-image-source-sha256": source.sha256 });
    if (recipe) headers.set("x-image-recipe", JSON.stringify(recipe));
    return new Response(bytes, { status, headers });
}
async function dispatchNativeV5Images(env: ProductImageEnv, revision: string, current: NativeV5Target | undefined, send: typeof fetch) {
    const now = Date.now();
    await env.DB.prepare(`UPDATE product_image_jobs SET status=CASE WHEN attempt_count<3 THEN 'queued' ELSE 'failed' END,updated_at=?
      WHERE status='rendering' AND updated_at<? AND EXISTS(SELECT 1 FROM native_v5_dispatches native WHERE native.job_id=product_image_jobs.id)`)
        .bind(now, now - LEASE).run();
    const pending = await env.DB.prepare(`${JOB_SELECT} WHERE jobs.design_revision_id=? AND jobs.renderer_version='product-images-v5'
      AND jobs.status IN ('queued','failed') AND jobs.attempt_count<3
      AND (jobs.attempt_count=0 OR EXISTS(SELECT 1 FROM native_v5_dispatches accepted WHERE accepted.job_id=jobs.id))
      ${current ? "" : "AND EXISTS(SELECT 1 FROM native_v5_dispatches native WHERE native.job_id=jobs.id)"}
      ORDER BY jobs.created_at,jobs.view LIMIT 6`).bind(revision).all<Job>();
    if (!pending.results.length) return;
    if (!env.STORY_VIDEO_LAMBDA_ACCESS_KEY_ID || !env.STORY_VIDEO_LAMBDA_SECRET_ACCESS_KEY) throw new Error("Install the protected native invocation credentials.");
    const capacity = Number(env.STORY_VIDEO_MAX_INFLIGHT ?? 8);
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 8) throw new Error("Invalid native image admission capacity.");
    const plans = [], sources = new Map<string, NativeImageSource>();
    for (const job of pending.results) {
        const previous = await retainedNativeV5Dispatch(env.DB, job.job_id), target = previous?.target ?? current;
        if (!target) continue;
        const sourceKey = `${job.artwork_key}:${job.source_sha256}`;
        let source = previous ? acceptedNativeImageInput(previous.acceptance, job) : sources.get(sourceKey);
        if (previous) {
            if (!source) throw new Error("Retained native job input changed before retry.");
            const verified = await retainedNativeSourceResponse(env, source);
            await verified.body?.cancel();
            if (verified.status !== 200) throw new Error("Retained native source bytes changed before retry.");
        }
        if (!source) { source = await nativeImageSource(env, job); sources.set(sourceKey, source); }
        const acceptance = await prepareNativeV5Acceptance(env, target, current, job.job_id, job.attempt_count + 1,
            { job: nativeJobIdentity(job), source }, now);
        plans.push({ job, acceptance });
    }
    const occupancy = `((SELECT count(*) FROM product_image_jobs WHERE
      (renderer_version<>'product-images-v5' OR dispatch_provider IS 'native-v5' OR EXISTS(SELECT 1 FROM native_v5_dispatches native WHERE native.job_id=product_image_jobs.id))
      AND (status='rendering' OR (status IN ('ready','failed') AND execution_id IS NOT NULL AND updated_at>?)))
      +(SELECT count(*) FROM story_video_jobs WHERE status='rendering' OR (status IN ('ready','failed') AND execution_id IS NOT NULL AND updated_at>?)))`;
    const statements = plans.flatMap(({ job, acceptance }) => [env.DB.prepare(`UPDATE product_image_jobs SET status='rendering',attempt_count=attempt_count+1,execution_id=NULL,updated_at=?,dispatch_provider='native-v5'
      WHERE id=? AND status IN ('queued','failed') AND attempt_count=? AND (execution_id IS NULL OR updated_at<=?)
      AND NOT EXISTS(SELECT 1 FROM native_v5_dispatches native WHERE native.job_id=product_image_jobs.id AND native.attempt=?)
      ${current ? `AND NOT EXISTS(SELECT 1 FROM product_image_jobs legacy WHERE ${UNRETAINED_LEGACY_WORK})` : ""} AND ${occupancy}<?`)
        .bind(now, job.job_id, job.attempt_count, now - HOLD, acceptance.attempt, ...(current ? [now - HOLD] : []), now - HOLD, now - HOLD, capacity), nativeV5AcceptanceStatement(env.DB, acceptance)]);
    // D1 batch is transactional. The claim and immutable target/input/grant row
    // commit together before any signed AWS request can leave this process.
    const claims = await env.DB.batch(statements);
    await Promise.allSettled(plans.map(async ({ job, acceptance }, index) => {
        if (claims[index * 2]?.meta.changes !== 1 || claims[index * 2 + 1]?.meta.changes !== 1) return;
        const retained = await acceptedNativeV5Grant(env.DB, acceptance.grant, job.job_id, Date.now());
        if (retained?.acceptance.request_sha256 !== acceptance.requestDigest || retained.acceptance.target_digest !== acceptance.targetDigest) throw new Error("Native dispatch acceptance readback differs.");
        const response = await invokeQualifiedNativeV5(env, acceptance.target, acceptance.body, send).catch(() => undefined);
        const uncertain = !response || response.status >= 500 || response.status === 202;
        const accepted = response?.status === 200;
        await env.DB.prepare("UPDATE native_v5_dispatches SET dispatch_state=? WHERE job_id=? AND attempt=? AND dispatch_state='prepared'")
            .bind(uncertain ? "uncertain" : accepted ? "accepted" : "rejected", job.job_id, acceptance.attempt).run();
        if (!accepted) {
            await response?.body?.cancel();
            if (!uncertain) await env.DB.prepare("UPDATE product_image_jobs SET status='failed',updated_at=? WHERE id=? AND attempt_count=? AND status='rendering' AND execution_id IS NULL").bind(Date.now(), job.job_id, acceptance.attempt).run();
            return;
        }
        // FunctionError describes an accepted handler execution. Its retained
        // grant must still authorize a late fenced completion/failure callback.
        if (response.headers.has("x-amz-function-error")) { await response.body?.cancel(); return; }
        const result: unknown = await response.json().catch(() => undefined);
        if (typeof result !== "object" || result === null || !("jobId" in result) || result.jobId !== job.job_id ||
            !("executionId" in result) || typeof result.executionId !== "string" || !UUID.test(result.executionId) ||
            !("key" in result) || result.key !== job.storage_key || !("sha256" in result) || typeof result.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(result.sha256) ||
            !("size" in result) || typeof result.size !== "number" || !Number.isSafeInteger(result.size)) return;
        await env.DB.prepare("UPDATE product_image_jobs SET execution_id=NULL WHERE id=? AND attempt_count=? AND execution_id=? AND status='ready' AND storage_key=? AND sha256=? AND byte_size=?")
            .bind(job.job_id, acceptance.attempt, result.executionId, result.key, result.sha256, result.size).run();
    }));
}
export async function ensureProductImages(env: ProductImageEnv, ids: string | readonly string[], context?: Pick<ExecutionContext, "waitUntil">) {
    if (env.STORY_VIDEO_PROVIDER !== "lambda")
        return;
    const products = typeof ids === "string" ? [ids] : [...new Set(ids)];
    if (products.length < 1 || products.length > 2 || products.some(id => !UUID.test(id)))
        return;
    const nativeTarget = await admittedNativeV5Target(env);
    if (nativeTarget) await assertNativeImageAdmission(env);
    const rows = await env.DB.prepare(`SELECT id, design_id, design_revision_id, base_product_id FROM products
    WHERE id IN (${products.map(() => "?").join(",")}) AND status = 'active' AND design_revision_id IS NOT NULL`)
        .bind(...products).all<Product>();
    const now = Date.now(), version = imageVersion(env);
    const statements = rows.results.flatMap(product => {
        const slug = baseProductSlugForId(product.base_product_id);
        if (!slug)
            return [];
        return productProjectionSpecification(slug).colors.flatMap(colour => (slug === "staple-tee" ? ["flat", "lifestyle"] : ["flat"]).map(view => {
            const key = `designs/${product.design_id}/product-images/${version === VERCEL_IMAGE_VERSION ? "v5" : "v4"}/${product.id}/${product.design_revision_id}/${colour.toLowerCase()}-${view}.webp`;
            return env.DB.prepare(`INSERT INTO product_image_jobs(id, product_id, design_revision_id, colour, view, renderer_version,
        storage_key, created_at, updated_at${nativeTarget ? ", dispatch_provider" : ""}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?${nativeTarget ? ", 'native-v5'" : ""})
        ON CONFLICT(product_id, colour, view, renderer_version) DO NOTHING`)
                .bind(crypto.randomUUID(), product.id, product.design_revision_id, colour, view, version, key, now, now);
        }));
    });
    if (!statements.length)
        return;
    await env.DB.batch(statements);
    const delivery = Promise.allSettled([...new Set(rows.results.map(row => row.design_revision_id))].flatMap(designRevisionId => [
        dispatchProductImages(env, designRevisionId),
        env.STORY_VIDEO_JOBS?.send({ designRevisionId, productImages: true }) ?? Promise.resolve(),
    ])).then(() => undefined);
    if (context)
        context.waitUntil(delivery);
    else
        await delivery;
}
async function dispatchProductImages(env: ProductImageEnv, revision: string, send: typeof fetch = fetch) {
    if (env.STORY_VIDEO_PROVIDER !== "lambda")
        return;
    const nativeTarget = await admittedNativeV5Target(env), nativeSchema = await hasNativeV5Schema(env.DB);
    if (nativeTarget) await assertNativeImageAdmission(env);
    if (nativeSchema) await dispatchNativeV5Images(env, revision, nativeTarget, send);
    if (nativeTarget) return;
    const vercel = env.PRODUCT_IMAGE_PROVIDER === "vercel", version = imageVersion(env);
    const config = vercel ? undefined : validateLambdaStoryVideoEnv(env);
    const grantSecret = vercel ? env.STORY_VIDEO_GRANT_SECRET : config?.grantSecret;
    if (!grantSecret || grantSecret.length < 32)
        throw new Error("Missing image grant secret.");
    // During a paired rollout the new route must exist before any attempt is spent.
    if (vercel && !await vercelAvailable(env, send))
        return;
    const now = Date.now();
    await env.DB.prepare(`UPDATE product_image_jobs SET status = CASE WHEN attempt_count < 3 THEN 'queued' ELSE 'failed' END,
    updated_at = ? WHERE status = 'rendering' AND updated_at < ?
    ${nativeSchema ? "AND dispatch_provider IS NULL AND NOT EXISTS(SELECT 1 FROM native_v5_dispatches native WHERE native.job_id=product_image_jobs.id)" : ""}`).bind(now, now - LEASE).run();
    const pending = await env.DB.prepare(`${JOB_SELECT} WHERE jobs.design_revision_id = ? AND jobs.renderer_version = ?
    ${nativeSchema ? "AND jobs.dispatch_provider IS NULL AND NOT EXISTS(SELECT 1 FROM native_v5_dispatches native WHERE native.job_id=jobs.id)" : ""}
    AND jobs.status IN ('queued','failed') AND jobs.attempt_count < 3 ORDER BY jobs.created_at, jobs.view LIMIT 6`)
        .bind(revision, version).all<Job>();
    if (!pending.results.length)
        return;
    const capacity = Number(vercel ? env.PRODUCT_IMAGE_MAX_INFLIGHT ?? 32 : env.STORY_VIDEO_MAX_INFLIGHT ?? 8);
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > (vercel ? 64 : 8))
        throw new Error("Invalid image render capacity.");
    const nativePredicate = nativeSchema ? "(dispatch_provider IS 'native-v5' OR EXISTS(SELECT 1 FROM native_v5_dispatches native WHERE native.job_id=product_image_jobs.id))" : "0";
    const occupancy = vercel ? `(SELECT count(*) FROM product_image_jobs WHERE renderer_version='product-images-v5' AND NOT (${nativePredicate}) AND
    (status='rendering' OR (status IN ('ready','failed') AND execution_id IS NOT NULL AND updated_at > ?)))` :
        `((SELECT count(*) FROM product_image_jobs WHERE (renderer_version<>'product-images-v5' OR ${nativePredicate}) AND (status='rendering' OR (status IN ('ready','failed') AND execution_id IS NOT NULL AND updated_at > ?)))
    + (SELECT count(*) FROM story_video_jobs WHERE status='rendering' OR (status IN ('ready','failed') AND execution_id IS NOT NULL AND updated_at > ?)))`;
    // D1 serializes conditional claims. Vercel has its own bounded lane; Lambda
    // images and videos retain their original shared reserved-concurrency limit.
    const claims = await env.DB.batch(pending.results.map(job => env.DB.prepare(`UPDATE product_image_jobs
    SET status='rendering',attempt_count=attempt_count+1,execution_id=NULL,updated_at=?
    WHERE id=? AND status IN ('queued','failed') AND attempt_count=? AND (execution_id IS NULL OR updated_at<=?) AND ${occupancy} < ?`)
        .bind(now, job.job_id, job.attempt_count, now - HOLD, ...(vercel ? [now - HOLD] : [now - HOLD, now - HOLD]), capacity)));
    const signer = config ? new AwsClient({ accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey, service: "lambda", region: "ap-southeast-2", retries: 0 }) : undefined;
    await Promise.allSettled(pending.results.map(async (job, index) => {
        if (claims[index]?.meta.changes !== 1)
            return;
        const attempt = job.attempt_count + 1;
        try {
            const slug = baseProductSlugForId(job.base_product_id);
            if (!slug)
                throw new Error("Unknown product.");
            const grant = await createStoryVideoGrant(grantSecret, job.job_id, attempt);
            const request = vercel ? new Request(`${rendererOrigin(env)}/api/internal/product-image-render`, { method: "POST", headers: vercelHeaders(env), body: JSON.stringify({ jobId: job.job_id, grant, rendererVersion: version }) }) : signer && config ? await signer.sign(`https://lambda.ap-southeast-2.amazonaws.com/2015-03-31/functions/${encodeURIComponent(config.functionArn)}/invocations`, {
                method: "POST", headers: { "content-type": "application/json", "x-amz-invocation-type": "RequestResponse" },
                body: JSON.stringify({ kind: "product-image", schemaVersion: 1, jobId: job.job_id, attempt, grant,
                    rendererVersion: PRODUCT_IMAGE_VERSION, artwork: { sha256: job.source_sha256, size: job.source_size },
                    baseProductSlug: slug, color: job.colour, view: job.view, printMode: job.print_mode, storageKey: job.storage_key,
                    settings: { cropX: job.crop_x, cropY: job.crop_y, cropZoom: job.crop_zoom, depth: job.placement_depth,
                        placementX: job.placement_x, placementY: job.placement_y, placementWidth: job.placement_width } }),
            }) : undefined;
            if (!request)
                throw new Error("Image renderer unavailable.");
            const dispatchedAt = Date.now();
            console.info("Product image dispatched", { jobId: job.job_id, attempt, view: job.view, colour: job.colour,
                queuedMs: dispatchedAt - job.created_at });
            // Still renders finish in seconds. A synchronous response proves the
            // invocation ended, so a verified completion can release its slot now.
            // Lost/invalid responses retain the existing lease and completion hold.
            const response = await send(request, { redirect: "manual", signal: AbortSignal.timeout(25000) }).catch(() => undefined);
            if (!response)
                return;
            if (response.status === 200 && !response.headers.has("x-amz-function-error")) {
                const result: unknown = await response.json().catch(() => undefined);
                if (typeof result !== "object" || result === null ||
                    !("jobId" in result) || result.jobId !== job.job_id ||
                    !("executionId" in result) || typeof result.executionId !== "string" || !UUID.test(result.executionId) ||
                    !("key" in result) || result.key !== job.storage_key ||
                    !("sha256" in result) || typeof result.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(result.sha256) ||
                    !("size" in result) || typeof result.size !== "number" || !Number.isSafeInteger(result.size))
                    return;
                const released = await env.DB.prepare(`UPDATE product_image_jobs SET execution_id=NULL
          WHERE id=? AND attempt_count=? AND execution_id=? AND status='ready' AND storage_key=? AND sha256=? AND byte_size=?`)
                    .bind(job.job_id, attempt, result.executionId, result.key, result.sha256, result.size).run();
                console.info("Product image invocation completed", { jobId: job.job_id, attempt,
                    invocationMs: Date.now() - dispatchedAt, slotReleased: released.meta.changes === 1 });
                return;
            }
            await response.body?.cancel();
            if (response.status >= 500 || response.status === 202 || response.status === 200)
                return;
            throw new Error("Native image dispatch rejected.");
        }
        catch {
            await env.DB.prepare(`UPDATE product_image_jobs SET status='failed', updated_at=?
        WHERE id=? AND attempt_count=? AND status='rendering' AND execution_id IS NULL`).bind(Date.now(), job.job_id, attempt).run();
        }
    }));
}
export async function reconcileProductImages(env: ProductImageEnv) {
    if (env.STORY_VIDEO_PROVIDER !== "lambda")
        return;
    // Inaccessible images cannot be served; their durable deletion is independent
    // of generation and also covers revisions removed by privacy maintenance.
    const obsolete = await env.DB.prepare(`SELECT id, storage_key FROM product_image_jobs jobs
    WHERE NOT EXISTS (SELECT 1 FROM products JOIN designs ON designs.id=products.design_id
      WHERE products.id=jobs.product_id AND products.status='active' AND designs.status='ready'
      AND products.design_revision_id=jobs.design_revision_id) LIMIT 100`).all<{
        id: string;
        storage_key: string;
    }>();
    for (const job of obsolete.results) {
        await env.DESIGN_ARTWORK.delete(job.storage_key);
        await env.DB.prepare("DELETE FROM product_image_jobs WHERE id=?").bind(job.id).run();
    }
    const nativeSchema = await hasNativeV5Schema(env.DB);
    const rows = await env.DB.prepare(`SELECT DISTINCT design_revision_id FROM product_image_jobs
    WHERE (renderer_version=? ${nativeSchema ? "OR dispatch_provider IS 'native-v5' OR EXISTS(SELECT 1 FROM native_v5_dispatches native WHERE native.job_id=product_image_jobs.id)" : ""})
    AND status IN ('queued','rendering','failed') AND (attempt_count<3 OR status='rendering') LIMIT 40`).bind(imageVersion(env)).all<{
        design_revision_id: string;
    }>();
    // Each dispatcher is bounded by the shared D1 admission ceiling.
    for (const row of rows.results)
        await dispatchProductImages(env, row.design_revision_id);
}
export async function consumeProductImageMessage(message: Message, env: ProductImageEnv) {
    const body: unknown = message.body;
    if (typeof body !== "object" || body === null || !("productImages" in body) || body.productImages !== true)
        return false;
    if (!("designRevisionId" in body) || typeof body.designRevisionId !== "string" || !UUID.test(body.designRevisionId)) {
        message.ack();
        return true;
    }
    try {
        await dispatchProductImages(env, body.designRevisionId);
        const nativeSchema = await hasNativeV5Schema(env.DB);
        const remaining = await env.DB.prepare(`SELECT id FROM product_image_jobs WHERE design_revision_id=?
      AND (renderer_version=? ${nativeSchema ? "OR dispatch_provider IS 'native-v5' OR EXISTS(SELECT 1 FROM native_v5_dispatches native WHERE native.job_id=product_image_jobs.id)" : ""})
      AND (status='rendering' OR (status IN ('queued','failed') AND attempt_count<3)) LIMIT 1`).bind(body.designRevisionId, imageVersion(env)).first();
        if (remaining)
            message.retry({ delaySeconds: 5 });
        else
            message.ack();
    }
    catch {
        message.retry({ delaySeconds: 10 });
    }
    return true;
}
export async function productImageResponse(request: Request, env: ProductImageEnv, context?: Pick<ExecutionContext, "waitUntil">) {
    const lookupStarted = performance.now();
    const url = new URL(request.url);
    const match = /^\/v2\/internal\/configured-products\/([a-f0-9-]{36})\/images\/(flat|lifestyle)\/(black|white|cream)$/.exec(url.pathname);
    if (!match)
        return;
    if (!await isAuthenticatedServiceRequest(request, env))
        return new Response(null, { status: 401 });
    if (!["GET", "HEAD"].includes(request.method))
        return new Response(null, { status: 405 });
    const [, id, view, colour] = match;
    if (!id || !view || !colour)
        return new Response(null, { status: 404 });
    const nativeSchema = await hasNativeV5Schema(env.DB);
    const nativeJob = nativeSchema ? "(jobs.dispatch_provider IS 'native-v5' OR EXISTS(SELECT 1 FROM native_v5_dispatches native WHERE native.job_id=jobs.id))" : "0";
    const readJob = () => env.DB.prepare(`${JOB_SELECT} WHERE jobs.product_id=? AND lower(jobs.colour)=? AND jobs.view=? AND (jobs.renderer_version=? OR ${nativeJob}) ${nativeSchema ? `ORDER BY ${nativeJob} DESC` : ""} LIMIT 1`)
        .bind(id, colour, view, imageVersion(env)).first<Job>();
    let job = await readJob();
    // An existing job already joins the current active product/revision/design.
    // Avoid a second serial authorization read for every readiness poll and GET.
    const product = job ?? await env.DB.prepare(`SELECT products.id, products.design_id, coalesce(products.design_revision_id, designs.id) AS design_revision_id, products.base_product_id
    FROM products JOIN designs ON designs.id=products.design_id AND designs.deleted_at IS NULL
    WHERE products.id=? AND products.status='active' AND (designs.status='ready' OR (designs.status='processing' AND designs.artwork_job_id IS NOT NULL AND designs.finalized_at IS NOT NULL))`).bind(id).first<Product>();
    const slug = product ? baseProductSlugForId(product.base_product_id) : undefined;
    if (!product || !slug || (url.searchParams.has("revision") && product.design_revision_id !== url.searchParams.get("revision")) ||
        !productProjectionSpecification(slug).colors.some(value => value.toLowerCase() === colour) || (view === "lifestyle" && slug !== "staple-tee"))
        return new Response(null, { status: 404 });
    if (!job) {
        await ensureProductImages(env, id, context);
        job = await readJob();
    }
    const headers = new Headers({ "cache-control": "private, no-store", "x-content-type-options": "nosniff" });
    const timing = (name: string, started: number) => { headers.append("server-timing", name + ";dur=" + (performance.now() - started).toFixed(1)); };
    timing("image-lookup", lookupStarted);
    if (request.method === "GET" && context && job?.renderer_version === VERCEL_IMAGE_VERSION &&
        (job.status === "queued" || job.status === "rendering")) {
        const waitStarted = performance.now();
        const deadline = Date.now() + 2000;
        if (job.status === "queued")
            context.waitUntil(dispatchProductImages(env, product.design_revision_id).catch(() => undefined));
        while (job && (job.status === "queued" || job.status === "rendering") && Date.now() < deadline && !request.signal.aborted) {
            await new Promise(resolve => setTimeout(resolve, 150));
            // Poll the immutable output in R2, keeping repeated readiness reads off
            // the D1 writer used to claim and publish concurrent image jobs.
            if (await env.DESIGN_ARTWORK.head(job.storage_key))
                job = await readJob();
        }
        // R2 existence is only a hint. Revalidate publication and access even when
        // the wait expires before an object appears or the request is aborted.
        job = await readJob();
        timing("image-wait", waitStarted);
        // A deletion/revision change during the short wait must still revoke access.
        if (!job)
            return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
    }
    if (job?.status !== "ready") {
        // A visible product must not rely solely on delayed queue delivery. The
        // same atomic claims preserve the release pause and provider admission ceiling.
        if (context && (job?.status === "queued" || (job?.status === "failed" && job.attempt_count < 3))) {
            context.waitUntil(dispatchProductImages(env, product.design_revision_id).catch(() => {
                console.error("Product image admission failed", { productId: id });
            }));
        }
        headers.set("retry-after", "2");
        return new Response(null, { status: job?.status === "failed" && job.attempt_count >= 3 ? 410 : 202, headers });
    }
    const masterStarted = performance.now();
    const object = await env.DESIGN_ARTWORK.get(job.storage_key);
    timing("image-master-read", masterStarted);
    if (!object || object.customMetadata?.["sha256"] !== job.sha256 || object.size !== job.byte_size)
        return new Response(null, { status: 503, headers });
    headers.set("content-type", "image/webp");
    headers.set("etag", object.httpEtag);
    headers.set("content-length", String(object.size));
    const width = Number(url.searchParams.get("width") ?? 1500);
    const format = url.searchParams.get("format") === "png" ? "image/png" : "image/webp";
    if (![192, 384, 768, 960, 1200, 1500].includes(width)) {
        await object.body.cancel();
        return new Response(null, { status: 400, headers });
    }
    if (request.method === "HEAD") {
        await object.body.cancel();
        return new Response(null, { headers });
    }
    // V5 is already a 768px display image. Deliver it directly on a cold read,
    // avoiding another Images transform and R2 write before the first display.
    if (job.renderer_version === VERCEL_IMAGE_VERSION && format === "image/webp")
        return new Response(object.body, { headers });
    if (env.IMAGES && (width < 1500 || format !== "image/webp")) {
        const sizeKey = job.storage_key.replace(/\.webp$/, `-${String(width)}.${format === "image/png" ? "png" : "webp"}`);
        const variantStarted = performance.now();
        const cached = await env.DESIGN_ARTWORK.get(sizeKey);
        timing("image-variant-read", variantStarted);
        if (cached) {
            await object.body.cancel();
            headers.set("content-type", format);
            headers.set("content-length", String(cached.size));
            headers.set("etag", cached.httpEtag);
            return new Response(cached.body, { headers });
        }
        const resizeStarted = performance.now();
        const resized = await env.IMAGES.input(new Blob([await object.arrayBuffer()]).stream()).transform({ width, fit: "scale-down" }).output({ format, quality: 90 });
        const result = await resized.response().arrayBuffer();
        timing("image-resize", resizeStarted);
        const writeStarted = performance.now();
        const saved = await env.DESIGN_ARTWORK.put(sizeKey, result, { httpMetadata: { contentType: format }, customMetadata: { sourceImageSha256: job.sha256 } });
        timing("image-variant-write", writeStarted);
        headers.set("content-length", String(result.byteLength));
        headers.set("content-type", format);
        headers.set("etag", saved.httpEtag);
        return new Response(result, { headers });
    }
    return new Response(object.body, { headers });
}
async function vercelSourceResponse(env: ProductImageEnv, job: Job, status = 200, recipe?: object) {
    const preview = await env.DESIGN_ARTWORK.get(artworkPreviewKey(job.design_id, job.source_sha256));
    const object = preview ?? await env.DESIGN_ARTWORK.get(job.artwork_key);
    if (!object || object.size > 25000000 || (!preview && object.size !== job.source_size))
        return new Response(null, { status: 404 });
    const headers = new Headers({ "content-type": preview ? "image/webp" : "image/png", "content-length": String(object.size), "cache-control": "no-store" });
    if (recipe)
        headers.set("x-image-recipe", JSON.stringify(recipe));
    const storedDigest = preview?.customMetadata?.["sha256"];
    if (!preview || (storedDigest && /^[a-f0-9]{64}$/.test(storedDigest))) {
        headers.set("x-image-source-sha256", storedDigest ?? job.source_sha256);
        return new Response(object.body, { status, headers });
    }
    const bytes = await object.arrayBuffer();
    headers.set("x-image-source-sha256", Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), value => value.toString(16).padStart(2, "0")).join(""));
    return new Response(bytes, { status, headers });
}
export async function productImageTransfer(request: Request, env: ProductImageEnv) {
    const match = /^\/v2\/internal\/product-image-jobs\/([a-f0-9-]{36})\/(claim|artwork|image|failure)$/.exec(new URL(request.url).pathname);
    if (!match)
        return;
    const [, id, action] = match;
    if (!id || !UUID.test(id))
        return new Response(null, { status: 403 });
    const token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    const native = token.startsWith("nv5_") ? await acceptedNativeV5Grant(env.DB, token, id, Date.now(), action === "failure" ? 15 * 60000 : 0) : undefined;
    const grant = token.startsWith("nv5_") ? native : env.STORY_VIDEO_GRANT_SECRET ? await verifyStoryVideoGrant(env.STORY_VIDEO_GRANT_SECRET, token, id, Date.now(), action === "failure" ? 15 * 60000 : 0) : undefined;
    if (!grant)
        return new Response(null, { status: 403 });
    if (!native && await hasNativeV5Schema(env.DB) && await env.DB.prepare(`SELECT id FROM product_image_jobs WHERE id=? AND attempt_count=?
      AND (dispatch_provider IS 'native-v5' OR EXISTS(SELECT 1 FROM native_v5_dispatches native WHERE native.job_id=product_image_jobs.id AND native.attempt=product_image_jobs.attempt_count))`).bind(id, grant.attempt).first())
        return new Response(null, { status: 403 });
    const execution = request.headers.get("x-image-execution-id");
    if (execution !== null && !UUID.test(execution))
        return new Response(null, { status: 400 });
    const job = await env.DB.prepare(`${JOB_SELECT} WHERE jobs.id=? AND jobs.attempt_count=? AND jobs.renderer_version IN ('product-images-v4','product-images-v5')
    AND (jobs.status='rendering' OR (jobs.status='ready' AND ?='image'))`).bind(id, grant.attempt, action).first<Job>();
    if (!job)
        return new Response(null, { status: action === "claim" || action === "failure" ? 204 : 409 });
    const nativeSource = native ? acceptedNativeImageInput(native.acceptance, job) : undefined;
    if (native && !nativeSource) return new Response(null, { status: 409 });
    if (request.headers.has("x-image-renderer-version") && request.headers.get("x-image-renderer-version") !== job.renderer_version)
        return new Response(null, { status: 409 });
    if (action === "claim") {
        if (request.method !== "POST" || !execution)
            return new Response(null, { status: 400 });
        const result = await env.DB.prepare(`UPDATE product_image_jobs SET execution_id=? WHERE id=? AND status='rendering'
      AND attempt_count=? AND (execution_id IS NULL OR execution_id=?)`).bind(execution, id, grant.attempt, execution).run();
        if (result.meta.changes !== 1)
            return new Response(null, { status: 204 });
        if (job.renderer_version === VERCEL_IMAGE_VERSION) {
            const recipe = { baseProductSlug: baseProductSlugForId(job.base_product_id), color: job.colour, view: job.view, printMode: job.print_mode, storageKey: job.storage_key,
                settings: { cropX: job.crop_x, cropY: job.crop_y, cropZoom: job.crop_zoom, depth: job.placement_depth, placementX: job.placement_x, placementY: job.placement_y, placementWidth: job.placement_width } };
            if (request.headers.get("accept") === "application/vnd.bent.product-image-source")
                return nativeSource ? retainedNativeSourceResponse(env, nativeSource, 201, recipe) : vercelSourceResponse(env, job, 201, recipe);
            return Response.json(recipe, { status: 201, headers: { "cache-control": "no-store" } });
        }
        return new Response(null, { status: 201 });
    }
    if (action === "failure") {
        if (request.method !== "POST")
            return new Response(null, { status: 405 });
        await env.DB.prepare(`UPDATE product_image_jobs SET status='failed', updated_at=? WHERE id=? AND status='rendering'
      AND attempt_count=? AND (execution_id=? OR (execution_id IS NULL AND ? IS NULL))`).bind(Date.now(), id, grant.attempt, execution, execution).run();
        return new Response(null, { status: 204 });
    }
    if (!execution || job.execution_id !== execution)
        return new Response(null, { status: 409 });
    if (action === "artwork") {
        if (request.method !== "GET")
            return new Response(null, { status: 405 });
        if (job.renderer_version === VERCEL_IMAGE_VERSION)
            return nativeSource ? retainedNativeSourceResponse(env, nativeSource) : vercelSourceResponse(env, job);
        const object = await env.DESIGN_ARTWORK.get(job.artwork_key);
        if (object?.size !== job.source_size)
            return new Response(null, { status: 404 });
        return new Response(object.body, { headers: { "content-type": "image/png", "content-length": String(object.size), "cache-control": "no-store" } });
    }
    if (request.method !== "PUT")
        return new Response(null, { status: 405 });
    const size = Number(request.headers.get("content-length"));
    const digest = request.headers.get("x-image-sha256");
    if (!request.body || !Number.isSafeInteger(size) || size < 12 || size > 2000000 || !digest || !/^[a-f0-9]{64}$/.test(digest) ||
        request.headers.get("content-type") !== "image/webp")
        return new Response(null, { status: 400 });
    const reader = request.body.getReader();
    const bytes = new Uint8Array(size);
    let offset = 0;
    try {
        for (let item = await reader.read(); !item.done; item = await reader.read()) {
            if (offset + item.value.length > size)
                return new Response(null, { status: 413 });
            bytes.set(item.value, offset);
            offset += item.value.length;
        }
    }
    finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
    }
    if (offset !== size || new TextDecoder().decode(bytes.subarray(0, 4)) !== "RIFF" ||
        new TextDecoder().decode(bytes.subarray(8, 12)) !== "WEBP")
        return new Response(null, { status: 422 });
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), value => value.toString(16).padStart(2, "0")).join("");
    if (hash !== digest)
        return new Response(null, { status: 422 });
    const writeStarted = performance.now();
    const stored = await env.DESIGN_ARTWORK.put(job.storage_key, bytes, { onlyIf: { etagDoesNotMatch: "*" }, sha256: digest,
        httpMetadata: { contentType: "image/webp" }, customMetadata: { sha256: digest, sourceSha256: job.source_sha256, rendererVersion: job.renderer_version } });
    const object = stored ?? await env.DESIGN_ARTWORK.head(job.storage_key);
    if (object?.size !== size || object.customMetadata?.["sha256"] !== digest)
        return new Response(null, { status: 409 });
    const writtenAt = performance.now();
    const result = await env.DB.prepare(`UPDATE product_image_jobs SET status='ready', sha256=?, byte_size=?, updated_at=?
    WHERE id=? AND attempt_count=? AND execution_id=? AND status IN ('rendering','ready')
      AND EXISTS (SELECT 1 FROM products JOIN designs ON designs.id=products.design_id AND designs.status='ready'
        WHERE products.id=product_image_jobs.product_id AND products.status='active' AND products.design_revision_id=product_image_jobs.design_revision_id)`)
        .bind(digest, size, Date.now(), id, grant.attempt, execution).run();
    if (result.meta.changes !== 1) {
        // Leave any winning immutable output intact; the orphan sweep handles a
        // deletion racing upload after its normal grace period.
        return new Response(null, { status: 409 });
    }
    console.info("Product image ready", { jobId: id, view: job.view, colour: job.colour, size,
        r2WriteMs: writtenAt - writeStarted, publishMs: performance.now() - writtenAt });
    return Response.json({ key: job.storage_key, size, sha256: digest }, { headers: { "cache-control": "no-store" } });
}
export async function legacyProductImageResponse(request: Request, env: ProductImageEnv, context?: Pick<ExecutionContext, "waitUntil">) {
    const url = new URL(request.url);
    const match = /^\/v2\/internal\/designs\/([a-f0-9-]{36})\/images\/([a-f0-9-]{36,64})\/(black|white)$/.exec(url.pathname);
    if (!match)
        return;
    if (!await isAuthenticatedServiceRequest(request, env))
        return new Response(null, { status: 401 });
    const [, design, revision, colour] = match;
    if (!design || !revision || !colour)
        return new Response(null, { status: 404 });
    const product = await env.DB.prepare("SELECT products.id FROM products JOIN design_revisions revisions ON revisions.id=products.design_revision_id\n    WHERE products.design_id=? AND products.status='active' AND products.base_product_id='" + "a51b7acf-77e9-4762-83c4-62d96dd8942c" + "'\n      AND (revisions.id=? OR revisions.sha256=?) LIMIT 1").bind(design, revision, revision).first<{
        id: string;
    }>();
    if (!product)
        return new Response(null, { status: 404 });
    url.pathname = `/v2/internal/configured-products/${product.id}/images/flat/${colour}`;
    return productImageResponse(new Request(url, request), env, context);
}
// A read-only, revision-fenced display source. Rendering this source in a browser
// does not claim native capacity, publish a master, or advance a job's state.
export async function productPreviewResponse(request: Request, env: ProductImageEnv) {
    const match = /^\/v2\/internal\/configured-products\/([a-f0-9-]{36})\/preview\/([a-f0-9-]{36})$/.exec(new URL(request.url).pathname);
    if (!match)
        return;
    if (!await isAuthenticatedServiceRequest(request, env))
        return new Response(null, { status: 401 });
    if (request.method !== "GET")
        return new Response(null, { status: 405 });
    const product = await env.DB.prepare(`SELECT products.design_id, coalesce(products.design_revision_id, designs.id) AS design_revision_id, products.base_product_id,
    products.placement_x, products.placement_y, products.placement_width, products.placement_depth, products.print_mode,
    coalesce(revisions.artwork_key, designs.artwork_key) AS artwork_key,
    coalesce(revisions.sha256, designs.sha256) AS sha256,
    coalesce(revisions.crop_x, designs.crop_x) AS crop_x, coalesce(revisions.crop_y, designs.crop_y) AS crop_y,
    coalesce(revisions.crop_zoom, designs.crop_zoom) AS crop_zoom
    FROM products JOIN designs ON designs.id=products.design_id AND designs.deleted_at IS NULL
    AND designs.status IN ('ready', 'processing')
    LEFT JOIN design_revisions revisions ON revisions.id=products.design_revision_id AND revisions.design_id=products.design_id
    WHERE products.id=? AND coalesce(products.design_revision_id, designs.id)=? AND products.status='active'
      AND (revisions.id IS NOT NULL OR (products.design_revision_id IS NULL AND designs.artwork_job_id IS NOT NULL AND designs.finalized_at IS NOT NULL))`)
        .bind(match[1], match[2]).first<{
        design_id: string;
        design_revision_id: string;
        base_product_id: string;
        placement_x: number;
        placement_y: number;
        placement_width: number;
        placement_depth: number;
        print_mode: string;
        artwork_key: string;
        sha256: string;
        crop_x: number;
        crop_y: number;
        crop_zoom: number;
    }>();
    const slug = product ? baseProductSlugForId(product.base_product_id) : undefined;
    const headers = new Headers({ "cache-control": "private, no-store", "x-content-type-options": "nosniff" });
    if (!product || !slug)
        return new Response(null, { status: 404, headers });
    const object = await env.DESIGN_ARTWORK.get(artworkPreviewKey(product.design_id, product.sha256)) ?? await env.DESIGN_ARTWORK.get(product.artwork_key);
    if (!object)
        return new Response(null, { status: 503, headers });
    headers.set("content-type", object.httpMetadata?.contentType ?? "image/png");
    headers.set("x-product-preview", JSON.stringify({ revision: product.design_revision_id, baseProductSlug: slug,
        settings: { cropX: product.crop_x, cropY: product.crop_y, cropZoom: product.crop_zoom,
            depth: product.print_mode === "base-image-only" ? 0 : product.placement_depth,
            placementX: product.placement_x, placementY: product.placement_y, placementWidth: product.placement_width } }));
    return new Response(object.body, { headers });
}
