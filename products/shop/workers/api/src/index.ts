import { checkStorefrontAvailability } from "./storefront-monitor";
import { diagnosticRequestId, safeErrorDetails } from "@forever-tee/contracts/diagnostics";
import { observeApiRequest, observeBackgroundTask } from "./observability";
import { completePendingProductFamilies } from "./pending-product-families";
import { executeArtworkPreparation, isArtworkPreparationMessage, recoverArtworkPreparation } from "./artwork-preparation-jobs";
import { productPreviewResponse, ensureProductImages, legacyProductImageResponse, productImageResponse, productImageTransfer, reconcileProductImages } from "./product-images";
import {
  HttpApiBuilder,
  HttpServer,
} from "@effect/platform";
import {
  DependencyUnavailable,
  DesignNotFound as PublicDesignNotFound,
  ForeverTeeApi,
  InvalidRequest,
  ProductNotFound as PublicProductNotFound,
  RateLimitExceeded,
  type BackgroundRemovalQuality,
} from "@forever-tee/contracts";
import { Cause, Effect, Layer } from "effect";

import type { DesignDomainError } from "./design-errors";
import { handleCartLineCapabilityRequest } from "./cart-line-capabilities";
import { handleCartProductContextRequest } from "./cart-product-context";
import {
  handleCatalogueRequest,
  runScheduledCatalogueRefresh,
} from "./catalogue-api";
import { rateLimitAllows } from "./abuse-controls";
import { enqueuePrintAssetJobs, consumePrintAssetQueue, recoverPrintAssetJobs, type PrintAssetJobEnv } from "./print-asset-jobs";
import { cleanupPrintStaging } from "./print-asset-staging";
import {
  handleAnonymousDesignRequest,
} from "./anonymous-design-api";
import { makeDesignRepositoryLayer } from "./design-repository";
import { handleImmutableProductRequest } from "./immutable-product-api";
import {
  JPEG_CONTENT_TYPE,
  hasJpegMagic,
  MAX_SOURCE_BYTES,
  processJpeg,
} from "./image-processing";
import {
  makeOpenAiSafetyScreeningClient,
  type SafetyScreeningClient,
} from "./openai-safety-screening";
import { processPortraitForStorage } from "./portrait-processing";
import { takeProviderToken } from "./provider-admission";
import type { IntegrationEnv } from "./integration-config";
import {
  createDesign,
  getDesign,
  getDesignArtwork,
  getDesignArtworkPreview,
  uploadDesignArtwork,
  updateDesignSettings,
} from "./design-programs";
import type { ProductDomainError } from "./product-errors";
import { makeProductRepositoryLayer } from "./product-repository";
import { handleProductLifecycleRequest } from "./product-lifecycle";
import { handlePaidOrderRecoveryRequest } from "./paid-order-recovery";
import { handleFeaturedProductsRequest } from "./featured-products";
import { handleOperationalControlRequest } from "./operational-controls";
import { handleOrderManagementCapabilityRequest } from "./order-management-capabilities";
import {
  handleVariantMappingRequest,
  runScheduledVariantMappingRefresh,
} from "./variant-mapping-api";
import {
  createConfiguredProduct,
  getProduct,
  getProductFamily,
} from "./product-programs";
import {
  consumeStoryVideoQueue,
  ensureStoryVideoJobs,
  reconcileStoryVideoJobs,
  type StoryVideoEnv,
} from "./story-video-jobs";
import { scheduleStoryVideoWarmup } from "./story-video-warmup";
import { handleStoryVideoTransfer } from "./story-video-transfer";
import { handleNativeVideoStatus } from "./native-video-status";
import { handleShopifyWebhookRequest } from "./shopify-webhooks";
import { handleOrderManagementRequest, reconcileOrderManagement } from "./order-management";
import { reconcilePaidOrderHolds } from "./paid-order-holds";
import { runScheduledPrivacyMaintenance } from "./privacy-maintenance";
import { runScheduledStorageMaintenance } from "./storage-maintenance";
import { drainDesignAssetDeletions } from "./design-deletion";
import { handlePrintAssetDeliveryRequest } from "./print-asset-delivery";
import {
  handlePrintAssetReconciliationRequest,
  runScheduledPrintAssetReconciliation,
} from "./print-asset-reconciliation";
import { runScheduledPrintifyMaterialisation } from "./printify-production-materialisation";
import { runScheduledPrintifyOrderSubmission } from "./printify-order-submission";
import {
  handlePrintifyWebhookRequest,
  runScheduledPrintifyShipmentReconciliation,
} from "./printify-webhooks";
export { StoryVideoNotifications } from "./story-video-notifications";

