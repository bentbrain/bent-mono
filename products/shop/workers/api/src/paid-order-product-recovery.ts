import { protectedConfig } from "./protected-config";
import { Effect } from "effect";
import { validatePaidOrder, type PaidOrderHoldEnv } from "./paid-order-holds";
import { makeShopifyAdminClient } from "./shopify-admin-client";
import { recordPersonalDataAccess } from "./personal-data-audit";
import { PrintifyProductionClient, makePrintifyProductionClientLayer } from "./printify-production-client";
import { productIdentityMismatchFields, productReadbackIdentity, productionProductTitle } from "./printify-product-identity";
// This recovery is only for the recorded product created by #1003's normal pipeline.
export const ORDER_1003_PRODUCT_TARGET = {
    orderId: protectedConfig("resource_5df53ebae4ae"),
    productId: protectedConfig("resource_211886fbc19e"),
    providerProductId: protectedConfig("order1003ProviderProductId"),
    requestSha256: protectedConfig("resource_1b4cc40f0983"),
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
    readonly product_updated_at: number;
    readonly exception_created_at: number;
    readonly configured_product_id: string;
    readonly print_asset_sha256: string;
    readonly printify_variant_id: number;
    readonly retail_price_minor_units: number;
    readonly blueprint_id: number;
    readonly print_provider_id: number;
    readonly width_px: number;
    readonly height_px: number;
    readonly provider_image_id: string;
    readonly title: string;
}
export async function recoverPaidOrderProduct(env: PaidOrderHoldEnv, target: typeof ORDER_1003_PRODUCT_TARGET, releaseId: string, expectedPlanSha256?: string, fetcher: typeof fetch = fetch, now = () => Date.now()) {
    const row = await env.DB.prepare(`
    SELECT o.id, o.shopify_order_id, o.shopify_order_name, o.order_management_capability_hash,
      o.currency_code, o.total_minor_units, o.production_hold_expires_at,
      o.delivery_address_json, o.updated_at, p.updated_at AS product_updated_at,
      e.created_at AS exception_created_at, p.configured_product_id, p.print_asset_sha256,
      p.printify_variant_id, p.retail_price_minor_units, p.blueprint_id, p.print_provider_id,
      a.width_px, a.height_px, m.provider_image_id, p.title
    FROM paid_orders o JOIN paid_order_lines l ON l.paid_order_id = o.id
    JOIN printify_production_products p ON p.configured_product_id = l.configured_product_id
      AND p.design_revision_id = l.design_revision_id AND p.base_product_id = l.base_product_id
      AND p.projection_version = l.projection_version AND p.print_geometry_key = l.print_geometry_key
      AND p.print_asset_id = l.print_asset_id AND p.print_asset_sha256 = l.print_asset_sha256
      AND p.printify_variant_id = l.printify_variant_id AND p.retail_price_minor_units = l.retail_price_minor_units
    JOIN products configured ON configured.id = l.configured_product_id AND configured.status = 'active'
    JOIN print_assets a ON a.id = p.print_asset_id AND a.status = 'ready' AND a.sha256 = p.print_asset_sha256
    JOIN printify_media_copies m ON m.id = p.media_copy_id AND m.status = 'ready'
      AND m.print_asset_sha256 = p.print_asset_sha256 AND m.provider_image_id IS NOT NULL
    JOIN fulfilment_exceptions e ON e.paid_order_id = o.id
      AND e.code = 'PRINTIFY_PRODUCT_READBACK_FAILED' AND e.status = 'open'
    WHERE o.id = ? AND p.id = ? AND p.provider_product_id = ? AND p.request_sha256 = ?
      AND o.status = 'fulfilment_locked' AND o.fulfilment_locked_at IS NOT NULL
      AND o.production_lease_id IS NULL AND o.delivery_address_json IS NOT NULL
      AND p.status = 'failed' AND p.last_error_code = 'PRINTIFY_PRODUCT_READBACK_FAILED'
      AND p.lease_id IS NULL AND p.lease_expires_at IS NULL AND p.verified_at IS NULL
      AND p.readback_sha256 IS NULL
      AND (SELECT count(*) FROM paid_order_lines WHERE paid_order_id = o.id) = 1
      AND (SELECT count(*) FROM fulfilment_exceptions WHERE paid_order_id = o.id AND status = 'open') = 1
      AND NOT EXISTS (SELECT 1 FROM printify_fulfilment_orders WHERE paid_order_id = o.id)
      AND NOT EXISTS (SELECT 1 FROM order_management_commands WHERE paid_order_id = o.id
        AND status IN ('pending','processing','ambiguous'))
  `).bind(target.orderId, target.productId, target.providerProductId, target.requestSha256).first<RecoveryRow>();
    if (!row)
        return { ready: false, code: "PRODUCT_NOT_RECOVERABLE" };
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
    const product = await Effect.runPromise(Effect.gen(function* () {
        const client = yield* PrintifyProductionClient;
        return yield* client.getProduct(target.providerProductId);
    }).pipe(Effect.provide(makePrintifyProductionClientLayer(env, fetcher))));
    const shopId = Number(env.PRINTIFY_SHOP_ID);
    if (!Number.isSafeInteger(shopId) || shopId <= 0 || row.title !== productionProductTitle(row) || productIdentityMismatchFields(row, row.provider_image_id, target.providerProductId, row.title, shopId, product).length > 0)
        return { ready: false, code: "EXISTING_PRODUCT_IDENTITY_CHANGED" };
    const planSha256 = await hash({ target, row, order, releaseId, readback: productReadbackIdentity(product) });
    const plan = { ready: true, productId: target.productId, providerProductId: target.providerProductId, requestSha256: target.requestSha256, orderId: row.id, orderName: row.shopify_order_name, planSha256, providerMutations: false };
    if (expectedPlanSha256 === undefined)
        return { ...plan, orderMutations: false };
    if (planSha256 !== expectedPlanSha256)
        return { ready: false, code: "RECOVERY_PLAN_CHANGED" };
    // A transaction resumes verification of the existing resource and resolves only
    // its readback exception. Normal verification/submission remains mandatory.
    const results = await env.DB.batch([
        env.DB.prepare(`UPDATE printify_production_products SET status = 'verifying', last_error_code = NULL, updated_at = ?
      WHERE id = ? AND provider_product_id = ? AND request_sha256 = ? AND updated_at = ?
        AND status = 'failed' AND last_error_code = 'PRINTIFY_PRODUCT_READBACK_FAILED'
        AND lease_id IS NULL AND lease_expires_at IS NULL AND verified_at IS NULL AND readback_sha256 IS NULL
        AND EXISTS (SELECT 1 FROM paid_orders WHERE id = ? AND status = 'fulfilment_locked'
          AND updated_at = ? AND production_lease_id IS NULL AND delivery_address_json = ?)
        AND (SELECT count(*) FROM fulfilment_exceptions WHERE paid_order_id = ? AND status = 'open') = 1
        AND EXISTS (SELECT 1 FROM fulfilment_exceptions WHERE paid_order_id = ? AND status = 'open'
          AND code = 'PRINTIFY_PRODUCT_READBACK_FAILED' AND created_at = ?)
        AND NOT EXISTS (SELECT 1 FROM printify_fulfilment_orders WHERE paid_order_id = ?)
        AND NOT EXISTS (SELECT 1 FROM order_management_commands WHERE paid_order_id = ?
          AND status IN ('pending','processing','ambiguous'))
        AND EXISTS (SELECT 1 FROM products WHERE id = ? AND status = 'active')
        AND EXISTS (SELECT 1 FROM native_video_release_control WHERE singleton = 1 AND paused = 0 AND current_release_id = ?)
    `).bind(checkedAt, target.productId, target.providerProductId, target.requestSha256, row.product_updated_at, row.id, row.updated_at, row.delivery_address_json, row.id, row.id, row.exception_created_at, row.id, row.id, row.configured_product_id, releaseId),
        env.DB.prepare(`UPDATE fulfilment_exceptions SET status = 'resolved', resolved_at = ?
      WHERE paid_order_id = ? AND code = 'PRINTIFY_PRODUCT_READBACK_FAILED' AND status = 'open' AND created_at = ?
        AND EXISTS (SELECT 1 FROM printify_production_products WHERE id = ? AND provider_product_id = ?
          AND request_sha256 = ? AND status = 'verifying' AND updated_at = ? AND lease_id IS NULL)
    `).bind(checkedAt, row.id, row.exception_created_at, target.productId, target.providerProductId, target.requestSha256, checkedAt),
    ]);
    if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1)
        return { ready: false, code: "RECOVERY_STATE_CHANGED" };
    return { ...plan, orderMutations: true, normalVerificationRequired: true };
}
async function hash(value: unknown) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
