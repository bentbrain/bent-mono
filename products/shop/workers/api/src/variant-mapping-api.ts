import { safeErrorDetails } from "@forever-tee/contracts/diagnostics";
import type { IntegrationEnv } from "./integration-config";
import { IntegrationConfigError } from "./integration-config";
import type { BaseProductSlug } from "@forever-tee/contracts";
import {
  baseProductSpecificationForHandle,
  LAUNCH_BASE_PRODUCTS,
  type LaunchProductColor,
} from "./base-product-specifications";
import {
  makeShopifyAdminClient,
  ShopifyAdminAuthenticationError,
  ShopifyAdminContractError,
  ShopifyAdminDependencyError,
  ShopifyAdminRateLimitError,
  type ShopifyBaseProduct,
} from "./shopify-admin-client";
import {
  CATALOGUE_MAX_AGE_MS,
  setAutomaticVariantMappingPause,
} from "./operational-controls";
import {
  isAuthenticatedOperationsRequest,
  isAuthenticatedServiceRequest,
} from "./service-auth";

export const VARIANT_MAPPING_PATH = "/v2/internal/variant-mapping";
export const VARIANT_MAPPING_REFRESH_PATH =
  "/v2/internal/operations/variant-mapping-refresh";
export const VARIANT_MAPPING_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

interface VariantMappingEnv extends IntegrationEnv {
  readonly DB: D1Database;
  readonly FOREVER_TEE_API_SHARED_SECRET?: string;
}

interface CatalogueSnapshotRow {
  base_product_slug: BaseProductSlug;
  id: string;
  retrieved_at: number;
  variant_count: number;
}

interface CatalogueVariantRow {
  available: number;
  colour: LaunchProductColor;
  printify_variant_id: number;
  size: string;
}

interface MappingSnapshotRow {
  base_product_slug: BaseProductSlug;
  id: string;
  retrieved_at: number;
  shopify_product_handle: string;
}

interface CurrentMappingRow {
  catalogue_retrieved_at: number;
  colour: LaunchProductColor;
  mapping_retrieved_at: number;
  printify_available: number;
  printify_variant_id: number;
  shopify_available: number;
  shopify_product_handle: string;
  shopify_variant_id: string;
  size: string;
  sku: string | null;
}

export async function handleVariantMappingRequest(
  request: Request,
  env: VariantMappingEnv,
  fetcher: typeof fetch = fetch,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (url.pathname === VARIANT_MAPPING_REFRESH_PATH) {
    if (request.method !== "POST") return methodNotAllowed("POST");
    if (!(await isAuthenticatedOperationsRequest(request, env))) {
      return apiError(401, "UNAUTHORIZED", "Operations authentication is required.");
    }
    return refreshVariantMapping(env, fetcher);
  }
  if (url.pathname !== VARIANT_MAPPING_PATH) return undefined;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return methodNotAllowed("GET, HEAD");
  }
  if (!(await isAuthenticatedServiceRequest(request, env))) {
    return apiError(401, "UNAUTHORIZED", "Service authentication is required.");
  }
  const merchandiseId = url.searchParams.get("merchandiseId")?.trim();
  const baseHandle = url.searchParams.get("baseHandle")?.trim();
  if (!merchandiseId || !baseHandle) {
    return apiError(
      400,
      "INVALID_REQUEST",
      "merchandiseId and baseHandle are required.",
    );
  }
  return readCurrentMapping(
    env.DB,
    merchandiseId,
    baseHandle,
    request.method === "HEAD",
  );
}

async function refreshVariantMapping(
  env: VariantMappingEnv,
  fetcher: typeof fetch,
) {
  try {
    const results = await refreshLaunchVariantMappings(env, fetcher);
    return Response.json(
      { products: results },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof IntegrationConfigError ||
        error instanceof ShopifyAdminAuthenticationError) {
      return apiError(
        503,
        "CONFIGURATION_ERROR",
        "Shopify Admin is not configured for variant mapping.",
      );
    }
    if (error instanceof ShopifyAdminContractError) {
      return apiError(502, "INVALID_DEPENDENCY_RESPONSE", error.message);
    }
    if (error instanceof ShopifyAdminRateLimitError ||
        error instanceof ShopifyAdminDependencyError) {
      return apiError(503, "DEPENDENCY_UNAVAILABLE", error.message);
    }
    if (error instanceof VariantMappingError) {
      return apiError(409, "INVALID_VARIANT_MAPPING", error.message);
    }
    return storageUnavailable();
  }
}