type ApiEnv = Omit<Env, keyof IntegrationEnv | keyof StoryVideoEnv | keyof PrintAssetJobEnv> & IntegrationEnv & StoryVideoEnv & PrintAssetJobEnv & {
  readonly FOREVER_TEE_API_SHARED_SECRET?: string;
  readonly SAFETY_SCREENING?: SafetyScreeningClient;
  readonly STORY_VIDEOS: R2Bucket;
  readonly WEB_ORIGIN?: string;
  readonly WEB_ORIGINS?: string;
};

const mapDesignError = (error: DesignDomainError) => {
  switch (error._tag) {
    case "InvalidDesignInput":
      return new InvalidRequest({ message: error.message });
    case "DesignNotFound":
      return new PublicDesignNotFound({ message: "Design not found." });
    case "DatabaseFailure":
    case "ArtworkStorageFailure":
      return new DependencyUnavailable({ message: "Design storage is unavailable." });
  }
};

const mapProductError = (
  error: ProductDomainError | DesignDomainError,
) => {
  switch (error._tag) {
    case "InvalidProductInput":
    case "InvalidDesignInput":
      return new InvalidRequest({ message: error.message });
    case "ProductNotFound":
      return new PublicProductNotFound({ message: "Product not found." });
    case "DesignNotFound":
      return new PublicDesignNotFound({ message: "Design not found." });
    case "DatabaseFailure":
    case "ArtworkStorageFailure":
      return new DependencyUnavailable({ message: "Product storage is unavailable." });
  }
};

const observeFailure = (operation: string, requestId: string, designId?: string) =>
  <Success, Error, Requirements>(
    effect: Effect.Effect<Success, Error, Requirements>,
  ) =>
    effect.pipe(
      Effect.tapErrorCause((cause) =>
        Effect.logError("bent.shop legacy API operation failed", {
          operation, requestId, entityId: designId,
          failures: [...Cause.failures(cause), ...Cause.defects(cause)].slice(0, 5).map(safeErrorDetails),
        })
      ),
    );

const removeBackground = (
  env: ApiEnv,
  bytes: Uint8Array,
  contentType: string,
  quality: BackgroundRemovalQuality,
  quotaKey: string,
) =>
  Effect.gen(function*() {
    if (contentType !== JPEG_CONTENT_TYPE) {
      return yield* Effect.fail(new InvalidRequest({ message: "Upload a JPEG image." }));
    }
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_SOURCE_BYTES) {
      return yield* Effect.fail(
        new InvalidRequest({ message: "Images must be between 1 byte and 20 MB." }),
      );
    }
    const result = yield* Effect.tryPromise({
      try: () => processJpeg(env.IMAGES, bytes, quality, async () =>
        await rateLimitAllows(env.LEGACY_IMAGE_PROCESS_RATE_LIMIT, quotaKey) &&
        (await takeProviderToken(env.DB, "portrait")).allowed
      ),
      catch: () =>
        new DependencyUnavailable({ message: "Image processing is unavailable." }),
    });
    if (result.ok) return result.bytes;
    if (result.reason === "quota") {
      return yield* Effect.fail(new RateLimitExceeded({ message: "Too many images. Try again shortly." }));
    }
    if (result.reason === "invalid" || result.reason === "output-too-large") {
      return yield* Effect.fail(new InvalidRequest({ message: "Upload a supported JPEG image." }));
    }
    return yield* Effect.fail(
      new DependencyUnavailable({ message: "Image processing is unavailable." }),
    );
  }).pipe(Effect.withSpan("portrait.removeBackground"));

