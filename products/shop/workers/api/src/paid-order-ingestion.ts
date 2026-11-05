import {
  verifyCartLineCapability,
  type CartLineCapabilityPayload,
} from "@forever-tee/contracts/cart-line-capability";

import {
  requireCartLineCapabilityConfig,
  type IntegrationEnv,
} from "./integration-config";

import { makeShopifyAdminClient } from "./shopify-admin-client";
import { recordPersonalDataAccess } from "./personal-data-audit";

const ORDER_CAPABILITY_ATTRIBUTE = "_orderManagementCapability";
const LINE_CAPABILITY_ATTRIBUTE = "_lineCapability";
const PRODUCTION_HOLD_MS = 60 * 60 * 1_000;
const MAX_ORDER_LINES = 250;
const MAX_ORDER_QUANTITY = 10;

interface PaidOrderEnv extends IntegrationEnv {
  readonly DB: D1Database;
  readonly DESIGN_ARTWORK: R2Bucket;
}

interface OrderCore {
  readonly cartToken?: string;
  readonly currencyCode: string;
  readonly lineItems: readonly unknown[];
  readonly orderCapability?: string;
  readonly shopifyOrderId: string;
  readonly shopifyOrderName: string;
  readonly totalMinorUnits: number;
}

interface VerifiedLine {
  readonly capability: CartLineCapabilityPayload;
  readonly lineCapabilitySha256: string;
  readonly linePosition: number;
  readonly quantity: number;
  readonly shopifyLineItemId: string;
}

interface OrderValidation {
  readonly capabilityHash?: string;
  readonly exception?: { readonly code: string; readonly summary: string };
  readonly lines: readonly VerifiedLine[];
}

interface ExistingOrder {
  readonly id: string;
  readonly source_payload_sha256: string;
}

interface PrintAssetIdentity {
  readonly byte_size: number;
  readonly sha256: string;
  readonly storage_key: string;
}

class PaidOrderPayloadError extends Error {}

export async function ingestPaidShopifyOrder(
  env: PaidOrderEnv,
  payload: Record<string, unknown>,
  payloadSha256: string,
  now: number,
  fetcher: typeof fetch = fetch,
) {
  const core = parseOrderCore(payload);
  const existing = await readExistingOrder(env.DB, core.shopifyOrderId);
  if (existing) {
    await reconcileExistingOrder(env.DB, existing, payloadSha256, now);
    return;
  }

  const validation = await validateOrder(env, core, now);
  const deadline = validation.capabilityHash
    ? await makeShopifyAdminClient(env, fetcher).loadPaidOrderDeadline(core.shopifyOrderId, now)
    : now + PRODUCTION_HOLD_MS;
  if (validation.capabilityHash) await recordPersonalDataAccess(env.DB, {
    action: "read", actor: "system:shopify-webhook", purpose: "paid-order-ingestion", subject: core.shopifyOrderId,
  }, now);
  // A paid order exists from payment, even if its webhook arrives after the
  // correction window. Keep the verified deadline and the database ordering
  // invariant; webhook receipt time remains in the inbox and access audit.
  const createdAt = validation.capabilityHash
    ? Math.min(now, deadline - PRODUCTION_HOLD_MS)
    : now;
  const orderId = crypto.randomUUID();
  const status = "exception_review";
  const statements: D1PreparedStatement[] = [];
  if (validation.capabilityHash) {
    statements.push(env.DB.prepare(`
      UPDATE order_management_capabilities
      SET bound_at = ?
      WHERE token_hash = ? AND bound_at IS NULL AND revoked_at IS NULL
    `).bind(now, validation.capabilityHash));
  }
  statements.push(env.DB.prepare(`
    INSERT INTO paid_orders (
      id, shopify_order_id, shopify_order_name, source_payload_sha256,
      order_management_capability_hash, currency_code, total_minor_units,
      status, fraud_result, address_validation_result,
      production_hold_expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'pending', ?, ?, ?)
  `).bind(
    orderId,
    core.shopifyOrderId,
    core.shopifyOrderName,
    payloadSha256,
    validation.capabilityHash ?? null,
    core.currencyCode,
    core.totalMinorUnits,
    status,
    deadline,
    createdAt,
    now,
  ));
  for (const line of validation.lines) {
    statements.push(insertLine(env.DB, orderId, line, now));
  }
  const exception = validation.exception ?? {
    code: "VALIDATION_PENDING",
    summary: "Fraud and address validation must complete before production.",
  };
  statements.push(insertException(env.DB, orderId, exception, now));

  try {
    await env.DB.batch(statements);
  } catch (error) {
    const raced = await readExistingOrder(env.DB, core.shopifyOrderId);
    if (!raced) throw error;
    await reconcileExistingOrder(env.DB, raced, payloadSha256, now);
  }
}

