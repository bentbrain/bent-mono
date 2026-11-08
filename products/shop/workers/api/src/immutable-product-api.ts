import { Effect, Either } from "effect";

import type { ProductDomainError } from "./product-errors";
import {
  IntegrationConfigError,
  requireOpenAiConfig,
  requireOperationsConfig,
} from "./integration-config";
import {
  makeProductRepositoryLayer,
  ProductRepository,
} from "./product-repository";
import { isAuthenticatedServiceRequest } from "./service-auth";
import { STORY_VIDEO_RENDERER_VERSION } from "./story-video-jobs";
import { storyVideoEvents } from "./story-video-events";
import type { StoryVideoNotificationEnv } from "./story-video-notifications";
import { productPurchaseReadiness } from "./product-purchase-readiness";

const ACTIVE_PRODUCT_PATH =
  /^\/v2\/internal\/configured-products\/([0-9a-f-]{36})$/;
const HISTORICAL_PRODUCT_PATH =
  /^\/v2\/internal\/configured-products\/([0-9a-f-]{36})\/revisions\/([0-9a-f-]{36})$/;
const REVISION_ARTWORK_PATH =
  /^\/v2\/internal\/design-revisions\/([0-9a-f-]{36})\/artwork$/;
const STORY_VIDEO_PATH =
  /^\/v2\/internal\/configured-products\/([0-9a-f-]{36})\/story-videos\/(black|cream|white)$/;
const CAPABILITIES_PATH = "/v2/internal/capabilities";
const STORY_VIDEO_EVENTS_PATH =
  /^\/v2\/internal\/configured-products\/([0-9a-f-]{36})\/story-video-events$/;
const WORKER_RELEASE = "bent-shirt-pilot-m2-v1";
const WORKER_CAPABILITIES = [
  "cart-product-context-v1",
  "anonymous-drafts-v2",
  "owner-artwork-media-v1",
  "saved-designs-v1",
  "saved-design-pages-v1",
  "order-management-v1",
  "featured-products-v1",
  "immutable-product-snapshots-v1",
  "printify-catalogue-snapshots-v1",
  "portrait-safety-screening-v1",
  "product-projections-v1",
  "sales-pause-v1",
  "shopify-printify-variant-mapping-v1",
  "story-video-media-v1",
];