const screenPortraitForStorage = (
  env: ApiEnv,
  bytes: Uint8Array,
  contentType: string,
  quotaKey: string,
) =>
  Effect.gen(function*() {
    if (contentType !== JPEG_CONTENT_TYPE) {
      return yield* Effect.fail(new InvalidRequest({ message: "Upload a JPEG image." }));
    }
    let screeningClient: SafetyScreeningClient;
    try {
      screeningClient = env.SAFETY_SCREENING ??
        makeOpenAiSafetyScreeningClient(env);
    } catch {
      return yield* Effect.fail(new DependencyUnavailable({
        message: "Photo screening is temporarily unavailable. Please try again.",
      }));
    }
    const result = yield* Effect.tryPromise({
      try: () => processPortraitForStorage(
        env.IMAGES,
        bytes,
        async () => await rateLimitAllows(env.LEGACY_IMAGE_PROCESS_RATE_LIMIT, quotaKey) &&
          (await takeProviderToken(env.DB, "portrait")).allowed,
        screeningClient,
      ),
      catch: () => new DependencyUnavailable({
        message: "Image processing is temporarily unavailable. Please try again.",
      }),
    });
    if (result.ok) return result;
    if (result.reason === "quota") {
      return yield* Effect.fail(new RateLimitExceeded({
        message: "Too many images. Try again shortly.",
      }));
    }
    if (result.reason === "invalid" || result.reason === "output-too-large") {
      return yield* Effect.fail(new InvalidRequest({
        message: "Upload a supported JPEG image.",
      }));
    }
    if (result.reason === "blocked") {
      return yield* Effect.fail(new InvalidRequest({
        message: "That photo can't be used. Please choose another.",
      }));
    }
    return yield* Effect.fail(new DependencyUnavailable({
      message: result.reason === "screening-dependency"
        ? "Photo screening is temporarily unavailable. Please try again."
        : "Image processing is temporarily unavailable. Please try again.",
    }));
  }).pipe(Effect.withSpan("portrait.screenForStorage"));

const makeDesignApiLayer = (env: ApiEnv, requestId: string, quotaKey: string) =>
  HttpApiBuilder.group(ForeverTeeApi, "designs", (handlers) =>
    handlers
      .handle("removeBackground", ({ headers, payload }) =>
        removeBackground(
          env,
          payload,
          headers["content-type"],
          headers["x-background-removal-quality"] ?? "print",
          quotaKey,
        ).pipe(
          observeFailure("removeBackground", requestId),
        ),
      )
      .handle("createDesign", () =>
        createDesign().pipe(
          Effect.map((design) => ({ id: design.id })),
          Effect.mapError(mapDesignError),
          observeFailure("createDesign", requestId),
        ),
      )
      .handle("uploadDesignArtwork", ({ path, headers, payload }) =>
        screenPortraitForStorage(
          env,
          payload,
          headers["content-type"],
          quotaKey,
        ).pipe(
          Effect.flatMap((processed) =>
            uploadDesignArtwork(
              path.id,
              processed.bytes,
              "image/png",
              headers["x-design-settings"],
              processed.screening,
            ).pipe(Effect.mapError(mapDesignError))
          ),
          Effect.map((design) => ({
            id: design.id,
            artworkUrl: design.artworkUrl,
            updatedAt: design.updatedAt,
          })),
          observeFailure("uploadDesignArtwork", requestId, path.id),
        ),
      )
      .handle("processDesignArtwork", ({ path, headers, payload }) =>
        screenPortraitForStorage(
          env,
          payload,
          headers["content-type"],
          quotaKey,
        ).pipe(
          Effect.flatMap((processed) =>
            uploadDesignArtwork(
              path.id,
              processed.bytes,
              "image/png",
              undefined,
              processed.screening,
            ).pipe(
              Effect.mapError(mapDesignError),
            )
          ),
          Effect.map((design) => ({
            id: design.id,
            artworkUrl: design.artworkUrl,
            updatedAt: design.updatedAt,
          })),
          observeFailure("processDesignArtwork", requestId, path.id),
        ),
      )
      .handle("getDesign", ({ path }) =>
        getDesign(path.id).pipe(
          Effect.mapError(mapDesignError),
          observeFailure("getDesign", requestId, path.id),
        ),
      )
      .handle("updateDesign", ({ path, payload }) =>
        updateDesignSettings(path.id, payload).pipe(
          Effect.map((design) => ({
            id: design.id,
            updatedAt: design.updatedAt,
          })),
          Effect.mapError(mapDesignError),
          observeFailure("updateDesign", requestId, path.id),
        ),
      )
      .handle("getArtwork", ({ path }) =>
        getDesignArtwork(path.id).pipe(
          Effect.map(({ bytes }) => bytes),
          Effect.mapError(mapDesignError),
          observeFailure("getArtwork", requestId, path.id),
        ),
      )
      .handle("getArtworkPreview", ({ path }) =>
        getDesignArtworkPreview(path.id).pipe(
          Effect.map(({ bytes }) => bytes),
          Effect.mapError(mapDesignError),
          observeFailure("getArtworkPreview", requestId, path.id),
        ),
      ),
  );

