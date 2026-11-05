import {
  signCartLineCapability,
  signCartLineIntent,
  verifyCartLineIntent,
  type CartLineIntentPayload,
  verifyCartLineCapability,
  type CartLineCapabilityPayload,
} from "@forever-tee/contracts/cart-line-capability";

import {
  requireCartLineCapabilityConfig,
  type IntegrationEnv,
} from "./integration-config";
import {
  CATALOGUE_MAX_AGE_MS,
} from "./operational-controls";
import { isAuthenticatedServiceRequest } from "./service-auth";
import { VARIANT_MAPPING_MAX_AGE_MS } from "./variant-mapping-api";

export const CART_LINE_CAPABILITIES_PATH =
  "/v2/internal/cart-line-capabilities";
const CAPABILITY_LIFETIME_MS = 14 * 24 * 60 * 60 * 1_000;

interface CartLineCapabilityEnv extends IntegrationEnv {
  readonly DB: D1Database;
  readonly DESIGN_ARTWORK: Pick<R2Bucket, "head">;
  readonly FOREVER_TEE_API_SHARED_SECRET?: string;
}

interface CapabilityRow {
  readonly base_product_id: string;
  readonly catalogue_retrieved_at: number;
  readonly colour: "Black" | "Cream" | "White";
  readonly configured_product_id: string;
  readonly design_revision_id: string;
  readonly mapping_retrieved_at: number;
  readonly print_asset_byte_size: number | null;
  readonly print_asset_id: string | null;
  readonly print_asset_sha256: string | null;
  readonly print_asset_storage_key: string | null;
  readonly print_geometry_key: string;
  readonly printify_available: number;
  readonly printify_variant_id: number;
  readonly projection_version: "legacy-shirt-v1" | "safe-margin-v1";
  readonly shopify_available: number;
  readonly shopify_variant_id: string;
  readonly size: string;
  readonly variant_mapping_snapshot_id: string;
}

interface CapabilityRequest {
  readonly allowPending?: boolean;
  readonly capability?: string;
  readonly configuredProductId: string;
  readonly merchandiseId: string;
  readonly quantity: number;
}