async function validateOrder(
  env: PaidOrderEnv,
  core: OrderCore,
  now: number,
): Promise<OrderValidation> {
  const orderIdentity = await validateOrderCapability(env.DB, core, now);
  if (!orderIdentity.capabilityHash) {
    return {
      ...(orderIdentity.exception
        ? { exception: orderIdentity.exception }
        : {}),
      lines: [],
    };
  }

  let secret: string;
  try {
    secret = requireCartLineCapabilityConfig(env).secret;
  } catch (error) {
    throw error;
  }
  const verifiedLines: VerifiedLine[] = [];
  let totalQuantity = 0;
  const lineItemIds = new Set<string>();
  for (let index = 0; index < core.lineItems.length; index += 1) {
    const parsed = parseLineItem(core.lineItems[index], index + 1);
    if (!parsed || lineItemIds.has(parsed.shopifyLineItemId)) {
      return invalidLineOrder(orderIdentity.capabilityHash);
    }
    lineItemIds.add(parsed.shopifyLineItemId);
    totalQuantity += parsed.quantity;
    if (totalQuantity > MAX_ORDER_QUANTITY) {
      return {
        capabilityHash: orderIdentity.capabilityHash,
        exception: {
          code: "ORDER_QUANTITY_INVALID",
          summary: "The paid order exceeds the supported production quantity.",
        },
        lines: [],
      };
    }
    const capability = await verifyCartLineCapability(
      parsed.capability,
      secret,
      now,
    );
    if (!capability) return invalidLineOrder(orderIdentity.capabilityHash);
    if (
      capability.quantity !== parsed.quantity ||
      capability.shopifyVariantId !== parsed.shopifyVariantId ||
      !(await capabilityIdentityExists(env, capability))
    ) {
      return invalidLineOrder(orderIdentity.capabilityHash);
    }
    verifiedLines.push({
      capability,
      lineCapabilitySha256: await sha256Hex(parsed.capability),
      linePosition: parsed.linePosition,
      quantity: parsed.quantity,
      shopifyLineItemId: parsed.shopifyLineItemId,
    });
  }
  return { capabilityHash: orderIdentity.capabilityHash, lines: verifiedLines };
}

async function validateOrderCapability(
  db: D1Database,
  core: OrderCore,
  now: number,
) {
  if (!core.orderCapability || !core.cartToken) {
    return {
      exception: {
        code: "ORDER_CAPABILITY_MISSING",
        summary: "The paid order is missing its checkout identity.",
      },
    };
  }
  if (!/^[A-Za-z0-9_-]{43}$/u.test(core.orderCapability)) {
    return {
      exception: {
        code: "ORDER_CAPABILITY_INVALID",
        summary: "The paid order checkout identity is invalid.",
      },
    };
  }
  const capabilityHash = await sha256Hex(core.orderCapability);
  const stored = await db.prepare(`
    SELECT shopify_cart_id, expires_at, bound_at, revoked_at
    FROM order_management_capabilities
    WHERE token_hash = ?
  `).bind(capabilityHash).first<{
    shopify_cart_id: string;
    expires_at: number;
    bound_at: number | null;
    revoked_at: number | null;
  }>();
  if (
    !stored || stored.expires_at <= now || stored.bound_at !== null ||
    stored.revoked_at !== null || cartTokenFromId(stored.shopify_cart_id) !== core.cartToken
  ) {
    return {
      exception: {
        code: "ORDER_CAPABILITY_INVALID",
        summary: "The paid order checkout identity could not be verified.",
      },
    };
  }
  return { capabilityHash };
}

function invalidLineOrder(capabilityHash: string): OrderValidation {
  return {
    capabilityHash,
    exception: {
      code: "LINE_IDENTITY_INVALID",
      summary: "One or more paid order lines failed production identity verification.",
    },
    lines: [],
  };
}