const makeProductApiLayer = (requestId: string) =>
  HttpApiBuilder.group(ForeverTeeApi, "products", (handlers) =>
    handlers
      .handle("getProduct", ({ path }) =>
        getProduct(path.id).pipe(
          Effect.mapError(mapProductError),
          observeFailure("getProduct", requestId, path.id),
        ),
      )
      .handle("getProductFamily", ({ path }) =>
        getProductFamily(path.id).pipe(
          Effect.mapError(mapProductError),
          observeFailure("getProductFamily", requestId, path.id),
        ),
      )
      .handle("createConfiguredProduct", ({ payload }) =>
        createConfiguredProduct(payload.baseProductId, payload.designId).pipe(
          Effect.mapError(mapProductError),
          observeFailure("createConfiguredProduct", requestId, payload.designId),
        ),
      ),
  );

const makeHandler = (env: ApiEnv, requestId: string, quotaKey: string) =>
  HttpApiBuilder.toWebHandler(
    Layer.merge(
      HttpApiBuilder.api(ForeverTeeApi).pipe(
        Layer.provide(
          Layer.merge(
            makeDesignApiLayer(env, requestId, quotaKey),
            makeProductApiLayer(requestId),
          ).pipe(
            Layer.provide(
              Layer.merge(
                makeDesignRepositoryLayer(env),
                makeProductRepositoryLayer(env),
              ),
            ),
          ),
        ),
      ),
      HttpServer.layerContext,
    ),
  );

const worker: ExportedHandler<ApiEnv> = {
  fetch: handleRequest,
  queue(batch: MessageBatch, env, context) {
    const operation = /^forever-tee-print-assets-(development|production)$/.test(batch.queue)
      ? "print_asset_queue" : "story_video_queue";
    return observeBackgroundTask(operation, env, async () => {
      if (/^forever-tee-print-assets-(development|production)$/.test(batch.queue)) {
        for (const message of batch.messages) {
          if (!isArtworkPreparationMessage(message.body)) continue;
          if (await executeArtworkPreparation(env, message.body.artworkJobId)) {
            await finishPendingProducts(env, context);
            message.ack();
          }
          else message.retry({ delaySeconds: 60 });
        }
        return consumePrintAssetQueue({ ...batch,
          messages: batch.messages.filter(message => !isArtworkPreparationMessage(message.body)),
        }, env);
      }
      return consumeStoryVideoQueue(batch, env);
    });
  },
  scheduled(controller, env, context) {
    context.waitUntil(observeBackgroundTask("print_asset_recovery", env, () => recoverPrintAssetJobs(env)));
    context.waitUntil(observeBackgroundTask("artwork_preparation_recovery", env, () => recoverArtworkPreparation(env).then(() => finishPendingProducts(env, context))));
    context.waitUntil(observeBackgroundTask("product_image_reconciliation", env, () => reconcileProductImages(env)));
    context.waitUntil(observeBackgroundTask("print_staging_cleanup", env, () => cleanupPrintStaging(env)));
    // Lambda recovery needs a minute backstop for failed queue sends. Do not
    // multiply the unrelated catalogue/Shopify refreshes by fifteen.
    if (new Date(controller.scheduledTime).getUTCMinutes() % 15 === 0) {
      context.waitUntil(observeBackgroundTask("storefront_availability", env, () => checkStorefrontAvailability(env.OPERATIONS_ENVIRONMENT)));
      context.waitUntil(runScheduledRefreshes(env));
    } else {
      context.waitUntil(Promise.all([
        observeBackgroundTask("story_video_reconciliation", env, () => reconcileStoryVideoJobs(env)),
        reconcileFulfilment(env),
      ]).then(() => undefined));
    }
  },
};

