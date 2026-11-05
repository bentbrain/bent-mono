import { safeErrorDetails } from "@forever-tee/contracts/diagnostics";
import type { IntegrationEnv } from "./integration-config";
import { IntegrationConfigError } from "./integration-config";
import { LAUNCH_BASE_PRODUCTS } from "./base-product-specifications";
import {
  makePrintifyClient,
  baseProductPrintGeometries,
  PrintifyAuthenticationError,
  PrintifyContractError,
  PrintifyRateLimitError,
  type BaseProductCatalogue,
} from "./printify-client";
import type { BaseProductSlug } from "@forever-tee/contracts";
import { setAutomaticCataloguePause } from "./operational-controls";
import {
  isAuthenticatedOperationsRequest,
  isAuthenticatedServiceRequest,
} from "./service-auth";

export const CATALOGUE_PATH = "/v2/internal/catalogue";
export const CATALOGUE_REFRESH_PATH =
  "/v2/internal/operations/catalogue-refresh";

interface CatalogueEnv extends IntegrationEnv {
  readonly DB: D1Database;
  readonly FOREVER_TEE_API_SHARED_SECRET?: string;
}

interface SnapshotRow {
  base_product_id: string;
  base_product_slug: BaseProductSlug;
  blueprint_id: number;
  id: string;
  print_provider_id: number;
  retrieved_at: number;
  source_urls_json: string;
  variant_count: number;
}

interface VariantRow {
  available: number;
  colour: "Black" | "Cream" | "White";
  decoration_method: string;
  handling_days_from: number;
  handling_days_to: number;
  print_height: number;
  print_width: number;
  printify_variant_id: number;
  shipping_additional_item: number;
  shipping_currency: string;
  shipping_first_item: number;
  size: string;
}

export async function handleCatalogueRequest(
  request: Request,
  env: CatalogueEnv,
  fetcher: typeof fetch = fetch,
): Promise<Response | undefined> {
  const path = new URL(request.url).pathname;
  if (path === CATALOGUE_REFRESH_PATH) {
    if (request.method !== "POST") return methodNotAllowed("POST");
    if (!(await isAuthenticatedOperationsRequest(request, env))) {
      return apiError(
        401,
        "UNAUTHORIZED",
        "Operations authentication is required.",
      );
    }
    return refreshCatalogue(env, fetcher);
  }
  if (path !== CATALOGUE_PATH) return undefined;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return methodNotAllowed("GET, HEAD");
  }
  if (!(await isAuthenticatedServiceRequest(request, env))) {
    return apiError(401, "UNAUTHORIZED", "Service authentication is required.");
  }
  const requestedSlug = new URL(request.url).searchParams.get("baseProduct");
  const baseProductSlug = parseBaseProductSlug(requestedSlug ?? "staple-tee");
  if (!baseProductSlug) {
    return apiError(400, "INVALID_REQUEST", "baseProduct is invalid.");
  }
  return readLatestCatalogue(
    env.DB,
    baseProductSlug,
    request.method === "HEAD",
  );
}

async function persistCatalogueSnapshot(
  db: D1Database,
  catalogue: BaseProductCatalogue,
) {
  const snapshotId = crypto.randomUUID();
  const retrievedAt = Date.parse(catalogue.retrievedAt);
  if (!Number.isSafeInteger(retrievedAt)) {
    throw new Error("Catalogue retrieval time is invalid.");
  }
  const statements = [
    db.prepare(`
      INSERT INTO printify_catalogue_snapshots (
        id, shop_id, base_product_id, base_product_slug, blueprint_id,
        print_provider_id, retrieved_at, source_urls_json, variant_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      snapshotId,
      String(catalogue.shop.id),
      catalogue.baseProductId,
      catalogue.baseProductSlug,
      catalogue.blueprintId,
      catalogue.printProviderId,
      retrievedAt,
      JSON.stringify(catalogue.sourceUrls),
      catalogue.variants.length,
    ),
    ...catalogue.variants.map((variant) => db.prepare(`
      INSERT INTO printify_catalogue_variants (
        snapshot_id, printify_variant_id, colour, size, available,
        decoration_method, print_width, print_height, shipping_first_item,
        shipping_additional_item, shipping_currency, handling_days_from,
        handling_days_to
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      snapshotId,
      variant.id,
      variant.color,
      variant.size,
      variant.available ? 1 : 0,
      variant.decorationMethod,
      variant.printWidth,
      variant.printHeight,
      variant.standardShippingToAustralia.firstItem.amount,
      variant.standardShippingToAustralia.additionalItems.amount,
      variant.standardShippingToAustralia.firstItem.currency,
      variant.standardShippingToAustralia.handlingDaysFrom,
      variant.standardShippingToAustralia.handlingDaysTo,
    )),
  ];
  await db.batch(statements);
  return snapshotId;
}