async function capabilityIdentityExists(
  env: PaidOrderEnv,
  capability: CartLineCapabilityPayload,
) {
  const row = await env.DB.prepare(`
    SELECT coalesce(object.storage_key, asset.storage_key) AS storage_key,
      asset.byte_size, asset.sha256
    FROM products AS configured
    JOIN products AS base
      ON base.id = configured.base_product_id
      AND base.id = ? AND base.status = 'active' AND base.design_id IS NULL
    JOIN print_assets AS asset
      ON asset.id = ?
      AND asset.configured_product_id = configured.id
      AND asset.design_revision_id = configured.design_revision_id
      AND asset.base_product_id = configured.base_product_id
      AND asset.projection_version = configured.projection_version
      AND asset.geometry_key = ?
      AND asset.sha256 = ?
      AND asset.status = 'ready'
    LEFT JOIN print_asset_objects AS object
      ON object.sha256 = asset.object_sha256
    JOIN shopify_variant_mapping_snapshots AS snapshot
      ON snapshot.id = ? AND snapshot.base_product_id = configured.base_product_id
    JOIN shopify_variant_mappings AS mapping
      ON mapping.snapshot_id = snapshot.id
      AND mapping.shopify_variant_id = ?
      AND mapping.printify_variant_id = ?
      AND mapping.colour = ? AND mapping.size = ?
    WHERE configured.id = ? AND configured.status = 'active'
      AND configured.design_id IS NOT NULL
      AND configured.design_revision_id = ?
      AND configured.projection_version = ?
  `).bind(
    capability.baseProductId,
    capability.printAssetId,
    capability.printGeometryKey,
    capability.printAssetSha256,
    capability.variantMappingSnapshotId,
    capability.shopifyVariantId,
    capability.printifyVariantId,
    capability.color,
    capability.size,
    capability.configuredProductId,
    capability.designRevisionId,
    capability.projectionVersion,
  ).first<PrintAssetIdentity>();
  if (!row) return false;
  const object = await env.DESIGN_ARTWORK.head(row.storage_key);
  const checksum = object?.checksums.sha256;
  return object?.size === row.byte_size && checksum !== undefined &&
    bytesToHex(new Uint8Array(checksum)) === row.sha256;
}

function parseOrderCore(payload: Record<string, unknown>): OrderCore {
  const shopifyOrderId = payload["admin_graphql_api_id"];
  const shopifyOrderName = payload["name"];
  const currencyCode = payload["currency"];
  const total = payload["current_total_price"];
  const lineItems = payload["line_items"];
  if (
    typeof shopifyOrderId !== "string" ||
    !/^gid:\/\/shopify\/Order\/[0-9]+$/u.test(shopifyOrderId) ||
    typeof shopifyOrderName !== "string" || shopifyOrderName.length < 1 ||
    shopifyOrderName.length > 128 || typeof currencyCode !== "string" ||
    !/^[A-Z]{3}$/u.test(currencyCode) || typeof total !== "string" ||
    !Array.isArray(lineItems) || lineItems.length < 1 ||
    lineItems.length > MAX_ORDER_LINES
  ) throw new PaidOrderPayloadError("Paid order identity is invalid.");
  const totalMinorUnits = moneyToMinorUnits(total, currencyCode);
  if (totalMinorUnits === undefined) {
    throw new PaidOrderPayloadError("Paid order total is invalid.");
  }
  const cartToken = payload["cart_token"];
  const orderCapability = singleNamedValue(
    payload["note_attributes"],
    ORDER_CAPABILITY_ATTRIBUTE,
    128,
  );
  return {
    ...(typeof cartToken === "string" && cartToken.length <= 512
      ? { cartToken }
      : {}),
    currencyCode,
    lineItems: lineItems.map((lineItem: unknown) => lineItem),
    ...(orderCapability ? { orderCapability } : {}),
    shopifyOrderId,
    shopifyOrderName,
    totalMinorUnits,
  };
}

function parseLineItem(value: unknown, linePosition: number) {
  if (!isRecord(value)) return undefined;
  const shopifyLineItemId = value["admin_graphql_api_id"];
  const quantity = value["quantity"];
  const variantId = numericIdentifier(value["variant_id"]);
  const capability = singleNamedValue(
    value["properties"],
    LINE_CAPABILITY_ATTRIBUTE,
    500,
  );
  if (
    typeof shopifyLineItemId !== "string" ||
    !/^gid:\/\/shopify\/LineItem\/[0-9]+$/u.test(shopifyLineItemId) ||
    typeof quantity !== "number" || !Number.isInteger(quantity) ||
    quantity < 1 || quantity > MAX_ORDER_QUANTITY || !variantId || !capability
  ) return undefined;
  return {
    capability,
    linePosition,
    quantity,
    shopifyLineItemId,
    shopifyVariantId: `gid://shopify/ProductVariant/${variantId}`,
  };
}