async function runScheduledRefreshes(env: ApiEnv) {
  const refreshProductDependencies = observeBackgroundTask("catalogue_refresh", env, () => runScheduledCatalogueRefresh(env))
    .then(() => observeBackgroundTask("variant_mapping_refresh", env, () => runScheduledVariantMappingRefresh(env)))
    .then(() => observeBackgroundTask("print_asset_reconciliation", env, () => runScheduledPrintAssetReconciliation(env)));
  await Promise.all([
    refreshProductDependencies,
    observeBackgroundTask("story_video_reconciliation", env, () => reconcileStoryVideoJobs(env)),
    reconcileFulfilment(env),
    observeBackgroundTask("privacy_maintenance", env, () => runScheduledPrivacyMaintenance(env)),
    observeBackgroundTask("storage_maintenance", env, () => runScheduledStorageMaintenance(env)),
    observeBackgroundTask("design_asset_deletion", env, () => drainDesignAssetDeletions(env)),
  ]);
}

async function reconcileFulfilment(env: ApiEnv) {
  await observeBackgroundTask("order_management_reconciliation", env, () => reconcileOrderManagement(env));
  await observeBackgroundTask("paid_order_hold_reconciliation", env, () => reconcilePaidOrderHolds(env));
  await observeBackgroundTask("printify_materialisation", env, () => runScheduledPrintifyMaterialisation(env));
  await observeBackgroundTask("printify_order_submission", env, () => runScheduledPrintifyOrderSubmission(env));
  await observeBackgroundTask("shipment_reconciliation", env, () => runScheduledPrintifyShipmentReconciliation(env));
}

export async function handleRequest(request: Request, env: ApiEnv, context?: Pick<ExecutionContext, "waitUntil">) {
  return observeApiRequest(request, env, correlated => routeRequest(correlated, env, context));
}

