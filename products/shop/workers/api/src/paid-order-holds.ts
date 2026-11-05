import { safeErrorDetails } from "@forever-tee/contracts/diagnostics";
import type { IntegrationEnv } from "./integration-config";
import { recordPersonalDataAccess } from "./personal-data-audit";
import {
  makeShopifyAdminClient,
  type ShopifyPaidOrder,
  type ShopifyPaidOrderLine,
} from "./shopify-admin-client";

const MAX_ORDERS_PER_RUN = 25;
const PRODUCTION_LEASE_MS = 2 * 60 * 1_000;

export interface PaidOrderHoldEnv extends IntegrationEnv {
  readonly DB: D1Database;
  readonly DESIGN_ARTWORK: R2Bucket;
}

interface CandidateOrder {
  readonly currency_code: string;
  readonly id: string;
  readonly order_management_capability_hash: string;
  readonly production_hold_expires_at: number;
  readonly shopify_order_id: string;
  readonly shopify_order_name: string;
  readonly total_minor_units: number;
}

interface StoredLine {
  readonly base_product_id: string;
  readonly colour: "Black" | "Cream" | "White";
  readonly configured_product_id: string;
  readonly design_revision_id: string;
  readonly line_capability_sha256: string;
  readonly print_asset_id: string;
  readonly print_asset_sha256: string;
  readonly print_geometry_key: string;
  readonly printify_variant_id: number;
  readonly projection_version: "legacy-shirt-v1" | "safe-margin-v1";
  readonly quantity: number;
  readonly shopify_line_item_id: string;
  readonly shopify_variant_id: string;
  readonly size: string;
}

interface CurrentLineIdentity {
  readonly byte_size: number | null;
  readonly sha256: string | null;
  readonly storage_key: string | null;
  readonly catalogue_pending: number | null;
}

class PaidOrderCataloguePending extends Error {}

interface RecoverableOrder extends CandidateOrder {
  readonly source_payload_sha256: string;
  readonly updated_at: number;
  readonly exception_created_at: number;
}