function numericIdentifier(value: unknown) {
  if (
    typeof value === "number" && Number.isSafeInteger(value) && value > 0
  ) return String(value);
  if (typeof value === "string" && /^[1-9][0-9]{0,15}$/u.test(value)) {
    const numeric = Number(value);
    return Number.isSafeInteger(numeric) ? value : undefined;
  }
  return undefined;
}

function singleNamedValue(value: unknown, name: string, maxLength: number) {
  if (!Array.isArray(value)) return undefined;
  const matches = value.flatMap((item: unknown) =>
    isRecord(item) && item["name"] === name && typeof item["value"] === "string"
      ? [item]
      : []
  );
  if (matches.length !== 1) return undefined;
  const selected = matches[0];
  if (!selected || !isRecord(selected)) return undefined;
  const selectedValue = selected["value"];
  return typeof selectedValue === "string" && selectedValue.length >= 1 &&
      selectedValue.length <= maxLength
    ? selectedValue
    : undefined;
}

function moneyToMinorUnits(value: string, currencyCode: string) {
  let exponent: number;
  try {
    const resolvedExponent = new Intl.NumberFormat("en", {
      currency: currencyCode,
      style: "currency",
    }).resolvedOptions().maximumFractionDigits;
    if (resolvedExponent === undefined) return undefined;
    exponent = resolvedExponent;
  } catch {
    return undefined;
  }
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/u.exec(value);
  if (!match) return undefined;
  const whole = match[1];
  const fraction = match[2] ?? "";
  if (!whole || fraction.length > exponent) return undefined;
  const combined = `${whole}${fraction.padEnd(exponent, "0")}`;
  const minor = Number(combined);
  return Number.isSafeInteger(minor) ? minor : undefined;
}

function cartTokenFromId(shopifyCartId: string) {
  const match = /^gid:\/\/shopify\/Cart\/([^?]+)(?:\?.*)?$/u.exec(shopifyCartId);
  return match?.[1];
}

async function readExistingOrder(db: D1Database, shopifyOrderId: string) {
  return db.prepare(`
    SELECT id, source_payload_sha256 FROM paid_orders WHERE shopify_order_id = ?
  `).bind(shopifyOrderId).first<ExistingOrder>();
}

async function reconcileExistingOrder(
  db: D1Database,
  existing: ExistingOrder,
  payloadSha256: string,
  now: number,
) {
  if (existing.source_payload_sha256 === payloadSha256) return;
  const exception = {
    code: "DUPLICATE_ORDER_MISMATCH",
    summary: "A repeated paid-order event carried different order data.",
  };
  await db.batch([
    db.prepare(`
      UPDATE paid_orders SET status = 'exception_review', updated_at = ?
      WHERE id = ?
    `).bind(now, existing.id),
    insertException(db, existing.id, exception, now),
  ]);
}

function insertLine(
  db: D1Database,
  orderId: string,
  line: VerifiedLine,
  now: number,
) {
  const capability = line.capability;
  return db.prepare(`
    INSERT INTO paid_order_lines (
      id, paid_order_id, shopify_line_item_id, line_position, quantity,
      base_product_id, configured_product_id, design_revision_id,
      projection_version, print_geometry_key, print_asset_id,
      print_asset_sha256, shopify_variant_id, printify_variant_id,
      variant_mapping_snapshot_id, colour, size,
      line_capability_sha256, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    crypto.randomUUID(),
    orderId,
    line.shopifyLineItemId,
    line.linePosition,
    line.quantity,
    capability.baseProductId,
    capability.configuredProductId,
    capability.designRevisionId,
    capability.projectionVersion,
    capability.printGeometryKey,
    capability.printAssetId,
    capability.printAssetSha256,
    capability.shopifyVariantId,
    capability.printifyVariantId,
    capability.variantMappingSnapshotId,
    capability.color,
    capability.size,
    line.lineCapabilitySha256,
    now,
  );
}

function insertException(
  db: D1Database,
  orderId: string,
  exception: { readonly code: string; readonly summary: string },
  now: number,
) {
  return db.prepare(`
    INSERT INTO fulfilment_exceptions (
      id, paid_order_id, code, summary, status, created_at
    ) VALUES (?, ?, ?, ?, 'open', ?)
    ON CONFLICT (id) DO NOTHING
  `).bind(
    `${orderId}:${exception.code}`,
    orderId,
    exception.code,
    exception.summary,
    now,
  );
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return bytesToHex(new Uint8Array(digest));
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