async function routeRequest(request: Request, env: ApiEnv, context?: Pick<ExecutionContext, "waitUntil">) {
    if (new URL(request.url).pathname.startsWith("/v2/design-upload-grants/")) {
      const response = request.method === "OPTIONS" ? new Response(null, { status: 204 })
      : Response.json({ error: { code: "UPLOAD_EXPIRED", message: "This upload link expired. Retry the upload." } }, {
        status: 410, headers: { "Cache-Control": "private, no-store" },
      });
      return withCors(response, request.headers.get("origin"), configuredOrigins(env));
    }
    const printAssetResponse = await handlePrintAssetDeliveryRequest(request, env);
    if (printAssetResponse) return printAssetResponse;
    const printifyWebhookResponse = await handlePrintifyWebhookRequest(request, env);
    if (printifyWebhookResponse) return printifyWebhookResponse;
    const shopifyWebhookResponse = await handleShopifyWebhookRequest(request, env);
    if (shopifyWebhookResponse) return shopifyWebhookResponse;
    const cartContextResponse = await handleCartProductContextRequest(request, env);
    if (cartContextResponse) return cartContextResponse;
    const cartLineCapabilityResponse = await handleCartLineCapabilityRequest(
      request,
      env,
    );
    if (cartLineCapabilityResponse) return cartLineCapabilityResponse;
    const orderManagementCapabilityResponse =
      await handleOrderManagementCapabilityRequest(request, env);
    if (orderManagementCapabilityResponse) {
      return orderManagementCapabilityResponse;
    }
    const nativeStatus = await handleNativeVideoStatus(request, env);
    if (nativeStatus) return nativeStatus;
    const imageResponse = await productPreviewResponse(request, env) ?? await productImageResponse(request, env, context) ?? await legacyProductImageResponse(request, env, context) ?? await productImageTransfer(request, env);
    if (imageResponse) return imageResponse;
    const transferResponse = await handleStoryVideoTransfer(request, env);
    if (transferResponse) return transferResponse;
    const origin = request.headers.get("origin");
    const allowedOrigins = configuredOrigins(env);
    const requestPath = new URL(request.url).pathname;
    const requestId = diagnosticRequestId(request.headers.get("x-request-id")) ?? crypto.randomUUID();
    const isAnonymousPath = requestPath.startsWith("/v2/design-") ||
      requestPath === "/v2/background-removal" ||
      requestPath === "/v2/configured-product-families" ||
      requestPath === "/v2/configured-products";
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: isAnonymousPath
          ? corsHeaders(origin, allowedOrigins)
          : legacyCorsHeaders(origin, env.WEB_ORIGIN ?? "http://localhost:3000"),
      });
    }
    const managementResponse = await handleOrderManagementRequest(request, env);
    if (managementResponse) return managementResponse;

    const lifecycleResponse = await handleProductLifecycleRequest(request, env);
    if (lifecycleResponse) return lifecycleResponse;

    const paidOrderRecoveryResponse = await handlePaidOrderRecoveryRequest(request, env);
    if (paidOrderRecoveryResponse) return paidOrderRecoveryResponse;

    const featuredResponse = await handleFeaturedProductsRequest(request, env);
    if (featuredResponse) return featuredResponse;

    const operationalControlResponse = await handleOperationalControlRequest(
      request,
      env,
    );
    if (operationalControlResponse) return operationalControlResponse;
    const printAssetReconciliationResponse =
      await handlePrintAssetReconciliationRequest(request, env);
    if (printAssetReconciliationResponse) {
      return printAssetReconciliationResponse;
    }
    const catalogueResponse = await handleCatalogueRequest(request, env);
    if (catalogueResponse) return catalogueResponse;
    const variantMappingResponse = await handleVariantMappingRequest(request, env);
    if (variantMappingResponse) return variantMappingResponse;
    const immutableProductResponse = await handleImmutableProductRequest(request, env);
    if (immutableProductResponse) return immutableProductResponse;
    const anonymousStartedAt = performance.now();
    {
      const completion = handleAnonymousDesignWithMedia(request, env, context);
      if (request.method === "POST" && ["/v2/configured-products", "/v2/configured-product-families"].includes(requestPath)) {
        // A disconnected caller must not stop an accepted configuration between
        // its product commit and durable print/video outbox inserts.
        context?.waitUntil(completion.then(() => undefined, () => undefined));
      }
      const anonymousResponse = await completion;
      if (anonymousResponse) {
        const durationMs = Math.round(performance.now() - anonymousStartedAt);
        const headers = new Headers(anonymousResponse.headers);
        headers.append("Server-Timing", `worker;dur=${durationMs.toString()}`);
        headers.set("x-request-id", requestId);
        return withCors(new Response(anonymousResponse.body, {
          headers,
          status: anonymousResponse.status,
          statusText: anonymousResponse.statusText,
        }), origin, allowedOrigins);
      }
    }
    const legacyPaidProcessing = isLegacyPaidProcessingPath(requestPath, request.method);
    const legacyMutation = isRetainedLegacyMutationPath(requestPath, request.method);
    const clientDigest = legacyPaidProcessing || legacyMutation
      ? await clientAddressDigest(request)
      : "not-applicable";
    const quotaKey = legacyPaidProcessing || legacyMutation
      ? `legacy:${clientDigest}`
      : "legacy:not-applicable";
    if (
      legacyMutation &&
      !await rateLimitAllows(
        env.LEGACY_MUTATION_RATE_LIMIT,
        `legacy-mutation:${clientDigest}`,
      )
    ) return withLegacyCors(rateLimited(), origin, env);
    let effectiveRequest = request;
    if (isLegacyArtworkWritePath(requestPath, request.method)) {
      const validated = await validateLegacyArtworkRequest(request);
      if (validated instanceof Response) {
        return withLegacyCors(validated, origin, env);
      }
      effectiveRequest = new Request(request, { body: validated });
    }
    if (isLegacyDraftMutation(request)) {
      console.warn("bent.shop deprecated v1 draft mutation called", {
        method: request.method,
        path: new URL(request.url).pathname,
      });
    }
    const { dispose, handler } = makeHandler(env, requestId, quotaKey);
    try {
      const response = await handler(effectiveRequest);
      const headers = new Headers(response.headers);
      if (response.status === 429) headers.set("Retry-After", "60");
      legacyCorsHeaders(origin, env.WEB_ORIGIN ?? "http://localhost:3000").forEach((value, key) => {
        headers.set(key, value);
      });
      if (
        response.ok &&
        isVersionedArtworkPreview(new URL(request.url))
      ) {
        headers.set("Cache-Control", "no-store");
      }
      if (isLegacyDraftMutation(request)) {
        headers.set("Deprecation", "true");
        headers.set("Link", "</v2/design-drafts>; rel=successor-version");
      }
      if (response.status === 429 && !headers.has("Retry-After")) {
        headers.set("Retry-After", "86400");
      }
      if (
        response.status === 503 &&
        isLegacyArtworkWritePath(requestPath, request.method) &&
        !headers.has("Retry-After")
      ) {
        headers.set("Retry-After", "5");
      }
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    } finally {
      await dispose();
    }
}