// Recovery only reopens validation. It never locks an order, revokes customer
// access, creates provider resources or submits production work.
export async function recoverPaidOrderValidation(
  env: PaidOrderHoldEnv,
  orderId: string,
  expectedPlanSha256?: string,
  fetcher: typeof fetch = fetch,
  now = () => Date.now(),
) {
  const checkedAt = now();
  const candidate = await env.DB.prepare(`
    SELECT orders.id, orders.shopify_order_id, orders.shopify_order_name,
      orders.order_management_capability_hash, orders.currency_code,
      orders.total_minor_units, orders.production_hold_expires_at,
      orders.source_payload_sha256, orders.updated_at,
      exception.created_at AS exception_created_at
    FROM paid_orders orders
    JOIN fulfilment_exceptions exception ON exception.paid_order_id = orders.id
      AND exception.code = 'LINE_IDENTITY_CHANGED' AND exception.status = 'open'
    JOIN order_management_capabilities capability
      ON capability.token_hash = orders.order_management_capability_hash
      AND capability.revoked_at IS NULL
    WHERE orders.id = ? AND orders.status = 'exception_review'
      AND orders.fulfilment_locked_at IS NULL AND orders.production_lease_id IS NULL
      AND orders.production_hold_expires_at <= ?
      AND (SELECT count(*) FROM fulfilment_exceptions
        WHERE paid_order_id = orders.id AND status = 'open') = 1
      AND NOT EXISTS (SELECT 1 FROM printify_fulfilment_orders WHERE paid_order_id = orders.id)
      AND NOT EXISTS (SELECT 1 FROM order_management_commands
        WHERE paid_order_id = orders.id AND status IN ('pending','processing','ambiguous'))
  `).bind(orderId, checkedAt).first<RecoverableOrder>();
  if (!candidate) return { ready: false, code: "ORDER_NOT_RECOVERABLE" };

  const order = await makeShopifyAdminClient(env, fetcher).loadPaidOrder(candidate.shopify_order_id);
  await recordPersonalDataAccess(env.DB, {
    action: "read", actor: "system:paid-order-reconciliation",
    purpose: "fraud-address-line-validation", subject: candidate.shopify_order_id,
  }, checkedAt);
  try {
    const mismatch = await validatePaidOrder(env, candidate, order);
    if (mismatch) return { ready: false, code: mismatch.code };
  } catch (error) {
    if (error instanceof PaidOrderCataloguePending) return { ready: false, code: "CATALOGUE_REFRESH_PENDING" };
    throw error;
  }
  if (!['accept', 'none'].includes(order.fraudResult) ||
      order.addressValidationResult !== "no_issues" || order.address?.countryCode !== "AU") {
    return { ready: false, code: "VALIDATION_NOT_ACCEPTED" };
  }
  const lines = await env.DB.prepare("SELECT * FROM paid_order_lines WHERE paid_order_id = ? ORDER BY line_position")
    .bind(orderId).all();
  const planSha256 = await sha256Hex(JSON.stringify({ candidate, lines: lines.results, order }));
  const plan = { ready: true, orderId, orderName: candidate.shopify_order_name, planSha256, providerMutations: false };
  if (expectedPlanSha256 === undefined) return { ...plan, orderMutations: false };
  if (expectedPlanSha256 !== planSha256) return { ready: false, code: "RECOVERY_PLAN_CHANGED" };

  const resolved = await env.DB.prepare(`
    UPDATE fulfilment_exceptions SET status = 'resolved', resolved_at = ?
    WHERE paid_order_id = ? AND code = 'LINE_IDENTITY_CHANGED' AND status = 'open'
      AND created_at = ? AND EXISTS (
        SELECT 1 FROM paid_orders orders
        JOIN order_management_capabilities capability
          ON capability.token_hash = orders.order_management_capability_hash
          AND capability.revoked_at IS NULL
        WHERE orders.id = fulfilment_exceptions.paid_order_id
          AND orders.status = 'exception_review' AND orders.fulfilment_locked_at IS NULL
          AND orders.production_lease_id IS NULL AND orders.updated_at = ?
          AND orders.source_payload_sha256 = ?
          AND (SELECT count(*) FROM fulfilment_exceptions
            WHERE paid_order_id = orders.id AND status = 'open') = 1
          AND NOT EXISTS (SELECT 1 FROM printify_fulfilment_orders WHERE paid_order_id = orders.id)
          AND NOT EXISTS (SELECT 1 FROM order_management_commands
            WHERE paid_order_id = orders.id AND status IN ('pending','processing','ambiguous'))
      )
  `).bind(checkedAt, orderId, candidate.exception_created_at, candidate.updated_at,
    candidate.source_payload_sha256).run();
  if (resolved.meta.changes !== 1) return { ready: false, code: "RECOVERY_STATE_CHANGED" };
  return { ...plan, orderMutations: true, normalValidationRequired: true };
}

export interface PaidOrderHoldReport {
  readonly claimed: number;
  readonly exceptions: number;
  readonly locked: number;
  readonly ready: number;
  readonly retried: number;
}

