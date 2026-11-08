import { readDesignMedia } from "./design-media";
import { safeErrorDetails } from "@forever-tee/contracts/diagnostics";
import { pendingProductPreparation } from "./pending-product-families";
import { DESIGN_SOURCE_CONTENT_TYPES, MAX_PREPARED_ARTWORK_BYTES } from "@forever-tee/contracts/limits";
import { printBufferAdmission, isPrintMemoryCapacityError } from "./print-asset-memory";
import type {
  EditorSettingsDto,
} from "@forever-tee/contracts";
import { Effect } from "effect";
import { artworkPreviewKey, generateArtworkPreview, prepareInlineArtworkPreview, storeArtworkPreview } from "./artwork-preview";
import {
  baseProductSlugForId,
  STAPLE_TEE_BASE_PRODUCT_ID,
  COTTON_TOTE_BASE_PRODUCT_ID,
  projectEditorPlacement,
} from "@forever-tee/contracts";

import { rateLimitAllows } from "./abuse-controls";
import { designRevisionFingerprint } from "./design-revision-repository";
import {
  type ImageProcessingBinding,
  JPEG_CONTENT_TYPE,
  sourceContentType,
  MAX_SOURCE_BYTES,
  processJpeg,
} from "./image-processing";
import {
  makeOpenAiSafetyScreeningClient,
  type SafetyScreeningClient,
} from "./openai-safety-screening";
import {
  makeClefProductColorAnalysisClient,
  type PendingProductColorAnalysis,
  type ProductColorAnalysisClient,
  type ProductColorAnalysisEnv,
  type ProductColorAnalysisResult,
} from "./product-color-analysis";
import { deliverArtworkPreparation, publishArtworkPreparation } from "./artwork-preparation-jobs";
import { processPortraitForCanvas, processPortraitForStorage } from "./portrait-processing";
import { ensureConfiguredProductPrintAssets, productPrintResolution, productMaximumCropZoom } from "./print-assets";
import { enqueuePrintAssetJobs, type PrintAssetJobEnv } from "./print-asset-jobs";
import { takeProviderToken } from "./provider-admission";
import { isAuthenticatedServiceRequest } from "./service-auth";
import { deleteOwnedDesign } from "./design-deletion";
import { listSavedDesigns } from "./saved-design-pages";

const DESIGN_PATH = /^\/v2\/design-drafts\/([0-9a-f-]{36})$/;
const CLAIM_PATH = /^\/v2\/design-drafts\/([0-9a-f-]{36})\/claim$/;
const GRANT_PATH = /^\/v2\/design-drafts\/([0-9a-f-]{36})\/upload-grants$/;
const UPLOAD_PATH = "/v2/design-upload-grants";
const CONFIGURED_PRODUCTS_PATH = "/v2/configured-products";
const CONFIGURED_FAMILIES_PATH = "/v2/configured-product-families";
const BACKGROUND_REMOVAL_PATH = "/v2/background-removal";
const GRANT_LIFETIME_MS = 5 * 60 * 1_000;
export const PROCESSING_LEASE_MS = 10 * 60 * 1_000;

type ConfiguredMedia = (productIds: readonly string[]) => Promise<void>;