async function refreshCatalogueSnapshot(
  env: CatalogueEnv,
  fetcher: typeof fetch = fetch,
) {
  let client: ReturnType<typeof makePrintifyClient>;
  try {
    client = makePrintifyClient(env, fetcher);
  } catch (error) {
    for (const specification of LAUNCH_BASE_PRODUCTS) {
      await setAutomaticCataloguePause(
        env.DB,
        true,
        `Printify ${specification.slug} catalogue refresh failed.`,
        specification.slug,
      );
    }
    await setAutomaticCataloguePause(
      env.DB,
      false,
      "Legacy catalogue pause superseded by product-aware controls.",
    );
    throw error;
  }
  const snapshots: {
    catalogue: BaseProductCatalogue;
    snapshotId: string;
  }[] = [];
  let firstError: Error | undefined;
  for (const specification of LAUNCH_BASE_PRODUCTS) {
    try {
      const catalogue = await client.loadBaseProductCatalogue(
        specification.slug,
      );
      const snapshotId = await persistCatalogueSnapshot(env.DB, catalogue);
      snapshots.push({ catalogue, snapshotId });
      await setAutomaticCataloguePause(
        env.DB,
        false,
        `Printify ${specification.slug} catalogue refresh succeeded.`,
        specification.slug,
      );
    } catch (error) {
      await setAutomaticCataloguePause(
        env.DB,
        true,
        `Printify ${specification.slug} catalogue refresh failed.`,
        specification.slug,
      );
      firstError ??= error instanceof Error
        ? error
        : new Error("Printify catalogue refresh failed.");
    }
  }
  await setAutomaticCataloguePause(
    env.DB,
    false,
    "Legacy catalogue pause superseded by product-aware controls.",
  );
  if (firstError !== undefined) throw firstError;
  return snapshots;
}

export async function runScheduledCatalogueRefresh(
  env: CatalogueEnv,
  fetcher: typeof fetch = fetch,
) {
  try {
    await refreshCatalogueSnapshot(env, fetcher);
  } catch (error) {
    console.error("bent.shop catalogue refresh failed", {
      ...safeErrorDetails(error),
    });
  }
}