export async function runScheduledVariantMappingRefresh(
  env: VariantMappingEnv,
  fetcher: typeof fetch = fetch,
) {
  try {
    const results = await refreshLaunchVariantMappings(env, fetcher);
    console.info("bent.shop Shopify variant mapping refreshed", {
      products: results,
    });
  } catch (error) {
    console.error("bent.shop Shopify variant mapping refresh failed", {
      ...safeErrorDetails(error),
    });
  }
}

async function refreshLaunchVariantMappings(
  env: VariantMappingEnv,
  fetcher: typeof fetch,
) {
  let client: ReturnType<typeof makeShopifyAdminClient>;
  try {
    client = makeShopifyAdminClient(env, fetcher);
  } catch (error) {
    for (const specification of LAUNCH_BASE_PRODUCTS) {
      await setAutomaticVariantMappingPause(
        env.DB,
        true,
        `Shopify ${specification.slug} variant mapping refresh failed.`,
        specification.slug,
      );
    }
    await setAutomaticVariantMappingPause(
      env.DB,
      false,
      "Legacy variant mapping pause superseded by product-aware controls.",
    );
    throw error;
  }
  const results: Awaited<ReturnType<typeof persistVariantMapping>>[] = [];
  let firstError: Error | undefined;
  for (const specification of LAUNCH_BASE_PRODUCTS) {
    try {
      const product = await client.loadBaseProductForSlug(specification.slug);
      results.push(await persistVariantMapping(env.DB, product));
      await setAutomaticVariantMappingPause(
        env.DB,
        false,
        `Shopify ${specification.slug} variant mapping refresh succeeded.`,
        specification.slug,
      );
    } catch (error) {
      await setAutomaticVariantMappingPause(
        env.DB,
        true,
        `Shopify ${specification.slug} variant mapping refresh failed.`,
        specification.slug,
      );
      firstError ??= error instanceof Error
        ? error
        : new Error("Shopify variant mapping refresh failed.");
    }
  }
  await setAutomaticVariantMappingPause(
    env.DB,
    false,
    "Legacy variant mapping pause superseded by product-aware controls.",
  );
  if (firstError !== undefined) throw firstError;
  return results;
}

class VariantMappingError extends Error {}

async function persistVariantMapping(
  db: D1Database,
  product: ShopifyBaseProduct,
) {
  const catalogue = await latestCatalogue(db, product.baseProductSlug);
  const catalogueVariants = await db.prepare(`
    SELECT printify_variant_id, colour, size, available
    FROM printify_catalogue_variants
    WHERE snapshot_id = ?
  `).bind(catalogue.id).all<CatalogueVariantRow>();
  if (catalogueVariants.results.length !== catalogue.variant_count) {
    throw new VariantMappingError("The latest Printify snapshot is incomplete.");
  }
  const printifyByCombination = new Map(
    catalogueVariants.results.map((variant) => [
      combinationKey(variant.colour, variant.size),
      variant,
    ]),
  );
  if (product.variants.length !== printifyByCombination.size) {
    throw new VariantMappingError(
      "Shopify and Printify expose different variant counts.",
    );
  }
  const mappings = product.variants.map((variant) => {
    const printify = printifyByCombination.get(
      combinationKey(variant.color, variant.size),
    );
    if (!printify) {
      throw new VariantMappingError(
        `Shopify variant ${variant.color} / ${variant.size} has no Printify match.`,
      );
    }
    return { printify, shopify: variant };
  });
  const snapshotId = crypto.randomUUID();
  const retrievedAt = Date.now();
  await db.batch([
    db.prepare(`
      INSERT INTO shopify_variant_mapping_snapshots (
        id, catalogue_snapshot_id, base_product_id, base_product_slug,
        shopify_product_id, shopify_product_handle, shopify_product_title,
        retrieved_at, source_url, variant_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      snapshotId,
      catalogue.id,
      product.baseProductId,
      product.baseProductSlug,
      product.id,
      product.handle,
      product.title,
      retrievedAt,
      product.sourceUrl,
      mappings.length,
    ),
    ...mappings.map(({ printify, shopify }) => db.prepare(`
      INSERT INTO shopify_variant_mappings (
        snapshot_id, shopify_variant_id, printify_variant_id,
        colour, size, sku, shopify_available
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      snapshotId,
      shopify.id,
      printify.printify_variant_id,
      shopify.color,
      shopify.size,
      shopify.sku,
      shopify.availableForSale ? 1 : 0,
    )),
  ]);
  return {
    baseProductId: product.baseProductId,
    baseProductSlug: product.baseProductSlug,
    catalogueSnapshotId: catalogue.id,
    retrievedAt: new Date(retrievedAt).toISOString(),
    snapshotId,
    variantCount: mappings.length,
  };
}