export async function reconcilePaidOrderHolds(
  env: PaidOrderHoldEnv,
  fetcher: typeof fetch = fetch,
  now = () => Date.now(),
): Promise<PaidOrderHoldReport> {
  const report = { claimed: 0, exceptions: 0, locked: 0, ready: 0, retried: 0 };
  const candidates = await readCandidates(env.DB, now());
  const shopify = makeShopifyAdminClient(env, fetcher);
  for (const candidate of candidates) {
    const checkedAt = now();
    const leaseId = crypto.randomUUID();
    const claim = await env.DB.prepare(`
      UPDATE paid_orders
      SET production_lease_id = ?, production_lease_expires_at = ?,
        updated_at = ?
      WHERE id = ? AND status IN ('production_hold', 'exception_review')
        AND NOT EXISTS (SELECT 1 FROM order_management_commands WHERE paid_order_id = paid_orders.id AND status IN ('pending','processing','ambiguous'))
        AND (production_lease_id IS NULL OR production_lease_expires_at <= ?)
    `).bind(
      leaseId,
      checkedAt + PRODUCTION_LEASE_MS,
      checkedAt,
      candidate.id,
      checkedAt,
    ).run();
    if (claim.meta.changes !== 1) continue;
    report.claimed += 1;
    try {
      const order = await shopify.loadPaidOrder(candidate.shopify_order_id);
      await recordPersonalDataAccess(env.DB, {
        action: "read",
        actor: "system:paid-order-reconciliation",
        purpose: "fraud-address-line-validation",
        subject: candidate.shopify_order_id,
      }, checkedAt);
      const outcome = await validatePaidOrder(env, candidate, order);
      if (outcome !== undefined) {
        await moveToException(env.DB, candidate.id, leaseId, outcome, checkedAt);
        report.exceptions += 1;
        continue;
      }
      if (order.fraudResult === "cancel" ||
          order.fraudResult === "investigate") {
        await moveToException(env.DB, candidate.id, leaseId, {
          code: "FRAUD_REVIEW_REQUIRED",
          summary: "Shopify fraud screening requires staff review.",
        }, checkedAt, order);
        report.exceptions += 1;
        continue;
      }
      if (order.fraudResult === "pending") {
        await keepValidationPending(env.DB, candidate.id, leaseId, order, checkedAt);
        report.ready += 1;
        continue;
      }
      if (order.addressValidationResult !== "no_issues" ||
          order.address?.countryCode !== "AU") {
        if (checkedAt >= candidate.production_hold_expires_at) {
          await moveToException(env.DB, candidate.id, leaseId, {
            code: "ADDRESS_REVIEW_REQUIRED",
            summary: "The delivery address did not pass Australian address validation.",
          }, checkedAt, order);
          report.exceptions += 1;
        } else {
          await keepValidationPending(env.DB, candidate.id, leaseId, order, checkedAt);
          report.ready += 1;
        }
        continue;
      }
      if (checkedAt < candidate.production_hold_expires_at) {
        await enterProductionHold(env.DB, candidate.id, leaseId, order, checkedAt);
        report.ready += 1;
        continue;
      }
      const locked = await establishFulfilmentLock(
        env.DB,
        candidate,
        leaseId,
        order,
        checkedAt,
      );
      if (locked) report.locked += 1;
    } catch (error) {
      await releaseLease(env.DB, candidate.id, leaseId, checkedAt);
      report.retried += 1;
      if (!(error instanceof PaidOrderCataloguePending)) {
        console.error("bent.shop paid-order validation will retry", {
          ...safeErrorDetails(error),
          orderId: candidate.id,
        });
      }
    }
  }
  return report;
}

async function readCandidates(db: D1Database, now: number) {
  const rows = await db.prepare(`
    SELECT orders.id, orders.shopify_order_id, orders.shopify_order_name,
      orders.order_management_capability_hash, orders.currency_code,
      orders.total_minor_units, orders.production_hold_expires_at
    FROM paid_orders AS orders
    JOIN order_management_capabilities AS capability
      ON capability.token_hash = orders.order_management_capability_hash
      AND capability.revoked_at IS NULL
    WHERE orders.status IN ('production_hold', 'exception_review')
      AND orders.order_management_capability_hash IS NOT NULL
      AND (orders.production_lease_id IS NULL OR
        orders.production_lease_expires_at <= ?)
      AND EXISTS (
        SELECT 1 FROM paid_order_lines WHERE paid_order_id = orders.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM fulfilment_exceptions
        WHERE paid_order_id = orders.id AND status = 'open'
          AND code != 'VALIDATION_PENDING'
      )
    ORDER BY orders.production_hold_expires_at, orders.created_at
    LIMIT ?
  `).bind(now, MAX_ORDERS_PER_RUN).all<CandidateOrder>();
  return rows.results;
}