async function refreshCatalogue(env: CatalogueEnv, fetcher: typeof fetch) {
  try {
    const snapshots = await refreshCatalogueSnapshot(
      env,
      fetcher,
    );
    return Response.json({
      products: snapshots.map(({ catalogue, snapshotId }) => ({
        availableVariantCount: catalogue.variants.filter(
          ({ available }) => available,
        ).length,
        baseProductId: catalogue.baseProductId,
        baseProductSlug: catalogue.baseProductSlug,
        retrievedAt: catalogue.retrievedAt,
        snapshotId,
        variantCount: catalogue.variants.length,
      })),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof IntegrationConfigError) {
      return apiError(503, "CONFIGURATION_ERROR", error.message);
    }
    if (error instanceof PrintifyAuthenticationError) {
      return apiError(
        503,
        "CONFIGURATION_ERROR",
        "Printify authentication failed.",
      );
    }
    if (error instanceof PrintifyRateLimitError) {
      const headers = error.retryAfterSeconds === undefined
        ? undefined
        : { "Retry-After": String(error.retryAfterSeconds) };
      return apiError(
        503,
        "DEPENDENCY_UNAVAILABLE",
        "Printify rate limited the catalogue refresh.",
        headers,
      );
    }
    if (error instanceof PrintifyContractError) {
      return apiError(502, "INVALID_DEPENDENCY_RESPONSE", error.message);
    }
    return apiError(
      503,
      "DEPENDENCY_UNAVAILABLE",
      "The Printify catalogue could not be refreshed.",
    );
  }
}

async function readLatestCatalogue(
  db: D1Database,
  baseProductSlug: BaseProductSlug,
  head: boolean,
) {
  let snapshot: SnapshotRow | null;
  try {
    snapshot = await db.prepare(`
      SELECT id, base_product_id, base_product_slug, blueprint_id,
             print_provider_id, retrieved_at, source_urls_json, variant_count
      FROM printify_catalogue_snapshots
      WHERE base_product_slug = ?
      ORDER BY retrieved_at DESC, id DESC
      LIMIT 1
    `).bind(baseProductSlug).first<SnapshotRow>();
  } catch {
    return storageUnavailable();
  }
  if (!snapshot) {
    return apiError(404, "NOT_FOUND", "No catalogue snapshot is available.");
  }
  if (head) return new Response(null, { status: 200 });

  let variants: D1Result<VariantRow>;
  try {
    variants = await db.prepare(`
      SELECT printify_variant_id, colour, size, available,
             decoration_method, print_width, print_height,
             shipping_first_item, shipping_additional_item,
             shipping_currency, handling_days_from, handling_days_to
      FROM printify_catalogue_variants
      WHERE snapshot_id = ?
      ORDER BY colour, size, printify_variant_id
    `).bind(snapshot.id).all<VariantRow>();
  } catch {
    return storageUnavailable();
  }
  if (variants.results.length !== snapshot.variant_count) {
    return storageUnavailable();
  }
  const sourceUrls = parseSourceUrls(snapshot.source_urls_json);
  if (!sourceUrls) return storageUnavailable();
  const catalogueVariants = variants.results.map((variant) => ({
    available: variant.available === 1,
    color: variant.colour,
    decorationMethod: variant.decoration_method,
    id: variant.printify_variant_id,
    printHeight: variant.print_height,
    printWidth: variant.print_width,
    size: variant.size,
    standardShippingToAustralia: {
      additionalItems: {
        amount: variant.shipping_additional_item,
        currency: variant.shipping_currency,
      },
      firstItem: {
        amount: variant.shipping_first_item,
        currency: variant.shipping_currency,
      },
      handlingDaysFrom: variant.handling_days_from,
      handlingDaysTo: variant.handling_days_to,
    },
  }));
  return Response.json({
    baseProductId: snapshot.base_product_id,
    baseProductSlug: snapshot.base_product_slug,
    blueprintId: snapshot.blueprint_id,
    printProviderId: snapshot.print_provider_id,
    printGeometries: baseProductPrintGeometries(
      catalogueVariants,
      snapshot.base_product_slug,
    ),
    retrievedAt: new Date(snapshot.retrieved_at).toISOString(),
    snapshotId: snapshot.id,
    sourceUrls,
    variants: catalogueVariants,
  }, { headers: { "Cache-Control": "no-store" } });
}

function parseBaseProductSlug(value: string): BaseProductSlug | undefined {
  if (value === "staple-tee" || value === "cotton-tote") return value;
  return undefined;
}

function parseSourceUrls(value: string) {
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.every((url) => typeof url === "string")) {
      return parsed;
    }
  } catch {
    // The response below deliberately fails closed on corrupt provenance.
  }
  return undefined;
}

function storageUnavailable() {
  return apiError(
    503,
    "DEPENDENCY_UNAVAILABLE",
    "Catalogue storage is unavailable.",
  );
}

function methodNotAllowed(allow: string) {
  return apiError(405, "METHOD_NOT_ALLOWED", "Method not allowed.", {
    Allow: allow,
  });
}

function apiError(
  status: number,
  code: string,
  message: string,
  headers?: HeadersInit,
) {
  return Response.json(
    { error: { code, message } },
    headers ? { headers, status } : { status },
  );
}
