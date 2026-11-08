import { checkStorefrontAvailability } from "./storefront-monitor";
import { diagnosticRequestId, safeErrorDetails } from "@forever-tee/contracts/diagnostics";
import { observeApiRequest, observeBackgroundTask } from "./observability";
import { completePendingProductFamilies } from "./pending-product-families";
import { executeArtworkPreparation, isArtworkPreparationMessage, recoverArtworkPreparation } from "./artwork-preparation-jobs";
import { productPreviewResponse, ensureProductImages, legacyProductImageResponse, productImageResponse, productImageTransfer, reconcileProductImages } from "./product-images";
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiGroup,
  HttpRouter,
  HttpServer,
  HttpServerResponse,
} from "@effect/platform";
import {
  DependencyUnavailable,
  DesignNotFound as PublicDesignNotFound,
  ForeverTeeApi,
  DesignsGroup,
  ProductsGroup,
  InvalidRequest,
  ProductNotFound as PublicProductNotFound,
} from "@forever-tee/contracts";
import { Cause, Effect, Layer } from "effect";

import type { DesignDomainError } from "./design-errors";
import { handleCartLineCapabilityRequest } from "./cart-line-capabilities";
import { handleCartProductContextRequest } from "./cart-product-context";
import {
  handleCatalogueRequest,
  runScheduledCatalogueRefresh,
} from "./catalogue-api";
import { enqueuePrintAssetJobs, consumePrintAssetQueue, recoverPrintAssetJobs, type PrintAssetJobEnv } from "./print-asset-jobs";
import { cleanupPrintStaging } from "./print-asset-staging";
import {
  handleAnonymousDesignRequest,
} from "./anonymous-design-api";
import { makeDesignRepositoryLayer } from "./design-repository";
import { handleImmutableProductRequest } from "./immutable-product-api";
import type { SafetyScreeningClient } from "./openai-safety-screening";
import type { IntegrationEnv } from "./integration-config";
import {
  getDesign,
  getDesignArtwork,
  getDesignArtworkPreview,
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

function legacyEndpoint<Endpoint extends { readonly name: string }, Name extends Endpoint["name"]>(
  endpoints: readonly Endpoint[], name: Name,
) {
  const endpoint = endpoints.find((candidate): candidate is Extract<Endpoint, { readonly name: Name }> => candidate.name === name);
  if (!endpoint) throw new Error(`Legacy endpoint is unavailable: ${name}`);
  return endpoint;
}

const legacyDesigns = Object.values(ForeverTeeApi.groups).find(
  (group): group is typeof DesignsGroup => group.identifier === DesignsGroup.identifier,
);
const legacyProducts = Object.values(ForeverTeeApi.groups).find(
  (group): group is typeof ProductsGroup => group.identifier === ProductsGroup.identifier,
);
if (!legacyDesigns || !legacyProducts) throw new Error("Legacy API groups are unavailable.");
const designEndpoints = Object.values(legacyDesigns.endpoints);
const productEndpoints = Object.values(legacyProducts.endpoints);

// Keep successful legacy reads on their existing schemas. Retired writes use
// the same router's endpoint paths, with no payload or header decoding.
const LegacyReadApi = HttpApi.make(ForeverTeeApi.identifier)
  .add(HttpApiGroup.make("designs")
    .add(legacyEndpoint(designEndpoints, "getDesign"))
    .add(legacyEndpoint(designEndpoints, "getArtwork"))
    .add(legacyEndpoint(designEndpoints, "getArtworkPreview"))
    .addError(legacyDesigns.errorSchema))
  .add(HttpApiGroup.make("products")
    .add(legacyEndpoint(productEndpoints, "getProduct"))
    .add(legacyEndpoint(productEndpoints, "getProductFamily"))
    .addError(legacyProducts.errorSchema))
  .addError(ForeverTeeApi.errorSchema);

const retiredLegacyEndpoints = [
  legacyEndpoint(designEndpoints, "removeBackground"),
  legacyEndpoint(designEndpoints, "createDesign"),
  legacyEndpoint(designEndpoints, "uploadDesignArtwork"),
  legacyEndpoint(designEndpoints, "processDesignArtwork"),
  legacyEndpoint(designEndpoints, "updateDesign"),
  legacyEndpoint(productEndpoints, "createConfiguredProduct"),
];

const retiredLegacyRoutes = HttpApiBuilder.Router.use(router => Effect.forEach(
  retiredLegacyEndpoints,
  endpoint => router.addRoute(HttpRouter.makeRoute(endpoint.method, endpoint.path,
    Effect.sync(() => HttpServerResponse.unsafeJson({ error: {
      code: "LEGACY_WRITE_RETIRED", message: "Use the current design upload flow.",
    } }, { status: 410, headers: {
      "Cache-Control": "no-store", Deprecation: "true", Link: "</v2/design-drafts>; rel=successor-version",
    } })))),
  { discard: true },
));

const makeDesignApiLayer = (requestId: string) =>
  HttpApiBuilder.group(LegacyReadApi, "designs", handlers => handlers
    .handle("getDesign", ({ path }) => getDesign(path.id).pipe(
      Effect.mapError(mapDesignError), observeFailure("getDesign", requestId, path.id),
    ))
    .handle("getArtwork", ({ path }) => getDesignArtwork(path.id).pipe(
      Effect.map(({ bytes }) => bytes), Effect.mapError(mapDesignError),
      observeFailure("getArtwork", requestId, path.id),
    ))
    .handle("getArtworkPreview", ({ path }) => getDesignArtworkPreview(path.id).pipe(
      Effect.map(({ bytes }) => bytes), Effect.mapError(mapDesignError),
      observeFailure("getArtworkPreview", requestId, path.id),
    )));

const makeProductApiLayer = (requestId: string) =>
  HttpApiBuilder.group(LegacyReadApi, "products", handlers => handlers
    .handle("getProduct", ({ path }) => getProduct(path.id).pipe(
      Effect.mapError(mapProductError), observeFailure("getProduct", requestId, path.id),
    ))
    .handle("getProductFamily", ({ path }) => getProductFamily(path.id).pipe(
      Effect.mapError(mapProductError), observeFailure("getProductFamily", requestId, path.id),
    )));

const makeHandler = (env: ApiEnv, requestId: string) =>
  HttpApiBuilder.toWebHandler(
    Layer.merge(
      HttpApiBuilder.api(LegacyReadApi).pipe(
        Layer.provide(
          Layer.mergeAll(
            makeDesignApiLayer(requestId),
            makeProductApiLayer(requestId),
            retiredLegacyRoutes,
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
    const { dispose, handler } = makeHandler(env, requestId);
    try {
      const response = await handler(request);
      const headers = new Headers(response.headers);
      if (response.status === 429) headers.set("Retry-After", "60");
      legacyCorsHeaders(origin, env.WEB_ORIGIN ?? "http://localhost:3000").forEach((value, key) => {
        headers.set(key, value);
      });
      // Every response from the legacy read/retirement router is revocable.
      headers.set("Cache-Control", "no-store");
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