export async function validatePaidOrder(
  env: PaidOrderHoldEnv,
  stored: CandidateOrder,
  order: ShopifyPaidOrder,
) {
  if (
    order.id !== stored.shopify_order_id ||
    order.name !== stored.shopify_order_name ||
    order.currencyCode !== stored.currency_code ||
    order.totalMinorUnits !== stored.total_minor_units ||
    order.cancelledAt !== null || order.financialStatus !== "PAID" ||
    order.lines.some((line) =>
      line.retailCurrencyCode !== order.currencyCode ||
      line.retailPriceMinorUnits <= 0
    )
  ) {
    return {
      code: "ORDER_STATE_CHANGED",
      summary: "The paid Shopify order no longer matches its verified payment state.",
    };
  }
  const storedLines = await env.DB.prepare(`
    SELECT shopify_line_item_id, quantity, base_product_id,
      configured_product_id, design_revision_id, projection_version,
      print_geometry_key, print_asset_id, print_asset_sha256,
      shopify_variant_id, printify_variant_id, colour, size,
      line_capability_sha256
    FROM paid_order_lines
    WHERE paid_order_id = ?
    ORDER BY line_position
  `).bind(stored.id).all<StoredLine>();
  if (order.edited || storedLines.results.length !== order.lines.length) {
    return lineChangedException();
  }
  const shopifyLines = new Map(order.lines.map((line) => [line.id, line]));
  for (const storedLine of storedLines.results) {
    const shopifyLine = shopifyLines.get(storedLine.shopify_line_item_id);
    if (!shopifyLine || !await lineMatches(storedLine, shopifyLine) ||
        !await currentLineIdentityExists(env, storedLine)) {
      return lineChangedException();
    }
  }
  return undefined;
}

async function lineMatches(stored: StoredLine, current: ShopifyPaidOrderLine) {
  return current.currentQuantity === stored.quantity &&
    current.originalQuantity === stored.quantity &&
    current.shopifyVariantId === stored.shopify_variant_id &&
    await sha256Hex(current.lineCapability) === stored.line_capability_sha256;
}

async function currentLineIdentityExists(
  env: PaidOrderHoldEnv,
  line: StoredLine,
) {
  // A customer's deletion retires the public product, but cannot invalidate an
  // existing paid order. Verify its recorded asset, projection and variant.
  const identity = await env.DB.prepare(`
    WITH identity AS (
    SELECT coalesce(object.storage_key, asset.storage_key) AS storage_key,
      asset.byte_size, asset.sha256
    FROM products AS configured
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
      AND mapping.printify_variant_id = ?
      AND mapping.colour = ? AND mapping.size = ?
      AND mapping.shopify_available = 1
    JOIN printify_catalogue_snapshots AS catalogue
      ON catalogue.id = mapping_snapshot.catalogue_snapshot_id
      AND catalogue.id = (
        SELECT id FROM printify_catalogue_snapshots
        WHERE base_product_id = configured.base_product_id
        ORDER BY retrieved_at DESC, id DESC LIMIT 1
      )
    JOIN printify_catalogue_variants AS catalogue_variant
      ON catalogue_variant.snapshot_id = catalogue.id
      AND catalogue_variant.printify_variant_id = mapping.printify_variant_id
      AND catalogue_variant.colour = mapping.colour
      AND catalogue_variant.size = mapping.size
      AND catalogue_variant.available = 1
    JOIN print_assets AS asset
      ON asset.id = ? AND asset.configured_product_id = configured.id
      AND asset.design_revision_id = configured.design_revision_id
      AND asset.base_product_id = configured.base_product_id
      AND asset.projection_version = configured.projection_version
      AND asset.geometry_key = lower(catalogue_variant.decoration_method)
        || ':' || catalogue_variant.print_width || 'x'
        || catalogue_variant.print_height
      AND asset.geometry_key = ? AND asset.sha256 = ?
      AND asset.status = 'ready'
    LEFT JOIN print_asset_objects AS object
      ON object.sha256 = asset.object_sha256
    WHERE configured.id = ? AND configured.status IN ('active', 'deleted')
      AND configured.design_revision_id = ?
      AND configured.base_product_id = ?
      AND configured.projection_version = ?
    )
    SELECT identity.storage_key, identity.byte_size, identity.sha256,
      (SELECT catalogue_snapshot_id FROM shopify_variant_mapping_snapshots
        WHERE base_product_id = ? AND shopify_product_handle =
          (SELECT shopify_handle FROM products WHERE id = ?)
        ORDER BY retrieved_at DESC, id DESC LIMIT 1) !=
      (SELECT id FROM printify_catalogue_snapshots
        WHERE base_product_id = ?
        ORDER BY retrieved_at DESC, id DESC LIMIT 1) AS catalogue_pending
    FROM (SELECT 1) LEFT JOIN identity ON 1 = 1
  `).bind(
    line.shopify_variant_id,
    line.printify_variant_id,
    line.colour,
    line.size,
    line.print_asset_id,
    line.print_geometry_key,
    line.print_asset_sha256,
    line.configured_product_id,
    line.design_revision_id,
    line.base_product_id,
    line.projection_version,
    line.base_product_id,
    line.base_product_id,
    line.base_product_id,
  ).first<CurrentLineIdentity>();
  // Read consistency and identity in one D1 snapshot. Refresh publishes the
  // catalogue before its mapping; that gap must hold/retry, never lock an
  // order using old availability or create a permanent line-change exception.
  if (identity?.catalogue_pending === 1) throw new PaidOrderCataloguePending();
  if (!identity?.storage_key || identity.byte_size === null || !identity.sha256) return false;
  const object = await env.DESIGN_ARTWORK.head(identity.storage_key);
  const checksum = object?.checksums.sha256;
  return object?.size === identity.byte_size && checksum !== undefined &&
    bytesToHex(new Uint8Array(checksum)) === identity.sha256;
}

