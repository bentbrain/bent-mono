import { protectedConfig } from "./protected-config";
import { Effect, Schema } from "effect";
import { validatePaidOrder, type PaidOrderHoldEnv } from "./paid-order-holds";
import { makeShopifyAdminClient } from "./shopify-admin-client";
import { recordPersonalDataAccess } from "./personal-data-audit";
import { PrintifyProductionClient, makePrintifyProductionClientLayer } from "./printify-production-client";
import { DeliveryAddressSchema, orderIdentityMismatchFields, orderReadbackIdentity, orderRequest } from "./printify-order-identity";
export const ORDER_1003_PROVIDER_TARGET = {
    orderId: protectedConfig("resource_5df53ebae4ae"),
    fulfilmentId: protectedConfig("resource_837385716250"),
    providerOrderId: protectedConfig("order1003ProviderOrderId"),
    requestSha256: protectedConfig("resource_04473478c366"),
};
export const ORDER_1004_PROVIDER_TARGET = {
    orderId: protectedConfig("resource_5ba68fa39a92"),
    fulfilmentId: protectedConfig("resource_d590174029ce"),
    providerOrderId: protectedConfig("order1004ProviderOrderId"),
    requestSha256: protectedConfig("resource_c7bc487d56fd"),
};
interface RecoveryRow {
    readonly id: string;
    readonly shopify_order_id: string;
    readonly shopify_order_name: string;
    readonly order_management_capability_hash: string;
    readonly currency_code: string;
    readonly total_minor_units: number;
    readonly production_hold_expires_at: number;
    readonly delivery_address_json: string;
    readonly updated_at: number;
    readonly fulfilment_updated_at: number;
    readonly exception_created_at: number;
    readonly label: string;
}
interface RecoveryLine {
    readonly external_id: string;
    readonly print_provider_id: number;
    readonly provider_product_id: string;
    readonly provider_sku: string;
    readonly printify_variant_id: number;
    readonly quantity: number;
    readonly retail_price_minor_units: number;
}
const linesSql = `SELECT l.id AS external_id, p.print_provider_id, p.provider_product_id,
  p.provider_sku, l.printify_variant_id, l.quantity, l.retail_price_minor_units
  FROM paid_order_lines l JOIN products c ON c.id = l.configured_product_id AND c.status = 'active'
  JOIN printify_production_products p ON p.configured_product_id = l.configured_product_id
    AND p.design_revision_id = l.design_revision_id AND p.base_product_id = l.base_product_id
    AND p.projection_version = l.projection_version AND p.print_geometry_key = l.print_geometry_key
    AND p.print_asset_id = l.print_asset_id AND p.print_asset_sha256 = l.print_asset_sha256
    AND p.printify_variant_id = l.printify_variant_id AND p.retail_price_minor_units = l.retail_price_minor_units
    AND p.status = 'ready' AND p.lease_id IS NULL AND p.lease_expires_at IS NULL AND p.verified_at IS NOT NULL
  JOIN print_assets a ON a.id = p.print_asset_id AND a.status = 'ready' AND a.sha256 = p.print_asset_sha256
  JOIN printify_fulfilment_order_lines f ON f.paid_order_line_id = l.id AND f.production_product_id = p.id
    AND f.external_id = l.id AND f.provider_product_id = p.provider_product_id
    AND f.printify_variant_id = l.printify_variant_id AND f.provider_sku = p.provider_sku
    AND f.quantity = l.quantity AND f.shipped_quantity = 0
  WHERE l.paid_order_id = ? AND f.fulfilment_order_id = ? ORDER BY l.line_position`;