async function latestCatalogue(
  db: D1Database,
  baseProductSlug: BaseProductSlug,
) {
  const catalogue = await db.prepare(`
    SELECT id, base_product_slug, retrieved_at, variant_count
    FROM printify_catalogue_snapshots
    WHERE base_product_slug = ?
    ORDER BY retrieved_at DESC, id DESC
    LIMIT 1
  `).bind(baseProductSlug).first<CatalogueSnapshotRow>();
  if (!catalogue) {
    throw new VariantMappingError("No Printify catalogue snapshot is available.");
  }
  return catalogue;
}

async function readCurrentMapping(
  db: D1Database,
  merchandiseId: string,
  baseHandle: string,
  head: boolean,
) {
  const specification = baseProductSpecificationForHandle(baseHandle);
  if (!specification) {
    return apiError(404, "NOT_FOUND", "Variant mapping was not found.");
  }
  let snapshot: MappingSnapshotRow | null;
  try {
    snapshot = await db.prepare(`
      SELECT id, base_product_slug, shopify_product_handle, retrieved_at
      FROM shopify_variant_mapping_snapshots
      WHERE base_product_slug = ? AND shopify_product_handle = ?
      ORDER BY retrieved_at DESC, id DESC
      LIMIT 1
    `).bind(specification.slug, baseHandle).first<MappingSnapshotRow>();
  } catch {
    return storageUnavailable();
  }
  if (!snapshot || Date.now() - snapshot.retrieved_at >
      VARIANT_MAPPING_MAX_AGE_MS) {
    return apiError(503, "STALE_VARIANT_MAPPING", "Variant mapping is stale.");
  }
  let mapping: CurrentMappingRow | null;
  try {
    mapping = await db.prepare(`
      SELECT m.shopify_variant_id, m.printify_variant_id, m.colour, m.size,
             m.sku, m.shopify_available,
             ms.shopify_product_handle, ms.retrieved_at AS mapping_retrieved_at,
             cv.available AS printify_available,
             cs.retrieved_at AS catalogue_retrieved_at
      FROM shopify_variant_mappings m
      JOIN shopify_variant_mapping_snapshots ms ON ms.id = m.snapshot_id
      JOIN printify_catalogue_snapshots cs
        ON cs.id = ms.catalogue_snapshot_id
       AND cs.base_product_slug = ms.base_product_slug
      JOIN printify_catalogue_variants cv
        ON cv.snapshot_id = cs.id
       AND cv.colour = m.colour
       AND cv.size = m.size
       AND cv.printify_variant_id = m.printify_variant_id
      WHERE m.snapshot_id = ? AND m.shopify_variant_id = ?
        AND ms.base_product_slug = cs.base_product_slug
    `).bind(snapshot.id, merchandiseId).first<CurrentMappingRow>();
  } catch {
    return storageUnavailable();
  }
  if (!mapping) {
    return apiError(404, "NOT_FOUND", "Variant mapping was not found.");
  }
  if (Date.now() - mapping.catalogue_retrieved_at > CATALOGUE_MAX_AGE_MS) {
    return apiError(503, "STALE_CATALOGUE", "Printify catalogue is stale.");
  }
  return head
    ? new Response(null, { status: 200 })
    : Response.json({
        available: mapping.shopify_available === 1 &&
          mapping.printify_available === 1,
        baseProductId: specification.baseProductId,
        baseProductSlug: specification.slug,
        catalogueRetrievedAt: new Date(
          mapping.catalogue_retrieved_at,
        ).toISOString(),
        color: mapping.colour,
        mappingRetrievedAt: new Date(
          mapping.mapping_retrieved_at,
        ).toISOString(),
        printifyVariantId: mapping.printify_variant_id,
        shopifyVariantId: mapping.shopify_variant_id,
        size: mapping.size,
        sku: mapping.sku,
      }, { headers: { "Cache-Control": "no-store" } });
}

function combinationKey(color: string, size: string) {
  return `${color.trim().toLocaleLowerCase("en-AU")}\u0000${size.trim().toLocaleLowerCase("en-AU")}`;
}

function storageUnavailable() {
  return apiError(
    503,
    "DEPENDENCY_UNAVAILABLE",
    "Variant mapping storage is unavailable.",
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