function lineChangedException() {
  return {
    code: "LINE_IDENTITY_CHANGED",
    summary: "The Shopify order lines no longer match the immutable production identities.",
  };
}

async function keepValidationPending(
  db: D1Database,
  orderId: string,
  leaseId: string,
  order: ShopifyPaidOrder,
  now: number,
) {
  await db.prepare(`
    UPDATE paid_orders
    SET status = 'exception_review', fraud_result = ?,
      address_validation_result = ?, validation_checked_at = ?,
      shopify_order_updated_at = ?, production_lease_id = NULL,
      production_lease_expires_at = NULL, updated_at = ?
    WHERE id = ? AND production_lease_id = ?
  `).bind(
    order.fraudResult,
    order.addressValidationResult,
    now,
    order.updatedAt,
    now,
    orderId,
    leaseId,
  ).run();
}

async function enterProductionHold(
  db: D1Database,
  orderId: string,
  leaseId: string,
  order: ShopifyPaidOrder,
  now: number,
) {
  await db.batch([
    db.prepare(`
      UPDATE paid_orders
      SET status = 'production_hold', fraud_result = ?,
        address_validation_result = ?, validation_checked_at = ?,
        shopify_order_updated_at = ?, production_lease_id = NULL,
        production_lease_expires_at = NULL, updated_at = ?
      WHERE id = ? AND production_lease_id = ?
    `).bind(
      order.fraudResult,
      order.addressValidationResult,
      now,
      order.updatedAt,
      now,
      orderId,
      leaseId,
    ),
    resolveException(db, orderId, "VALIDATION_PENDING", now),
  ]);
}

async function moveToException(
  db: D1Database,
  orderId: string,
  leaseId: string,
  exception: { readonly code: string; readonly summary: string },
  now: number,
  order?: ShopifyPaidOrder,
) {
  await db.batch([
    db.prepare(`
      UPDATE paid_orders
      SET status = 'exception_review', fraud_result = ?,
        address_validation_result = ?, validation_checked_at = ?,
        shopify_order_updated_at = ?, production_lease_id = NULL,
        production_lease_expires_at = NULL, updated_at = ?
      WHERE id = ? AND production_lease_id = ?
    `).bind(
      order?.fraudResult ?? "pending",
      order?.addressValidationResult ?? "pending",
      now,
      order?.updatedAt ?? null,
      now,
      orderId,
      leaseId,
    ),
    openException(db, orderId, exception, now),
    resolveException(db, orderId, "VALIDATION_PENDING", now),
  ]);
}