export async function recoverPaidOrderProvider(env: PaidOrderHoldEnv, target: typeof ORDER_1003_PROVIDER_TARGET, releaseId: string, expectedPlanSha256?: string, fetcher: typeof fetch = fetch, now = () => Date.now()) {
    const row = await env.DB.prepare(`SELECT o.id, o.shopify_order_id, o.shopify_order_name,
    o.order_management_capability_hash, o.currency_code, o.total_minor_units, o.production_hold_expires_at,
    o.delivery_address_json, o.updated_at, f.updated_at AS fulfilment_updated_at, f.label,
    e.created_at AS exception_created_at
    FROM paid_orders o JOIN printify_fulfilment_orders f ON f.paid_order_id = o.id
    JOIN fulfilment_exceptions e ON e.paid_order_id = o.id AND e.status = 'open' AND e.code = 'PRINTIFY_ORDER_MISMATCH'
    WHERE o.id = ? AND f.id = ? AND f.provider_order_id = ? AND f.request_sha256 = ?
      AND o.status = 'fulfilment_locked' AND o.fulfilment_locked_at IS NOT NULL
      AND o.production_lease_id IS NULL AND o.delivery_address_json IS NOT NULL
      AND f.status = 'failed' AND f.last_error_code = 'PRINTIFY_ORDER_MISMATCH'
      AND f.lease_id IS NULL AND f.lease_expires_at IS NULL AND f.verified_at IS NULL AND f.submitted_at IS NULL
      AND (SELECT count(*) FROM paid_order_lines WHERE paid_order_id = o.id) = 1
      AND (SELECT count(*) FROM printify_fulfilment_order_lines WHERE fulfilment_order_id = f.id) = 1
      AND (SELECT count(*) FROM printify_fulfilment_orders WHERE paid_order_id = o.id) = 1
      AND (SELECT count(*) FROM printify_fulfilment_orders WHERE provider_order_id = f.provider_order_id) = 1
      AND (SELECT count(*) FROM fulfilment_exceptions WHERE paid_order_id = o.id AND status = 'open') = 1
      AND NOT EXISTS (SELECT 1 FROM order_management_commands WHERE paid_order_id = o.id
        AND status IN ('pending','processing','ambiguous'))
  `).bind(target.orderId, target.fulfilmentId, target.providerOrderId, target.requestSha256).first<RecoveryRow>();
    if (!row)
        return { ready: false, code: "ORDER_NOT_RECOVERABLE" };
    const lines = await env.DB.prepare(linesSql).bind(target.orderId, target.fulfilmentId).all<RecoveryLine>();
    if (lines.results.length !== 1)
        return { ready: false, code: "EXISTING_ORDER_LINEAGE_CHANGED" };
    const order = await makeShopifyAdminClient(env, fetcher).loadPaidOrder(row.shopify_order_id);
    const checkedAt = now();
    await recordPersonalDataAccess(env.DB, { action: "read", actor: "system:paid-order-reconciliation",
        purpose: "fraud-address-line-validation", subject: row.shopify_order_id }, checkedAt);
    const mismatch = await validatePaidOrder(env, row, order);
    if (mismatch)
        return { ready: false, code: mismatch.code };
    if (!['accept', 'none'].includes(order.fraudResult) || order.addressValidationResult !== "no_issues" ||
        order.address?.countryCode !== "AU" || JSON.stringify(order.address) !== row.delivery_address_json) {
        return { ready: false, code: "LOCKED_ORDER_VALIDATION_CHANGED" };
    }
    const address = Schema.decodeUnknownSync(DeliveryAddressSchema)(JSON.parse(row.delivery_address_json));
    const request = orderRequest({ id: target.orderId, label: row.label }, address, lines.results);
    if (await hash(request) !== target.requestSha256)
        return { ready: false, code: "IMMUTABLE_ORDER_REQUEST_CHANGED" };
    const provider = await Effect.runPromise(Effect.gen(function* () {
        const client = yield* PrintifyProductionClient;
        return yield* client.getOrder(target.providerOrderId);
    }).pipe(Effect.provide(makePrintifyProductionClientLayer(env, fetcher))));
    if (orderIdentityMismatchFields(target.providerOrderId, request, address, lines.results, provider).length > 0) {
        return { ready: false, code: "EXISTING_ORDER_IDENTITY_CHANGED" };
    }
    const planSha256 = await hash({ target, row, lines: lines.results, order, releaseId, readback: orderReadbackIdentity(provider) });
    const plan = { ready: true, ...target, orderName: row.shopify_order_name, planSha256, providerMutations: false };
    if (expectedPlanSha256 === undefined)
        return { ...plan, orderMutations: false };
    if (planSha256 !== expectedPlanSha256)
        return { ready: false, code: "RECOVERY_PLAN_CHANGED" };
    const results = await env.DB.batch([
        env.DB.prepare(`UPDATE printify_fulfilment_orders SET status = 'verifying', last_error_code = NULL, updated_at = ?
      WHERE id = ? AND paid_order_id = ? AND provider_order_id = ? AND request_sha256 = ? AND updated_at = ?
        AND status = 'failed' AND last_error_code = 'PRINTIFY_ORDER_MISMATCH'
        AND lease_id IS NULL AND lease_expires_at IS NULL AND verified_at IS NULL AND submitted_at IS NULL
        AND EXISTS (SELECT 1 FROM paid_orders WHERE id = ? AND status = 'fulfilment_locked'
          AND updated_at = ? AND production_lease_id IS NULL AND delivery_address_json = ?)
        AND (SELECT count(*) FROM fulfilment_exceptions WHERE paid_order_id = ? AND status = 'open') = 1
        AND EXISTS (SELECT 1 FROM fulfilment_exceptions WHERE paid_order_id = ? AND status = 'open'
          AND code = 'PRINTIFY_ORDER_MISMATCH' AND created_at = ?)
        AND (SELECT count(*) FROM printify_fulfilment_orders WHERE paid_order_id = ?) = 1
        AND (SELECT count(*) FROM printify_fulfilment_orders WHERE provider_order_id = ?) = 1
        AND (SELECT count(*) FROM paid_order_lines WHERE paid_order_id = ?) = 1
        AND (SELECT count(*) FROM printify_fulfilment_order_lines WHERE fulfilment_order_id = ?) = 1
        AND (SELECT count(*) FROM (${linesSql})) = 1
        AND NOT EXISTS (SELECT 1 FROM order_management_commands WHERE paid_order_id = ?
          AND status IN ('pending','processing','ambiguous'))
        AND EXISTS (SELECT 1 FROM native_video_release_control WHERE singleton = 1 AND paused = 0 AND current_release_id = ?)
    `).bind(checkedAt, target.fulfilmentId, target.orderId, target.providerOrderId, target.requestSha256, row.fulfilment_updated_at, row.id, row.updated_at, row.delivery_address_json, row.id, row.id, row.exception_created_at, row.id, target.providerOrderId, row.id, target.fulfilmentId, row.id, target.fulfilmentId, row.id, releaseId),
        env.DB.prepare(`UPDATE fulfilment_exceptions SET status = 'resolved', resolved_at = ?
      WHERE paid_order_id = ? AND code = 'PRINTIFY_ORDER_MISMATCH' AND status = 'open' AND created_at = ?
        AND EXISTS (SELECT 1 FROM printify_fulfilment_orders WHERE id = ? AND provider_order_id = ?
          AND request_sha256 = ? AND status = 'verifying' AND updated_at = ?
          AND lease_id IS NULL AND lease_expires_at IS NULL AND verified_at IS NULL AND submitted_at IS NULL)
    `).bind(checkedAt, row.id, row.exception_created_at, target.fulfilmentId, target.providerOrderId, target.requestSha256, checkedAt),
    ]);
    if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1)
        return { ready: false, code: "RECOVERY_STATE_CHANGED" };
    return { ...plan, orderMutations: true, normalVerificationRequired: true };
}
async function hash(value: unknown) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