interface ImmutableProductEnv extends StoryVideoNotificationEnv {
  readonly BENT_SHIRT_OPERATIONS_SECRET?: string;
  readonly DB: D1Database;
  readonly DESIGN_ARTWORK: R2Bucket;
  readonly FOREVER_TEE_API_SHARED_SECRET?: string;
  readonly OPENAI_API_KEY?: string;
  readonly STORY_VIDEO_RENDERER?: {
    readonly fetch: (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => Promise<Response>;
  };
}

interface StoryVideoRow {
  readonly output_byte_size: number | null;
  readonly status: "failed" | "queued" | "ready" | "rendering";
  readonly story_key: string;
}

export async function handleImmutableProductRequest(
  request: Request,
  env: ImmutableProductEnv,
): Promise<Response | undefined> {
  const path = new URL(request.url).pathname;
  if (!path.startsWith("/v2/internal/")) return undefined;

  if (!(await isAuthenticatedServiceRequest(request, env))) {
    return apiError(401, "UNAUTHORIZED", "Service authentication is required.");
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return apiError(405, "METHOD_NOT_ALLOWED", "This route is read-only.", {
      Allow: "GET, HEAD",
    });
  }
  if (path === CAPABILITIES_PATH) {
    return workerCapabilities(env, request.method === "HEAD");
  }

  const readinessId = /^\/v2\/internal\/configured-products\/([0-9a-f-]{36})\/purchase-readiness$/.exec(path)?.[1];
  if (readinessId) {
    const readiness = await productPurchaseReadiness(env.DB, readinessId);
    return readiness ? Response.json(readiness, { headers: { "Cache-Control": "no-store" } }) : notFound();
  }

  const storyVideoMatch = STORY_VIDEO_PATH.exec(path);
  const eventsProductId = STORY_VIDEO_EVENTS_PATH.exec(path)?.[1];
  if (eventsProductId) return storyVideoEvents(request, env.DB, eventsProductId, env);
  const storyVideoProductId = storyVideoMatch?.[1];
  const storyVideoColour = storyVideoMatch?.[2];
  if (storyVideoProductId && storyVideoColour) {
    return configuredProductStoryVideo(
      request,
      env,
      storyVideoProductId,
      storyVideoColour,
    );
  }

  const historicalMatch = HISTORICAL_PRODUCT_PATH.exec(path);
  const historicalProductId = historicalMatch?.[1];
  const historicalRevisionId = historicalMatch?.[2];
  if (historicalProductId && historicalRevisionId) {
    return runProductLookup(
      env,
      (repository) =>
        repository.findHistoricalRevisionSnapshot(
          historicalProductId,
          historicalRevisionId,
        ),
      request.method === "HEAD",
    );
  }

  const activeProductId = ACTIVE_PRODUCT_PATH.exec(path)?.[1];
  if (activeProductId) {
    return runProductLookup(
      env,
      (repository) => repository.findActiveRevisionSnapshot(activeProductId),
      request.method === "HEAD",
    );
  }

  const revisionId = REVISION_ARTWORK_PATH.exec(path)?.[1];
  if (revisionId) {
    return revisionArtwork(request, env, revisionId);
  }

  return notFound();
}

async function workerCapabilities(env: ImmutableProductEnv, head: boolean) {
  try {
    requireOperationsConfig(env);
    requireOpenAiConfig(env);
    await env.DB.prepare("SELECT id FROM order_management_commands LIMIT 1").first();
    await env.DB.prepare("SELECT id FROM order_management_access_log LIMIT 1").first();
    await env.DB.prepare("SELECT slot FROM featured_products LIMIT 1").first();
    await env.DB.prepare("SELECT revision FROM featured_product_state WHERE id = 1").first();
    await env.DB.prepare("SELECT storage_key FROM design_asset_deletions LIMIT 1").first();
    await env.DB.prepare(
      `SELECT safety_screening_decision, safety_screening_model,
        default_product_color_status
        FROM designs LIMIT 1`,
    ).first();
    await env.DB.prepare(
      "SELECT control_key FROM operational_controls LIMIT 1",
    ).first();
    await env.DB.prepare(
      "SELECT id FROM printify_catalogue_snapshots LIMIT 1",
    ).first();
    await env.DB.prepare(
      "SELECT id FROM shopify_variant_mapping_snapshots LIMIT 1",
    ).first();
    await env.DB.prepare(
      "SELECT projection_version FROM products LIMIT 1",
    ).first();
    await env.DB.prepare(
      "SELECT renderer_version FROM story_video_jobs LIMIT 1",
    ).first();
  } catch (error) {
    const message = error instanceof IntegrationConfigError
      ? error.message
      : "Required operational storage is not migrated.";
    return apiError(503, "CONFIGURATION_ERROR", message);
  }
  return head
    ? new Response(null, { status: 200 })
    : Response.json({
        capabilities: WORKER_CAPABILITIES,
        release: WORKER_RELEASE,
      });
}

async function runProductLookup(
  env: ImmutableProductEnv,
  lookup: (
    repository: Effect.Effect.Success<typeof ProductRepository>,
  ) => Effect.Effect<unknown, ProductDomainError>,
  head: boolean,
) {
  const result = await Effect.runPromise(
    Effect.gen(function*() {
      const repository = yield* ProductRepository;
      return yield* lookup(repository);
    }).pipe(
      Effect.provide(makeProductRepositoryLayer(env)),
      Effect.either,
    ),
  );
  if (Either.isLeft(result)) return productError(result.left);
  if (head) return new Response(null, { status: 200 });
  return Response.json(result.right);
}

async function revisionArtwork(
  request: Request,
  env: ImmutableProductEnv,
  revisionId: string,
) {
  const metadata = await Effect.runPromise(
    Effect.gen(function*() {
      const repository = yield* ProductRepository;
      return yield* repository.findRevisionArtwork(revisionId);
    }).pipe(
      Effect.provide(makeProductRepositoryLayer(env)),
      Effect.either,
    ),
  );
  if (Either.isLeft(metadata)) return productError(metadata.left);

  let object: R2ObjectBody | null;
  try {
    object = await env.DESIGN_ARTWORK.get(metadata.right.artworkKey);
  } catch {
    return apiError(
      503,
      "DEPENDENCY_UNAVAILABLE",
      "Revision artwork is unavailable.",
    );
  }
  if (!object) return notFound();
  if (object.size !== metadata.right.byteSize) {
    return artworkUnavailable();
  }

  const storedSha256 = object.checksums.sha256;
  let responseBody: ReadableStream | ArrayBuffer;
  if (storedSha256) {
    if (!checksumMatches(storedSha256, metadata.right.sha256)) {
      return artworkUnavailable();
    }
    responseBody = object.body;
  } else {
    let legacyBytes: ArrayBuffer;
    try {
      legacyBytes = await object.arrayBuffer();
    } catch {
      return artworkUnavailable();
    }
    const computed = await crypto.subtle.digest("SHA-256", legacyBytes);
    if (!checksumMatches(computed, metadata.right.sha256)) {
      return artworkUnavailable();
    }
    responseBody = legacyBytes;
  }

  const etag = `"${metadata.right.sha256}"`;
  const headers = new Headers({
    "Cache-Control": "private, max-age=31536000, immutable",
    "Content-Digest": `sha-256=:${hexSha256ToBase64(metadata.right.sha256)}:`,
    "Content-Length": String(metadata.right.byteSize),
    "Content-Type": metadata.right.contentType,
    ETag: etag,
  });
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(request.method === "HEAD" ? null : responseBody, {
    status: 200,
    headers,
  });
}

async function configuredProductStoryVideo(
  request: Request,
  env: ImmutableProductEnv,
  productId: string,
  colour: string,
) {
  let job: StoryVideoRow | null;
  try {
    const product = await env.DB.prepare("SELECT placement_depth FROM products WHERE id = ? AND status = 'active'")
      .bind(productId).first<{ placement_depth: number | null }>();
    if (product?.placement_depth === 0) return new Response(null, { status: 204, headers: { "Cache-Control": "private, no-store" } });
    job = await env.DB.prepare(`
      SELECT story_key, status, output_byte_size
      FROM story_video_jobs
      WHERE product_id = ? AND lower(colour) = ? AND renderer_version = ?
      LIMIT 1
    `).bind(
      productId,
      colour,
      STORY_VIDEO_RENDERER_VERSION,
    ).first<StoryVideoRow>();
  } catch {
    return apiError(
      503,
      "DEPENDENCY_UNAVAILABLE",
      "Story-video status is unavailable.",
    );
  }
  if (!job || job.status === "failed") return notFound();
  if (job.status !== "ready") {
    return Response.json(
      { status: job.status },
      {
        headers: {
          "Cache-Control": "private, no-store",
          "Retry-After": "2",
        },
        status: 202,
      },
    );
  }
  if (!env.STORY_VIDEO_RENDERER) {
    return apiError(
      503,
      "DEPENDENCY_UNAVAILABLE",
      "Story-video storage is unavailable.",
    );
  }
  let stored: Response;
  try {
    stored = await env.STORY_VIDEO_RENDERER.fetch(
      "https://story-video.internal/video",
      {
        headers: { "x-story-video-key": job.story_key },
        method: request.method,
      },
    );
  } catch {
    return apiError(
      503,
      "DEPENDENCY_UNAVAILABLE",
      "Story-video storage is unavailable.",
    );
  }
  if (!stored.ok) {
    return apiError(
      503,
      "DEPENDENCY_UNAVAILABLE",
      "The rendered story video is unavailable.",
    );
  }
  const headers = new Headers(stored.headers);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  headers.set("Content-Type", "video/mp4");
  headers.set("X-Content-Type-Options", "nosniff");
  if (job.output_byte_size !== null) {
    headers.set("Content-Length", String(job.output_byte_size));
  }
  return new Response(request.method === "HEAD" ? null : stored.body, {
    headers,
    status: 200,
  });
}

function productError(error: ProductDomainError) {
  switch (error._tag) {
    case "InvalidProductInput":
    case "ProductNotFound":
      return notFound();
    case "DatabaseFailure":
      return apiError(
        503,
        "DEPENDENCY_UNAVAILABLE",
        "Product storage is unavailable.",
      );
  }
}

function hexSha256ToBase64(sha256: string) {
  const bytes = Uint8Array.from(
    sha256.match(/.{2}/g) ?? [],
    (pair) => Number.parseInt(pair, 16),
  );
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function checksumMatches(checksum: ArrayBuffer, expectedHex: string) {
  return Array.from(
    new Uint8Array(checksum),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("") === expectedHex;
}

function artworkUnavailable() {
  return apiError(
    503,
    "DEPENDENCY_UNAVAILABLE",
    "Revision artwork is unavailable.",
  );
}

function notFound() {
  return apiError(404, "NOT_FOUND", "Product revision not found.");
}

function apiError(
  status: number,
  code: string,
  message: string,
  headers?: HeadersInit,
) {
  return Response.json(
    { error: { code, message } },
    headers ? { status, headers } : { status },
  );
}