async function establishFulfilmentLock(
  db: D1Database,
  stored: CandidateOrder,
  leaseId: string,
  order: ShopifyPaidOrder,
  now: number,
) {
  if (!order.address) return false;
  const addressJson = JSON.stringify(order.address);
  const addressSha256 = await sha256Hex(addressJson);
  const linePriceUpdates = order.lines.map((line) => db.prepare(`
    UPDATE paid_order_lines
    SET retail_price_minor_units = ?
    WHERE paid_order_id = ? AND shopify_line_item_id = ?
      AND retail_price_minor_units IS NULL
  `).bind(
    line.retailPriceMinorUnits,
    stored.id,
    line.id,
  ));
  const results = await db.batch([
    db.prepare(`
      UPDATE paid_orders
      SET status = 'fulfilment_locked', fraud_result = ?,
        address_validation_result = 'no_issues',
        shopify_order_updated_at = ?, delivery_address_sha256 = ?,
        delivery_address_json = ?, validation_checked_at = ?,
        fulfilment_locked_at = ?, production_lease_id = NULL,
        production_lease_expires_at = NULL, updated_at = ?
      WHERE id = ? AND production_lease_id = ?
        AND status IN ('production_hold', 'exception_review')
        AND NOT EXISTS (SELECT 1 FROM order_management_commands WHERE paid_order_id = paid_orders.id AND status IN ('pending','processing','ambiguous'))
        AND NOT EXISTS (
          SELECT 1 FROM paid_order_lines lines JOIN products ON products.id = lines.configured_product_id
          WHERE lines.paid_order_id = paid_orders.id AND products.status IN ('suspended', 'unpublished', 'retired')
        )
        AND EXISTS (
          SELECT 1 FROM order_management_capabilities
          WHERE token_hash = ? AND revoked_at IS NULL
        )
    `).bind(
      order.fraudResult,
      order.updatedAt,
      addressSha256,
      addressJson,
      now,
      now,
      now,
      stored.id,
      leaseId,
      stored.order_management_capability_hash,
    ),
    db.prepare(`
      UPDATE order_management_capabilities
      SET revoked_at = ?
      WHERE token_hash = ? AND revoked_at IS NULL AND EXISTS (
        SELECT 1 FROM paid_orders
        WHERE id = ? AND status = 'fulfilment_locked'
          AND fulfilment_locked_at = ?
      )
    `).bind(
      now,
      stored.order_management_capability_hash,
      stored.id,
      now,
    ),
    ...linePriceUpdates,
    resolveException(db, stored.id, "VALIDATION_PENDING", now),
  ]);
  return results[0]?.meta.changes === 1 && results[1]?.meta.changes === 1 &&
    linePriceUpdates.every((_, index) =>
      results[index + 2]?.meta.changes === 1
    );
}

async function releaseLease(
  db: D1Database,
  orderId: string,
  leaseId: string,
  now: number,
) {
  await db.prepare(`
    UPDATE paid_orders
    SET production_lease_id = NULL, production_lease_expires_at = NULL,
      updated_at = ?
    WHERE id = ? AND production_lease_id = ?
  `).bind(now, orderId, leaseId).run();
}

function openException(
  db: D1Database,
  orderId: string,
  exception: { readonly code: string; readonly summary: string },
  now: number,
) {
  return db.prepare(`
    INSERT INTO fulfilment_exceptions (
      id, paid_order_id, code, summary, status, created_at, resolved_at
    ) VALUES (?, ?, ?, ?, 'open', ?, NULL)
    ON CONFLICT (id) DO UPDATE SET summary = excluded.summary,
      status = 'open', resolved_at = NULL
  `).bind(
    `${orderId}:${exception.code}`,
    orderId,
    exception.code,
    exception.summary,
    now,
  );
}

function resolveException(
  db: D1Database,
  orderId: string,
  code: string,
  now: number,
) {
  return db.prepare(`
    UPDATE fulfilment_exceptions
    SET status = 'resolved', resolved_at = ?
    WHERE paid_order_id = ? AND code = ? AND status = 'open'
  `).bind(now, orderId, code);
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