async function handleAnonymousDesignWithMedia(
  request: Request,
  env: ApiEnv,
  context?: Pick<ExecutionContext, "waitUntil">,
) {
  const response = await handleAnonymousDesignRequest(request, env, context, async ids => {
    // These are independent durable outboxes. Still images must not wait for
    // print/video persistence or provider handoff before starting generation.
    const results = await Promise.allSettled([ensureProductImages(env, ids, context), ensureStoryVideoJobs(env, ids, context)]);
    const failed = results.find(result => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  });
  if (response) scheduleStoryVideoWarmup(request, response, env, context);
  return response;
}

function isVersionedArtworkPreview(url: URL) {
  return url.pathname.endsWith("/artwork/preview") &&
    /^[0-9a-f]{64}$/.test(url.searchParams.get("revision") ?? "");
}

function corsHeaders(origin: string | null, allowedOrigins: ReadonlySet<string>) {
  const headers = new Headers({
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,OPTIONS",
    "Access-Control-Expose-Headers": "Retry-After, Server-Timing, X-Request-Id",
    Vary: "Origin",
  });
  if (origin && allowedOrigins.has(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Timing-Allow-Origin", origin);
  }
  return headers;
}

function configuredOrigins(env: ApiEnv) {
  const configured = env.WEB_ORIGINS ?? env.WEB_ORIGIN ?? "http://localhost:3000";
  return new Set(
    configured.split(",").map((value) => value.trim()).filter((value) => value.length > 0),
  );
}

function legacyCorsHeaders(origin: string | null, allowedOrigin: string) {
  const headers = new Headers({
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Expose-Headers": "Retry-After, Server-Timing, X-Request-Id",
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,OPTIONS",
    Vary: "Origin",
  });
  if (origin && isLegacyAllowedOrigin(origin, allowedOrigin)) {
    headers.set("Access-Control-Allow-Origin", origin);
  }
  return headers;
}

function isLegacyAllowedOrigin(origin: string, configuredOrigin: string) {
  if (origin === configuredOrigin) return true;
  try {
    const hostname = new URL(origin).hostname;
    return hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname.endsWith(".trycloudflare.com") ||
      hostname.endsWith(".vercel.app");
  } catch {
    return false;
  }
}

function withCors(
  response: Response,
  origin: string | null,
  allowedOrigins: ReadonlySet<string>,
) {
  const headers = new Headers(response.headers);
  corsHeaders(origin, allowedOrigins).forEach((value, key) => {
    headers.set(key, value);
  });
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function isLegacyDraftMutation(request: Request) {
  const path = new URL(request.url).pathname;
  return request.method !== "GET" && request.method !== "HEAD" &&
    (path === "/v1/background-removal" || path === "/v1/designs" || path === "/v1/products" ||
      /^\/v1\/designs\/[0-9a-f-]{36}(?:\/artwork(?:\/background-removal)?)?$/.test(path));
}

function isLegacyPaidProcessingPath(path: string, method: string) {
  return (method === "POST" && path === "/v1/background-removal") ||
    (method === "PUT" && /^\/v1\/designs\/[0-9a-f-]{36}\/artwork\/background-removal$/.test(path));
}

function isRetainedLegacyMutationPath(path: string, method: string) {
  return (method === "POST" && path === "/v1/designs") ||
    isLegacyArtworkWritePath(path, method);
}

function isLegacyArtworkWritePath(path: string, method: string) {
  return method === "PUT" &&
    /^\/v1\/designs\/[0-9a-f-]{36}\/artwork(?:\/background-removal)?$/.test(path);
}

async function validateLegacyArtworkRequest(request: Request) {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (contentType !== JPEG_CONTENT_TYPE) {
    return legacyBoundaryError(415, "Upload a JPEG image.");
  }
  const declaredText = request.headers.get("content-length");
  if (!declaredText || !/^\d+$/.test(declaredText)) {
    return legacyBoundaryError(411, "A valid Content-Length is required.");
  }
  const declared = Number(declaredText);
  if (!Number.isSafeInteger(declared) || declared <= 0 || declared > MAX_SOURCE_BYTES) {
    return legacyBoundaryError(413, "The image must be no larger than 20 MB.");
  }
  const bytes = await readBoundedRequestBody(request, MAX_SOURCE_BYTES);
  if (bytes?.byteLength !== declared) {
    return legacyBoundaryError(400, "Content-Length does not match the image body.");
  }
  if (!hasJpegMagic(bytes)) {
    return legacyBoundaryError(415, "Upload a valid JPEG image.");
  }
  return bytes;
}

async function readBoundedRequestBody(request: Request, maximum: number) {
  if (!request.body) return undefined;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let next = await reader.read();
  while (!next.done) {
    length += next.value.byteLength;
    if (length > maximum) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(next.value);
    next = await reader.read();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function legacyBoundaryError(status: number, message: string) {
  return Response.json({ error: { code: "BAD_REQUEST", message } }, { status });
}

async function clientAddressDigest(request: Request) {
  const address = request.headers.get("cf-connecting-ip") ?? "unknown";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(address));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function rateLimited() {
  return Response.json(
    { error: { code: "RATE_LIMITED", message: "Too many requests. Try again later." } },
    { headers: { "Retry-After": "60" }, status: 429 },
  );
}

function withLegacyCors(response: Response, origin: string | null, env: ApiEnv) {
  const headers = new Headers(response.headers);
  legacyCorsHeaders(origin, env.WEB_ORIGIN ?? "http://localhost:3000").forEach(
    (value, key) => { headers.set(key, value); },
  );
  return new Response(response.body, { headers, status: response.status });
}


export default worker;

async function finishPendingProducts(env: ApiEnv, context: Pick<ExecutionContext, "waitUntil">) {
  await completePendingProductFamilies(env.DB, async ids => {
    const results = await Promise.allSettled([
      enqueuePrintAssetJobs(env, ids, context), ensureProductImages(env, ids, context), ensureStoryVideoJobs(env, ids, context),
    ]);
    const failed = results.find(result => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  });
}