export async function handleCartLineCapabilityRequest(
  request: Request,
  env: CartLineCapabilityEnv,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (url.pathname !== CART_LINE_CAPABILITIES_PATH) return undefined;
  if (request.method !== "POST") return methodNotAllowed();
  if (!(await isAuthenticatedServiceRequest(request, env))) {
    return apiError(401, "UNAUTHORIZED", "Service authentication is required.");
  }
  if (!request.headers.get("content-type")?.includes("application/json")) {
    return apiError(415, "UNSUPPORTED_MEDIA_TYPE", "Send a JSON request.");
  }
  const input = parseRequest(await request.json().catch(() => undefined));
  if (!input) {
    return apiError(400, "INVALID_REQUEST", "A product, variant, and quantity are required.");
  }
  let row: CapabilityRow | null;
  try {
    row = await readCapabilityRow(env.DB, input);
  } catch {
    return unavailable("Cart-line identity could not be verified.");
  }
  if (!row) {
    return apiError(409, "INVALID_CART_LINE", "This product and variant combination is unavailable.");
  }
  const now = Date.now();
  if (
    now - row.catalogue_retrieved_at > CATALOGUE_MAX_AGE_MS ||
    now - row.mapping_retrieved_at > VARIANT_MAPPING_MAX_AGE_MS
  ) {
    return unavailable("Product availability data is stale.");
  }
  if (row.shopify_available !== 1 || row.printify_available !== 1) {
    return apiError(409, "VARIANT_UNAVAILABLE", "That colour and size is unavailable.");
  }
  let secret: string;
  try {
    secret = requireCartLineCapabilityConfig(env).secret;
  } catch {
    return unavailable("Cart-line capability could not be issued.");
  }
  const identity: CartLineIntentPayload = {
    baseProductId: row.base_product_id, color: row.colour,
    configuredProductId: row.configured_product_id, designRevisionId: row.design_revision_id,
    expiresAt: now + CAPABILITY_LIFETIME_MS, issuedAt: now,
    printGeometryKey: row.print_geometry_key, printifyVariantId: row.printify_variant_id,
    projectionVersion: row.projection_version, quantity: input.quantity,
    shopifyVariantId: row.shopify_variant_id, size: row.size,
    variantMappingSnapshotId: row.variant_mapping_snapshot_id,
  };
  const isIntent = input.capability?.startsWith("i1.") === true;
  if (isIntent && input.capability) {
    const intent = await verifyCartLineIntent(input.capability, secret, now);
    if (!intent || !intentMatches(intent, row, input)) {
      return apiError(409, "INVALID_LINE_CAPABILITY", "This cart line could not be verified.");
    }
  }
  if (!row.print_asset_id || !row.print_asset_sha256 || !row.print_asset_storage_key || row.print_asset_byte_size === null) {
    if (input.allowPending && !input.capability) {
      try {
        return Response.json({ capability: await signCartLineIntent(identity, secret) }, { headers: { "Cache-Control": "no-store" } });
      } catch {
        return unavailable("Cart selection could not be verified.");
      }
    }
    return apiError(409, "PRINT_ASSETS_PENDING", "Your artwork is still being prepared. Checkout will be available shortly.");
  }
  try {
    const object = await env.DESIGN_ARTWORK.head(row.print_asset_storage_key);
    const checksum = object?.checksums.sha256;
    if (
      object?.size !== row.print_asset_byte_size || checksum === undefined ||
      bytesToHex(new Uint8Array(checksum)) !== row.print_asset_sha256
    ) {
      return unavailable("Print-ready artwork is unavailable.");
    }
    // R2 verification yields to other requests. Recheck the lifecycle before
    // returning a new capability or validating a previously issued cart line.
    const active = await env.DB.prepare("SELECT id FROM products WHERE id = ? AND status = 'active'").bind(input.configuredProductId).first();
    if (!active) return apiError(409, "INVALID_CART_LINE", "This product is unavailable.");
    if (input.capability && !isIntent) {
      const verified = await verifyCartLineCapability(
        input.capability,
        secret,
        now,
      );
      if (!verified || !capabilityMatches(verified, row, input)) {
        return apiError(
          409,
          "INVALID_LINE_CAPABILITY",
          "This cart line could not be verified.",
        );
      }
      return Response.json(
        { valid: true },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    const capability = await signCartLineCapability({
      baseProductId: row.base_product_id,
      color: row.colour,
      configuredProductId: row.configured_product_id,
      designRevisionId: row.design_revision_id,
      expiresAt: now + CAPABILITY_LIFETIME_MS,
      issuedAt: now,
      printAssetId: row.print_asset_id,
      printAssetSha256: row.print_asset_sha256,
      printGeometryKey: row.print_geometry_key,
      printifyVariantId: row.printify_variant_id,
      projectionVersion: row.projection_version,
      quantity: input.quantity,
      shopifyVariantId: row.shopify_variant_id,
      size: row.size,
      variantMappingSnapshotId: row.variant_mapping_snapshot_id,
      version: 1,
    }, secret);
    return Response.json(
      { capability, ...(isIntent ? { valid: true } : {}) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return unavailable("Cart-line capability could not be issued.");
  }
}

async function readCapabilityRow(
  db: D1Database,
  input: CapabilityRequest,
) {
  return db.prepare(`
    SELECT configured.id AS configured_product_id,
      configured.base_product_id, coalesce(configured.design_revision_id,
        CASE WHEN design.artwork_job_id IS NOT NULL AND design.finalized_at IS NOT NULL THEN design.id END) AS design_revision_id,
      configured.projection_version,
      mapping_snapshot.id AS variant_mapping_snapshot_id,
      mapping_snapshot.retrieved_at AS mapping_retrieved_at,
      mapping.shopify_variant_id, mapping.printify_variant_id,
      mapping.colour, mapping.size, mapping.shopify_available,
      catalogue.retrieved_at AS catalogue_retrieved_at,
      catalogue_variant.available AS printify_available,
      print_asset.id AS print_asset_id,
      lower(catalogue_variant.decoration_method) || ':' || catalogue_variant.print_width || 'x' || catalogue_variant.print_height AS print_geometry_key,
      coalesce(print_object.storage_key, print_asset.storage_key)
        AS print_asset_storage_key,
      print_asset.byte_size AS print_asset_byte_size,
      print_asset.sha256 AS print_asset_sha256
    FROM products AS configured
    JOIN designs AS design ON design.id = configured.design_id AND design.deleted_at IS NULL
      AND design.status IN ('processing', 'ready')
    JOIN products AS base
      ON base.id = configured.base_product_id
      AND base.status = 'active' AND base.design_id IS NULL
    JOIN shopify_variant_mapping_snapshots AS mapping_snapshot
      ON mapping_snapshot.id = (
        SELECT id FROM shopify_variant_mapping_snapshots
        WHERE base_product_id = configured.base_product_id
          AND shopify_product_handle = base.shopify_handle
        ORDER BY retrieved_at DESC, id DESC LIMIT 1
      )
    JOIN shopify_variant_mappings AS mapping
      ON mapping.snapshot_id = mapping_snapshot.id
      AND mapping.shopify_variant_id = ?
    JOIN printify_catalogue_snapshots AS catalogue
      ON catalogue.id = mapping_snapshot.catalogue_snapshot_id
      AND catalogue.base_product_id = configured.base_product_id
    JOIN printify_catalogue_variants AS catalogue_variant
      ON catalogue_variant.snapshot_id = catalogue.id
      AND catalogue_variant.printify_variant_id = mapping.printify_variant_id
      AND catalogue_variant.colour = mapping.colour
      AND catalogue_variant.size = mapping.size
    LEFT JOIN print_assets AS print_asset
      ON print_asset.configured_product_id = configured.id
      AND print_asset.design_revision_id = configured.design_revision_id
      AND print_asset.base_product_id = configured.base_product_id
      AND print_asset.projection_version = configured.projection_version
      AND print_asset.geometry_key = lower(catalogue_variant.decoration_method)
        || ':' || catalogue_variant.print_width || 'x'
        || catalogue_variant.print_height
      AND print_asset.status = 'ready'
    LEFT JOIN print_asset_objects AS print_object
      ON print_object.sha256 = print_asset.object_sha256
    WHERE configured.id = ? AND configured.status = 'active'
      AND configured.design_id IS NOT NULL
      AND (configured.design_revision_id IS NOT NULL OR (design.artwork_job_id IS NOT NULL AND design.finalized_at IS NOT NULL))
      AND mapping_snapshot.base_product_id = configured.base_product_id
      AND catalogue.base_product_id = configured.base_product_id
  `).bind(input.merchandiseId, input.configuredProductId)
    .first<CapabilityRow>();
}

function parseRequest(value: unknown): CapabilityRequest | undefined {
  if (!isRecord(value)) return undefined;
  const configuredProductId = value["configuredProductId"];
  const capability = value["capability"];
  const allowPending = value["allowPending"];
  const merchandiseId = value["merchandiseId"];
  const quantity = value["quantity"];
  if (
    (allowPending !== undefined && typeof allowPending !== "boolean") ||
    typeof configuredProductId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(configuredProductId) ||
    typeof merchandiseId !== "string" || merchandiseId.length < 1 ||
    merchandiseId.length > 256 || typeof quantity !== "number" ||
    !Number.isInteger(quantity) || quantity < 1 || quantity > 10 ||
    (capability !== undefined &&
      (typeof capability !== "string" || capability.length < 1 ||
        capability.length > 500))
  ) return undefined;
  return {
    ...(typeof allowPending === "boolean" ? { allowPending } : {}),
    ...(typeof capability === "string" ? { capability } : {}),
    configuredProductId,
    merchandiseId,
    quantity,
  };
}

function capabilityMatches(
  capability: CartLineCapabilityPayload,
  row: CapabilityRow,
  input: CapabilityRequest,
) {
  return capability.printAssetId === row.print_asset_id &&
    capability.printAssetSha256 === row.print_asset_sha256 &&
    intentMatches(capability, row, input);
}

function intentMatches(
  capability: CartLineIntentPayload, row: CapabilityRow, input: CapabilityRequest,
) {
  return capability.baseProductId === row.base_product_id &&
    capability.color === row.colour &&
    capability.configuredProductId === row.configured_product_id &&
    capability.designRevisionId === row.design_revision_id &&
    capability.printGeometryKey === row.print_geometry_key &&
    capability.printifyVariantId === row.printify_variant_id &&
    capability.projectionVersion === row.projection_version &&
    capability.quantity === input.quantity &&
    capability.shopifyVariantId === input.merchandiseId &&
    capability.shopifyVariantId === row.shopify_variant_id &&
    capability.size === row.size &&
    capability.variantMappingSnapshotId === row.variant_mapping_snapshot_id;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function unavailable(message: string) {
  return apiError(503, "DEPENDENCY_UNAVAILABLE", message);
}

function methodNotAllowed() {
  return apiError(405, "METHOD_NOT_ALLOWED", "Use POST.", { Allow: "POST" });
}

function apiError(
  status: number,
  code: string,
  message: string,
  headers?: HeadersInit,
) {
  return Response.json(
    { error: { code, message } },
    { ...(headers ? { headers } : {}), status },
  );
}