async function persistConfiguredOutboxes(tasks: readonly Promise<unknown>[]) {
  // A failing sibling must not end the request's lifetime before the other
  // durable outboxes finish. Provider delivery owns separate waitUntil tasks.
  const results = await Promise.allSettled(tasks);
  const failed = results.find(result => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
}


interface AnonymousDesignEnv extends PrintAssetJobEnv, ProductColorAnalysisEnv {
  readonly OPENAI_API_KEY?: string;
  readonly SAFETY_SCREENING?: SafetyScreeningClient;
  readonly PRODUCT_COLOR_ANALYSIS?: ProductColorAnalysisClient;
  readonly STORY_VIDEO_FAMILY_CONFIGURATION?: string;
  readonly DB: D1Database;
  readonly DESIGN_ARTWORK: R2Bucket;
  readonly STORY_VIDEOS: R2Bucket;
  readonly IMAGES: ImagesBinding & ImageProcessingBinding;
  readonly OWNER_MUTATION_RATE_LIMIT: RateLimit;
  readonly IMAGE_PROCESS_RATE_LIMIT: RateLimit;
  readonly FOREVER_TEE_API_SHARED_SECRET?: string;
}

interface DesignRow {
  readonly id: string;
  readonly owner_id: string | null;
  readonly artwork_key: string;
  readonly original_artwork_key: string | null;
  readonly artwork_job_id: string | null;
  readonly artwork_job_status: string | null;
  readonly remove_background: number | null;
  readonly artwork_height: number | null;
  readonly artwork_width: number | null;
  readonly content_type: string;
  readonly byte_size: number;
  readonly sha256: string;
  readonly crop_x: number;
  readonly crop_y: number;
  readonly crop_zoom: number;
  readonly placement_x: number;
  readonly placement_y: number;
  readonly placement_width: number;
  readonly depth: number;
  readonly default_product_color: "Black" | "White";
  readonly default_product_color_status: "pending" | "complete" | "fallback";
  readonly status: string;
  readonly version: number;
  readonly finalized_at: number | null;
  readonly legacy_claim_expires_at: number | null;
  readonly created_at: number;
  readonly updated_at: number;
  readonly deleted_at: number | null;
}

interface GrantRow {
  readonly progressive: number;
  readonly token_hash: string;
  readonly design_id: string;
  readonly owner_id: string;
  readonly expected_version: number;
  readonly content_type: string;
  readonly max_bytes: number;
  readonly expires_at: number;
  readonly used_at: number | null;
}

interface ProductRow {
  readonly id: string;
  readonly base_product_id: string;
  readonly design_id: string | null;
  readonly design_revision_id: string | null;
  readonly placement_depth: number | null;
  readonly placement_width: number | null;
  readonly placement_x: number | null;
  readonly placement_y: number | null;
  readonly projection_version: "legacy-shirt-v1" | "safe-margin-v1" | null;
  readonly default_color: "Black" | "White";
  readonly shopify_handle: string;
  readonly created_at: number;
}


export async function handleAnonymousDesignRequest(
  request: Request,
  env: AnonymousDesignEnv,
  context?: Pick<ExecutionContext, "waitUntil">,
  configuredMedia?: ConfiguredMedia,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (
    !url.pathname.startsWith("/v2/design-") &&
    url.pathname !== CONFIGURED_PRODUCTS_PATH &&
    url.pathname !== CONFIGURED_FAMILIES_PATH &&
    url.pathname !== BACKGROUND_REMOVAL_PATH
  ) return undefined;

  // Capabilities belong in the query, which platform telemetry explicitly
  // redacts. URL-path redaction is heuristic and can miss valid random tokens.
  if (url.pathname.startsWith(`${UPLOAD_PATH}/`)) {
    return apiError(410, "UPLOAD_EXPIRED", "This upload link expired. Retry the upload.");
  }
  if (url.pathname === UPLOAD_PATH && request.method === "PUT") {
    const token = url.searchParams.get("token");
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return notFound();
    return useUploadGrant(request, env, token, context);
  }

  const ownerId = await authenticateServiceRequest(request, env);
  if (!ownerId) return apiError(401, "UNAUTHORIZED", "Service authentication is required.");
  if (
    request.method !== "GET" && request.method !== "HEAD" &&
    !await rateLimitAllows(env.OWNER_MUTATION_RATE_LIMIT, ownerId)
  ) return rateLimited();

  if (url.pathname === BACKGROUND_REMOVAL_PATH && request.method === "POST") {
    return removeBackgroundPreview(request, env, ownerId);
  }

  if (url.pathname === CONFIGURED_PRODUCTS_PATH && request.method === "POST") {
    return configureProduct(request, env, ownerId, context, configuredMedia);
  }
  if (url.pathname === CONFIGURED_FAMILIES_PATH && request.method === "POST") {
    return env.STORY_VIDEO_FAMILY_CONFIGURATION === "1"
      ? configureProductFamily(request, env, ownerId, context, configuredMedia) : notFound();
  }

  if (url.pathname === "/v2/design-drafts" && request.method === "POST") {
    if (!await rateLimitAllows(env.IMAGE_PROCESS_RATE_LIMIT, `draft:${ownerId}`)) {
      return rateLimited();
    }
    return createDraft(env, ownerId);
  }
  if (url.pathname === "/v2/design-drafts" && request.method === "GET") {
    return listSavedDesigns(env, ownerId, url);
  }

  const retryMatch = /^\/v2\/design-drafts\/([0-9a-f-]{36})\/artwork-processing$/.exec(url.pathname);
  if (retryMatch && request.method === "POST") {
    const id = retryMatch[1];
    if (!id) return notFound();
    const current = await ownedDraft(env.DB, ownerId, id);
    const payload: unknown = await request.json().catch(() => undefined);
    if (!current) return notFound();
    if (!isRecord(payload) || payload["artworkJobId"] !== current.artwork_job_id || !current.artwork_job_id) return badRequest("The photo changed. Reload and try again.");
    const job = await env.DB.prepare("SELECT source_key FROM artwork_preparation_jobs WHERE id = ? AND status = 'failed'")
      .bind(current.artwork_job_id).first<{ source_key: string }>();
    if (!job) return conflict("DRAFT_NOT_READY", "Photo preparation is already in progress.");
    if (!await env.DESIGN_ARTWORK.head(job.source_key)) return conflict("DRAFT_NOT_READY", "Please take or upload the photo again.");
    if (!await allowPortraitProcessing(env, ownerId)) return rateLimited();
    const retried = await env.DB.prepare(`UPDATE artwork_preparation_jobs SET status = 'pending', attempts = 0, next_attempt_at = ?, updated_at = ?
      WHERE id = ? AND status = 'failed' AND source_deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM designs WHERE id = ? AND artwork_job_id = ? AND deleted_at IS NULL)`)
      .bind(Date.now(), Date.now(), current.artwork_job_id, id, current.artwork_job_id).run();
    if (retried.meta.changes !== 1) return conflict("DRAFT_NOT_READY", "The photo changed or expired. Please take or upload it again.");
    await deliverArtworkPreparation(env, current.artwork_job_id);
    return Response.json({ id }, { status: 202 });
  }

  const mediaMatch = /^\/v2\/design-drafts\/([0-9a-f-]{36})\/artwork(\/preview)?$/.exec(url.pathname);
  if (mediaMatch && request.method === "GET") {
    const id = mediaMatch[1];
    if (!id) return notFound();
    const result = await Effect.runPromise(Effect.either(
      readDesignMedia(env, id, { kind: "owner", ownerId }, mediaMatch[2] !== undefined),
    ));
    if (result._tag === "Left") return result.left._tag === "DesignNotFound"
      ? notFound() : apiError(503, "DEPENDENCY_UNAVAILABLE", "The artwork is temporarily unavailable.");
    return new Response(result.right.bytes, { headers: {
      "Content-Type": result.right.contentType, "Cache-Control": "private, no-store",
    } });
  }

  const sourceMatch = /^\/v2\/design-drafts\/([0-9a-f-]{36})\/artwork-sources\/(original|cutout)$/.exec(url.pathname);
  if (sourceMatch && request.method === "GET") {
    const id = sourceMatch[1], kind = sourceMatch[2];
    if (!id || !kind) return notFound();
    const draft = await ownedDraft(env.DB, ownerId, id);
    if (draft?.finalized_at !== null) return notFound();
    const source = await env.DB.prepare("SELECT artwork_key, sha256 FROM design_artwork_sources WHERE design_id = ? AND kind = ?")
      .bind(id, kind).first<{ artwork_key: string; sha256: string }>();
    if (!source) return notFound();
    try {
      const headers = { "Content-Type": "image/webp", "Cache-Control": "private, no-store" };
      const cached = await env.DESIGN_ARTWORK.get(artworkPreviewKey(id, source.sha256));
      if (cached) return new Response(cached.body, { headers });
      const object = await env.DESIGN_ARTWORK.get(source.artwork_key);
      if (!object) return notFound();
      const preview = await Effect.runPromise(generateArtworkPreview(env.IMAGES, new Uint8Array(await object.arrayBuffer())));
      const cache = Effect.runPromise(storeArtworkPreview(env.DESIGN_ARTWORK, id, source.sha256, preview).pipe(
        Effect.timeout("5 seconds"),
        Effect.catchAll(() => Effect.void),
      ));
      if (context) context.waitUntil(cache);
      else await cache;
      return new Response(preview, { headers });
    } catch { return apiError(503, "DEPENDENCY_UNAVAILABLE", "The photo is temporarily unavailable."); }
  }

  const designMatch = DESIGN_PATH.exec(url.pathname);
  if (designMatch) {
    const id = designMatch[1];
    if (!id) return notFound();
    if (request.method === "GET") return getDraft(env, ownerId, id);
    if (request.method === "PATCH") return patchDraft(request, env, ownerId, id);
    if (request.method === "DELETE") {
      const result = await deleteOwnedDesign(env, ownerId, id);
      return result ? Response.json(result, { headers: { "Cache-Control": "private, no-store" } }) : notFound();
    }
  }

  const claimMatch = CLAIM_PATH.exec(url.pathname);
  if (claimMatch && request.method === "POST") {
    const id = claimMatch[1];
    if (!id) return notFound();
    return claimLegacyDraft(env, ownerId, id);
  }

  const grantMatch = GRANT_PATH.exec(url.pathname);
  if (grantMatch && request.method === "POST") {
    const id = grantMatch[1];
    if (!id) return notFound();
    return issueUploadGrant(request, env, ownerId, id);
  }

  return notFound();
}

async function authenticateServiceRequest(
  request: Request,
  env: AnonymousDesignEnv,
) {
  const ownerId = request.headers.get("x-forever-tee-owner-id");
  if (!ownerId || !/^[0-9a-f]{64}$/.test(ownerId)) {
    return undefined;
  }
  return (await isAuthenticatedServiceRequest(request, env)) ? ownerId : undefined;
}

async function createDraft(env: AnonymousDesignEnv, ownerId: string) {
  const id = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare(`
    INSERT INTO designs (
      id, owner_id, artwork_key, content_type, byte_size, sha256,
      crop_x, crop_y, crop_zoom, placement_x, placement_y, placement_width,
      depth, status, version, finalized_at, legacy_claim_expires_at,
      created_at, updated_at, deleted_at
    ) VALUES (?, ?, ?, 'application/octet-stream', 0, '', 0.5, 0.5, 1,
      0.39, 0.43, 0.22, 5, 'creating', 0, NULL, NULL, ?, ?, NULL)
  `).bind(id, ownerId, `designs/${id}/pending`, now, now).run();
  return Response.json({ id, version: 0 }, { status: 201 });
}

async function getDraft(env: AnonymousDesignEnv, ownerId: string, id: string) {
  const row = await ownedDraft(env.DB, ownerId, id);
  return row ? Response.json(await toDraftDto(env.DB, row)) : notFound();
}

async function patchDraft(
  request: Request,
  env: AnonymousDesignEnv,
  ownerId: string,
  id: string,
) {
  const payload = await request.json().catch(() => undefined);
  const parsed = parseSettingsMutation(payload);
  if (!parsed) return badRequest("Valid settings and expectedVersion are required.");
  const current = await ownedDraft(env.DB, ownerId, id);
  if (!current) return notFound();
  if (current.finalized_at !== null) return conflict("DRAFT_FINALIZED", "This draft is finalized.");
  if (current.status === "processing" && !current.artwork_job_id) {
    return conflict("DRAFT_NOT_READY", "Artwork processing is still in progress.");
  }
  if (current.version !== parsed.expectedVersion) {
    return conflict("VERSION_CONFLICT", "The draft changed. Reload and try again.");
  }
  const removeBackground = parsed.settings.removeBackground ?? true;
  const currentRemoval = current.remove_background === null ? current.original_artwork_key !== current.artwork_key : current.remove_background === 1;
  const selected = removeBackground === currentRemoval ? undefined : await env.DB.prepare(`
    SELECT artwork_key, sha256, byte_size, width, height FROM design_artwork_sources
    WHERE design_id = ? AND kind = ?
  `).bind(id, removeBackground ? "cutout" : "original").first<{
    artwork_key: string; sha256: string; byte_size: number; width: number; height: number;
  }>();
  if (removeBackground !== currentRemoval && !selected) {
    return conflict("DRAFT_NOT_READY", "The original photo is unavailable. Take or upload another photo.");
  }
  const now = Date.now();
  const result = await env.DB.prepare(`
    UPDATE designs SET artwork_key = ?, sha256 = ?, byte_size = ?, artwork_width = ?, artwork_height = ?, remove_background = ?,
      crop_x = ?, crop_y = ?, crop_zoom = ?, placement_x = ?,
      placement_y = ?, placement_width = ?, depth = ?, version = version + 1,
      updated_at = ?
    WHERE id = ? AND owner_id = ? AND version = ? AND finalized_at IS NULL
      AND deleted_at IS NULL AND (status IN ('creating', 'ready') OR (status = 'processing' AND artwork_job_id IS NOT NULL))
  `).bind(
    selected?.artwork_key ?? current.artwork_key,
    selected?.sha256 ?? current.sha256,
    selected?.byte_size ?? current.byte_size,
    current.status === "processing" ? current.artwork_width : selected?.width ?? current.artwork_width,
    current.status === "processing" ? current.artwork_height : selected?.height ?? current.artwork_height,
    removeBackground ? 1 : 0,
    parsed.settings.cropX,
    parsed.settings.cropY,
    parsed.settings.cropZoom,
    parsed.settings.placementX,
    parsed.settings.placementY,
    parsed.settings.placementWidth,
    parsed.settings.depth,
    now,
    id,
    ownerId,
    parsed.expectedVersion,
  ).run();
  if (result.meta.changes !== 1) {
    return conflict("VERSION_CONFLICT", "The draft changed. Reload and try again.");
  }
  return Response.json({ id, updatedAt: new Date(now).toISOString(), version: parsed.expectedVersion + 1 });
}

async function claimLegacyDraft(
  env: AnonymousDesignEnv,
  ownerId: string,
  id: string,
) {
  const now = Date.now();
  const result = await env.DB.prepare(`
    UPDATE designs SET owner_id = ?, updated_at = ?
    WHERE id = ? AND owner_id IS NULL AND legacy_claim_expires_at >= ?
      AND deleted_at IS NULL AND status <> 'deleted'
  `).bind(ownerId, now, id, now).run();
  if (result.meta.changes !== 1) return notFound();
  const row = await ownedDraft(env.DB, ownerId, id);
  return row ? Response.json(await toDraftDto(env.DB, row)) : notFound();
}

async function issueUploadGrant(
  request: Request,
  env: AnonymousDesignEnv,
  ownerId: string,
  id: string,
) {
  const payload = await request.json().catch(() => undefined);
  const parsed = parseGrantRequest(payload);
  if (!parsed) return badRequest("Valid upload constraints are required.");
  const current = await ownedDraft(env.DB, ownerId, id);
  if (!current) return notFound();
  if (current.finalized_at !== null) return conflict("DRAFT_FINALIZED", "This draft is finalized.");
  if (current.version !== parsed.expectedVersion) {
    return conflict("VERSION_CONFLICT", "The draft changed. Reload and try again.");
  }
  const token = randomToken();
  const tokenHash = await sha256Text(token);
  const now = Date.now();
  const expiresAt = now + GRANT_LIFETIME_MS;
  const results = await env.DB.batch([
    env.DB.prepare(`
      UPDATE designs SET status = 'creating', updated_at = ?
      WHERE id = ? AND owner_id = ? AND version = ? AND status = 'processing' AND artwork_job_id IS NULL
        AND updated_at <= ? AND finalized_at IS NULL AND deleted_at IS NULL
    `).bind(
      now,
      id,
      ownerId,
      parsed.expectedVersion,
      now - PROCESSING_LEASE_MS,
    ),
    env.DB.prepare(`
      INSERT INTO design_upload_grants (
        token_hash, design_id, owner_id, expected_version, content_type,
        max_bytes, expires_at, used_at, created_at, progressive
      )
      SELECT ?, id, owner_id, version, ?, ?, ?, NULL, ?, ?
      FROM designs
      WHERE id = ? AND owner_id = ? AND version = ?
        AND (status IN ('creating', 'ready') OR (status = 'processing' AND artwork_job_id IS NOT NULL))
        AND finalized_at IS NULL AND deleted_at IS NULL
    `).bind(
      tokenHash,
      parsed.contentType,
      parsed.maxBytes,
      expiresAt,
      now,
      parsed.progressive && env.PRINT_ASSET_JOBS ? 1 : 0,
      id,
      ownerId,
      parsed.expectedVersion,
    ),
  ]);
  if (results[1]?.meta.changes !== 1) {
    const latest = await ownedDraft(env.DB, ownerId, id);
    return latest?.status === "processing"
      ? conflict("DRAFT_NOT_READY", "Artwork processing is still in progress.")
      : conflict("VERSION_CONFLICT", "The draft changed. Reload and try again.");
  }
  const uploadUrl = new URL(UPLOAD_PATH, request.url);
  uploadUrl.searchParams.set("token", token);
  return Response.json({ uploadUrl: uploadUrl.toString(), expiresAt: new Date(expiresAt).toISOString() }, { status: 201 });
}

// Database fencing remains authoritative across isolates. This also rejects a
// concurrent replay before it can occupy a second local image buffer.
const activeUploadGrants = new Set<string>();

async function useUploadGrant(
  request: Request,
  env: AnonymousDesignEnv,
  token: string,
  context?: Pick<ExecutionContext, "waitUntil">,
) {
  const tokenHash = await sha256Text(token);
  const grant = await env.DB.prepare(`
    SELECT token_hash, design_id, owner_id, expected_version, content_type,
      max_bytes, expires_at, used_at, progressive
    FROM design_upload_grants WHERE token_hash = ?
  `).bind(tokenHash).first<GrantRow>();
  if (grant?.used_at !== null || grant.expires_at < Date.now()) return notFound();
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (contentType !== grant.content_type || !DESIGN_SOURCE_CONTENT_TYPES.includes(contentType)) return apiError(415, "UNSUPPORTED_MEDIA_TYPE", "The upload type does not match the grant.");
  if (activeUploadGrants.has(tokenHash)) return conflict("VERSION_CONFLICT", "This upload is already in progress.");
  let releaseMemory: () => void;
  try {
    // Share the isolate budget with print rendering. Include source accumulation,
    // both retained outputs and one encoding/hash copy, plus the small previews.
    releaseMemory = printBufferAdmission.reserve(2 * grant.max_bytes +
      (grant.progressive === 1 && env.PRINT_ASSET_JOBS ? 16 * 1024 * 1024 : 3 * MAX_PREPARED_ARTWORK_BYTES + 1_000_000));
  } catch (error) {
    if (!isPrintMemoryCapacityError(error)) throw error;
    return apiError(503, "IMAGE_CAPACITY_BUSY", "Image processing is busy. Please try again.", { "Retry-After": "5" });
  }
  activeUploadGrants.add(tokenHash);
  try {
    const declaredLength = Number(request.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > grant.max_bytes) return tooLarge();
    const bodyStartedAt = performance.now();
    const source = await readBoundedBody(request, grant.max_bytes);
    const bodyDurationMs = Math.round(performance.now() - bodyStartedAt);
    if (!source || source.byteLength === 0) return tooLarge();
    if (sourceContentType(source) !== contentType) return apiError(415, "UNSUPPORTED_MEDIA_TYPE", "The image contents do not match its file type.");
    const reservedAt = Date.now();
    const reservation = await env.DB.batch([
      env.DB.prepare(`
        UPDATE design_upload_grants SET used_at = ?
        WHERE token_hash = ? AND used_at IS NULL AND expires_at >= ?
          AND EXISTS (
            SELECT 1 FROM designs WHERE id = ? AND owner_id = ? AND version = ?
              AND finalized_at IS NULL AND deleted_at IS NULL
              AND (status IN ('creating', 'ready') OR (status = 'processing' AND artwork_job_id IS NOT NULL))
          )
      `).bind(
        reservedAt,
        tokenHash,
        reservedAt,
        grant.design_id,
        grant.owner_id,
        grant.expected_version,
      ),
      env.DB.prepare(`
        UPDATE designs SET version = version + 1, status = 'processing', artwork_job_id = NULL, remove_background = 1,
          default_product_color = 'White', default_product_color_model = NULL,
          updated_at = ?
        WHERE id = ? AND owner_id = ? AND version = ? AND finalized_at IS NULL
          AND deleted_at IS NULL AND (status IN ('creating', 'ready') OR (status = 'processing' AND artwork_job_id IS NOT NULL))
          AND EXISTS (
            SELECT 1 FROM design_upload_grants
            WHERE token_hash = ? AND used_at = ?
          )
      `).bind(
        reservedAt,
        grant.design_id,
        grant.owner_id,
        grant.expected_version,
        tokenHash,
        reservedAt,
      ),
    ]);
    if (reservation[0]?.meta.changes !== 1 || reservation[1]?.meta.changes !== 1) {
      return conflict("VERSION_CONFLICT", "The draft changed or this grant was already used.");
    }
    const completion = finishArtworkUpload(env, grant, source, bodyDurationMs, context)
      .catch(async (error: unknown) => {
        await restoreDraftAfterFailedUpload(env.DB, grant);
        throw error;
      });
    // Keep the accepted upload's fenced commit alive during Cloudflare's
    // post-disconnect grace period. The HTTP response still awaits completion.
    context?.waitUntil(completion.then(() => undefined, () => undefined));
    return await completion;
  } finally {
    activeUploadGrants.delete(tokenHash);
    releaseMemory();
  }
}

async function finishArtworkUpload(
  env: AnonymousDesignEnv,
  grant: GrantRow,
  source: Uint8Array,
  bodyDurationMs: number,
  context?: Pick<ExecutionContext, "waitUntil">,
) {
  let screeningClient: SafetyScreeningClient;
  try {
    screeningClient = env.SAFETY_SCREENING ??
      makeOpenAiSafetyScreeningClient(env);
  } catch {
    await restoreDraftAfterFailedUpload(env.DB, grant);
    return screeningUnavailable();
  }
  let productColorAnalysisClient: ProductColorAnalysisClient | undefined;
  try {
    productColorAnalysisClient = env.PRODUCT_COLOR_ANALYSIS ??
      makeClefProductColorAnalysisClient(env);
  } catch {
    productColorAnalysisClient = undefined;
  }
  const processingStartedAt = performance.now();
  const progressive = grant.progressive === 1 && env.PRINT_ASSET_JOBS !== undefined;
  const processPortrait = progressive ? processPortraitForCanvas : processPortraitForStorage;
  const processed = await processPortrait(
    env.IMAGES,
    source,
    () => allowPortraitProcessing(env, grant.owner_id),
    screeningClient,
    productColorAnalysisClient
      ? {
          client: productColorAnalysisClient,
          safetyIdentifier: grant.owner_id,
        }
      : undefined,
    true,
  );
  const processingDurationMs = Math.round(performance.now() - processingStartedAt);
  if (!processed.ok) {
    await restoreDraftAfterFailedUpload(env.DB, grant);
    if (processed.reason === "quota") return rateLimited();
    if (processed.reason === "invalid") {
      return apiError(415, "UNSUPPORTED_MEDIA_TYPE", "Choose a JPEG, PNG or WebP up to 20 MB, 50 megapixels and 12,000 pixels per side.");
    }
    if (processed.reason === "output-too-large") return apiError(413, "ARTWORK_OUTPUT_TOO_LARGE", "This photo could not be prepared at its full resolution within the artwork size limit.");
    if (processed.reason === "blocked") {
      return withScreeningTiming(
        apiError(
          422,
          "PORTRAIT_NOT_ACCEPTED",
          "That photo can't be used. Please choose another.",
        ),
        processed.screeningDurationMs,
      );
    }
    if (processed.reason === "screening-dependency") {
      return withScreeningTiming(
        screeningUnavailable(),
        processed.screeningDurationMs,
      );
    }
    return withScreeningTiming(
      apiError(
        503,
        "DEPENDENCY_UNAVAILABLE",
        "Image processing is temporarily unavailable. Please try again.",
        { "Retry-After": "5" },
      ),
      processed.screeningDurationMs,
    );
  }
  if (!processed.original) throw new Error("Original photo processing did not complete.");
  if (progressive) {
    const job = await publishArtworkPreparation(env, grant, source, processed);
    await scheduleProductColorPersistence(env.DB, grant.design_id, job.artworkKey, processed.productColorAnalysis, context, job.id);
    const delivery = deliverArtworkPreparation(env, job.id);
    if (context) context.waitUntil(delivery);
    else await delivery;
    let binary = "";
    for (let offset = 0; offset < processed.bytes.length; offset += 8192) {
      binary += String.fromCharCode(...processed.bytes.subarray(offset, offset + 8192));
    }
    const response = withScreeningTiming(Response.json({
      id: grant.design_id, artworkUrl: `/v1/designs/${grant.design_id}/artwork`,
      updatedAt: job.updatedAt, version: grant.expected_version + 1,
      printReady: false, artworkJobId: job.id,
      preview: { contentType: "image/webp", base64: btoa(binary) },
    }, { status: 202 }), processed.screeningDurationMs);
    response.headers.append("server-timing", `portrait-processing;dur=${String(processingDurationMs)}`);
    response.headers.append("server-timing", `upload-body;dur=${String(bodyDurationMs)}`);
    console.info("bent.shop artwork preview prepared", { jobId: job.id, processingDurationMs,
      screeningDurationMs: processed.screeningDurationMs, uploadBytes: source.length, previewBytes: processed.bytes.length });
    return response;
  }

  const hashStartedAt = performance.now();
  const original = processed.original;
  const originalDigest = await sha256Bytes(original.bytes);
  const originalKey = `designs/${grant.design_id}/original/${originalDigest.hex}`;
  const artwork = processed.bytes;
  const artworkDigest = await sha256Bytes(artwork);
  const sha256 = artworkDigest.hex;
  const artworkKey = `designs/${grant.design_id}/artwork/${sha256}`;
  const hashDurationMs = Math.round(performance.now() - hashStartedAt);
  const previewStartedAt = performance.now();
  const previewPromise = Effect.runPromise(
    prepareInlineArtworkPreview(env, grant.design_id, sha256, artwork, context),
  ).then((preview) => ({ preview, durationMs: Math.round(performance.now() - previewStartedAt) }));
  const storageStartedAt = performance.now();
  try {
    // Both buffers already exist. Overlap independent storage, but retain the
    // upload's memory reservation and processing lease until both writes settle.
    const stored = await Promise.allSettled([
      env.DESIGN_ARTWORK.put(originalKey, original.bytes, {
        httpMetadata: { contentType: "image/webp" },
        customMetadata: { designId: grant.design_id, sha256: originalDigest.hex }, sha256: originalDigest.bytes,
      }),
      (async () => {
        const existing = await env.DESIGN_ARTWORK.head(artworkKey);
        if (!existing) {
          await env.DESIGN_ARTWORK.put(artworkKey, artwork, {
            httpMetadata: { contentType: "image/webp" },
            customMetadata: { designId: grant.design_id, sha256 },
            sha256: artworkDigest.bytes,
          });
        }
      })(),
    ]);
    if (stored.some(result => result.status === "rejected")) throw new Error("Artwork storage failed.");
  } catch {
    await restoreDraftAfterFailedUpload(env.DB, grant);
    return apiError(503, "DEPENDENCY_UNAVAILABLE", "Artwork storage is unavailable.");
  }
  const storageDurationMs = Math.round(performance.now() - storageStartedAt);
  const commitStartedAt = performance.now();
  const now = Date.now();
  const sources = [
    { kind: "original", key: originalKey, hash: originalDigest.hex, image: original },
    { kind: "cutout", key: artworkKey, hash: sha256, image: processed },
  ];
  const results = await env.DB.batch([
    ...sources.map(source => env.DB.prepare(`
      INSERT INTO design_artwork_sources (design_id, kind, artwork_key, sha256, byte_size, width, height)
      SELECT id, ?, ?, ?, ?, ?, ? FROM designs
      WHERE id = ? AND owner_id = ? AND version = ? AND finalized_at IS NULL
        AND deleted_at IS NULL AND status = 'processing'
      ON CONFLICT(design_id, kind) DO UPDATE SET artwork_key = excluded.artwork_key,
        sha256 = excluded.sha256, byte_size = excluded.byte_size, width = excluded.width, height = excluded.height
    `).bind(source.kind, source.key, source.hash, source.image.bytes.byteLength, source.image.width, source.image.height,
      grant.design_id, grant.owner_id, grant.expected_version + 1)),
    env.DB.prepare(`
      UPDATE designs SET artwork_key = ?, content_type = 'image/webp', byte_size = ?,
        artwork_width = ?, artwork_height = ?, sha256 = ?, status = 'ready',
        safety_screening_decision = ?, safety_screening_model = ?, updated_at = ?,
        default_product_color_status = ?
      WHERE id = ? AND owner_id = ? AND version = ? AND finalized_at IS NULL
        AND deleted_at IS NULL AND status = 'processing'
        AND EXISTS (
          SELECT 1 FROM design_upload_grants
          WHERE token_hash = ? AND used_at IS NOT NULL
        )
    `).bind(
    artworkKey,
    artwork.byteLength,
    processed.width,
    processed.height,
    sha256,
    processed.screening.decision,
    processed.screening.model,
    now,
    processed.productColorAnalysis ? "pending" : "fallback",
    grant.design_id,
    grant.owner_id,
    grant.expected_version + 1,
    grant.token_hash,
  ),
  ]);
  if (results[2]?.meta.changes !== 1) {
    return conflict("VERSION_CONFLICT", "The draft changed or this grant was already used.");
  }
  const commitDurationMs = Math.round(performance.now() - commitStartedAt);
  await scheduleProductColorPersistence(
    env.DB,
    grant.design_id,
    artworkKey,
    processed.productColorAnalysis,
    context,
  );
  const { preview, durationMs: previewDurationMs } = await previewPromise;
  console.info("bent.shop artwork upload prepared", {
    uploadBytes: source.byteLength,
    originalBytes: original.bytes.byteLength,
    artworkBytes: artwork.byteLength,
    processingDurationMs,
    screeningDurationMs: processed.screeningDurationMs,
    hashDurationMs,
    storageDurationMs,
    commitDurationMs,
    previewDurationMs,
  });
  const response = withScreeningTiming(
    Response.json({
      id: grant.design_id,
      artworkUrl: `/v1/designs/${grant.design_id}/artwork`,
      updatedAt: new Date(now).toISOString(),
      version: grant.expected_version + 1,
      ...(preview ? { preview } : {}),
    }),
    processed.screeningDurationMs,
  );
  response.headers.append("server-timing", `artwork-preview;dur=${String(previewDurationMs)}`);
  response.headers.append("server-timing", `upload-body;dur=${String(bodyDurationMs)}`);
  response.headers.append("server-timing", `portrait-processing;dur=${String(processingDurationMs)}`);
  response.headers.append("server-timing", `artwork-hash;dur=${String(hashDurationMs)}`);
  response.headers.append("server-timing", `artwork-storage;dur=${String(storageDurationMs)}`);
  response.headers.append("server-timing", `artwork-commit;dur=${String(commitDurationMs)}`);
  return response;
}

async function scheduleProductColorPersistence(
  db: D1Database,
  designId: string,
  artworkKey: string,
  pending: PendingProductColorAnalysis | undefined,
  context?: Pick<ExecutionContext, "waitUntil">,
  artworkJobId: string | null = null,
) {
  if (!pending) return;
  const completed = pending.completed();
  const persistence = completed
    ? persistProductColorAnalysis(db, designId, artworkKey, completed, artworkJobId)
    : pending.result.then((result) =>
        persistProductColorAnalysis(db, designId, artworkKey, result, artworkJobId)
      );
  const observed = persistence.catch((cause: unknown) => {
    console.error("Product default colour could not be stored.", {
      designId,
      ...safeErrorDetails(cause),
    });
  });
  if (context) {
    context.waitUntil(observed);
    return;
  }
  if (completed) {
    await observed;
    return;
  }
  void observed;
}

async function persistProductColorAnalysis(
  db: D1Database,
  designId: string,
  artworkKey: string,
  result: ProductColorAnalysisResult,
  artworkJobId: string | null,
) {
  if (!result.ok) {
    await db.prepare(`
      UPDATE designs SET default_product_color_status = 'fallback'
      WHERE id = ? AND (artwork_job_id = ? OR artwork_key = ? OR EXISTS (
        SELECT 1 FROM design_artwork_sources
        WHERE design_id = designs.id AND kind = 'cutout' AND artwork_key = ?
      )) AND status IN ('ready', 'processing')
        AND default_product_color_status = 'pending'
    `).bind(designId, artworkJobId, artworkKey, artworkKey).run();
    return;
  }
  await db.batch([
    db.prepare(`
      UPDATE designs SET default_product_color = ?,
        default_product_color_model = ?,
        default_product_color_status = 'complete'
      WHERE id = ? AND (artwork_job_id = ? OR artwork_key = ? OR EXISTS (
        SELECT 1 FROM design_artwork_sources
        WHERE design_id = designs.id AND kind = 'cutout' AND artwork_key = ?
      )) AND status IN ('ready', 'processing')
        AND default_product_color_status = 'pending'
    `).bind(
      result.analysis.color,
      result.analysis.model,
      designId,
      artworkJobId,
      artworkKey,
      artworkKey,
    ),
    db.prepare(`
      UPDATE products SET default_color = (
        SELECT default_product_color FROM designs WHERE id = ?
      )
      WHERE design_id = ? AND status = 'active'
        AND EXISTS (
          SELECT 1 FROM designs WHERE id = ? AND (artwork_job_id = ? OR artwork_key = ? OR EXISTS (
            SELECT 1 FROM design_artwork_sources
            WHERE design_id = designs.id AND kind = 'cutout' AND artwork_key = ?
          ))
            AND default_product_color_status = 'complete'
        )
    `).bind(designId, designId, designId, artworkJobId, artworkKey, artworkKey),
  ]);
}

async function configureProduct(
  request: Request,
  env: AnonymousDesignEnv,
  ownerId: string,
  context?: Pick<ExecutionContext, "waitUntil">,
  configuredMedia?: ConfiguredMedia,
) {
  const payload = await request.json().catch(() => undefined);
  const parsed = parseConfigureProductRequest(payload);
  if (!parsed) return badRequest("Valid product, draft, and expectedVersion values are required.");

  const existing = await env.DB.prepare(`
    SELECT products.id, products.base_product_id, products.design_id,
      products.design_revision_id, products.placement_x, products.placement_y,
      products.placement_width, products.placement_depth,
      products.projection_version, products.default_color,
      products.shopify_handle, products.created_at
    FROM products
    JOIN designs ON designs.id = products.design_id
    WHERE products.design_id = ? AND products.base_product_id = ?
      AND products.status = 'active'
      AND designs.owner_id = ?
  `).bind(parsed.designId, parsed.baseProductId, ownerId).first<ProductRow>();
  if (existing) return configuredProductResponse(env, existing, context, configuredMedia);

  const design = await ownedDraft(env.DB, ownerId, parsed.designId);
  if (!design) return notFound();
  if (design.version !== parsed.expectedVersion) {
    return conflict("VERSION_CONFLICT", "The draft changed. Reload and try again.");
  }
  if (
    design.status !== "ready" ||
    !design.sha256 ||
    design.artwork_key === `designs/${design.id}/pending`
  ) {
    return conflict("DRAFT_NOT_READY", "Artwork must be ready before configuration.");
  }
  if (design.default_product_color_status === "pending") {
    return productColorPending();
  }
  const baseProduct = await env.DB.prepare(`
    SELECT id, base_product_id, design_id, design_revision_id,
      placement_x, placement_y, placement_width, placement_depth,
      projection_version, default_color, shopify_handle, created_at
    FROM products WHERE id = ? AND status = 'active' AND design_id IS NULL
  `).bind(parsed.baseProductId).first<ProductRow>();
  if (!baseProduct) return apiError(404, "NOT_FOUND", "Base product not found.");
  const baseProductSlug = baseProductSlugForId(baseProduct.id);
  if (!baseProductSlug) {
    return apiError(404, "NOT_FOUND", "Base product not found.");
  }
  const resolutionError = await validateProductPrintResolution(env.DB, design, baseProduct.id, baseProductSlug);
  if (resolutionError) return resolutionError;
  const placement = projectEditorPlacement({
    depth: design.depth,
    placementWidth: design.placement_width,
    placementX: design.placement_x,
    placementY: design.placement_y,
  }, baseProductSlug);

  if (design.finalized_at !== null) {
    const productId = crypto.randomUUID();
    await env.DB.prepare(`
      INSERT INTO products (
        id, base_product_id, design_id, design_revision_id, shopify_handle,
        placement_x, placement_y, placement_width, placement_depth,
        projection_version, default_color, status, created_at, deleted_at
      )
      SELECT ?, base.id, ?, revision.id, base.shopify_handle,
        ?, ?, ?, ?, 'safe-margin-v1', designs.default_product_color,
        'active', ?, NULL
      FROM products AS base
      JOIN design_revisions AS revision ON revision.design_id = ? AND revision.fingerprint NOT LIKE 'video-preview-v1:%'
      JOIN designs ON designs.id = revision.design_id
      WHERE base.id = ? AND base.status = 'active' AND base.design_id IS NULL
        AND designs.owner_id = ? AND designs.version = ?
        AND designs.finalized_at IS NOT NULL
      ORDER BY revision.created_at ASC, revision.id ASC
      LIMIT 1
      ON CONFLICT DO NOTHING
    `).bind(
      productId,
      design.id,
      placement.x,
      placement.y,
      placement.width,
      placement.depth,
      Date.now(),
      design.id,
      baseProduct.id,
      ownerId,
      parsed.expectedVersion,
    ).run();
    const configured = await env.DB.prepare(`
      SELECT id, base_product_id, design_id, design_revision_id,
        placement_x, placement_y, placement_width, placement_depth,
        projection_version, default_color, shopify_handle, created_at
      FROM products
      WHERE design_id = ? AND base_product_id = ? AND status = 'active'
    `).bind(design.id, baseProduct.id).first<ProductRow>();
    return configured
      ? configuredProductResponse(env, configured, context, configuredMedia)
      : conflict("DRAFT_FINALIZED", "This draft has no reusable revision.");
  }

  const fingerprint = await designRevisionFingerprint(env.DB, {
    id: design.id,
    artworkHeight: design.artwork_height,
    artworkKey: design.artwork_key,
    artworkWidth: design.artwork_width,
    contentType: design.content_type,
    byteSize: design.byte_size,
    sha256: design.sha256,
    cropX: design.crop_x,
    cropY: design.crop_y,
    cropZoom: design.crop_zoom,
    updatedAt: new Date(design.updated_at),
  });
  const revisionId = crypto.randomUUID();
  const productId = crypto.randomUUID();
  const now = Date.now();
  const results = await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO design_revisions (
        id, design_id, fingerprint, artwork_key, content_type, byte_size,
        artwork_width, artwork_height, sha256, crop_x, crop_y, crop_zoom,
        placement_x, placement_y,
        placement_width, depth, created_at
      )
      SELECT ?, id, ?, artwork_key, content_type, byte_size,
        artwork_width, artwork_height, sha256,
        crop_x, crop_y, crop_zoom, 0, 0, 0.08, 1, updated_at
      FROM designs
      WHERE id = ? AND owner_id = ? AND version = ? AND finalized_at IS NULL
        AND deleted_at IS NULL AND status = 'ready' AND sha256 <> ''
      ON CONFLICT (design_id, fingerprint) DO NOTHING
    `).bind(revisionId, fingerprint, design.id, ownerId, parsed.expectedVersion),
    env.DB.prepare(`
      INSERT INTO products (
        id, base_product_id, design_id, design_revision_id, shopify_handle,
        placement_x, placement_y, placement_width, placement_depth,
        projection_version, default_color, status, created_at, deleted_at
      )
      SELECT ?, base.id, ?, revision.id, base.shopify_handle,
        ?, ?, ?, ?, 'safe-margin-v1', designs.default_product_color,
        'active', ?, NULL
      FROM products AS base
      JOIN design_revisions AS revision
        ON revision.design_id = ? AND revision.fingerprint = ?
      JOIN designs ON designs.id = revision.design_id
      WHERE base.id = ? AND base.status = 'active' AND base.design_id IS NULL
        AND designs.owner_id = ? AND designs.version = ?
        AND designs.finalized_at IS NULL AND designs.status = 'ready'
      ON CONFLICT DO NOTHING
    `).bind(
      productId,
      design.id,
      placement.x,
      placement.y,
      placement.width,
      placement.depth,
      now,
      design.id,
      fingerprint,
      baseProduct.id,
      ownerId,
      parsed.expectedVersion,
    ),
    env.DB.prepare(`
      UPDATE designs SET finalized_at = ?, version = version + 1, updated_at = ?
      WHERE id = ? AND owner_id = ? AND version = ? AND finalized_at IS NULL
        AND status = 'ready'
        AND EXISTS (
          SELECT 1 FROM products
          JOIN design_revisions ON design_revisions.id = products.design_revision_id
          WHERE products.design_id = ? AND products.status = 'active'
            AND design_revisions.fingerprint = ?
        )
    `).bind(
      now,
      now,
      design.id,
      ownerId,
      parsed.expectedVersion,
      design.id,
      fingerprint,
    ),
  ]);
  if (results[1]?.meta.changes !== 1 || results[2]?.meta.changes !== 1) {
    const racedExisting = await env.DB.prepare(`
      SELECT products.id, products.base_product_id, products.design_id,
      products.design_revision_id, products.placement_x, products.placement_y,
      products.placement_width, products.placement_depth,
      products.projection_version, products.default_color,
        products.shopify_handle, products.created_at
      FROM products
      JOIN designs ON designs.id = products.design_id
      WHERE products.design_id = ? AND products.base_product_id = ?
        AND products.status = 'active'
        AND designs.owner_id = ?
    `).bind(design.id, parsed.baseProductId, ownerId).first<ProductRow>();
    return racedExisting
      ? configuredProductResponse(env, racedExisting, context, configuredMedia)
      : conflict("VERSION_CONFLICT", "The draft changed. Reload and try again.");
  }
  const configured = await env.DB.prepare(`
    SELECT id, base_product_id, design_id, design_revision_id,
      placement_x, placement_y, placement_width, placement_depth,
      projection_version, default_color, shopify_handle, created_at
    FROM products WHERE id = ?
  `).bind(productId).first<ProductRow>();
  if (!configured) return apiError(503, "DEPENDENCY_UNAVAILABLE", "Product storage is unavailable.");
  return configuredProductResponse(env, configured, context, configuredMedia);
}

// Experimental all-or-nothing family admission. Single-product callers retain
// the existing endpoint, including the ability to select only a safe product.
async function configureProductFamily(
  request: Request,
  env: AnonymousDesignEnv,
  ownerId: string,
  context?: Pick<ExecutionContext, "waitUntil">,
  configuredMedia?: ConfiguredMedia,
) {
  const payload: unknown = await request.json().catch(() => undefined);
  if (!isRecord(payload) || !Array.isArray(payload["baseProductIds"])) return badRequest("A product family is required.");
  const ids: string[] = [];
  for (const value of payload["baseProductIds"]) {
    if (typeof value !== "string" || !/^[0-9a-f-]{36}$/.test(value) || ids.includes(value)) {
      return badRequest("Distinct base product IDs are required.");
    }
    ids.push(value);
  }
  if (ids.length < 1 || ids.length > 2) return badRequest("Select one or two base products.");
  const parsed = parseConfigureProductRequest({ ...payload, baseProductId: ids[0] });
  if (!parsed) return badRequest("Valid draft and expectedVersion values are required.");
  const placeholders = ids.map(() => "?").join(",");
  const readProducts = () => env.DB.prepare(`
    SELECT products.* FROM products JOIN designs ON designs.id = products.design_id
    WHERE products.design_id = ? AND designs.owner_id = ? AND products.status = 'active'
      AND products.base_product_id IN (${placeholders})
  `).bind(parsed.designId, ownerId, ...ids).all<ProductRow>();
  const [design, existing, bases] = await Promise.all([
    ownedDraft(env.DB, ownerId, parsed.designId), readProducts(),
    env.DB.prepare(`SELECT * FROM products WHERE id IN (${placeholders})
      AND status = 'active' AND design_id IS NULL`).bind(...ids).all<ProductRow>(),
  ]);
  if (!design) return notFound();
  const response = (rows: ProductRow[]) =>
    configuredProductFamilyResponse(env, rows, ids, context, configuredMedia);
  if (existing.results.length === ids.length) return response(existing.results);
  if (design.version !== parsed.expectedVersion) return conflict("VERSION_CONFLICT", "The draft changed. Reload and try again.");
  const preparing = design.status === "processing" && design.artwork_job_id !== null &&
    design.artwork_width !== null && design.artwork_height !== null;
  if ((!preparing && design.status !== "ready") || !design.sha256 || design.artwork_key === `designs/${design.id}/pending`) {
    return conflict("DRAFT_NOT_READY", "Artwork must be ready before configuration.");
  }
  if (design.default_product_color_status === "pending") {
    return productColorPending();
  }
  const missing = ids.filter((id) => !existing.results.some((product) => product.base_product_id === id));
  const projections = [];
  const resolutionChecks = await Promise.all(missing.map(id => {
    const slug = baseProductSlugForId(id);
    return slug ? validateProductPrintResolution(env.DB, design, id, slug) : Promise.resolve(undefined);
  }));
  for (const [index, id] of missing.entries()) {
    const base = bases.results.find((product) => product.id === id);
    const slug = baseProductSlugForId(id);
    if (!base || !slug) return apiError(404, "NOT_FOUND", "Base product not found.");
    const resolutionError = resolutionChecks[index];
    if (resolutionError) return resolutionError;
    projections.push({ base, placement: projectEditorPlacement({
      depth: design.depth, placementWidth: design.placement_width,
      placementX: design.placement_x, placementY: design.placement_y,
    }, slug) });
  }
  if (preparing) {
    if (design.finalized_at !== null || existing.results.length) return conflict("DRAFT_FINALIZED", "This draft is finalized.");
    const now = Date.now();
    const videoRevisionId = crypto.randomUUID();
    const videoFingerprint = `video-preview-v1:${await designRevisionFingerprint(env.DB, {
      id: design.id, artworkKey: design.artwork_key, contentType: design.content_type,
      byteSize: design.byte_size, sha256: design.sha256, cropX: design.crop_x,
      cropY: design.crop_y, cropZoom: design.crop_zoom, updatedAt: new Date(design.updated_at),
    })}`;
    const baseGuard = `(SELECT count(*) FROM products WHERE id IN (${ids.map(() => "?").join(",")})
      AND status = 'active' AND design_id IS NULL) = ?`;
    await env.DB.batch([
      // Freeze the actual preview pixels and crop. Full-source preparation may
      // replace the draft's sources, but never this video's source or identity.
      env.DB.prepare(`INSERT INTO design_revisions (id, design_id, fingerprint, artwork_key, content_type,
        byte_size, artwork_width, artwork_height, sha256, crop_x, crop_y, crop_zoom,
        placement_x, placement_y, placement_width, depth, created_at)
        SELECT ?, d.id, ?, s.artwork_key, d.content_type, s.byte_size, s.width, s.height,
          s.sha256, d.crop_x, d.crop_y, d.crop_zoom, 0, 0, 0.08, 1, ?
        FROM designs d JOIN design_artwork_sources s ON s.design_id = d.id
          AND s.artwork_key = d.artwork_key AND s.sha256 = d.sha256
        WHERE d.id = ? AND d.owner_id = ? AND d.version = ? AND d.finalized_at IS NULL
          AND d.status = 'processing' AND d.artwork_job_id = ? AND d.deleted_at IS NULL AND ${baseGuard}
        ON CONFLICT DO NOTHING`).bind(videoRevisionId, videoFingerprint, now, design.id, ownerId,
          parsed.expectedVersion, design.artwork_job_id, ...ids, ids.length),
      ...projections.map(({ base, placement }) => env.DB.prepare(`
        INSERT INTO products (id, base_product_id, design_id, design_revision_id, video_design_revision_id, shopify_handle,
          placement_x, placement_y, placement_width, placement_depth, projection_version,
          default_color, status, created_at)
        SELECT ?, ?, id, NULL, (SELECT id FROM design_revisions WHERE design_id = designs.id AND fingerprint = ?), ?, ?, ?, ?, ?, 'safe-margin-v1',
          default_product_color, 'active', ?
        FROM designs WHERE id = ? AND owner_id = ? AND version = ? AND finalized_at IS NULL
          AND status = 'processing' AND artwork_job_id = ? AND deleted_at IS NULL AND ${baseGuard}
          AND EXISTS (SELECT 1 FROM design_revisions WHERE design_id = designs.id AND fingerprint = ?)
        ON CONFLICT DO NOTHING`).bind(crypto.randomUUID(), base.id, videoFingerprint, base.shopify_handle,
          placement.x, placement.y, placement.width, placement.depth, now,
          design.id, ownerId, parsed.expectedVersion, design.artwork_job_id, ...ids, ids.length, videoFingerprint)),
      env.DB.prepare(`UPDATE designs SET finalized_at = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND owner_id = ? AND version = ? AND finalized_at IS NULL AND status = 'processing'
          AND artwork_job_id = ? AND deleted_at IS NULL
          AND (SELECT count(*) FROM products WHERE design_id = designs.id AND status = 'active'
            AND design_revision_id IS NULL AND base_product_id IN (${placeholders})) = ?`)
        .bind(now, now, design.id, ownerId, parsed.expectedVersion, design.artwork_job_id, ...ids, ids.length),
    ]);
    const pending = await readProducts();
    return pending.results.length === ids.length ? response(pending.results)
      : conflict("VERSION_CONFLICT", "The draft changed. Reload and try again.");
  }
  const now = Date.now();
  const finalized = design.finalized_at !== null;
  const fingerprint = finalized ? "" : await designRevisionFingerprint(env.DB, {
    id: design.id, artworkHeight: design.artwork_height, artworkWidth: design.artwork_width,
    artworkKey: design.artwork_key, contentType: design.content_type, byteSize: design.byte_size,
    sha256: design.sha256, cropX: design.crop_x, cropY: design.crop_y, cropZoom: design.crop_zoom,
    updatedAt: new Date(design.updated_at),
  });
  // All requested missing bases must still be active inside the transaction.
  // This prevents a concurrent catalogue change from admitting half a family.
  const baseGuard = `(SELECT count(*) FROM products WHERE id IN (${missing.map(() => "?").join(",")})
    AND status = 'active' AND design_id IS NULL) = ?`;
  const statements: D1PreparedStatement[] = [];
  if (!finalized) statements.push(env.DB.prepare(`
    INSERT INTO design_revisions (id, design_id, fingerprint, artwork_key, content_type,
      byte_size, artwork_width, artwork_height, sha256, crop_x, crop_y, crop_zoom,
      placement_x, placement_y, placement_width, depth, created_at)
    SELECT ?, id, ?, artwork_key, content_type, byte_size, artwork_width, artwork_height,
      sha256, crop_x, crop_y, crop_zoom, 0, 0, 0.08, 1, updated_at FROM designs
    WHERE id = ? AND owner_id = ? AND version = ? AND finalized_at IS NULL
      AND deleted_at IS NULL AND status = 'ready' AND sha256 <> '' AND ${baseGuard}
    ON CONFLICT (design_id, fingerprint) DO NOTHING
  `).bind(crypto.randomUUID(), fingerprint, design.id, ownerId, parsed.expectedVersion, ...missing, missing.length));
  for (const { base, placement } of projections) statements.push(env.DB.prepare(`
    INSERT INTO products (id, base_product_id, design_id, design_revision_id, shopify_handle,
      placement_x, placement_y, placement_width, placement_depth, projection_version,
      default_color, status, created_at, deleted_at)
    SELECT ?, base.id, designs.id, revision.id, base.shopify_handle, ?, ?, ?, ?,
      'safe-margin-v1', designs.default_product_color, 'active', ?, NULL
    FROM products AS base JOIN designs ON designs.id = ?
    JOIN design_revisions AS revision ON revision.design_id = designs.id AND revision.fingerprint NOT LIKE 'video-preview-v1:%'
    WHERE base.id = ? AND base.status = 'active' AND base.design_id IS NULL
      AND designs.owner_id = ? AND designs.version = ? AND designs.deleted_at IS NULL
      AND designs.status = 'ready' AND ${baseGuard}
      AND ${finalized ? "designs.finalized_at IS NOT NULL" : "designs.finalized_at IS NULL AND revision.fingerprint = ?"}
    ORDER BY revision.created_at ASC, revision.id ASC LIMIT 1
    ON CONFLICT DO NOTHING
  `).bind(crypto.randomUUID(), placement.x, placement.y, placement.width, placement.depth, now,
    design.id, base.id, ownerId, parsed.expectedVersion, ...missing, missing.length,
    ...(finalized ? [] : [fingerprint])));
  if (!finalized) statements.push(env.DB.prepare(`
    UPDATE designs SET finalized_at = ?, version = version + 1, updated_at = ?
    WHERE id = ? AND owner_id = ? AND version = ? AND finalized_at IS NULL AND status = 'ready'
      AND (SELECT count(*) FROM products JOIN design_revisions ON design_revisions.id = products.design_revision_id
        WHERE products.design_id = ? AND products.status = 'active'
          AND products.base_product_id IN (${placeholders}) AND design_revisions.fingerprint = ?) = ?
  `).bind(now, now, design.id, ownerId, parsed.expectedVersion, design.id, ...ids, fingerprint, ids.length));
  await env.DB.batch(statements);
  const configured = await readProducts();
  return configured.results.length === ids.length ? response(configured.results)
    : conflict("VERSION_CONFLICT", "The draft changed. Reload and try again.");
}

async function validateProductPrintResolution(
  db: D1Database,
  design: DesignRow,
  baseProductId: string,
  slug: string,
) {
  // Historical uploads without dimensions are checked when their source is decoded.
  if (design.artwork_width === null || design.artwork_height === null) return undefined;
  const resolution = await productPrintResolution(
    db, baseProductId, design.artwork_width, design.artwork_height,
    { cropX: design.crop_x, cropY: design.crop_y, cropZoom: design.crop_zoom },
  );
  if (!resolution) {
    return apiError(503, "PRINT_GEOMETRY_UNAVAILABLE", "The product print dimensions are temporarily unavailable. Please try again.");
  }
  if (!resolution.safe) {
    return apiError(422, "PRODUCT_PROJECTION_UNSAFE", `The artwork resolution is too low for the ${slug} projection.`);
  }
  return undefined;
}

async function configuredProductResponse(
  env: AnonymousDesignEnv,
  product: ProductRow,
  context?: Pick<ExecutionContext, "waitUntil">,
  configuredMedia?: ConfiguredMedia,
) {
  if (env.PRINT_ASSET_JOBS) {
    await persistConfiguredOutboxes([enqueuePrintAssetJobs(env, [product.id], context), configuredMedia?.([product.id]) ?? Promise.resolve()]);
    return Response.json(toProductDto(product), { status: 201 });
  }
  await configuredMedia?.([product.id]);
  if (context) {
    context.waitUntil(prepareConfiguredProductPrintAssets(env, [product.id]));
    return Response.json(toProductDto(product), { status: 201 });
  }
  try {
    await ensureConfiguredProductPrintAssets(env, product.id);
    return Response.json(toProductDto(product), { status: 201 });
  } catch (cause) {
    console.error("Configured product print assets are unavailable.", safeErrorDetails(cause));
    return apiError(
      503,
      "PRINT_ASSETS_UNAVAILABLE",
      "The product artwork could not be prepared for printing.",
    );
  }
}

async function configuredProductFamilyResponse(
  env: AnonymousDesignEnv,
  rows: ProductRow[],
  baseProductIds: string[],
  context?: Pick<ExecutionContext, "waitUntil">,
  configuredMedia?: ConfiguredMedia,
) {
  const preparationId = rows.some(row => row.design_revision_id === null) && rows[0]?.design_id
    ? await pendingProductPreparation(env.DB, rows[0].design_id) : undefined;
  const response = () => Response.json({
    products: rows
      .sort((left, right) =>
        baseProductIds.indexOf(left.base_product_id) -
        baseProductIds.indexOf(right.base_product_id)
      )
      .map(row => ({ ...toProductDto(row), ...(preparationId && !row.design_revision_id ? { preparationId } : {}) })),
  }, { status: 201 });
  if (preparationId) {
    await configuredMedia?.(rows.map(row => row.id));
    return response();
  }
  if (env.PRINT_ASSET_JOBS) {
    const ids = rows.map(row => row.id);
    await persistConfiguredOutboxes([enqueuePrintAssetJobs(env, ids, context), configuredMedia?.(ids) ?? Promise.resolve()]);
    return response();
  }
  await configuredMedia?.(rows.map(row => row.id));
  if (context) {
    context.waitUntil(prepareConfiguredProductPrintAssets(
      env,
      rows.map((row) => row.id),
    ));
    return response();
  }
  try {
    for (const row of rows) {
      await ensureConfiguredProductPrintAssets(env, row.id);
    }
    return response();
  } catch (cause) {
    console.error("Configured product family print assets are unavailable.", safeErrorDetails(cause));
    return apiError(
      503,
      "PRINT_ASSETS_UNAVAILABLE",
      "The product artwork could not be prepared for printing.",
    );
  }
}

async function prepareConfiguredProductPrintAssets(
  env: AnonymousDesignEnv,
  productIds: readonly string[],
) {
  await Promise.all(productIds.map(async (productId) => {
    try {
      await ensureConfiguredProductPrintAssets(env, productId);
    } catch (cause: unknown) {
      console.error("Configured product print assets are unavailable.", {
        ...safeErrorDetails(cause),
        productId,
      });
    }
  }));
}

async function ownedDraft(db: D1Database, ownerId: string, id: string) {
  return db.prepare(`
    SELECT id, owner_id, artwork_key, content_type, byte_size, artwork_job_id, remove_background,
      (SELECT status FROM artwork_preparation_jobs WHERE id = designs.artwork_job_id) AS artwork_job_status,
      (SELECT artwork_key FROM design_artwork_sources WHERE design_id = designs.id AND kind = 'original') AS original_artwork_key,
      artwork_width, artwork_height, sha256,
      crop_x, crop_y, crop_zoom, placement_x, placement_y, placement_width,
      depth, status, version, finalized_at, legacy_claim_expires_at,
      default_product_color, default_product_color_status,
      created_at, updated_at, deleted_at
    FROM designs WHERE id = ? AND owner_id = ? AND deleted_at IS NULL
      AND status <> 'deleted'
  `).bind(id, ownerId).first<DesignRow>();
}

async function restoreDraftAfterFailedUpload(
  db: D1Database,
  grant: GrantRow,
) {
  await db.prepare(`
    UPDATE designs SET status = 'creating', updated_at = ?
    WHERE id = ? AND owner_id = ? AND version = ? AND finalized_at IS NULL
      AND deleted_at IS NULL AND status = 'processing' AND artwork_job_id IS NULL
  `).bind(
    Date.now(),
    grant.design_id,
    grant.owner_id,
    grant.expected_version + 1,
  ).run();
}

async function toDraftDto(db: D1Database, row: DesignRow) {
  const width = row.artwork_width, height = row.artwork_height;
  const limits = (row.status === "ready" || row.artwork_job_id !== null) && width !== null && height !== null
    ? await Promise.all([STAPLE_TEE_BASE_PRODUCT_ID, COTTON_TOTE_BASE_PRODUCT_ID].map(id =>
      productMaximumCropZoom(db, id, width, height)))
    : [];
  const maximumCropZoom = limits.length === 2 && limits.every(limit => limit !== null)
    ? Math.min(...limits) : null;
  return {
    maximumCropZoom,
    previewReady: row.artwork_job_id !== null || row.status === "ready",
    artworkJobId: row.artwork_job_id,
    artworkProcessingStatus: row.artwork_job_status,
    id: row.id,
    defaultColor: row.default_product_color,
    defaultColorStatus: row.default_product_color_status,
    status: row.status === "ready" ? "ready" : "creating",
    contentType: row.content_type,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    artworkRevision: /^[0-9a-f]{64}$/.test(row.sha256) ? row.sha256 : null,
    hasOriginalArtwork: row.original_artwork_key !== null,
    settings: {
      removeBackground: row.remove_background === null ? row.original_artwork_key !== row.artwork_key : row.remove_background === 1,
      cropX: row.crop_x,
      cropY: row.crop_y,
      cropZoom: row.crop_zoom,
      placementX: row.placement_x,
      placementY: row.placement_y,
      placementWidth: row.placement_width,
      depth: row.depth,
    },
    artworkUrl: `/v1/designs/${row.id}/artwork`,
    version: row.version,
    finalized: row.finalized_at !== null,
  };
}

function parseSettingsMutation(value: unknown): { expectedVersion: number; settings: EditorSettingsDto } | undefined {
  if (!isRecord(value) || !isNonNegativeInteger(value["expectedVersion"]) || !isSettings(value["settings"])) return undefined;
  return { expectedVersion: value["expectedVersion"], settings: value["settings"] };
}

function parseGrantRequest(value: unknown) {
  if (!isRecord(value)) return undefined;
  const expectedVersion = value["expectedVersion"];
  const contentType = value["contentType"];
  const maxBytes = value["maxBytes"];
  if (!isNonNegativeInteger(expectedVersion) || (typeof contentType !== "string" || !DESIGN_SOURCE_CONTENT_TYPES.includes(contentType)) || !isPositiveInteger(maxBytes) || maxBytes > MAX_SOURCE_BYTES) return undefined;
  return { expectedVersion, contentType, maxBytes, progressive: value["progressive"] === true };
}

function parseConfigureProductRequest(value: unknown) {
  if (!isRecord(value)) return undefined;
  const baseProductId = value["baseProductId"];
  const designId = value["designId"];
  const expectedVersion = value["expectedVersion"];
  if (
    typeof baseProductId !== "string" || !isUuid(baseProductId) ||
    typeof designId !== "string" || !isUuid(designId) ||
    !isNonNegativeInteger(expectedVersion)
  ) return undefined;
  return { baseProductId, designId, expectedVersion };
}

function isSettings(value: unknown): value is EditorSettingsDto {
  if (!isRecord(value)) return false;
  const cropX = value["cropX"];
  const cropY = value["cropY"];
  const cropZoom = value["cropZoom"];
  const placementX = value["placementX"];
  const placementY = value["placementY"];
  const placementWidth = value["placementWidth"];
  const depth = value["depth"];
  return isBetween(cropX, 0, 1) && isBetween(cropY, 0, 1) &&
    isBetween(cropZoom, 0.65, 2.6) &&
    isBetween(placementX, 0, 1) && isBetween(placementY, 0, 1) &&
    isBetween(placementWidth, 0.08, 0.48) &&
    placementX + placementWidth <= 1 && placementY + placementWidth <= 1 &&
    typeof depth === "number" && Number.isInteger(depth) && depth >= 0 && depth <= 8 &&
    (value["removeBackground"] === undefined || typeof value["removeBackground"] === "boolean");
}

function isBetween(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isFinite(value) &&
    value >= minimum && value <= maximum;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function toProductDto(row: ProductRow) {
  return {
    id: row.id,
    baseProductId: row.base_product_id,
    designId: row.design_id,
    designRevisionId: row.design_revision_id,
    placement: row.placement_x === null || row.placement_y === null ||
        row.placement_width === null || row.placement_depth === null
      ? null
      : {
        x: row.placement_x,
        y: row.placement_y,
        width: row.placement_width,
        depth: row.placement_depth,
      },
    projectionVersion: row.projection_version,
    defaultColor: row.default_color,
    shopifyHandle: row.shopify_handle,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

function base64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function sha256Text(value: string) {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
}

async function sha256Bytes(value: Uint8Array) {
  const input = new ArrayBuffer(value.byteLength);
  new Uint8Array(input).set(value);
  const checksum = await crypto.subtle.digest("SHA-256", input);
  const bytes = new Uint8Array(checksum);
  return { bytes, hex: bytesToHex(bytes) };
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function removeBackgroundPreview(
  request: Request,
  env: AnonymousDesignEnv,
  ownerId: string,
) {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (contentType !== JPEG_CONTENT_TYPE) {
    return apiError(415, "UNSUPPORTED_MEDIA_TYPE", "Upload a JPEG image.");
  }
  const source = await readBoundedBody(request, MAX_SOURCE_BYTES);
  if (!source || source.byteLength === 0) return tooLarge();
  const processed = await processJpeg(env.IMAGES, source, "preview", () =>
    allowPortraitProcessing(env, ownerId)
  );
  if (!processed.ok) {
    if (processed.reason === "quota") return rateLimited();
    if (processed.reason === "invalid") {
      return apiError(415, "UNSUPPORTED_MEDIA_TYPE", "Upload a supported JPEG image.");
    }
    if (processed.reason === "output-too-large") return apiError(413, "ARTWORK_OUTPUT_TOO_LARGE", "This photo could not be prepared at its full resolution within the artwork size limit.");
    return apiError(503, "DEPENDENCY_UNAVAILABLE", "Image processing is unavailable.");
  }
  return new Response(new Uint8Array(processed.bytes).buffer, {
    headers: { "content-type": "image/png" },
  });
}

async function allowPortraitProcessing(env: AnonymousDesignEnv, ownerId: string) {
  if (!await rateLimitAllows(env.IMAGE_PROCESS_RATE_LIMIT, ownerId)) return false;
  return (await takeProviderToken(env.DB, "portrait")).allowed;
}

async function readBoundedBody(request: Request, maxBytes: number) {
  if (!request.body) return undefined;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let next = await reader.read();
  while (!next.done) {
    total += next.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(next.value);
    next = await reader.read();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function apiError(
  status: number,
  code: string,
  message: string,
  headers?: HeadersInit,
) {
  return headers
    ? Response.json({ error: { code, message } }, { headers, status })
    : Response.json({ error: { code, message } }, { status });
}

function screeningUnavailable() {
  return apiError(
    503,
    "DEPENDENCY_UNAVAILABLE",
    "Photo screening is temporarily unavailable. Please try again.",
    { "Retry-After": "5" },
  );
}

function productColorPending() {
  return apiError(
    503,
    "PRODUCT_COLOR_PENDING",
    "Product colour analysis is still in progress.",
    { "Retry-After": "1" },
  );
}

function withScreeningTiming(response: Response, durationMs?: number) {
  if (durationMs === undefined) return response;
  const headers = new Headers(response.headers);
  headers.append(
    "Server-Timing",
    `safety-screening;dur=${durationMs.toString()}`,
  );
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

function notFound() {
  return apiError(404, "NOT_FOUND", "Design not found.");
}

function badRequest(message: string) {
  return apiError(400, "BAD_REQUEST", message);
}

function conflict(code: string, message: string) {
  return apiError(409, code, message);
}

function tooLarge() {
  return apiError(413, "PAYLOAD_TOO_LARGE", "The upload exceeds its grant.");
}

function rateLimited(retryAfter = 60) {
  return Response.json(
    { error: { code: "RATE_LIMITED", message: "Too many requests. Try again later." } },
    { headers: { "Retry-After": String(retryAfter) }, status: 429 },
  );
}
