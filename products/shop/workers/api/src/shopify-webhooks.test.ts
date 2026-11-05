import { protectedConfig } from "./protected-config";
import { shippingQualificationOptions, verifyShippingQualificationProxy } from "./shipping-qualification-platform";
import { readFile } from "node:fs/promises";
import { signCartLineCapability } from "@forever-tee/contracts/cart-line-capability";
import { Effect, Either, Schema } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getPlatformProxy, type PlatformProxy } from "wrangler";
import { handleShopifyWebhookRequest as actualShopifyWebhookRequest, SHOPIFY_ORDERS_PAID_WEBHOOK_PATH, } from "./shopify-webhooks";
import { handleOrderManagementRequest, reconcileOrderManagement, ORDER_MANAGEMENT_PATH } from "./order-management";
import { reconcilePaidOrderHolds, recoverPaidOrderValidation } from "./paid-order-holds";
import { PrintifyProductionProductSchema } from "./printify-product-identity";
import { recoverPaidOrderProvider } from "./paid-order-provider-recovery";
import { recoverPaidOrderProduct } from "./paid-order-product-recovery";
import { handlePaidOrderRecoveryRequest, PAID_ORDER_PROVIDER_RECOVERY_PATH, PAID_ORDER_PRODUCT_RECOVERY_PATH, PAID_ORDER_RECOVERY_PATH } from "./paid-order-recovery";
import { deleteOwnedDesign } from "./design-deletion";
import { resetShopifyAdminAccessTokenCache } from "./shopify-admin-client";
import { PrintifyCreateOrderRequestSchema, PrintifyCreateProductRequestSchema, PrintifyUploadByUrlRequestSchema, PrintifyProductionClient, makePrintifyProductionClientLayer, type PrintifyCreateOrderRequest, type PrintifyCreateProductRequest, } from "./printify-production-client";
import { runScheduledPrintifyMaterialisation } from "./printify-production-materialisation";
import { runScheduledPrintifyOrderSubmission } from "./printify-order-submission";
import { observeBackgroundTask } from "./observability";
import { handlePrintifyWebhookRequest, PRINTIFY_SHIPMENT_WEBHOOK_PATH, runScheduledPrintifyShipmentReconciliation, } from "./printify-webhooks";
const WEBHOOK_SECRET = "shopify-webhook-test-secret";
const SIGNING_SECRET = "cart-capability-test-secret-value-123456";
const SHOP_DOMAIN = "bent-shirt.myshopify.com";
const WEBHOOK_ID = "b7dd72bf-1677-4c45-9990-9e1d18c45fd9";
const NOW = 1788000000000;
const BASE_PRODUCT_ID = "a51b7acf-77e9-4762-83c4-62d96dd8942c";
const CONFIGURED_PRODUCT_ID = "189976ee-4965-45d1-8bae-6ea03a9c14bc";
const DESIGN_ID = "348bd319-df6a-4be1-b74b-dc2582ef9679";
const REVISION_ID = "401c53ee-dc17-49e5-bc04-1588a589b8b6";
const CATALOGUE_ID = "581b0c51-70c0-4f72-a292-d30030b3284e";
const MAPPING_ID = "9247ce8e-b8c1-41d5-ad50-d29fafc614ca";
const ASSET_ID = "f0584c5e-0583-453a-8f85-4fb53faabbd8";
const SHOPIFY_VARIANT_ID = "gid://shopify/ProductVariant/101";
const SECOND_SHOPIFY_VARIANT_ID = "gid://shopify/ProductVariant/102";
const ORDER_CAPABILITY = "o".repeat(43);
const ASSET = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]);
const PRINTIFY_SHOP_ID = "12345";
const PRINTIFY_ASSET_DELIVERY_SECRET = "printify-asset-delivery-test-secret-value";
const PRINTIFY_WEBHOOK_SECRET = "printify-webhook-test-secret-value-123456";
let platform: PlatformProxy<Env> | undefined;
const nativeFetch = globalThis.fetch;
function paymentDeadlineFetcher(paidAt = NOW) {
    return vi.fn<typeof fetch>((input) => Promise.resolve(fetchInputUrl(input).endsWith("/admin/oauth/access_token")
        ? Response.json({ access_token: "payment-clock-token", expires_in: 86399, scope: "write_orders" })
        : Response.json({ data: { order: { id: "gid://shopify/Order/1001", displayFinancialStatus: "PAID", currentTotalPriceSet: { presentmentMoney: { amount: "70.00", currencyCode: "AUD" } }, transactions: [{ kind: "SALE", status: "SUCCESS", createdAt: new Date(paidAt).toISOString(), amountSet: { presentmentMoney: { amount: "70.00", currencyCode: "AUD" } } }] } } })));
}
function handleShopifyWebhookRequest(request: Request, env: Parameters<typeof actualShopifyWebhookRequest>[1], now = () => Date.now()) {
    return actualShopifyWebhookRequest(request, env, now, paymentDeadlineFetcher());
}
function testPlatform() {
    if (!platform)
        throw new Error("Test bindings are unavailable.");
    return platform;
}
function workerEnv() {
    return {
        CART_LINE_CAPABILITY_SECRET: SIGNING_SECRET,
        DB: testPlatform().env.DB,
        DESIGN_ARTWORK: testPlatform().env.DESIGN_ARTWORK,
        PRINTIFY_API_TOKEN: "printify-test-token",
        PRINTIFY_ASSET_DELIVERY_SECRET,
        PRINTIFY_ASSET_ORIGIN: "https://api.example.com",
        PRINTIFY_SHOP_ID,
        PRINTIFY_WEBHOOK_SECRET,
        SHOPIFY_ADMIN_STORE_DOMAIN: SHOP_DOMAIN,
        SHOPIFY_CLIENT_ID: "client-id",
        SHOPIFY_CLIENT_SECRET: WEBHOOK_SECRET,
    };
}
beforeAll(async () => {
    const qualification = await shippingQualificationOptions();
    platform = await getPlatformProxy<Env>(qualification.options);
    if (qualification.remote) {
        await verifyShippingQualificationProxy(platform.env.DB);
        return;
    }
    for (const name of [
        "0000_loving_king_bedlam.sql",
        "0001_faulty_taskmaster.sql",
        "0002_separate_product_design_ids.sql",
        "0003_idempotent-configured-products.sql",
        "0004_immutable_revision_ledger.sql",
        "0005_catch_up_revision_links.sql",
        "0006_anonymous_draft_capabilities.sql",
        "0007_paid_operation_quotas.sql",
        "0008_operational_controls.sql",
        "0009_printify_catalogue_snapshots.sql",
        "0010_shopify_variant_mappings.sql",
        "0011_reusable_design_revisions.sql",
        "0012_product_aware_catalogues.sql",
        "0013_versioned_product_projections.sql",
        "0014_default_design_product_family.sql",
        "0015_story_video_jobs.sql",
        "0016_story_video_renderer_v5.sql",
        "0017_story_video_renderer_v6.sql",
        "0018_story_video_execution_fence.sql",
        "0019_paid_order_foundation.sql",
        "0020_protected_customer_data_hardening.sql",
        "0031_order_management.sql",
        "0021_printify_production_resources.sql",
        "0022_print_asset_render_slots.sql",
        "0023_printify_fulfilment_orders.sql",
        "0024_story_video_renderer_v7.sql",
        "0025_storage_maintenance.sql",
        "0026_portrait_safety_screening.sql",
        "0027_image_based_default_product_color.sql",
        "0028_product_color_analysis_state.sql",
        "0029_design_asset_deletions.sql",
        "0035_shared_tracking_shipments.sql",
        "0036_print_job_outbox.sql",
        "0039_featured_media_composition.sql",
        "0040_recursive_video_placement.sql",
        "0041_product_image_jobs.sql",
        "0042_design_artwork_sources.sql",
        "0043_artwork_preparation_jobs.sql",
        "0044_video_preview_revisions.sql",
    ]) {
        const sql = await readFile(new URL(`../drizzle/${name}`, import.meta.url), "utf8");
        // Preserve migration order without 154 separate Miniflare round trips,
        // which exceeded the setup-hook deadline on cold CI runners.
        const statements = sql.split("--> statement-breakpoint")
            .map((statement) => statement.trim())
            .filter(Boolean)
            .map((statement) => testPlatform().env.DB.prepare(statement));
        if (statements.length > 0) {
            await testPlatform().env.DB.batch(statements);
        }
    }
});
beforeEach(async () => {
    await testPlatform().env.DB.prepare("DELETE FROM provider_admission").run();
    if (process.env["NATIVE_SHIPPING_QUALIFICATION_CONFIG"]) {
        const denyProviderRequests: typeof fetch = (input, init) => {
            const url = new URL(fetchInputUrl(input));
            if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
                return nativeFetch(input, init);
            return Promise.reject(new Error("Cloud shipping qualification forbids real provider requests."));
        };
        vi.stubGlobal("fetch", denyProviderRequests);
    }
    resetShopifyAdminAccessTokenCache();
    await testPlatform().env.DB.batch([
        testPlatform().env.DB.prepare("DELETE FROM order_management_commands"),
        testPlatform().env.DB.prepare("DELETE FROM order_management_access_log"),
        testPlatform().env.DB.prepare("DELETE FROM design_asset_deletions"),
        testPlatform().env.DB.prepare("DELETE FROM printify_shipment_lines"),
        testPlatform().env.DB.prepare("DELETE FROM printify_shipments"),
        testPlatform().env.DB.prepare("DELETE FROM printify_webhook_inbox"),
        testPlatform().env.DB.prepare("DELETE FROM printify_fulfilment_order_lines"),
        testPlatform().env.DB.prepare("DELETE FROM printify_fulfilment_orders"),
        testPlatform().env.DB.prepare("DELETE FROM printify_production_products"),
        testPlatform().env.DB.prepare("DELETE FROM printify_media_copies"),
        testPlatform().env.DB.prepare("DELETE FROM privacy_object_deletions"),
        testPlatform().env.DB.prepare("DELETE FROM personal_data_access_log"),
        testPlatform().env.DB.prepare("DELETE FROM fulfilment_exceptions"),
        testPlatform().env.DB.prepare("DELETE FROM paid_order_lines"),
        testPlatform().env.DB.prepare("DELETE FROM paid_orders"),
        testPlatform().env.DB.prepare("DELETE FROM order_management_capabilities"),
        testPlatform().env.DB.prepare("DELETE FROM print_assets"),
        testPlatform().env.DB.prepare("DELETE FROM print_asset_objects"),
        testPlatform().env.DB.prepare("DELETE FROM shopify_variant_mappings"),
        testPlatform().env.DB.prepare("DELETE FROM shopify_variant_mapping_snapshots"),
        testPlatform().env.DB.prepare("DELETE FROM printify_catalogue_variants"),
        testPlatform().env.DB.prepare("DELETE FROM printify_catalogue_snapshots"),
        testPlatform().env.DB.prepare("DELETE FROM shopify_webhook_inbox"),
        testPlatform().env.DB.prepare("DELETE FROM products"),
        testPlatform().env.DB.prepare("DELETE FROM design_revisions"),
        testPlatform().env.DB.prepare("DELETE FROM designs"),
    ]);
});
afterAll(async () => {
    await platform?.dispose();
    if (process.env["NATIVE_SHIPPING_QUALIFICATION_CONFIG"])
        vi.unstubAllGlobals();
});
describe("Shopify paid-order webhook processing", () => {
    it("keeps the payment-based deadline when webhook delivery is delayed", async () => {
        const payload = await validOrderPayload();
        const response = await actualShopifyWebhookRequest(await webhookRequest(payload), workerEnv(), () => NOW + 30000, paymentDeadlineFetcher(NOW));
        expect(response?.status).toBe(202);
        const order = await testPlatform().env.DB.prepare("SELECT production_hold_expires_at FROM paid_orders").first<{
            production_hold_expires_at: number;
        }>();
        expect(order?.production_hold_expires_at).toBe(NOW + 3600000);
    });
    it("imports a delayed payment after its correction window without extending the deadline", async () => {
        const payload = await validOrderPayload();
        await testPlatform().env.DB.prepare("UPDATE order_management_capabilities SET expires_at = ?").bind(NOW + 30 * 24 * 3600000).run();
        const deliveredAt = NOW + 3660000;
        const response = await actualShopifyWebhookRequest(await webhookRequest(payload), workerEnv(), () => deliveredAt, paymentDeadlineFetcher(NOW));
        expect(response?.status).toBe(202);
        const order = await testPlatform().env.DB.prepare("SELECT production_hold_expires_at FROM paid_orders").first<{
            production_hold_expires_at: number;
        }>();
        expect(order?.production_hold_expires_at).toBe(NOW + 3600000);
        const view = await handleOrderManagementRequest(new Request(`https://api.example.com${ORDER_MANAGEMENT_PATH}`, {
            headers: { "x-forever-tee-service-secret": "service-secret", "x-order-management-capability": ORDER_CAPABILITY },
        }), { ...workerEnv(), FOREVER_TEE_API_SHARED_SECRET: "service-secret" }, paymentDeadlineFetcher(NOW), () => deliveredAt);
        expect(view?.status).toBe(410);
    });
    it("does not bind an order when its paid timestamp cannot be verified", async () => {
        const payload = await validOrderPayload();
        const unavailable = vi.fn<typeof fetch>(() => Promise.resolve(new Response(null, { status: 503 })));
        const response = await actualShopifyWebhookRequest(await webhookRequest(payload), workerEnv(), () => NOW, unavailable);
        expect(response?.status).toBe(503);
        expect(await tableCount("paid_orders")).toBe(0);
        const capability = await testPlatform().env.DB.prepare("SELECT bound_at FROM order_management_capabilities").first<{
            bound_at: number | null;
        }>();
        expect(capability?.bound_at).toBeNull();
    });
    it("stores an exact paid-order chain without retaining the webhook body", async () => {
        const payload = await validOrderPayload();
        payload["email"] = "buyer@example.com";
        payload["customer"] = { email: "buyer@example.com", first_name: "Ada" };
        payload["shipping_address"] = {
            address1: "1 Queen Street",
            first_name: "Ada",
            last_name: "Lovelace",
        };
        const lineCapability = readLineCapability(payload);
        const response = await handleShopifyWebhookRequest(await webhookRequest(payload), workerEnv(), () => NOW);
        expect(response?.status).toBe(202);
        const inbox = await testPlatform().env.DB.prepare(`
      SELECT status, attempt_count, payload_json, processing_started_at
      FROM shopify_webhook_inbox
    `).first<{
            status: string;
            attempt_count: number;
            payload_json: string;
            processing_started_at: number | null;
        }>();
        expect(inbox).toMatchObject({
            attempt_count: 1,
            processing_started_at: null,
            status: "processed",
        });
        expect(inbox?.payload_json).toBe('{"schema":"orders-paid-audit-v1"}');
        expect(inbox?.payload_json).not.toContain(ORDER_CAPABILITY);
        expect(inbox?.payload_json).not.toContain(lineCapability);
        expect(inbox?.payload_json).not.toContain("buyer@example.com");
        expect(inbox?.payload_json).not.toContain("Queen Street");
        const order = await testPlatform().env.DB.prepare(`
      SELECT status, fraud_result, address_validation_result,
        production_hold_expires_at, order_management_capability_hash
      FROM paid_orders
    `).first<{
            status: string;
            fraud_result: string;
            address_validation_result: string;
            production_hold_expires_at: number;
            order_management_capability_hash: string;
        }>();
        expect(order).toMatchObject({
            address_validation_result: "pending",
            fraud_result: "pending",
            production_hold_expires_at: NOW + 60 * 60 * 1000,
            status: "exception_review",
        });
        expect(order?.order_management_capability_hash).toBe(await sha256Hex(ORDER_CAPABILITY));
        const line = await testPlatform().env.DB.prepare(`
      SELECT quantity, configured_product_id, print_asset_id,
        shopify_variant_id, line_capability_sha256
      FROM paid_order_lines
    `).first();
        expect(line).toEqual({
            configured_product_id: CONFIGURED_PRODUCT_ID,
            line_capability_sha256: await sha256Hex(lineCapability),
            print_asset_id: ASSET_ID,
            quantity: 2,
            shopify_variant_id: SHOPIFY_VARIANT_ID,
        });
        expect((await openException())?.code).toBe("VALIDATION_PENDING");
        const bound = await testPlatform().env.DB.prepare(`
      SELECT bound_at FROM order_management_capabilities
    `).first<{
            bound_at: number;
        }>();
        expect(bound?.bound_at).toBe(NOW);
        const audit = await testPlatform().env.DB.prepare(`
      SELECT actor, action, purpose, subject_hash
      FROM personal_data_access_log
    `).first<{
            actor: string;
            action: string;
            purpose: string;
            subject_hash: string;
        }>();
        expect(audit).toEqual({
            action: "receive",
            actor: "system:shopify-webhook",
            purpose: "paid-order-ingestion",
            subject_hash: await sha256Hex("gid://shopify/Order/1001"),
        });
    });
    it("accepts an exact delivery retry without duplicating work", async () => {
        const payload = await validOrderPayload();
        const first = await handleShopifyWebhookRequest(await webhookRequest(payload), workerEnv(), () => NOW);
        const retry = await handleShopifyWebhookRequest(await webhookRequest(payload), workerEnv(), () => NOW + 1000);
        expect(first?.status).toBe(202);
        expect(retry?.status).toBe(202);
        expect(await tableCount("shopify_webhook_inbox")).toBe(1);
        expect(await tableCount("paid_orders")).toBe(1);
        expect(await tableCount("paid_order_lines")).toBe(1);
        const inbox = await testPlatform().env.DB.prepare(`
      SELECT attempt_count FROM shopify_webhook_inbox
    `).first<{
            attempt_count: number;
        }>();
        expect(inbox?.attempt_count).toBe(1);
    });
    it("accepts an identical duplicate delivery under a new webhook identifier", async () => {
        const payload = await validOrderPayload();
        const first = await handleShopifyWebhookRequest(await webhookRequest(payload), workerEnv(), () => NOW);
        const duplicate = await handleShopifyWebhookRequest(await webhookRequest(payload, {
            webhookId: "a18d5ed5-70f9-4369-b451-d2f78bd1a16e",
        }), workerEnv(), () => NOW + 1000);
        expect(first?.status).toBe(202);
        expect(duplicate?.status).toBe(202);
        expect(await tableCount("shopify_webhook_inbox")).toBe(2);
        expect(await tableCount("paid_orders")).toBe(1);
        expect(await tableCount("paid_order_lines")).toBe(1);
    });
    it("lets concurrent duplicate deliveries claim the order only once", async () => {
        const payload = await validOrderPayload();
        const responses = await Promise.all([
            handleShopifyWebhookRequest(await webhookRequest(payload), workerEnv(), () => NOW),
            handleShopifyWebhookRequest(await webhookRequest(payload), workerEnv(), () => NOW),
        ]);
        const statuses = responses.map((response) => response?.status).sort();
        expect(statuses[0]).toBe(202);
        expect([202, 503]).toContain(statuses[1]);
        expect(await tableCount("shopify_webhook_inbox")).toBe(1);
        expect(await tableCount("paid_orders")).toBe(1);
        expect(await tableCount("paid_order_lines")).toBe(1);
    });
    it("rejects a reused webhook identifier carrying different content", async () => {
        const payload = await validOrderPayload();
        await handleShopifyWebhookRequest(await webhookRequest(payload), workerEnv());
        const conflict = await handleShopifyWebhookRequest(await webhookRequest({ ...payload, name: "#1002" }), workerEnv());
        expect(conflict?.status).toBe(409);
        expect(await conflict?.json()).toMatchObject({
            error: { code: "WEBHOOK_ID_CONFLICT" },
        });
    });
    it("routes a forged line to one exception without persisting any lines", async () => {
        const payload = await validOrderPayload();
        setFirstLineProperty(payload, `${readLineCapability(payload)}x`);
        const response = await handleShopifyWebhookRequest(await webhookRequest(payload), workerEnv(), () => NOW);
        expect(response?.status).toBe(202);
        expect(await tableCount("paid_orders")).toBe(1);
        expect(await tableCount("paid_order_lines")).toBe(0);
        expect((await openException())?.code).toBe("LINE_IDENTITY_INVALID");
    });
    it("routes a quantity mismatch to one exception without partial lines", async () => {
        const payload = await validOrderPayload();
        setFirstLineQuantity(payload, 3);
        const response = await handleShopifyWebhookRequest(await webhookRequest(payload), workerEnv(), () => NOW);
        expect(response?.status).toBe(202);
        expect(await tableCount("paid_order_lines")).toBe(0);
        expect((await openException())?.code).toBe("LINE_IDENTITY_INVALID");
    });
    it("creates an exception shell when the order capability is missing", async () => {
        const payload = await validOrderPayload();
        payload["note_attributes"] = [];
        const response = await handleShopifyWebhookRequest(await webhookRequest(payload), workerEnv(), () => NOW);
        expect(response?.status).toBe(202);
        const order = await testPlatform().env.DB.prepare(`
      SELECT order_management_capability_hash FROM paid_orders
    `).first<{
            order_management_capability_hash: string | null;
        }>();
        expect(order?.order_management_capability_hash).toBeNull();
        expect(await tableCount("paid_order_lines")).toBe(0);
        expect((await openException())?.code).toBe("ORDER_CAPABILITY_MISSING");
    });
    it("rejects invalid signatures and unexpected shops without persistence", async () => {
        const payload = await validOrderPayload();
        const invalidSignature = await handleShopifyWebhookRequest(await webhookRequest(payload, { signature: "invalid" }), workerEnv());
        const unexpectedShop = await handleShopifyWebhookRequest(await webhookRequest(payload, { shopDomain: "other.myshopify.com" }), workerEnv());
        expect(invalidSignature?.status).toBe(401);
        expect(unexpectedShop?.status).toBe(403);
        expect(await tableCount("shopify_webhook_inbox")).toBe(0);
    });
});
describe("Shopify paid-order hold reconciliation", () => {
    it.each([30, 60])("retries a catalogue refresh overlap at %i minutes without a permanent exception", async (minutes) => {
        const payload = await ingestValidOrder();
        const catalogueId = await publishOrderCatalogueRefresh();
        const time = NOW + minutes * 60 * 1000;
        const pending = await reconcilePaidOrderHolds(workerEnv(), adminOrderFetcher(payload), () => time);
        expect(pending).toMatchObject({ claimed: 1, retried: 1, exceptions: 0, locked: 0 });
        expect((await openException())?.code).toBe("VALIDATION_PENDING");
        expect(await paidOrderState()).toMatchObject({ production_lease_id: null, fulfilment_locked_at: null });
        expect(await tableCount("printify_fulfilment_orders")).toBe(0);
        await publishOrderMappingRefresh(catalogueId);
        const resumed = await reconcilePaidOrderHolds(workerEnv(), adminOrderFetcher(payload), () => time + 1000);
        expect(resumed).toMatchObject({ retried: 0, exceptions: 0, ...(minutes === 60 ? { locked: 1 } : { ready: 1 }) });
        expect(await openException()).toBeNull();
    });
    it("still rejects a real variant change after catalogue refresh completes", async () => {
        const payload = await ingestValidOrder();
        const catalogueId = await publishOrderCatalogueRefresh(0);
        await publishOrderMappingRefresh(catalogueId);
        const report = await reconcilePaidOrderHolds(workerEnv(), adminOrderFetcher(payload), () => NOW + 3600000);
        expect(report).toMatchObject({ exceptions: 1, locked: 0 });
        expect((await openException())?.code).toBe("LINE_IDENTITY_CHANGED");
    });
    it.each(["", "   "])("locks a validated order with a blank optional address line %j", async (address2) => {
        const payload = await ingestValidOrder();
        const report = await reconcilePaidOrderHolds(workerEnv(), adminOrderFetcher(payload, { address2 }), () => NOW + 60 * 60 * 1000);
        expect(report).toMatchObject({ locked: 1, retried: 0 });
        const order = await paidOrderState();
        expect(order?.status).toBe("fulfilment_locked");
        expect(order?.delivery_address_json).toContain('"address2":null');
        expect(await openException()).toBeNull();
    });
    it("retains a deleted design's order assets and still fulfils the paid order", async () => {
        const payload = await ingestValidOrder();
        const db = testPlatform().env.DB;
        const owner = "a".repeat(64);
        await db.prepare("UPDATE designs SET owner_id = ? WHERE id = ?").bind(owner, DESIGN_ID).run();
        const source = await db.prepare("SELECT artwork_key FROM designs WHERE id = ?")
            .bind(DESIGN_ID).first<{
            artwork_key: string;
        }>();
        const print = await db.prepare("SELECT storage_key FROM print_assets WHERE id = ?")
            .bind(ASSET_ID).first<{
            storage_key: string;
        }>();
        if (!source || !print)
            throw new Error("Expected order assets");
        const env = testPlatform().env;
        if (!env.STORY_VIDEOS)
            throw new Error("Expected video bucket");
        await env.DESIGN_ARTWORK.put(source.artwork_key, "source");
        await env.DESIGN_ARTWORK.put(`designs/${DESIGN_ID}/old-preview.webp`, "preview");
        await deleteOwnedDesign({ ...workerEnv(), STORY_VIDEOS: env.STORY_VIDEOS }, owner, DESIGN_ID);
        expect(await env.DESIGN_ARTWORK.head(source.artwork_key)).not.toBeNull();
        expect(await env.DESIGN_ARTWORK.head(print.storage_key)).not.toBeNull();
        expect(await env.DESIGN_ARTWORK.head(`designs/${DESIGN_ID}/old-preview.webp`)).toBeNull();
        expect((await db.prepare("SELECT status FROM products WHERE id = ?").bind(CONFIGURED_PRODUCT_ID).first())?.["status"]).toBe("deleted");
        const report = await reconcilePaidOrderHolds(workerEnv(), adminOrderFetcher(payload), () => NOW + 60 * 60 * 1000);
        expect(report.locked).toBe(1);
        expect(await openException()).toBeNull();
    });
    it.each(["suspended", "unpublished", "retired"])("retains a paid order in exception review when its product is %s", async (status) => {
        const payload = await ingestValidOrder();
        await testPlatform().env.DB.prepare("UPDATE products SET status = ? WHERE id = ?").bind(status, CONFIGURED_PRODUCT_ID).run();
        const report = await reconcilePaidOrderHolds(workerEnv(), adminOrderFetcher(payload), () => NOW + 60 * 60 * 1000);
        expect(report.locked).toBe(0);
        expect((await paidOrderState())?.status).toBe("exception_review");
        expect(await openException()).not.toBeNull();
    });
    it("moves a fully validated order into its remaining Production Hold", async () => {
        const payload = await ingestValidOrder();
        const report = await reconcilePaidOrderHolds(workerEnv(), adminOrderFetcher(payload), () => NOW + 30 * 60 * 1000);
        expect(report).toMatchObject({ claimed: 1, locked: 0, ready: 1 });
        const order = await paidOrderState();
        expect(order).toMatchObject({
            address_validation_result: "no_issues",
            fraud_result: "accept",
            production_lease_id: null,
            status: "production_hold",
        });
        expect(await openException()).toBeNull();
    });
    it("atomically locks an expired hold with its address and revokes management", async () => {
        const payload = await ingestValidOrder();
        const lockTime = NOW + 60 * 60 * 1000;
        const reports = await Promise.all([
            reconcilePaidOrderHolds(workerEnv(), adminOrderFetcher(payload), () => lockTime),
            reconcilePaidOrderHolds(workerEnv(), adminOrderFetcher(payload), () => lockTime),
        ]);
        expect(reports.reduce((total, report) => total + report.locked, 0)).toBe(1);
        const order = await paidOrderState();
        expect(order).toMatchObject({
            address_validation_result: "no_issues",
            fraud_result: "accept",
            fulfilment_locked_at: lockTime,
            production_lease_id: null,
            status: "fulfilment_locked",
            validation_checked_at: lockTime,
        });
        expect(order?.delivery_address_sha256).toMatch(/^[0-9a-f]{64}$/u);
        expect(order?.delivery_address_json).toContain('"countryCode":"AU"');
        expect(order?.delivery_address_json).toContain('"phone":"+61412345678"');
        const capability = await testPlatform().env.DB.prepare(`
      SELECT revoked_at FROM order_management_capabilities
    `).first<{
            revoked_at: number | null;
        }>();
        expect(capability?.revoked_at).toBe(lockTime);
        const line = await testPlatform().env.DB.prepare(`
      SELECT retail_price_minor_units FROM paid_order_lines
    `).first<{
            retail_price_minor_units: number | null;
        }>();
        expect(line?.retail_price_minor_units).toBe(7000);
    });
    it("keeps pending fraud retryable after hold expiry", async () => {
        const payload = await ingestValidOrder();
        const report = await reconcilePaidOrderHolds(workerEnv(), adminOrderFetcher(payload, { fraud: "PENDING" }), () => NOW + 60 * 60 * 1000);
        expect(report).toMatchObject({ claimed: 1, locked: 0, ready: 1 });
        expect(await paidOrderState()).toMatchObject({
            fraud_result: "pending",
            production_lease_id: null,
            status: "exception_review",
        });
        expect((await openException())?.code).toBe("VALIDATION_PENDING");
    });
    it("routes an invalid address to a stable exception at hold expiry", async () => {
        const payload = await ingestValidOrder();
        await reconcilePaidOrderHolds(workerEnv(), adminOrderFetcher(payload, { address: "WARNING" }), () => NOW + 60 * 60 * 1000);
        expect((await openException())?.code).toBe("ADDRESS_REVIEW_REQUIRED");
    });
    it("routes a changed line to a stable exception", async () => {
        const payload = await ingestValidOrder();
        await reconcilePaidOrderHolds(workerEnv(), adminOrderFetcher(payload, { quantity: 1 }), () => NOW + 60 * 60 * 1000);
        expect((await openException())?.code).toBe("LINE_IDENTITY_CHANGED");
        expect(await paidOrderState()).toMatchObject({ status: "exception_review" });
    });
    it("releases its lease when Shopify is unavailable", async () => {
        await ingestValidOrder();
        const unavailable = vi.fn<typeof fetch>(() => Promise.reject(new Error("offline")));
        const report = await reconcilePaidOrderHolds(workerEnv(), unavailable, () => NOW + 60 * 60 * 1000);
        expect(report).toMatchObject({ claimed: 1, retried: 1 });
        expect(await paidOrderState()).toMatchObject({
            production_lease_id: null,
            status: "exception_review",
        });
    });
});
describe("paid-order validation recovery", () => {
    async function recoverableOrder() {
        const payload = await ingestValidOrder();
        await reconcilePaidOrderHolds(workerEnv(), adminOrderFetcher(payload), () => NOW + 1000);
        const row = await testPlatform().env.DB.prepare("SELECT id FROM paid_orders").first<{
            id: string;
        }>();
        if (!row)
            throw new Error("Missing recovery fixture");
        await testPlatform().env.DB.batch([
            testPlatform().env.DB.prepare("UPDATE paid_orders SET status = 'exception_review', updated_at = ? WHERE id = ?").bind(NOW + 2000, row.id),
            testPlatform().env.DB.prepare(`INSERT INTO fulfilment_exceptions
        (id, paid_order_id, code, summary, status, created_at)
        VALUES (?, ?, 'LINE_IDENTITY_CHANGED', 'Refresh overlap', 'open', ?)`)
                .bind(`${row.id}:LINE_IDENTITY_CHANGED`, row.id, NOW + 2000),
        ]);
        return { payload, id: row.id };
    }
    const time = () => NOW + 3600000;
    it("plans without changing the order and recovers through normal validation and Printify submission", async () => {
        const { payload, id } = await recoverableOrder();
        const fetcher = adminOrderFetcher(payload);
        const plan = await recoverPaidOrderValidation(workerEnv(), id, undefined, fetcher, time);
        expect(plan).toMatchObject({ ready: true, orderMutations: false, providerMutations: false });
        expect((await openException())?.code).toBe("LINE_IDENTITY_CHANGED");
        if (!('planSha256' in plan) || typeof plan.planSha256 !== "string")
            throw new Error("Missing recovery plan");
        expect(await recoverPaidOrderValidation(workerEnv(), id, plan.planSha256, fetcher, time))
            .toMatchObject({ ready: true, orderMutations: true, normalValidationRequired: true });
        expect(await openException()).toBeNull();
        expect((await paidOrderState())?.status).toBe("exception_review");
        expect(await tableCount("printify_fulfilment_orders")).toBe(0);
        expect(await reconcilePaidOrderHolds(workerEnv(), fetcher, time)).toMatchObject({ locked: 1 });
        const printify = successfulPrintifyFetcher(await currentAssetSha256());
        await runScheduledPrintifyMaterialisation(workerEnv(), printify, () => time() + 1000);
        await runScheduledPrintifyOrderSubmission(workerEnv(), printify, () => time() + 2000);
        expect(await printifyOrderState()).toMatchObject({ status: "in_production", providerOrderId: "printify-order-1" });
        expect(await recoverPaidOrderValidation(workerEnv(), id, plan.planSha256, fetcher, time))
            .toMatchObject({ ready: false, code: "ORDER_NOT_RECOVERABLE" });
    });
    it.each(["line", "address", "fraud", "refresh", "asset", "exception", "revoked", "lease"])("refuses recovery when %s checks fail", async (failure) => {
        const { payload, id } = await recoverableOrder();
        const db = testPlatform().env.DB;
        if (failure === "refresh")
            await publishOrderCatalogueRefresh();
        if (failure === "asset") {
            const asset = await db.prepare("SELECT storage_key FROM print_assets WHERE id = ?").bind(ASSET_ID).first<{
                storage_key: string;
            }>();
            if (!asset)
                throw new Error("Missing asset");
            await testPlatform().env.DESIGN_ARTWORK.delete(asset.storage_key);
        }
        if (failure === "exception")
            await db.prepare(`INSERT INTO fulfilment_exceptions
      (id, paid_order_id, code, summary, status, created_at) VALUES ('other', ?, 'ADDRESS_REVIEW_REQUIRED', 'Other review', 'open', ?)`)
                .bind(id, NOW + 3000).run();
        if (failure === "revoked")
            await db.prepare("UPDATE order_management_capabilities SET revoked_at = ?").bind(NOW + 3000).run();
        if (failure === "lease")
            await db.prepare("UPDATE paid_orders SET production_lease_id = 'other', production_lease_expires_at = ?")
                .bind(time() + 60000).run();
        const fetcher = adminOrderFetcher(payload, {
            ...(failure === "line" ? { quantity: 1 } : {}),
            ...(failure === "address" ? { address: "WARNING" } : {}),
            ...(failure === "fraud" ? { fraud: "PENDING" } : {}),
        });
        expect(await recoverPaidOrderValidation(workerEnv(), id, undefined, fetcher, time)).toMatchObject({ ready: false });
        expect(await tableCount("printify_fulfilment_orders")).toBe(0);
        expect(await db.prepare("SELECT status FROM fulfilment_exceptions WHERE code = 'LINE_IDENTITY_CHANGED'").first())
            .toMatchObject({ status: "open" });
    });
    it("rejects a changed reviewed plan and resolves a concurrent unchanged plan once", async () => {
        const { payload, id } = await recoverableOrder();
        const plan = await recoverPaidOrderValidation(workerEnv(), id, undefined, adminOrderFetcher(payload), time);
        if (!('planSha256' in plan) || typeof plan.planSha256 !== "string")
            throw new Error("Missing recovery plan");
        expect(await recoverPaidOrderValidation(workerEnv(), id, plan.planSha256, adminOrderFetcher(payload, { address2: "Unit 2" }), time))
            .toMatchObject({ ready: false, code: "RECOVERY_PLAN_CHANGED" });
        const results = await Promise.all([
            recoverPaidOrderValidation(workerEnv(), id, plan.planSha256, adminOrderFetcher(payload), time),
            recoverPaidOrderValidation(workerEnv(), id, plan.planSha256, adminOrderFetcher(payload), time),
        ]);
        expect(results.filter(result => result.ready)).toHaveLength(1);
        expect(await tableCount("printify_fulfilment_orders")).toBe(0);
    });
    it("does not resolve the exception if another review appears during live validation", async () => {
        const { payload, id } = await recoverableOrder();
        const baseFetcher = adminOrderFetcher(payload);
        const plan = await recoverPaidOrderValidation(workerEnv(), id, undefined, baseFetcher, time);
        if (!('planSha256' in plan) || typeof plan.planSha256 !== "string")
            throw new Error("Missing recovery plan");
        const fetcher: typeof fetch = async (input, init) => {
            const response = await baseFetcher(input, init);
            if (!fetchInputUrl(input).endsWith("/admin/oauth/access_token")) {
                await testPlatform().env.DB.prepare(`INSERT INTO fulfilment_exceptions
          (id, paid_order_id, code, summary, status, created_at)
          VALUES ('concurrent-review', ?, 'ADDRESS_REVIEW_REQUIRED', 'Concurrent review', 'open', ?)`)
                    .bind(id, time()).run();
            }
            return response;
        };
        expect(await recoverPaidOrderValidation(workerEnv(), id, plan.planSha256, fetcher, time))
            .toMatchObject({ ready: false, code: "RECOVERY_STATE_CHANGED" });
        expect(await testPlatform().env.DB.prepare("SELECT status FROM fulfilment_exceptions WHERE code = 'LINE_IDENTITY_CHANGED'").first())
            .toMatchObject({ status: "open" });
    });
    it("requires the operations secret and owner identity and returns no customer fields", async () => {
        const { payload, id } = await recoverableOrder();
        const source = "a".repeat(40);
        const db = testPlatform().env.DB;
        const controls = await readFile(new URL("../sql/native-release-controls.sql", import.meta.url), "utf8");
        for (const sql of controls.split("--> statement-breakpoint"))
            await db.prepare(sql).run();
        await db.prepare("UPDATE native_video_release_control SET paused = 0, current_release_id = 'native-12345' WHERE singleton = 1").run();
        await db.prepare("INSERT OR IGNORE INTO native_video_release_events VALUES ('native-12345', 'verified', ?, ?)")
            .bind(JSON.stringify({ sourceCommit: source }), NOW).run();
        const env = { ...workerEnv(), BENT_SHIRT_OPERATIONS_SECRET: "recovery-secret", OPERATIONS_ENVIRONMENT: "development",
            STORY_VIDEO_RELEASE_ID: "native-12345", STORY_VIDEO_RELEASE_COMMIT: source };
        const body = JSON.stringify({ operation: "plan", orderId: id, expectedSource: source });
        const request = (secret: string) => new Request(`https://api.example.com${PAID_ORDER_RECOVERY_PATH}`, {
            method: "POST", body, headers: { "content-type": "application/json", "x-bent-shirt-operations-secret": secret },
        });
        const identity = { actor: "bentbrain", actorId: protectedConfig("githubOwnerId"), owner: true, runId: "12345" };
        expect((await handlePaidOrderRecoveryRequest(request("wrong"), env, () => Promise.resolve(identity)))?.status).toBe(401);
        expect((await handlePaidOrderRecoveryRequest(request("recovery-secret"), env, () => Promise.resolve({ ...identity, owner: false })))?.status).toBe(403);
        const response = await handlePaidOrderRecoveryRequest(request("recovery-secret"), env, () => Promise.resolve(identity), adminOrderFetcher(payload), time);
        expect(response?.status).toBe(200);
        const text = await response?.text();
        expect(text).not.toContain("Queen Street");
        expect(text).not.toContain("buyer@example.com");
        expect(text).not.toContain(readLineCapability(payload));
        expect((await handlePaidOrderRecoveryRequest(request("recovery-secret"), { ...env, STORY_VIDEO_RELEASE_COMMIT: "b".repeat(40) }, () => Promise.resolve(identity)))?.status).toBe(409);
        await db.prepare("UPDATE native_video_release_control SET paused = 1 WHERE singleton = 1").run();
        expect((await handlePaidOrderRecoveryRequest(request("recovery-secret"), env, () => Promise.resolve(identity)))?.status).toBe(409);
    });
});
const correctedAddress = { firstName: "Ada", lastName: "Lovelace", address1: "20 Queen Street", address2: "", city: "Brisbane", provinceCode: "QLD", zip: "4000", countryCode: "AU", phone: "+61412345678" };
const addressCommand = () => ({ commandId: crypto.randomUUID(), operation: "address", address: correctedAddress });
const cancelCommand = () => ({ commandId: crypto.randomUUID(), operation: "cancel", confirmation: "CANCEL AND REFUND" });
async function managementCall(fetcher: typeof fetch, input?: unknown, time = NOW + 1000, capability = ORDER_CAPABILITY, method = input ? "POST" : "GET") {
    const request = new Request(`https://api.example.com${ORDER_MANAGEMENT_PATH}`, { method, headers: { "content-type": "application/json", "x-forever-tee-service-secret": "management-service", "x-order-management-capability": capability }, ...(input ? { body: JSON.stringify(input) } : {}) });
    const response = await handleOrderManagementRequest(request, { ...workerEnv(), FOREVER_TEE_API_SHARED_SECRET: "management-service" }, fetcher, () => time);
    if (!response)
        throw new Error("Missing management response");
    return response;
}
function capabilityState() { return testPlatform().env.DB.prepare("SELECT token_hash, revoked_at, bound_at FROM order_management_capabilities").first<{
    token_hash: string;
    revoked_at: number | null;
    bound_at: number | null;
}>(); }
function managementFetcher(payload: Record<string, unknown>, options: {
    refundComplete?: boolean;
    reject?: boolean;
    ambiguous?: boolean;
} = {}) {
    const reader = adminOrderFetcher(payload);
    return vi.fn<typeof fetch>(async (input, init) => {
        if (fetchInputUrl(input).endsWith("/admin/oauth/access_token"))
            return Response.json({ access_token: "management-token", expires_in: 86399, scope: "read_orders,write_orders" });
        const body = requestBody(init);
        if (body.includes("mutation BentShirt")) {
            if (options.ambiguous)
                throw new Error("Connection lost after send");
            if (body.includes("BentShirtUpdateAddress"))
                return Response.json({ data: { orderUpdate: { order: { id: "gid://shopify/Order/1001" }, userErrors: options.reject ? [{ message: "Invalid address" }] : [] } } });
            if (body.includes("BentShirtCancelOrder"))
                return Response.json({ data: { orderCancel: { job: { id: "gid://shopify/Job/test", done: false }, orderCancelUserErrors: [] } } });
        }
        if (body.includes("BentShirtRefundState"))
            return Response.json({ data: { order: { id: "gid://shopify/Order/1001", cancelledAt: options.refundComplete ? "2026-08-30T00:01:00Z" : null, displayFinancialStatus: options.refundComplete ? "REFUNDED" : "PAID", totalRefundedSet: { presentmentMoney: { amount: options.refundComplete ? "70.00" : "0.00", currencyCode: "AUD" } } } } });
        return reader(input, init);
    });
}
function gate() {
    let release: (() => void) | undefined;
    const wait = new Promise<void>(resolve => { release = resolve; });
    return { wait, release: () => { if (!release)
            throw new Error("Missing gate"); release(); } };
}
describe("one-hour order management", () => {
    it("allows repeated scanner-safe reads without changing the order or capability and excludes private fields from audits", async () => {
        const payload = await ingestValidOrder();
        const before = await paidOrderState(), hashBefore = await capabilityState();
        const fetcher = managementFetcher(payload);
        const order = await testPlatform().env.DB.prepare("SELECT id FROM paid_orders").first<{
            id: string;
        }>();
        if (!order)
            throw new Error("Paid-order fixture is missing.");
        const subjectHash = await sha256Hex(order.id);
        // Opaque audit IDs and subject hashes may contain the order's digits.
        const firstAuditId = "00001001-0000-4000-8000-000000000001";
        const secondAuditId = "00001001-0000-4000-8000-000000000002";
        const auditIds = vi.spyOn(crypto, "randomUUID")
            .mockReturnValueOnce(firstAuditId)
            .mockReturnValueOnce(secondAuditId);
        try {
            const response = await managementCall(fetcher);
            expect(response.status).toBe(200);
            expect(await response.json()).toMatchObject({ orderName: "#1001", deadline: new Date(NOW + 3600000).toISOString(), address: { address1: "1 Queen Street" } });
            expect((await managementCall(fetcher)).status).toBe(200);
            expect(await paidOrderState()).toEqual(before);
            expect(await capabilityState()).toEqual(hashBefore);
            expect(await tableCount("order_management_commands")).toBe(0);
            const logs = await testPlatform().env.DB.prepare("SELECT * FROM order_management_access_log ORDER BY id").all();
            expect(logs.results).toEqual([firstAuditId, secondAuditId].map(id => ({
                id,
                subject_hash: subjectHash,
                actor: "customer:capability",
                action: "read",
                occurred_at: NOW + 1000,
            })));
            expect((await managementCall(fetcher, undefined, NOW + 1000, ORDER_CAPABILITY, "HEAD")).status).toBe(405);
        }
        finally {
            auditIds.mockRestore();
        }
    });
    it("allows repeated address corrections without extending the deadline or replaying a command", async () => {
        const payload = await ingestValidOrder(), fetcher = managementFetcher(payload);
        const first = addressCommand();
        expect((await managementCall(fetcher, first)).status).toBe(200);
        expect((await managementCall(fetcher, first)).status).toBe(200);
        expect((await managementCall(fetcher, { ...addressCommand(), address: { ...correctedAddress, address1: "30 Queen Street" } })).status).toBe(200);
        const writes = fetcher.mock.calls.filter(([, init]) => requestBody(init).includes("mutation BentShirtUpdateAddress"));
        expect(writes).toHaveLength(2);
        expect(requestBody(writes[0]?.[1])).toContain('"country":"Australia"');
        expect(requestBody(writes[0]?.[1])).not.toContain('"countryCode"');
        expect((await testPlatform().env.DB.prepare("SELECT production_hold_expires_at FROM paid_orders").first<{
            production_hold_expires_at: number;
        }>())?.production_hold_expires_at).toBe(NOW + 3600000);
        expect((await capabilityState())?.revoked_at).toBeNull();
        expect((await managementCall(fetcher, { ...first, address: { ...correctedAddress, city: "Other" } })).status).toBe(409);
    });
    it("rejects invalid addresses and capability reuse after expiry or lock", async () => {
        const payload = await ingestValidOrder(), fetcher = managementFetcher(payload);
        expect((await managementCall(fetcher, { ...addressCommand(), address: { ...correctedAddress, countryCode: "US" } })).status).toBe(400);
        expect((await managementCall(fetcher, undefined, NOW + 1000, "x".repeat(43))).status).toBe(410);
        expect((await managementCall(fetcher, undefined, NOW + 1000, "bad")).status).toBe(410);
        expect((await managementCall(fetcher, addressCommand(), NOW + 3600000)).status).toBe(410);
        await reconcilePaidOrderHolds(workerEnv(), adminOrderFetcher(payload), () => NOW + 3600000);
        expect((await managementCall(fetcher)).status).toBe(410);
        expect((await managementCall(fetcher, cancelCommand())).status).toBe(410);
    });
    it("atomically revokes cancellation access, requests one full refund and reconciles actual refund completion", async () => {
        const payload = await ingestValidOrder(), fetcher = managementFetcher(payload), command = cancelCommand();
        expect((await managementCall(fetcher, command)).status).toBe(202);
        expect((await managementCall(fetcher, command)).status).toBe(202);
        expect((await managementCall(fetcher)).status).toBe(410);
        expect((await managementCall(fetcher, cancelCommand())).status).toBe(410);
        const writes = fetcher.mock.calls.filter(([, init]) => requestBody(init).includes("mutation BentShirtCancelOrder"));
        expect(writes).toHaveLength(1);
        expect(requestBody(writes[0]?.[1])).toContain("originalPaymentMethodsRefund: true");
        expect(requestBody(writes[0]?.[1])).toContain("notifyCustomer: true");
        await reconcileOrderManagement(workerEnv(), fetcher, () => NOW + 5000);
        expect((await paidOrderState())?.status).not.toBe("refunded");
        await reconcileOrderManagement(workerEnv(), managementFetcher(payload, { refundComplete: true }), () => NOW + 6000);
        expect((await paidOrderState())?.status).toBe("refunded");
        expect(await (await managementCall(fetcher, command)).json()).toMatchObject({ status: "succeeded" });
    });
    it("keeps production blocked after an ambiguous address response and expired lease", async () => {
        const payload = await ingestValidOrder(), fetcher = managementFetcher(payload, { ambiguous: true }), command = addressCommand();
        expect(await (await managementCall(fetcher, command)).json()).toMatchObject({ status: "ambiguous" });
        expect(await (await managementCall(fetcher, command)).json()).toMatchObject({ status: "ambiguous" });
        const report = await reconcilePaidOrderHolds(workerEnv(), adminOrderFetcher(payload), () => NOW + 3600000);
        expect(report.locked).toBe(0);
        expect((await testPlatform().env.DB.prepare("SELECT status FROM fulfilment_exceptions WHERE code = 'ORDER_MANAGEMENT_PENDING'").first<{
            status: string;
        }>())?.status).toBe("open");
    });
    it("lets the customer correct a definite address rejection", async () => {
        const payload = await ingestValidOrder();
        expect(await (await managementCall(managementFetcher(payload, { reject: true }), addressCommand())).json()).toMatchObject({ status: "rejected" });
        expect(await (await managementCall(managementFetcher(payload), addressCommand())).json()).toMatchObject({ status: "succeeded" });
    });
    it("allows only one address or cancellation request to own the order lease", async () => {
        const payload = await ingestValidOrder(), fetcher = managementFetcher(payload), started = gate(), finish = gate();
        const held = vi.fn<typeof fetch>(async (input, init) => {
            if (requestBody(init).includes("mutation BentShirtUpdateAddress")) {
                started.release();
                await finish.wait;
            }
            return fetcher(input, init);
        });
        const first = managementCall(held, addressCommand());
        await started.wait;
        expect((await managementCall(fetcher, cancelCommand())).status).toBe(409);
        const report = await reconcilePaidOrderHolds(workerEnv(), adminOrderFetcher(payload), () => NOW + 3600000);
        expect(report.locked).toBe(0);
        finish.release();
        expect((await first).status).toBe(200);
    });
});
describe("existing Printify product recovery", () => {
    const lockTime = NOW + 3600000;
    async function failedProduct() {
        const payload = await ingestValidOrder();
        await reconcilePaidOrderHolds(workerEnv(), adminOrderFetcher(payload), () => lockTime);
        let valid = false;
        const provider = successfulPrintifyFetcher(await currentAssetSha256(), (request, method) => {
            if (method === "POST")
                return { id: "printify-product-1" };
            const product = expandedPrintifyProductResponse(request);
            return valid ? product : { ...product, variants: product.variants.map(variant => ({ ...variant, sku: "" })) };
        });
        await runScheduledPrintifyMaterialisation(workerEnv(), provider, () => lockTime + 1000);
        expect((await openException())?.code).toBe("PRINTIFY_PRODUCT_READBACK_FAILED");
        valid = true;
        provider.mockClear();
        const db = testPlatform().env.DB;
        const row = await db.prepare(`SELECT o.id AS orderId, p.id AS productId,
      p.provider_product_id AS providerProductId, p.request_sha256 AS requestSha256
      FROM paid_orders o, printify_production_products p`).first<{
            orderId: string;
            productId: string;
            providerProductId: string;
            requestSha256: string;
        }>();
        if (!row)
            throw new Error("Missing failed resource");
        const controls = await readFile(new URL("../sql/native-release-controls.sql", import.meta.url), "utf8");
        for (const sql of controls.split("--> statement-breakpoint"))
            await db.prepare(sql).run();
        await db.prepare("UPDATE native_video_release_control SET paused = 0, current_release_id = 'native-12345' WHERE singleton = 1").run();
        const shopify = adminOrderFetcher(payload);
        const fetcher: typeof fetch = (input, init) => new URL(fetchInputUrl(input)).hostname === "api.printify.com"
            ? provider(input, init) : shopify(input, init);
        return { payload, target: row, provider, fetcher };
    }
    const time = () => lockTime + 2000;
    it("plans read-only and resumes the existing product through normal verification and submission", async () => {
        const fixture = await failedProduct();
        const plan = await recoverPaidOrderProduct(workerEnv(), fixture.target, "native-12345", undefined, fixture.fetcher, time);
        expect(plan).toMatchObject({ ready: true, orderMutations: false, providerMutations: false });
        expect((await openException())?.code).toBe("PRINTIFY_PRODUCT_READBACK_FAILED");
        expect(await productionResourceState()).toMatchObject({ productStatus: "failed", productId: fixture.target.providerProductId });
        expect(fixture.provider.mock.calls.every(([input, init]) => new Request(input, init).method === "GET")).toBe(true);
        if (!('planSha256' in plan))
            throw new Error("Missing plan hash");
        expect(await recoverPaidOrderProduct(workerEnv(), fixture.target, "native-12345", plan.planSha256, fixture.fetcher, time))
            .toMatchObject({ ready: true, orderMutations: true, providerMutations: false, normalVerificationRequired: true });
        expect(await openException()).toBeNull();
        expect(await tableCount("printify_fulfilment_orders")).toBe(0);
        fixture.provider.mockClear();
        await runScheduledPrintifyMaterialisation(workerEnv(), fixture.provider, () => time() + 1000);
        expect(await productionResourceState()).toMatchObject({ productStatus: "ready", productId: fixture.target.providerProductId });
        expect(fixture.provider.mock.calls.every(([input, init]) => new Request(input, init).method === "GET")).toBe(true);
        await runScheduledPrintifyOrderSubmission(workerEnv(), fixture.provider, () => time() + 2000);
        expect(await printifyOrderState()).toMatchObject({ status: "in_production", providerOrderId: "printify-order-1" });
        expect(await recoverPaidOrderProduct(workerEnv(), fixture.target, "native-12345", plan.planSha256, fixture.fetcher, time))
            .toMatchObject({ ready: false, code: "PRODUCT_NOT_RECOVERABLE" });
    });
    it.each(["line", "address", "fraud", "asset", "lease", "other exception", "suspended", "target hash"])("refuses a changed %s without resolving the exception", async (failure) => {
        const fixture = await failedProduct(), db = testPlatform().env.DB;
        if (failure === "asset") {
            const asset = await db.prepare("SELECT storage_key FROM print_assets WHERE id = ?").bind(ASSET_ID).first<{
                storage_key: string;
            }>();
            if (!asset)
                throw new Error("Missing asset");
            await testPlatform().env.DESIGN_ARTWORK.delete(asset.storage_key);
        }
        if (failure === "lease")
            await db.prepare("UPDATE printify_production_products SET lease_id = 'other', lease_expires_at = 1788003660000").run();
        if (failure === "suspended")
            await db.prepare("UPDATE products SET status = 'suspended' WHERE id = ?").bind(CONFIGURED_PRODUCT_ID).run();
        if (failure === "other exception")
            await db.prepare(`INSERT INTO fulfilment_exceptions
        (id, paid_order_id, code, summary, status, created_at) VALUES ('other', ?, 'ADDRESS_REVIEW_REQUIRED', 'Review', 'open', ?)`)
                .bind(fixture.target.orderId, time()).run();
        const shopify = adminOrderFetcher(fixture.payload, {
            ...(failure === "line" ? { quantity: 1 } : {}),
            ...(failure === "address" ? { address: "WARNING" } : {}),
            ...(failure === "fraud" ? { fraud: "PENDING" } : {}),
        });
        const fetcher: typeof fetch = (input, init) => new URL(fetchInputUrl(input)).hostname === "api.printify.com"
            ? fixture.provider(input, init) : shopify(input, init);
        const target = failure === "target hash" ? { ...fixture.target, requestSha256: "a".repeat(64) } : fixture.target;
        expect(await recoverPaidOrderProduct(workerEnv(), target, "native-12345", undefined, fetcher, time)).toMatchObject({ ready: false });
        expect(await db.prepare("SELECT status FROM fulfilment_exceptions WHERE code = 'PRINTIFY_PRODUCT_READBACK_FAILED'").first())
            .toMatchObject({ status: "open" });
        expect(await tableCount("printify_fulfilment_orders")).toBe(0);
    });
    it("rejects an unreviewed hash and does not clear a concurrent review", async () => {
        const fixture = await failedProduct();
        const plan = await recoverPaidOrderProduct(workerEnv(), fixture.target, "native-12345", undefined, fixture.fetcher, time);
        if (!('planSha256' in plan))
            throw new Error("Missing plan hash");
        expect(await recoverPaidOrderProduct(workerEnv(), fixture.target, "native-12345", "a".repeat(64), fixture.fetcher, time))
            .toMatchObject({ ready: false, code: "RECOVERY_PLAN_CHANGED" });
        const fetcher: typeof fetch = async (input, init) => {
            const result = await fixture.fetcher(input, init);
            if (new URL(fetchInputUrl(input)).hostname === "api.printify.com")
                await testPlatform().env.DB.prepare(`INSERT INTO fulfilment_exceptions
        (id, paid_order_id, code, summary, status, created_at) VALUES ('concurrent', ?, 'OTHER', 'Review', 'open', ?)`)
                    .bind(fixture.target.orderId, time()).run();
            return result;
        };
        expect(await recoverPaidOrderProduct(workerEnv(), fixture.target, "native-12345", plan.planSha256, fetcher, time))
            .toMatchObject({ ready: false, code: "RECOVERY_STATE_CHANGED" });
        expect(await productionResourceState()).toMatchObject({ productStatus: "failed" });
        expect(await testPlatform().env.DB.prepare("SELECT status FROM fulfilment_exceptions WHERE code = 'PRINTIFY_PRODUCT_READBACK_FAILED'").first())
            .toMatchObject({ status: "open" });
    });
    it.each(["sku", "placement"])("rejects a changed existing provider product %s", async (field) => {
        const fixture = await failedProduct();
        const fetcher: typeof fetch = async (input, init) => {
            const response = await fixture.fetcher(input, init);
            if (new URL(fetchInputUrl(input)).hostname !== "api.printify.com")
                return response;
            const product = Schema.decodeUnknownSync(PrintifyProductionProductSchema)(await response.json());
            return Response.json({ ...product,
                variants: field === "sku" ? product.variants.map(variant => variant.is_enabled ? { ...variant, sku: "different-sku" } : variant) : product.variants,
                print_areas: field === "placement" ? product.print_areas.map(area => ({ ...area,
                    placeholders: area.placeholders.map(placeholder => ({ ...placeholder,
                        images: placeholder.images.map(image => ({ ...image, x: 0.4 })),
                    })),
                })) : product.print_areas,
            });
        };
        expect(await recoverPaidOrderProduct(workerEnv(), fixture.target, "native-12345", undefined, fetcher, time))
            .toMatchObject({ ready: false, code: "EXISTING_PRODUCT_IDENTITY_CHANGED" });
        expect(await productionResourceState()).toMatchObject({ productStatus: "failed" });
    });
    it("requires the exact owner product workflow and Production order before reading dependencies", async () => {
        const env = { ...workerEnv(), BENT_SHIRT_OPERATIONS_SECRET: "recovery-secret", OPERATIONS_ENVIRONMENT: "production" };
        const identity = { actor: "bentbrain", actorId: protectedConfig("githubOwnerId"), owner: true, runId: "12345" };
        const request = () => new Request(`https://api.example.com${PAID_ORDER_PRODUCT_RECOVERY_PATH}`, {
            method: "POST", headers: { "content-type": "application/json", "x-bent-shirt-operations-secret": "recovery-secret" },
            body: JSON.stringify({ operation: "plan", orderId: crypto.randomUUID(), expectedSource: "a".repeat(40) }),
        });
        expect((await handlePaidOrderRecoveryRequest(request(), env, () => Promise.resolve({ ...identity, owner: false })))?.status).toBe(403);
        expect((await handlePaidOrderRecoveryRequest(request(), env, () => Promise.resolve(identity)))?.status).toBe(400);
    });
});
describe("existing Printify order recovery", () => {
    const lockTime = NOW + 3600000;
    const time = () => lockTime + 243000;
    async function failedOrder() {
        const payload = await ingestValidOrder();
        const shopify = adminOrderFetcher(payload, { phone: null });
        await reconcilePaidOrderHolds(workerEnv(), shopify, () => lockTime);
        let matching = false;
        const provider = successfulPrintifyFetcher(await currentAssetSha256(), expandedPrintifyProductResponse, (request, sha) => {
            const response = printifyOrderResponse(request, sha);
            return { ...response, address_to: { ...response.address_to, phone: "61400000000", zip: matching ? response.address_to.zip : "9999" } };
        });
        await runScheduledPrintifyMaterialisation(workerEnv(), provider, () => lockTime + 1000);
        for (let attempt = 0; attempt < 5; attempt++) {
            await runScheduledPrintifyOrderSubmission(workerEnv(), provider, () => lockTime + 2000 + attempt * 60000);
        }
        expect((await openException())?.code).toBe("PRINTIFY_ORDER_MISMATCH");
        matching = true;
        provider.mockClear();
        const db = testPlatform().env.DB;
        const target = await db.prepare(`SELECT paid_order_id AS orderId, id AS fulfilmentId,
      provider_order_id AS providerOrderId, request_sha256 AS requestSha256 FROM printify_fulfilment_orders`).first<{
            orderId: string;
            fulfilmentId: string;
            providerOrderId: string;
            requestSha256: string;
        }>();
        if (!target)
            throw new Error("Missing existing order fixture");
        const controls = await readFile(new URL("../sql/native-release-controls.sql", import.meta.url), "utf8");
        for (const sql of controls.split("--> statement-breakpoint"))
            await db.prepare(sql).run();
        await db.prepare("UPDATE native_video_release_control SET paused = 0, current_release_id = 'native-12345' WHERE singleton = 1").run();
        const fetcher: typeof fetch = (input, init) => new URL(fetchInputUrl(input)).hostname === "api.printify.com"
            ? provider(input, init) : shopify(input, init);
        return { target, provider, fetcher, payload, mismatch: () => { matching = false; } };
    }
    it("plans and resumes one existing order, then normally verifies and submits without another creation", async () => {
        const fixture = await failedOrder();
        const plan = await recoverPaidOrderProvider(workerEnv(), fixture.target, "native-12345", undefined, fixture.fetcher, time);
        expect(plan).toMatchObject({ ready: true, orderMutations: false, providerMutations: false });
        expect((await openException())?.code).toBe("PRINTIFY_ORDER_MISMATCH");
        expect(fixture.provider.mock.calls.every(([input, init]) => new Request(input, init).method === "GET")).toBe(true);
        if (!("planSha256" in plan))
            throw new Error("Missing recovery plan hash");
        expect(await recoverPaidOrderProvider(workerEnv(), fixture.target, "native-12345", plan.planSha256, fixture.fetcher, time))
            .toMatchObject({ ready: true, orderMutations: true, providerMutations: false, normalVerificationRequired: true });
        expect(await openException()).toBeNull();
        fixture.provider.mockClear();
        expect(await runScheduledPrintifyOrderSubmission(workerEnv(), fixture.provider, () => lockTime + 244000))
            .toMatchObject({ candidates: 1, created: 0, verified: 1, submitted: 1 });
        expect(await runScheduledPrintifyOrderSubmission(workerEnv(), fixture.provider, () => lockTime + 245000))
            .toMatchObject({ candidates: 0, submitted: 0 });
        expect(await tableCount("printify_fulfilment_orders")).toBe(1);
        expect(await printifyOrderState()).toMatchObject({ providerOrderId: fixture.target.providerOrderId, status: "in_production" });
        const writes = fixture.provider.mock.calls.filter(([input, init]) => new Request(input, init).method === "POST");
        expect(writes).toHaveLength(1);
        expect(fetchInputUrl(writes[0]?.[0] ?? "")).toContain(`/${fixture.target.providerOrderId}/send_to_production.json`);
        expect(await recoverPaidOrderProvider(workerEnv(), fixture.target, "native-12345", plan.planSha256, fixture.fetcher, time))
            .toMatchObject({ ready: false, code: "ORDER_NOT_RECOVERABLE" });
    });
    it("rejects stale hashes and mismatched provider identity without resolving anything", async () => {
        const fixture = await failedOrder();
        expect(await recoverPaidOrderProvider(workerEnv(), fixture.target, "native-12345", "a".repeat(64), fixture.fetcher, time))
            .toMatchObject({ ready: false, code: "RECOVERY_PLAN_CHANGED" });
        fixture.mismatch();
        expect(await recoverPaidOrderProvider(workerEnv(), fixture.target, "native-12345", undefined, fixture.fetcher, time))
            .toMatchObject({ ready: false, code: "EXISTING_ORDER_IDENTITY_CHANGED" });
        expect((await openException())?.code).toBe("PRINTIFY_ORDER_MISMATCH");
    });
    it.each(["lease", "submitted", "verified", "request hash", "provider ID", "other exception", "product lease", "shipment", "inactive product"])("rejects changed existing-order eligibility: %s", async (change) => {
        const fixture = await failedOrder();
        const db = testPlatform().env.DB;
        if (change === "lease")
            await db.prepare("UPDATE printify_fulfilment_orders SET lease_id = 'active', lease_expires_at = ?").bind(lockTime + 60000).run();
        if (change === "submitted")
            await db.prepare("UPDATE printify_fulfilment_orders SET submitted_at = ?").bind(NOW).run();
        if (change === "verified")
            await db.prepare("UPDATE printify_fulfilment_orders SET verified_at = ?").bind(NOW).run();
        if (change === "request hash")
            await db.prepare("UPDATE printify_fulfilment_orders SET request_sha256 = ?").bind("a".repeat(64)).run();
        if (change === "provider ID")
            await db.prepare("UPDATE printify_fulfilment_orders SET provider_order_id = 'other'").run();
        if (change === "other exception")
            await db.prepare("UPDATE fulfilment_exceptions SET code = 'OTHER'").run();
        if (change === "product lease")
            await db.prepare("UPDATE printify_production_products SET lease_id = 'active', lease_expires_at = ?").bind(lockTime + 60000).run();
        if (change === "shipment")
            await db.prepare("UPDATE printify_fulfilment_order_lines SET shipped_quantity = 1").run();
        if (change === "inactive product")
            await db.prepare("UPDATE products SET status = 'archived'").run();
        expect(await recoverPaidOrderProvider(workerEnv(), fixture.target, "native-12345", undefined, fixture.fetcher, time))
            .toMatchObject({ ready: false });
        expect(await printifyOrderState()).toMatchObject({ status: "failed" });
        expect(fixture.provider.mock.calls).toHaveLength(0);
    });
    it.each(["quantity", "address", "fraud"])("rechecks live Shopify before reading or resuming the provider order: %s", async (change) => {
        const fixture = await failedOrder();
        const shopify = adminOrderFetcher(fixture.payload, { phone: null,
            ...(change === "quantity" ? { quantity: 1 } : {}),
            ...(change === "address" ? { address2: "Changed" } : {}),
            ...(change === "fraud" ? { fraud: "PENDING" } : {}),
        });
        const fetcher: typeof fetch = (input, init) => new URL(fetchInputUrl(input)).hostname === "api.printify.com"
            ? fixture.provider(input, init) : shopify(input, init);
        expect(await recoverPaidOrderProvider(workerEnv(), fixture.target, "native-12345", undefined, fetcher, time))
            .toMatchObject({ ready: false });
        expect(fixture.provider.mock.calls).toHaveLength(0);
        expect((await openException())?.code).toBe("PRINTIFY_ORDER_MISMATCH");
    });
    it("requires the owner and fixed Production order before dependencies", async () => {
        const env = { ...workerEnv(), BENT_SHIRT_OPERATIONS_SECRET: "recovery-secret", OPERATIONS_ENVIRONMENT: "production" };
        const identity = { actor: "bentbrain", actorId: protectedConfig("githubOwnerId"), owner: true, runId: "12345" };
        const request = () => new Request(`https://api.example.com${PAID_ORDER_PROVIDER_RECOVERY_PATH}`, {
            method: "POST", headers: { "content-type": "application/json", "x-bent-shirt-operations-secret": "recovery-secret" },
            body: JSON.stringify({ operation: "plan", orderId: crypto.randomUUID(), expectedSource: "a".repeat(40) }),
        });
        expect((await handlePaidOrderRecoveryRequest(request(), env, () => Promise.resolve({ ...identity, owner: false })))?.status).toBe(403);
        expect((await handlePaidOrderRecoveryRequest(request(), env, () => Promise.resolve(identity)))?.status).toBe(400);
    });
    it.each([protectedConfig("resource_5df53ebae4ae"), protectedConfig("resource_5ba68fa39a92")])("requires a verified deployed source for reviewed provider recovery: %s", async (orderId) => {
        const env = { ...workerEnv(), BENT_SHIRT_OPERATIONS_SECRET: "recovery-secret", OPERATIONS_ENVIRONMENT: "production" };
        const identity = { actor: "bentbrain", actorId: protectedConfig("githubOwnerId"), owner: true, runId: "12345" };
        const request = () => new Request(`https://api.example.com${PAID_ORDER_PROVIDER_RECOVERY_PATH}`, {
            method: "POST", headers: { "content-type": "application/json", "x-bent-shirt-operations-secret": "recovery-secret" },
            body: JSON.stringify({ operation: "plan", orderId, expectedSource: "a".repeat(40) }),
        });
        const response = await handlePaidOrderRecoveryRequest(request(), env, () => Promise.resolve(identity));
        expect(response?.status).toBe(409);
        expect(await response?.json()).toEqual({ code: "RECOVERY_SOURCE_MISMATCH" });
        expect((await handlePaidOrderRecoveryRequest(request(), { ...env, OPERATIONS_ENVIRONMENT: "development" }, () => Promise.resolve(identity)))?.status).toBe(400);
    });
    it("atomically refuses resumption when the released pipeline is paused after plan review", async () => {
        const fixture = await failedOrder();
        const plan = await recoverPaidOrderProvider(workerEnv(), fixture.target, "native-12345", undefined, fixture.fetcher, time);
        if (!("planSha256" in plan))
            throw new Error("Missing recovery plan hash");
        await testPlatform().env.DB.prepare("UPDATE native_video_release_control SET paused = 1 WHERE singleton = 1").run();
        expect(await recoverPaidOrderProvider(workerEnv(), fixture.target, "native-12345", plan.planSha256, fixture.fetcher, time))
            .toMatchObject({ ready: false, code: "RECOVERY_STATE_CHANGED" });
        expect((await openException())?.code).toBe("PRINTIFY_ORDER_MISMATCH");
        expect(await printifyOrderState()).toMatchObject({ status: "failed" });
        expect(fixture.provider.mock.calls.every(([input, init]) => new Request(input, init).method === "GET")).toBe(true);
    });
});
describe("Printify production materialisation", () => {
    it("shares provider cooldowns between clients without making another provider request", async () => {
        const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(new Response(null, {
            status: 429, headers: { "retry-after": "120" },
        })));
        const request = () => Effect.runPromise(Effect.gen(function* () {
            const client = yield* PrintifyProductionClient;
            return yield* client.getProduct("product-123");
        }).pipe(Effect.provide(makePrintifyProductionClientLayer(workerEnv(), fetcher)), Effect.either));
        for (let index = 0; index < 2; index += 1) {
            const result = await request();
            expect(Either.isLeft(result)).toBe(true);
            if (Either.isLeft(result)) {
                expect(result.left._tag).toBe("PrintifyProductionRateLimitError");
                if (result.left._tag === "PrintifyProductionRateLimitError") {
                    expect(result.left.retryAfterSeconds).toBeGreaterThan(110);
                }
            }
        }
        expect(fetcher).toHaveBeenCalledOnce();
    });
    it.each(["suspended", "unpublished", "retired"])("blocks new provider resources after Fulfilment Lock when the product is %s", async (status) => {
        const payload = await ingestValidOrder();
        const lockTime = NOW + 60 * 60 * 1000;
        await reconcilePaidOrderHolds(workerEnv(), adminOrderFetcher(payload), () => lockTime);
        await testPlatform().env.DB.prepare("UPDATE products SET status = ? WHERE id = ?").bind(status, CONFIGURED_PRODUCT_ID).run();
        const fetcher = successfulPrintifyFetcher(await currentAssetSha256());
        const report = await runScheduledPrintifyMaterialisation(workerEnv(), fetcher, () => lockTime + 1000);
        expect(report.candidates).toBe(0);
        expect(fetcher).not.toHaveBeenCalled();
    });
    it("checks lifecycle again between provider media and product creation", async () => {
        const payload = await ingestValidOrder();
        const lockTime = NOW + 60 * 60 * 1000;
        await reconcilePaidOrderHolds(workerEnv(), adminOrderFetcher(payload), () => lockTime);
        const provider = successfulPrintifyFetcher(await currentAssetSha256());
        const fetcher = vi.fn<typeof fetch>(async (input, init) => {
            const response = await provider(input, init);
            await testPlatform().env.DB.prepare("UPDATE products SET status = 'suspended' WHERE id = ?").bind(CONFIGURED_PRODUCT_ID).run();
            return response;
        });
        const report = await runScheduledPrintifyMaterialisation(workerEnv(), fetcher, () => lockTime + 1000);
        expect(report.productsReady).toBe(0);
        expect(fetcher.mock.calls.every(([input]) => !(input instanceof Request ? input.url : input.toString()).includes("/products.json"))).toBe(true);
    });
    it.each(["suspended", "unpublished", "retired"])("blocks an order with ready provider resources when the product is %s", async (status) => {
        const payload = await ingestValidOrder();
        const lockTime = NOW + 60 * 60 * 1000;
        await reconcilePaidOrderHolds(workerEnv(), adminOrderFetcher(payload), () => lockTime);
        const fetcher = successfulPrintifyFetcher(await currentAssetSha256());
        await runScheduledPrintifyMaterialisation(workerEnv(), fetcher, () => lockTime + 1000);
        fetcher.mockClear();
        await testPlatform().env.DB.prepare("UPDATE products SET status = ? WHERE id = ?").bind(status, CONFIGURED_PRODUCT_ID).run();
        const report = await runScheduledPrintifyOrderSubmission(workerEnv(), fetcher, () => lockTime + 2000);
        expect(report.submitted).toBe(0);
        expect(fetcher).not.toHaveBeenCalled();
    });
    it("checks lifecycle again before sending a verified provider order to production", async () => {
        const payload = await ingestValidOrder();
        const lockTime = NOW + 60 * 60 * 1000;
        await reconcilePaidOrderHolds(workerEnv(), adminOrderFetcher(payload), () => lockTime);
        const provider = successfulPrintifyFetcher(await currentAssetSha256());
        await runScheduledPrintifyMaterialisation(workerEnv(), provider, () => lockTime + 1000);
        const fetcher = vi.fn<typeof fetch>(async (input, init) => {
            const response = await provider(input, init);
            await testPlatform().env.DB.prepare("UPDATE products SET status = 'suspended' WHERE id = ?").bind(CONFIGURED_PRODUCT_ID).run();
            return response;
        });
        const report = await runScheduledPrintifyOrderSubmission(workerEnv(), fetcher, () => lockTime + 2000);
        expect(report.submitted).toBe(0);
        expect(fetcher.mock.calls.every(([input]) => !(input instanceof Request ? input.url : input.toString()).includes("send_to_production"))).toBe(true);
    });
    it("creates and verifies one exact internal product idempotently", async () => {
        const payload = await ingestValidOrder();
        const lockTime = NOW + 60 * 60 * 1000;
        await reconcilePaidOrderHolds(workerEnv(), adminOrderFetcher(payload), () => lockTime);
        const fetcher = successfulPrintifyFetcher(await currentAssetSha256());
        const first = await runScheduledPrintifyMaterialisation(workerEnv(), fetcher, () => lockTime + 1000);
        const second = await runScheduledPrintifyMaterialisation(workerEnv(), fetcher, () => lockTime + 2000);
        expect(first).toEqual({
            candidates: 1,
            disabled: false,
            exceptions: 0,
            mediaReady: 1,
            productsReady: 1,
            retried: 0,
        });
        expect(second).toMatchObject({
            candidates: 0,
            exceptions: 0,
            mediaReady: 0,
            productsReady: 0,
        });
        expect(fetcher).toHaveBeenCalledTimes(4);
        expect(await productionResourceState()).toEqual({
            mediaId: "printify-image-1",
            mediaStatus: "ready",
            productId: "printify-product-1",
            productStatus: "ready",
        });
        expect(await openException()).toBeNull();
    });
    it.each(["expanded readback", "create acknowledgement"])("verifies a provider product with %s without recreating it", async (scenario) => {
        const payload = await ingestValidOrder();
        const lockTime = NOW + 60 * 60 * 1000;
        await reconcilePaidOrderHolds(workerEnv(), adminOrderFetcher(payload), () => lockTime);
        const fetcher = successfulPrintifyFetcher(await currentAssetSha256(), (request, method) => {
            if (scenario === "create acknowledgement" && method === "POST")
                return { id: "printify-product-1" };
            return scenario === "expanded readback" ? expandedPrintifyProductResponse(request) : printifyProductResponse(request);
        });
        const first = await runScheduledPrintifyMaterialisation(workerEnv(), fetcher, () => lockTime + 1000);
        expect(first.productsReady).toBe(1);
        expect(await productionResourceState()).toMatchObject({ productStatus: "ready", productId: "printify-product-1" });
        await runScheduledPrintifyMaterialisation(workerEnv(), fetcher, () => lockTime + 2000);
        expect(fetcher.mock.calls.filter(([input, init]) => new Request(input, init).method === "POST" && fetchInputUrl(input).endsWith("/products.json"))).toHaveLength(1);
        expect(await openException()).toBeNull();
    });
    it.each(["extra enabled variant", "printed back", "wrong image", "wrong sku", "wrong placement", "duplicate selected area"])("rejects an expanded product with %s", async (mismatch) => {
        const payload = await ingestValidOrder();
        const lockTime = NOW + 60 * 60 * 1000;
        await reconcilePaidOrderHolds(workerEnv(), adminOrderFetcher(payload), () => lockTime);
        const fetcher = successfulPrintifyFetcher(await currentAssetSha256(), request => {
            const product = expandedPrintifyProductResponse(request);
            const selected = product.variants[0];
            const disabled = product.variants[1];
            const area = product.print_areas[0];
            const front = area?.placeholders[0];
            const back = area?.placeholders[1];
            const image = front?.images[0];
            if (!selected || !disabled || !area || !front || !back || !image)
                throw new Error("Product fixture missing.");
            if (mismatch === "extra enabled variant") {
                disabled.is_enabled = true;
                disabled.sku = "unexpected-enabled-sku";
            }
            if (mismatch === "printed back")
                back.images.push(image);
            if (mismatch === "wrong image")
                image.id = "different-image";
            if (mismatch === "wrong sku")
                selected.sku = "different-sku";
            if (mismatch === "wrong placement")
                image.x = 0.4;
            if (mismatch === "duplicate selected area")
                product.print_areas.push(area);
            return product;
        });
        const result = await runScheduledPrintifyMaterialisation(workerEnv(), fetcher, () => lockTime + 1000);
        expect(result.productsReady).toBe(0);
        expect((await openException())?.code).toBe("PRINTIFY_PRODUCT_MISMATCH");
        expect((await productionResourceState()).productId).toBe("printify-product-1");
    });
    it("stops after an upload response becomes ambiguous", async () => {
        const payload = await ingestValidOrder();
        const lockTime = NOW + 60 * 60 * 1000;
        await reconcilePaidOrderHolds(workerEnv(), adminOrderFetcher(payload), () => lockTime);
        const fetcher = vi.fn<typeof fetch>(() => Promise.reject(new Error("connection lost after request")));
        const report = await runScheduledPrintifyMaterialisation(workerEnv(), fetcher, () => lockTime + 1000);
        expect(report).toMatchObject({
            candidates: 1,
            exceptions: 1,
            mediaReady: 0,
            productsReady: 0,
        });
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect((await openException())?.code).toBe("PRINTIFY_MEDIA_AMBIGUOUS");
        expect(await productionResourceState()).toEqual({
            mediaId: null,
            mediaStatus: "ambiguous",
            productId: null,
            productStatus: null,
        });
    });
    it.each(["complete", "null company", "missing shipments", "missing production timestamp", "phone prefix", "provider phone when omitted", "observed pending response"])("creates, verifies, and submits one exact Printify order idempotently: %s", async (responseShape) => {
        const payload = await ingestValidOrder();
        const lockTime = NOW + 60 * 60 * 1000;
        await reconcilePaidOrderHolds(workerEnv(), adminOrderFetcher(payload, responseShape === "provider phone when omitted" ? { phone: null } : {}), () => lockTime);
        const fetcher = successfulPrintifyFetcher(await currentAssetSha256(), expandedPrintifyProductResponse, (request, sha) => {
            const response = printifyOrderResponse(request, sha);
            if (responseShape === "provider phone when omitted") {
                expect(request.address_to.phone).toBeUndefined();
                return { ...response, address_to: { ...response.address_to, phone: "61400000000" } };
            }
            if (responseShape === "phone prefix")
                return { ...response, address_to: { ...response.address_to, phone: response.address_to.phone?.replace(/^\+/u, "") } };
            if (responseShape === "null company")
                return { ...response, address_to: { ...response.address_to, company: null } };
            if (responseShape === "missing shipments")
                return { ...response, shipments: undefined };
            if (responseShape === "missing production timestamp")
                return { ...response, sent_to_production_at: undefined };
            if (responseShape === "observed pending response")
                return {
                    ...response, address_to: { ...response.address_to, company: null, phone: response.address_to.phone?.replace(/^\+/u, "") },
                    shipments: undefined, sent_to_production_at: undefined,
                    line_items: response.line_items.map(line => ({ ...line, external_id: undefined })),
                };
            return response;
        });
        await runScheduledPrintifyMaterialisation(workerEnv(), fetcher, () => lockTime + 1000);
        const first = await runScheduledPrintifyOrderSubmission(workerEnv(), fetcher, () => lockTime + 2000);
        const second = await runScheduledPrintifyOrderSubmission(workerEnv(), fetcher, () => lockTime + 3000);
        expect(first).toEqual({
            candidates: 1,
            created: 1,
            disabled: false,
            exceptions: 0,
            retried: 0,
            submitted: 1,
            verified: 1,
        });
        expect(second).toMatchObject({ candidates: 0, submitted: 0 });
        expect(await printifyOrderState()).toEqual({
            lineCount: 1,
            providerOrderId: "printify-order-1",
            status: "in_production",
        });
    });
    it.each(["status", "phone", "address", "SKU"])("rechecks a temporary order mismatch and submits the same existing order once: %s", async (difference) => {
        const payload = await ingestValidOrder();
        const lockTime = NOW + 60 * 60 * 1000;
        await reconcilePaidOrderHolds(workerEnv(), adminOrderFetcher(payload), () => lockTime);
        let reads = 0;
        const fetcher = successfulPrintifyFetcher(await currentAssetSha256(), expandedPrintifyProductResponse, (request, sha) => {
            const response = printifyOrderResponse(request, sha);
            reads += 1;
            if (reads > 1)
                return response;
            if (difference === "phone")
                return { ...response, address_to: { ...response.address_to, phone: "61400000000" } };
            if (difference === "address")
                return { ...response, address_to: { ...response.address_to, zip: "9999" } };
            if (difference === "SKU")
                return { ...response, line_items: response.line_items.map(line => ({ ...line, metadata: { ...line.metadata, sku: "other" } })) };
            return { ...response, status: "pending" };
        });
        await runScheduledPrintifyMaterialisation(workerEnv(), fetcher, () => lockTime + 1000);
        const first = await runScheduledPrintifyOrderSubmission(workerEnv(), fetcher, () => lockTime + 2000);
        expect(first).toMatchObject({ created: 1, exceptions: 0, retried: 1, submitted: 0, verified: 0 });
        expect(await printifyOrderState()).toMatchObject({ providerOrderId: "printify-order-1", status: "verifying" });
        expect(await openException()).toBeNull();
        const early = await runScheduledPrintifyOrderSubmission(workerEnv(), fetcher, () => lockTime + 3000);
        expect(early).toMatchObject({ candidates: 0, submitted: 0 });
        expect(reads).toBe(1);
        const next = await runScheduledPrintifyOrderSubmission(workerEnv(), fetcher, () => lockTime + 62000);
        expect(next).toMatchObject({ created: 0, exceptions: 0, submitted: 1, verified: 1 });
        expect(await printifyOrderState()).toMatchObject({ providerOrderId: "printify-order-1", status: "in_production" });
        await runScheduledPrintifyOrderSubmission(workerEnv(), fetcher, () => lockTime + 122000);
        const calls = fetcher.mock.calls.map(([input, options]) => new Request(input, options));
        expect(calls.filter(request => request.method === "POST" && new URL(request.url).pathname.endsWith("/orders.json"))).toHaveLength(1);
        expect(calls.filter(request => new URL(request.url).pathname.endsWith("/send_to_production.json"))).toHaveLength(1);
    });
    it("records mismatch field names without customer or provider values", async () => {
        const payload = await ingestValidOrder();
        const lockTime = NOW + 60 * 60 * 1000;
        await reconcilePaidOrderHolds(workerEnv(), adminOrderFetcher(payload), () => lockTime);
        const sensitive = "PRIVATE_PROVIDER_VALUE";
        const fetcher = successfulPrintifyFetcher(await currentAssetSha256(), printifyProductResponse, (request, sha) => ({
            ...printifyOrderResponse(request, sha), status: sensitive,
        }));
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
        try {
            await runScheduledPrintifyMaterialisation(workerEnv(), fetcher, () => lockTime + 1000);
            await runScheduledPrintifyOrderSubmission(workerEnv(), fetcher, () => lockTime + 2000);
            await runScheduledPrintifyOrderSubmission(workerEnv(), fetcher, () => lockTime + 302000);
            expect(warn).toHaveBeenCalledWith("bent.shop Printify order identity will be rechecked", expect.objectContaining({ mismatchFields: ["order.status"] }));
            expect(error).toHaveBeenCalledWith("bent.shop Printify order identity requires reconciliation", expect.objectContaining({ mismatchFields: ["order.status"] }));
            const summary = await testPlatform().env.DB.prepare("SELECT summary FROM fulfilment_exceptions WHERE status='open'").first();
            expect(JSON.stringify([summary, warn.mock.calls, error.mock.calls])).not.toContain(sensitive);
        }
        finally {
            warn.mockRestore();
            error.mockRestore();
        }
    });
    it("stops verification when the mismatch window expires before the attempt limit", async () => {
        const payload = await ingestValidOrder();
        const lockTime = NOW + 60 * 60 * 1000;
        await reconcilePaidOrderHolds(workerEnv(), adminOrderFetcher(payload), () => lockTime);
        const fetcher = successfulPrintifyFetcher(await currentAssetSha256(), printifyProductResponse, (request, sha) => ({
            ...printifyOrderResponse(request, sha), status: "pending",
        }));
        await runScheduledPrintifyMaterialisation(workerEnv(), fetcher, () => lockTime + 1000);
        expect(await runScheduledPrintifyOrderSubmission(workerEnv(), fetcher, () => lockTime + 2000))
            .toMatchObject({ retried: 1, exceptions: 0, submitted: 0 });
        expect(await runScheduledPrintifyOrderSubmission(workerEnv(), fetcher, () => lockTime + 302000))
            .toMatchObject({ retried: 0, exceptions: 1, submitted: 0 });
        expect(await testPlatform().env.DB.prepare("SELECT attempt_count FROM printify_fulfilment_orders").first())
            .toEqual({ attempt_count: 2 });
        expect(await testPlatform().env.DB.prepare("SELECT code,summary FROM fulfilment_exceptions WHERE status='open'").first())
            .toEqual({ code: "PRINTIFY_ORDER_MISMATCH", summary: "The Printify order identity differs at: order.status." });
        expect(await runScheduledPrintifyOrderSubmission(workerEnv(), fetcher, () => lockTime + 362000))
            .toMatchObject({ candidates: 0, submitted: 0 });
    });
    it.each(["address", "phone digits", "missing phone", "SKU", "production timestamp", "provider", "malformed shipments"])("never submits a mismatched order readback: %s", async (difference) => {
        const payload = await ingestValidOrder();
        const lockTime = NOW + 60 * 60 * 1000;
        const hold = await reconcilePaidOrderHolds(workerEnv(), adminOrderFetcher(payload), () => lockTime);
        const fetcher = successfulPrintifyFetcher(await currentAssetSha256(), printifyProductResponse, (request, sha) => {
            const response = printifyOrderResponse(request, sha);
            if (difference === "phone digits")
                return { ...response, address_to: { ...response.address_to, phone: "61400000000" } };
            if (difference === "missing phone")
                return { ...response, address_to: { ...response.address_to, phone: undefined } };
            if (difference === "address")
                return { ...response, address_to: { ...response.address_to, zip: "9999" } };
            if (difference === "SKU")
                return { ...response, line_items: response.line_items.map(line => ({ ...line, metadata: { ...line.metadata, sku: "other" } })) };
            if (difference === "provider")
                return { ...response, line_items: response.line_items.map(line => ({ ...line, print_provider_id: 999 })) };
            if (difference === "production timestamp")
                return { ...response, sent_to_production_at: "2026-09-07T00:00:00Z" };
            return { ...response, shipments: null };
        });
        const materialisation = await runScheduledPrintifyMaterialisation(workerEnv(), fetcher, () => lockTime + 1000);
        let result = await runScheduledPrintifyOrderSubmission(workerEnv(), fetcher, () => lockTime + 2000);
        if (difference !== "malformed shipments") {
            expect(result).toMatchObject({ created: 1, exceptions: 0, retried: 1, submitted: 0, verified: 0 });
            for (let attempt = 1; attempt < 5; attempt++) {
                result = await runScheduledPrintifyOrderSubmission(workerEnv(), fetcher, () => lockTime + 2000 + attempt * 60000);
                expect(result).toMatchObject({ created: 0, exceptions: attempt === 4 ? 1 : 0, submitted: 0, verified: 0 });
            }
        }
        // Read only status/codes on failure, so cloud qualification can distinguish
        // an earlier prerequisite failure without logging addresses or credentials.
        const diagnostics = result.exceptions === 1 && result.submitted === 0 && result.verified === 0
            ? undefined
            : JSON.stringify({ hold, materialisation, state: await paidOrderFixtureState().catch(() => ({ readFailed: true })) });
        expect(result, diagnostics).toMatchObject({ exceptions: 1, submitted: 0, verified: 0 });
        expect(await printifyOrderState()).toMatchObject({ providerOrderId: "printify-order-1", status: "failed" });
        const urls = fetcher.mock.calls.map(([input]) => typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        expect(urls.some(url => url.includes("send_to_production"))).toBe(false);
    });
    it("fences an expired order mutation lease for manual reconciliation", async () => {
        await prepareInProductionOrder();
        await testPlatform().env.DB.prepare(`
      UPDATE printify_fulfilment_orders
      SET status = 'creating', lease_id = 'expired-order-lease',
        lease_expires_at = ?
    `).bind(NOW + 3000).run();
        const report = await runScheduledPrintifyOrderSubmission(workerEnv(), successfulPrintifyFetcher(await currentAssetSha256()), () => NOW + 4000);
        expect(report).toMatchObject({ candidates: 0, exceptions: 1 });
        expect(await printifyOrderState()).toMatchObject({ status: "ambiguous" });
        expect((await openException())?.code).toBe("PRINTIFY_ORDER_LEASE_EXPIRED");
    });
});
describe("scheduled Printify D1 diagnostics", () => {
    const sensitive = "PRIVATE_SQL_BINDING customer@example.com token=private";
    const cyclicCause = { cause: {}, code: sensitive };
    cyclicCause.cause = cyclicCause;
    const unreadableCause = Object.defineProperties({}, {
        code: { get() { throw new Error(sensitive); } },
        cause: { get() { throw new Error(sensitive); } },
    });
    const failures = [
        { label: "nested busy error", cause: new Error(sensitive, { cause: Object.assign(new Error(sensitive), { code: "SQLITE_BUSY" }) }), category: "busy", code: "SQLITE_BUSY" },
        { label: "capacity error", cause: { code: "SQLITE_FULL", message: sensitive }, category: "capacity", code: "SQLITE_FULL" },
        { label: "oversized error", cause: { code: "SQLITE_TOOBIG", message: sensitive }, category: "capacity", code: "SQLITE_TOOBIG" },
        { label: "D1 error", cause: { code: "D1_ERROR", message: sensitive }, category: "d1_error", code: "D1_ERROR" },
        { label: "D1 execution error", cause: { code: "D1_EXEC_ERROR", message: sensitive }, category: "d1_error", code: "D1_EXEC_ERROR" },
        { label: "cyclic cause", cause: cyclicCause, category: "unknown", code: "unknown" },
        { label: "accessor cause", cause: unreadableCause, category: "unknown", code: "unknown" },
        { label: "uninspectable cause", cause: new Proxy({}, { getOwnPropertyDescriptor() { throw new Error(sensitive); } }), category: "unknown", code: "unknown" },
        { label: "unsafe serializer", cause: { code: "SQLITE_BUSY", toJSON() { throw new Error(sensitive); } }, category: "busy", code: "SQLITE_BUSY" },
        { label: "undefined rejection", cause: undefined, category: "unknown", code: "unknown" },
        { label: "constraint error", cause: Object.assign(new Error(sensitive), { code: "SQLITE_CONSTRAINT" }), category: "constraint", code: "SQLITE_CONSTRAINT" },
        { label: "unknown code and name", cause: Object.assign(new Error(sensitive), { name: sensitive, code: sensitive }), category: "unknown", code: "unknown" },
        { label: "message-only known code", cause: new Error(`SQLITE_BUSY ${sensitive}`), category: "unknown", code: "unknown" },
        { label: "non-Error code", cause: { code: "SQLITE_LOCKED", message: sensitive, sql: sensitive, bindings: [sensitive] }, category: "busy", code: "SQLITE_LOCKED" },
        { label: "string rejection", cause: sensitive, category: "unknown", code: "unknown" },
        { label: "null rejection", cause: null, category: "unknown", code: "unknown" },
    ];
    for (const seam of ["fence", "candidate"]) {
        it.each(failures)(`keeps safe diagnostics for ${seam}: $label`, async ({ cause, category, code }) => {
            const db = testPlatform().env.DB;
            const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
            const provider = vi.fn<typeof fetch>(() => Promise.reject(new Error("Unexpected provider request")));
            const originalPrepare = db.prepare.bind(db);
            const batch = vi.fn(db.batch.bind(db));
            const prepare = vi.fn(originalPrepare);
            const rejectRead = vi.fn<() => Promise<never>>().mockRejectedValue(cause);
            if (seam === "fence")
                batch.mockRejectedValueOnce(cause);
            else
                prepare.mockImplementation(query => {
                    const statement = originalPrepare(query);
                    if (query.includes("SELECT paid.id, paid.shopify_order_name AS label")) {
                        const originalBind = statement.bind.bind(statement);
                        return new Proxy(statement, { get(target, property) {
                                if (property === "bind")
                                    return (...values: unknown[]) => new Proxy(originalBind(...values), {
                                        get(bound, key) {
                                            const value: unknown = key === "all" ? rejectRead : Reflect.get(bound, key, bound);
                                            return value;
                                        },
                                    });
                                const value: unknown = Reflect.get(target, property, target);
                                return value;
                            } });
                    }
                    return statement;
                });
            const failingDb = new Proxy(db, { get(target, property) {
                    if (property === "batch")
                        return batch;
                    if (property === "prepare")
                        return prepare;
                    const value: unknown = Reflect.get(target, property, target);
                    return value;
                } });
            try {
                // This is the same submission/observability composition used by the scheduler.
                let wrapped: unknown;
                const observed = observeBackgroundTask("printify_order_submission", {
                    OPERATIONS_ENVIRONMENT: "production", STORY_VIDEO_RELEASE_ID: "native-123",
                    STORY_VIDEO_RELEASE_COMMIT: "a".repeat(40),
                }, async () => {
                    try {
                        return await runScheduledPrintifyOrderSubmission({ ...workerEnv(), DB: failingDb }, provider, () => NOW);
                    }
                    catch (error) {
                        wrapped = error;
                        throw error;
                    }
                });
                await expect(observed).rejects.toThrow(/^Application execution failed\. Diagnostic reference: [a-f0-9-]{36}$/);
                await expect(observed).rejects.not.toHaveProperty("cause");
                expect(wrapped).toBeDefined();
                expect(JSON.stringify(wrapped)).not.toContain(sensitive);
                expect(log).toHaveBeenCalledExactlyOnceWith("bent.shop background task failed", expect.objectContaining({
                    operation: "printify_order_submission", environment: "production", releaseId: "native-123",
                    sourceCommit: "a".repeat(40),
                    databaseOperation: seam === "fence" ? "fence_expired_leases" : "read_order_candidates",
                    databaseErrorCategory: category, databaseErrorCode: code,
                }));
                const record: unknown = log.mock.calls[0]?.[1];
                if (typeof record !== "object" || record === null || !("executionId" in record) || typeof record.executionId !== "string")
                    throw new Error("Missing execution correlation");
                expect(record.executionId).toMatch(/^[a-f0-9-]{36}$/);
                await expect(observed).rejects.toHaveProperty("message", `Application execution failed. Diagnostic reference: ${record.executionId}`);
                expect(JSON.stringify(log.mock.calls)).not.toMatch(/PRIVATE_SQL_BINDING|customer@example|token=private|SQLITE_BUSY PRIVATE/);
                expect(batch).toHaveBeenCalledTimes(1);
                expect(prepare).toHaveBeenCalledTimes(seam === "fence" ? 3 : 4);
                expect(rejectRead).toHaveBeenCalledTimes(seam === "fence" ? 0 : 1);
                expect(provider).not.toHaveBeenCalled();
            }
            finally {
                vi.restoreAllMocks();
            }
        });
    }
});
describe("Printify shipment reconciliation", () => {
    it("sends one notification with both item lines for one parcel", async () => {
        const skus = await prepareInProductionOrder(true);
        if (!skus.secondarySku)
            throw new Error("Second SKU fixture is missing.");
        const shopify = shopifyFulfilmentFetcher(true);
        for (const [index, sku] of [skus.primarySku, skus.secondarySku].entries()) {
            await handlePrintifyWebhookRequest(await printifyWebhookRequest(printifyShipmentEvent({
                eventId: `parcel-item-${String(index)}`, sku, trackingNumber: "ONE-PARCEL", type: "created",
                carrierCode: "AUSTRALIA_POST", trackingUrl: "https://parcelsapp.com/tracking/ONE-PARCEL",
            })), workerEnv(), () => NOW + index * 12000);
        }
        expect(shopify.fetcher).not.toHaveBeenCalled();
        await runScheduledPrintifyShipmentReconciliation(workerEnv(), shopify.fetcher, () => NOW + 120000);
        expect(shopify.fetcher).not.toHaveBeenCalled();
        await runScheduledPrintifyShipmentReconciliation(workerEnv(), shopify.fetcher, () => NOW + 133000);
        const mutations = shopify.fetcher.mock.calls.filter(([, init]) => requestBody(init).includes("BentShirtCreateFulfilment"));
        expect(mutations).toHaveLength(1);
        const body = requestBody(mutations[0]?.[1]);
        expect(body).toContain('"notifyCustomer":true');
        expect(body).toContain('"company":"Australia Post"');
        expect(body).toContain('"url":"https://auspost.com.au/track/ONE-PARCEL"');
        expect(body).not.toContain("parcelsapp.com");
        expect(body).toContain("FulfillmentOrderLineItem/5001");
        expect(body).toContain("FulfillmentOrderLineItem/5002");
        expect(await shipmentState()).toMatchObject({ shipmentCount: 1, paidOrderStatus: "fulfilled" });
    });
    it("does not send a second notification for an item reported after parcel submission", async () => {
        const skus = await prepareInProductionOrder(true);
        if (!skus.secondarySku)
            throw new Error("Second SKU fixture is missing.");
        const shopify = shopifyFulfilmentFetcher(true);
        await handlePrintifyWebhookRequest(await printifyWebhookRequest(printifyShipmentEvent({
            eventId: "early-item", sku: skus.primarySku, trackingNumber: "ONE-PARCEL", type: "created",
        })), workerEnv(), () => NOW);
        await runScheduledPrintifyShipmentReconciliation(workerEnv(), shopify.fetcher, () => NOW + 180000);
        await handlePrintifyWebhookRequest(await printifyWebhookRequest(printifyShipmentEvent({
            eventId: "late-item", sku: skus.secondarySku, trackingNumber: "ONE-PARCEL", type: "created",
        })), workerEnv(), () => NOW + 181000);
        await runScheduledPrintifyShipmentReconciliation(workerEnv(), shopify.fetcher, () => NOW + 360000);
        expect(shopify.fetcher.mock.calls.filter(([, init]) => requestBody(init).includes("BentShirtCreateFulfilment"))).toHaveLength(1);
        expect((await openException())?.code).toBe("PRINTIFY_PARCEL_LINES_AFTER_SUBMISSION");
        expect(await shipmentState()).toMatchObject({ shipmentCount: 1, paidOrderStatus: "fulfilment_locked" });
    });
    it("retains delivery received during the Shopify request and fences a second scheduler", async () => {
        const skus = await prepareInProductionOrder();
        const shopify = shopifyFulfilmentFetcher(false);
        await handlePrintifyWebhookRequest(await printifyWebhookRequest(printifyShipmentEvent({
            eventId: "before-request", sku: skus.primarySku, trackingNumber: "ONE-PARCEL", type: "created",
        })), workerEnv(), () => NOW);
        const started = gate(), finish = gate();
        const paused: typeof fetch = async (input, init) => {
            if (requestBody(init).includes("BentShirtCreateFulfilment")) {
                started.release();
                await finish.wait;
            }
            return shopify.fetcher(input, init);
        };
        const first = runScheduledPrintifyShipmentReconciliation(workerEnv(), paused, () => NOW + 180000);
        await started.wait;
        try {
            await runScheduledPrintifyShipmentReconciliation(workerEnv(), paused, () => NOW + 181000);
            await handlePrintifyWebhookRequest(await printifyWebhookRequest(printifyShipmentEvent({
                eventId: "during-request", sku: skus.primarySku, trackingNumber: "ONE-PARCEL", type: "delivered",
            })), workerEnv(), () => NOW + 181000);
        }
        finally {
            finish.release();
        }
        await first;
        expect(shopify.fetcher.mock.calls.filter(([, init]) => requestBody(init).includes("BentShirtCreateFulfilment"))).toHaveLength(1);
        expect(await shipmentState()).toMatchObject({ delivered: 1, paidOrderStatus: "fulfilled" });
    });
    it("fulfils both items when separate events share a tracking number", async () => {
        const skus = await prepareInProductionOrder(true);
        if (!skus.secondarySku)
            throw new Error("Second SKU fixture is missing.");
        const shopify = shopifyFulfilmentFetcher(true);
        for (const [index, sku] of [skus.primarySku, skus.secondarySku, skus.primarySku, skus.secondarySku].entries()) {
            const response = await handlePrintifyWebhookRequest(await printifyWebhookRequest(printifyShipmentEvent({
                eventId: `shared-package-${String(index)}`, sku, trackingNumber: "ONE-PACKAGE", type: "created",
            })), workerEnv(), () => NOW + 4000 + index);
            expect(response?.status).toBe(200);
        }
        await runScheduledPrintifyShipmentReconciliation(workerEnv(), shopify.fetcher, () => NOW + 180000);
        expect(shopify.quantities).toEqual([2, 1]);
        expect(await shipmentState()).toMatchObject({ fulfilledLines: 3, paidOrderStatus: "fulfilled" });
        expect(await openException()).toBeNull();
    });
    it("accepts overlapping and reordered SKU lists without repeating fulfilments", async () => {
        const skus = await prepareInProductionOrder(true);
        if (!skus.secondarySku)
            throw new Error("Second SKU fixture is missing.");
        const shopify = shopifyFulfilmentFetcher(true);
        for (const [index, selected] of [[skus.primarySku], [skus.secondarySku, skus.primarySku],
            [skus.primarySku, skus.secondarySku]].entries()) {
            const response = await handlePrintifyWebhookRequest(await printifyWebhookRequest(printifyShipmentEvent({
                eventId: `overlap-${String(index)}`, sku: selected, trackingNumber: "ONE-PACKAGE", type: "created",
            })), workerEnv(), () => NOW + index);
            expect(response?.status).toBe(200);
        }
        const delivered = await handlePrintifyWebhookRequest(await printifyWebhookRequest(printifyShipmentEvent({
            eventId: "overlap-delivered", sku: [skus.secondarySku, skus.primarySku], trackingNumber: "ONE-PACKAGE", type: "delivered",
        })), workerEnv(), () => NOW + 5000);
        expect(delivered?.status).toBe(200);
        await runScheduledPrintifyShipmentReconciliation(workerEnv(), shopify.fetcher, () => NOW + 180000);
        expect(shopify.quantities).toEqual([2, 1]);
        expect(await shipmentState()).toMatchObject({ delivered: 1, fulfilledLines: 3, paidOrderStatus: "fulfilled" });
    });
    it.each(["unknown SKU", "different tracking"])("rejects %s after a package has been recorded", async (difference) => {
        const skus = await prepareInProductionOrder();
        const shopify = shopifyFulfilmentFetcher(false);
        await handlePrintifyWebhookRequest(await printifyWebhookRequest(printifyShipmentEvent({
            eventId: "valid-package", sku: skus.primarySku, trackingNumber: "ONE-PACKAGE", type: "created",
        })), workerEnv(), () => NOW);
        await handlePrintifyWebhookRequest(await printifyWebhookRequest(printifyShipmentEvent({
            eventId: "changed-package", sku: difference === "unknown SKU" ? "unknown" : skus.primarySku,
            trackingNumber: difference === "different tracking" ? "ANOTHER-PACKAGE" : "ONE-PACKAGE", type: "created",
        })), workerEnv(), () => NOW + 1000);
        expect(await openException()).not.toBeNull();
        expect(shopify.quantities).toEqual([]);
    });
    it("reserves overlapping concurrent events once and retries the losing delivery", async () => {
        const skus = await prepareInProductionOrder(true);
        if (!skus.secondarySku)
            throw new Error("Second SKU fixture is missing.");
        const shopify = shopifyFulfilmentFetcher(true);
        const events = [printifyShipmentEvent({ eventId: "concurrent-one", sku: skus.primarySku,
                trackingNumber: "ONE-PACKAGE", type: "created" }), printifyShipmentEvent({ eventId: "concurrent-both",
                sku: [skus.primarySku, skus.secondarySku], trackingNumber: "ONE-PACKAGE", type: "created" })];
        await Promise.all(events.map(async (event) => handlePrintifyWebhookRequest(await printifyWebhookRequest(event), workerEnv(), () => NOW)));
        for (const event of events) {
            const response = await handlePrintifyWebhookRequest(await printifyWebhookRequest(event), workerEnv(), () => NOW + 1000);
            expect(response?.status).toBe(200);
        }
        await runScheduledPrintifyShipmentReconciliation(workerEnv(), shopify.fetcher, () => NOW + 180000);
        expect([...shopify.quantities].sort()).toEqual([1, 2]);
        expect(shopify.fetcher.mock.calls.filter(([, init]) => requestBody(init).includes("BentShirtCreateFulfilment"))).toHaveLength(1);
        expect(await shipmentState()).toMatchObject({ fulfilledLines: 3, paidOrderStatus: "fulfilled" });
        expect(await openException()).toBeNull();
    });
    it("does not finish an order while another reserved parcel is still failed", async () => {
        const skus = await prepareInProductionOrder(true);
        if (!skus.secondarySku)
            throw new Error("Second SKU fixture is missing.");
        const shopify = shopifyFulfilmentFetcher(true);
        let reads = 0;
        const rateLimited: typeof fetch = (input, init) => requestBody(init).includes("BentShirtFulfilmentOrders") && reads++ === 0
            ? Promise.resolve(new Response(null, { status: 429 })) : shopify.fetcher(input, init);
        await handlePrintifyWebhookRequest(await printifyWebhookRequest(printifyShipmentEvent({ eventId: "failed-primary",
            sku: skus.primarySku, trackingNumber: "PRIMARY", type: "created" })), workerEnv(), () => NOW);
        await handlePrintifyWebhookRequest(await printifyWebhookRequest(printifyShipmentEvent({ eventId: "ready-secondary",
            sku: skus.secondarySku, trackingNumber: "SECONDARY", type: "created" })), workerEnv(), () => NOW + 1000);
        expect(await runScheduledPrintifyShipmentReconciliation(workerEnv(), rateLimited, () => NOW + 180000))
            .toMatchObject({ retried: 1, reconciled: 1 });
        expect(await shipmentState()).toMatchObject({ fulfilledLines: 3, paidOrderStatus: "fulfilment_locked" });
        await runScheduledPrintifyShipmentReconciliation(workerEnv(), shopify.fetcher, () => NOW + 181000);
        expect(await shipmentState()).toMatchObject({ paidOrderStatus: "fulfilled" });
    });
    it("preserves collected parcels and line references while rebuilding the tracking index", async () => {
        const skus = await prepareInProductionOrder(true);
        if (!skus.secondarySku)
            throw new Error("Second SKU fixture is missing.");
        const shopify = shopifyFulfilmentFetcher(true);
        await handlePrintifyWebhookRequest(await printifyWebhookRequest(printifyShipmentEvent({ eventId: "before-migration",
            sku: skus.primarySku, trackingNumber: "ONE-PACKAGE", type: "created" })), workerEnv(), () => NOW);
        const db = testPlatform().env.DB;
        const before = await db.prepare("SELECT * FROM printify_shipments").all();
        const beforeLines = await db.prepare("SELECT * FROM printify_shipment_lines").all();
        const migration = await readFile(new URL("../drizzle/0035_shared_tracking_shipments.sql", import.meta.url), "utf8");
        await db.batch(migration.split("--> statement-breakpoint").map(sql => db.prepare(sql.trim())));
        expect((await db.prepare("SELECT * FROM printify_shipments").all()).results).toEqual(before.results);
        expect((await db.prepare("SELECT * FROM printify_shipment_lines").all()).results).toEqual(beforeLines.results);
        expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
        await handlePrintifyWebhookRequest(await printifyWebhookRequest(printifyShipmentEvent({ eventId: "after-migration",
            sku: skus.secondarySku, trackingNumber: "ONE-PACKAGE", type: "created" })), workerEnv(), () => NOW + 1000);
        await runScheduledPrintifyShipmentReconciliation(workerEnv(), shopify.fetcher, () => NOW + 180000);
        expect(shopify.quantities).toEqual([2, 1]);
    });
    it("creates exact split-product fulfilments and ignores duplicate lifecycle events", async () => {
        const skus = await prepareInProductionOrder(true);
        if (!skus.secondarySku)
            throw new Error("Second SKU fixture is missing.");
        const shopify = shopifyFulfilmentFetcher(true);
        const firstShipment = printifyShipmentEvent({
            eventId: "shipment-created-1",
            sku: skus.primarySku,
            trackingNumber: "TRACK-ONE",
            type: "created",
        });
        const first = await handlePrintifyWebhookRequest(await printifyWebhookRequest(firstShipment), workerEnv(), () => NOW + 4000);
        expect(await shipmentState()).toEqual({
            delivered: 0,
            fulfilledLines: 2,
            paidOrderStatus: "fulfilment_locked",
            shipmentCount: 1,
        });
        const duplicate = await handlePrintifyWebhookRequest(await printifyWebhookRequest(firstShipment), workerEnv(), () => NOW + 5000);
        const delivered = await handlePrintifyWebhookRequest(await printifyWebhookRequest(printifyShipmentEvent({
            eventId: "shipment-delivered-1",
            sku: skus.primarySku,
            trackingNumber: "TRACK-ONE",
            type: "delivered",
        })), workerEnv(), () => NOW + 6000);
        const second = await handlePrintifyWebhookRequest(await printifyWebhookRequest(printifyShipmentEvent({
            eventId: "shipment-created-2",
            sku: skus.secondarySku,
            trackingNumber: "TRACK-TWO",
            type: "created",
        })), workerEnv(), () => NOW + 7000);
        expect([first?.status, duplicate?.status, delivered?.status, second?.status])
            .toEqual([200, 200, 200, 200]);
        expect(await openException()).toBeNull();
        await runScheduledPrintifyShipmentReconciliation(workerEnv(), shopify.fetcher, () => NOW + 180000);
        // Separate parcels reconcile concurrently. Each line's exact quantity and
        // duplicate protection are checked by the fetcher, not by completion order.
        expect([...shopify.quantities].sort((left, right) => left - right)).toEqual([1, 2]);
        expect(await shipmentState()).toEqual({
            delivered: 1,
            fulfilledLines: 3,
            paidOrderStatus: "fulfilled",
            shipmentCount: 2,
        });
    });
    it("handles delivery-before-created ordering without a duplicate fulfilment", async () => {
        const skus = await prepareInProductionOrder();
        const shopify = shopifyFulfilmentFetcher(false);
        const delivered = printifyShipmentEvent({
            eventId: "shipment-delivered-first",
            sku: skus.primarySku,
            trackingNumber: "TRACK-EARLY",
            type: "delivered",
        });
        const created = printifyShipmentEvent({
            eventId: "shipment-created-late",
            sku: skus.primarySku,
            trackingNumber: "TRACK-EARLY",
            type: "created",
        });
        const first = await handlePrintifyWebhookRequest(await printifyWebhookRequest(delivered), workerEnv(), () => NOW + 4000);
        const second = await handlePrintifyWebhookRequest(await printifyWebhookRequest(created), workerEnv(), () => NOW + 5000);
        expect([first?.status, second?.status]).toEqual([200, 200]);
        await runScheduledPrintifyShipmentReconciliation(workerEnv(), shopify.fetcher, () => NOW + 180000);
        expect(shopify.quantities).toEqual([2]);
        expect(await shipmentState()).toMatchObject({
            delivered: 1,
            fulfilledLines: 2,
            shipmentCount: 1,
        });
    });
    it("rejects an invalid signature before persistence", async () => {
        const response = await handlePrintifyWebhookRequest(new Request(`https://api.example.com${PRINTIFY_SHIPMENT_WEBHOOK_PATH}`, {
            body: JSON.stringify(printifyShipmentEvent({
                eventId: "shipment-invalid-signature",
                sku: "unknown-sku",
                trackingNumber: "TRACK-INVALID",
                type: "created",
            })),
            headers: { "x-pfy-signature": "sha256=invalid" },
            method: "POST",
        }), workerEnv());
        expect(response?.status).toBe(401);
        expect(await tableCount("printify_webhook_inbox")).toBe(0);
    });
    it("retries a safely failed Shopify read from the scheduled reconciler", async () => {
        const skus = await prepareInProductionOrder();
        const unavailable = vi.fn<typeof fetch>((input) => fetchInputUrl(input).endsWith("/admin/oauth/access_token")
            ? Promise.resolve(Response.json({
                access_token: "admin-token",
                expires_in: 86399,
                scope: "read_merchant_managed_fulfillment_orders,write_merchant_managed_fulfillment_orders",
            }))
            : Promise.reject(new Error("Shopify read unavailable")));
        const event = printifyShipmentEvent({
            eventId: "shipment-retry",
            sku: skus.primarySku,
            trackingNumber: "TRACK-RETRY",
            type: "created",
        });
        const first = await handlePrintifyWebhookRequest(await printifyWebhookRequest(event), workerEnv(), () => NOW + 4000);
        expect(await runScheduledPrintifyShipmentReconciliation(workerEnv(), unavailable, () => NOW + 180000))
            .toMatchObject({ retried: 1, reconciled: 0 });
        const shopify = shopifyFulfilmentFetcher(false);
        const report = await runScheduledPrintifyShipmentReconciliation(workerEnv(), shopify.fetcher, () => NOW + 181000);
        expect(first?.status).toBe(200);
        expect(report).toEqual({
            candidates: 1,
            disabled: false,
            exceptions: 0,
            fenced: 0,
            reconciled: 1,
            retried: 0,
        });
        expect(shopify.quantities).toEqual([2]);
        expect(await shipmentState()).toMatchObject({
            fulfilledLines: 2,
            paidOrderStatus: "fulfilled",
            shipmentCount: 1,
        });
    });
    it("fences an expired Shopify mutation lease without retrying it", async () => {
        const skus = await prepareInProductionOrder();
        const shopify = shopifyFulfilmentFetcher(false);
        await handlePrintifyWebhookRequest(await printifyWebhookRequest(printifyShipmentEvent({
            eventId: "shipment-expired-lease",
            sku: skus.primarySku,
            trackingNumber: "TRACK-EXPIRED",
            type: "created",
        })), workerEnv(), () => NOW + 4000);
        await testPlatform().env.DB.prepare(`
      UPDATE printify_shipments
      SET status = 'creating', lease_id = 'expired-shopify-lease',
        lease_expires_at = ?
    `).bind(NOW + 4500).run();
        const report = await runScheduledPrintifyShipmentReconciliation(workerEnv(), shopify.fetcher, () => NOW + 5000);
        expect(report).toMatchObject({ candidates: 0, fenced: 1 });
        expect((await openException())?.code).toBe("SHOPIFY_FULFILMENT_LEASE_EXPIRED");
        expect(shopify.quantities).toEqual([]);
    });
});
async function ingestValidOrder() {
    const payload = await validOrderPayload();
    const response = await handleShopifyWebhookRequest(await webhookRequest(payload), workerEnv(), () => NOW);
    if (response?.status !== 202)
        throw new Error("Paid-order fixture failed.");
    return payload;
}
async function publishOrderCatalogueRefresh(available = 1) {
    const id = crypto.randomUUID();
    const db = testPlatform().env.DB;
    await db.batch([
        db.prepare(`INSERT INTO printify_catalogue_snapshots
      (id, shop_id, blueprint_id, print_provider_id, retrieved_at, source_urls_json, variant_count, base_product_id, base_product_slug)
      SELECT ?, shop_id, blueprint_id, print_provider_id, ?, source_urls_json, variant_count, base_product_id, base_product_slug
      FROM printify_catalogue_snapshots WHERE id = ?`).bind(id, NOW + 1000, CATALOGUE_ID),
        db.prepare(`INSERT INTO printify_catalogue_variants
      (snapshot_id, printify_variant_id, colour, size, available, decoration_method, print_width, print_height,
       shipping_first_item, shipping_additional_item, shipping_currency, handling_days_from, handling_days_to)
      SELECT ?, printify_variant_id, colour, size, ?, decoration_method, print_width, print_height,
       shipping_first_item, shipping_additional_item, shipping_currency, handling_days_from, handling_days_to
      FROM printify_catalogue_variants WHERE snapshot_id = ?`).bind(id, available, CATALOGUE_ID),
    ]);
    return id;
}
async function publishOrderMappingRefresh(catalogueId: string) {
    const id = crypto.randomUUID();
    const db = testPlatform().env.DB;
    await db.batch([
        db.prepare(`INSERT INTO shopify_variant_mapping_snapshots
      (id, catalogue_snapshot_id, shopify_product_id, shopify_product_handle, shopify_product_title,
       retrieved_at, source_url, variant_count, base_product_id, base_product_slug)
      SELECT ?, ?, shopify_product_id, shopify_product_handle, shopify_product_title,
       ?, source_url, variant_count, base_product_id, base_product_slug
      FROM shopify_variant_mapping_snapshots WHERE id = ?`).bind(id, catalogueId, NOW + 2000, MAPPING_ID),
        db.prepare(`INSERT INTO shopify_variant_mappings
      (snapshot_id, shopify_variant_id, printify_variant_id, colour, size, sku, shopify_available)
      SELECT ?, shopify_variant_id, printify_variant_id, colour, size, sku, shopify_available
      FROM shopify_variant_mappings WHERE snapshot_id = ?`).bind(id, MAPPING_ID),
    ]);
}
function adminOrderFetcher(payload: Record<string, unknown>, options: {
    readonly address?: "NO_ISSUES" | "WARNING" | "ERROR";
    readonly address2?: string;
    readonly fraud?: "LOW" | "PENDING";
    readonly quantity?: number;
    readonly phone?: string | null;
} = {}) {
    const lineCapability = readLineCapability(payload);
    return vi.fn<typeof fetch>((input) => Promise.resolve(fetchInputUrl(input).endsWith("/admin/oauth/access_token")
        ? Response.json({
            access_token: "admin-order-token",
            expires_in: 86399,
            scope: "read_orders",
        })
        : Response.json({
            data: {
                order: {
                    cancelledAt: null,
                    currentTotalPriceSet: {
                        presentmentMoney: { amount: "70.00", currencyCode: "AUD" },
                    },
                    displayFinancialStatus: "PAID",
                    edited: false,
                    email: "buyer@example.com",
                    id: "gid://shopify/Order/1001",
                    lineItems: {
                        nodes: [{
                                currentQuantity: options.quantity ?? 2,
                                customAttributes: [{
                                        key: "_lineCapability",
                                        value: lineCapability,
                                    }],
                                id: "gid://shopify/LineItem/2001",
                                originalUnitPriceSet: {
                                    presentmentMoney: {
                                        amount: "70.00",
                                        currencyCode: "AUD",
                                    },
                                },
                                quantity: 2,
                                variant: { id: SHOPIFY_VARIANT_ID },
                            }],
                        pageInfo: { hasNextPage: false },
                    },
                    name: "#1001",
                    risk: {
                        assessments: [{ riskLevel: options.fraud ?? "LOW" }],
                        recommendation: "ACCEPT",
                    },
                    shippingAddress: {
                        address1: "1 Queen Street",
                        address2: options.address2 ?? null,
                        city: "Brisbane",
                        company: null,
                        country: "Australia",
                        countryCodeV2: "AU",
                        firstName: "Ada",
                        lastName: "Lovelace",
                        phone: options.phone === undefined ? "+61412345678" : options.phone,
                        province: "Queensland",
                        provinceCode: "QLD",
                        validationResultSummary: options.address ?? "NO_ISSUES",
                        zip: "4000",
                    },
                    updatedAt: "2026-08-30T00:00:00Z",
                },
            },
        })));
}
function fetchInputUrl(input: RequestInfo | URL) {
    if (typeof input === "string" || input instanceof URL)
        return input.toString();
    return input.url;
}
function requestBody(init: RequestInit | undefined) {
    return typeof init?.body === "string" ? init.body : "";
}
function successfulPrintifyFetcher(assetSha256: string, productResponse: (request: PrintifyCreateProductRequest, method: "GET" | "POST") => unknown = printifyProductResponse, orderResponse: (request: PrintifyCreateOrderRequest, assetSha256: string) => unknown = printifyOrderResponse) {
    let createdProduct: PrintifyCreateProductRequest | undefined;
    let createdOrder: PrintifyCreateOrderRequest | undefined;
    return vi.fn<typeof fetch>(async (input, init) => {
        const request = new Request(input, init);
        const path = new URL(request.url).pathname;
        if (request.method === "POST" && path === "/v1/uploads/images.json") {
            const upload = Schema.decodeUnknownSync(PrintifyUploadByUrlRequestSchema)(await request.json());
            const deliveryUrl = new URL(upload.url);
            expect(deliveryUrl.pathname).toBe(`/v2/print-assets/${ASSET_ID}/download`);
            expect(deliveryUrl.searchParams.get("grant")).toBeTruthy();
            expect(upload.file_name).toContain(assetSha256.slice(0, 16));
            return Response.json(printifyImageResponse(upload.file_name));
        }
        if (request.method === "GET" &&
            path === "/v1/uploads/printify-image-1.json") {
            return Response.json(printifyImageResponse(`bent-${ASSET_ID}-${assetSha256.slice(0, 16)}.png`));
        }
        if (request.method === "POST" &&
            path === `/v1/shops/${PRINTIFY_SHOP_ID}/products.json`) {
            createdProduct = Schema.decodeUnknownSync(PrintifyCreateProductRequestSchema)(await request.json());
            return Response.json(productResponse(createdProduct, "POST"));
        }
        if (request.method === "GET" &&
            path === `/v1/shops/${PRINTIFY_SHOP_ID}/products/printify-product-1.json`) {
            if (!createdProduct)
                throw new Error("Product was read before creation.");
            return Response.json(productResponse(createdProduct, "GET"));
        }
        if (request.method === "POST" &&
            path === `/v1/shops/${PRINTIFY_SHOP_ID}/orders.json`) {
            createdOrder = Schema.decodeUnknownSync(PrintifyCreateOrderRequestSchema)(await request.json());
            return Response.json({ id: printifyOrderResponse(createdOrder, assetSha256).id });
        }
        if (request.method === "GET" &&
            path === `/v1/shops/${PRINTIFY_SHOP_ID}/orders/printify-order-1.json`) {
            if (!createdOrder)
                throw new Error("Order was read before creation.");
            return Response.json(orderResponse(createdOrder, assetSha256));
        }
        if (request.method === "POST" &&
            path === `/v1/shops/${PRINTIFY_SHOP_ID}/orders/printify-order-1/send_to_production.json`) {
            return new Response(null, { status: 200 });
        }
        throw new Error(`Unexpected Printify request: ${request.method} ${path}`);
    });
}
function printifyOrderResponse(request: PrintifyCreateOrderRequest, assetSha256: string) {
    return {
        address_to: {
            ...request.address_to,
            address2: "",
            company: "",
            country: "Australia",
            region: "Queensland",
        },
        id: "printify-order-1",
        line_items: request.line_items.map((line) => ({
            cost: 3500,
            external_id: line.external_id,
            metadata: {
                external_id: line.external_id,
                price: line.variant_id === 202 ? 8000 : 7000,
                sku: [
                    "bnt",
                    line.variant_id === 202
                        ? "second-product-202-8000"
                        : [
                            CONFIGURED_PRODUCT_ID.replaceAll("-", "").slice(0, 12),
                            assetSha256.slice(0, 12),
                            "201",
                            "7000",
                        ].join("-"),
                ].join("-"),
            },
            print_provider_id: 1,
            product_id: line.product_id,
            quantity: line.quantity,
            shipping_cost: 1000,
            status: "on-hold",
            variant_id: line.variant_id,
        })),
        sent_to_production_at: null,
        shipments: [],
        shipping_method: request.shipping_method,
        status: "on-hold",
    };
}
function printifyImageResponse(fileName: string) {
    return {
        file_name: fileName,
        height: 5100,
        id: "printify-image-1",
        mime_type: "image/png",
        preview_url: "https://images.example.com/printify-image-1.png",
        size: ASSET.byteLength,
        upload_time: "2026-08-30T00:00:00Z",
        width: 4500,
    };
}
function printifyProductResponse(request: PrintifyCreateProductRequest) {
    return {
        blueprint_id: request.blueprint_id,
        description: request.description,
        id: "printify-product-1",
        is_locked: false,
        print_areas: request.print_areas.map((area) => ({
            placeholders: area.placeholders.map((placeholder) => ({
                decoration_method: "dtg",
                images: placeholder.images.map((image) => ({
                    ...image,
                    height: 5100,
                    type: "image/png",
                    width: 4500,
                })),
                position: placeholder.position,
            })),
            variant_ids: area.variant_ids,
        })),
        print_provider_id: request.print_provider_id,
        shop_id: Number(PRINTIFY_SHOP_ID),
        title: request.title,
        variants: request.variants.map((variant) => ({
            ...variant,
            cost: 3500,
            is_available: true,
        })),
        visible: true,
    };
}
function expandedPrintifyProductResponse(request: PrintifyCreateProductRequest): ReturnType<typeof printifyProductResponse> {
    const product = printifyProductResponse(request);
    const selected = product.variants[0];
    if (!selected)
        throw new Error("Selected fixture variant missing.");
    const disabled = { ...selected, id: selected.id + 1, is_enabled: false, sku: "" };
    return {
        ...product,
        variants: [...product.variants, disabled],
        print_areas: product.print_areas.map(area => ({
            ...area,
            variant_ids: [...area.variant_ids, disabled.id],
            placeholders: [...area.placeholders, { position: "back", decoration_method: "dtg", images: [] }],
        })),
    };
}
async function currentAssetSha256() {
    const asset = await testPlatform().env.DB.prepare(`
    SELECT sha256 FROM print_assets WHERE id = ?
  `).bind(ASSET_ID).first<{
        sha256: string;
    }>();
    if (!asset)
        throw new Error("Print-asset fixture is missing.");
    return asset.sha256;
}
async function productionResourceState() {
    const media = await testPlatform().env.DB.prepare(`
    SELECT status, provider_image_id FROM printify_media_copies
  `).first<{
        provider_image_id: string | null;
        status: string;
    }>();
    const product = await testPlatform().env.DB.prepare(`
    SELECT status, provider_product_id FROM printify_production_products
  `).first<{
        provider_product_id: string | null;
        status: string;
    }>();
    return {
        mediaId: media?.provider_image_id ?? null,
        mediaStatus: media?.status ?? null,
        productId: product?.provider_product_id ?? null,
        productStatus: product?.status ?? null,
    };
}
async function paidOrderFixtureState() {
    const db = testPlatform().env.DB;
    const [paid, media, products, exceptions, admission] = await db.batch([
        db.prepare("SELECT status FROM paid_orders"),
        db.prepare("SELECT status, last_error_code FROM printify_media_copies"),
        db.prepare("SELECT status, last_error_code FROM printify_production_products"),
        db.prepare("SELECT status, code FROM fulfilment_exceptions"),
        db.prepare("SELECT provider, tokens, blocked_until FROM provider_admission"),
    ]);
    return {
        paidOrders: paid?.results,
        media: media?.results,
        products: products?.results,
        exceptions: exceptions?.results,
        admission: admission?.results,
    };
}
async function printifyOrderState() {
    const order = await testPlatform().env.DB.prepare(`
    SELECT status, provider_order_id FROM printify_fulfilment_orders
  `).first<{
        provider_order_id: string | null;
        status: string;
    }>();
    return {
        lineCount: await tableCount("printify_fulfilment_order_lines"),
        providerOrderId: order?.provider_order_id ?? null,
        status: order?.status ?? null,
    };
}
async function prepareInProductionOrder(includeSecondLine = false) {
    const payload = await ingestValidOrder();
    const lockTime = NOW + 60 * 60 * 1000;
    await reconcilePaidOrderHolds(workerEnv(), adminOrderFetcher(payload), () => lockTime);
    const fetcher = successfulPrintifyFetcher(await currentAssetSha256());
    await runScheduledPrintifyMaterialisation(workerEnv(), fetcher, () => lockTime + 1000);
    if (includeSecondLine)
        await addSecondReadyOrderLine(lockTime + 1500);
    await runScheduledPrintifyOrderSubmission(workerEnv(), fetcher, () => lockTime + 2000);
    resetShopifyAdminAccessTokenCache();
    const lines = await testPlatform().env.DB.prepare(`
    SELECT fulfilment_line.provider_sku
    FROM printify_fulfilment_order_lines AS fulfilment_line
    JOIN paid_order_lines AS paid_line
      ON paid_line.id = fulfilment_line.paid_order_line_id
    ORDER BY paid_line.line_position
  `).all<{
        provider_sku: string;
    }>();
    const primarySku = lines.results[0]?.provider_sku;
    if (!primarySku)
        throw new Error("Printify order-line fixture is missing.");
    return {
        primarySku,
        secondarySku: lines.results[1]?.provider_sku ?? null,
    };
}
async function addSecondReadyOrderLine(now: number) {
    const db = testPlatform().env.DB;
    const source = await db.prepare(`
    SELECT line.paid_order_id, line.base_product_id,
      line.configured_product_id, line.design_revision_id,
      line.projection_version, line.print_geometry_key,
      line.print_asset_id, line.print_asset_sha256,
      line.variant_mapping_snapshot_id, product.media_copy_id
    FROM paid_order_lines AS line
    JOIN printify_production_products AS product
      ON product.configured_product_id = line.configured_product_id
      AND product.print_asset_id = line.print_asset_id
    LIMIT 1
  `).first<{
        base_product_id: string;
        configured_product_id: string;
        design_revision_id: string;
        media_copy_id: string;
        paid_order_id: string;
        print_asset_id: string;
        print_asset_sha256: string;
        print_geometry_key: string;
        projection_version: string;
        variant_mapping_snapshot_id: string;
    }>();
    if (!source)
        throw new Error("Second order-line source is missing.");
    const productId = "4ef19b12-f698-4f50-ab7b-cb03d87df2e1";
    const lineId = "99f421dd-dfdc-41b2-92c7-91c1f5064ea4";
    const providerSku = "bnt-second-product-202-8000";
    await db.batch([
        db.prepare(`
      INSERT INTO shopify_variant_mappings (
        snapshot_id, shopify_variant_id, printify_variant_id, colour, size,
        sku, shopify_available
      ) VALUES (?, ?, 202, 'Black', 'L', 'BENT-BLACK-L', 1)
    `).bind(source.variant_mapping_snapshot_id, SECOND_SHOPIFY_VARIANT_ID),
        db.prepare(`
      INSERT INTO printify_production_products (
        id, configured_product_id, design_revision_id, base_product_id,
        projection_version, print_geometry_key, print_asset_id,
        print_asset_sha256, media_copy_id, printify_variant_id, blueprint_id,
        print_provider_id, retail_price_minor_units, provider_product_id,
        provider_sku, title, request_sha256, readback_sha256, status,
        attempt_count, created_at, updated_at, verified_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 202, 1, 1, 8000,
        'printify-product-2', ?, 'Second locked product', ?, ?, 'ready',
        1, ?, ?, ?)
    `).bind(productId, source.configured_product_id, source.design_revision_id, source.base_product_id, source.projection_version, source.print_geometry_key, source.print_asset_id, source.print_asset_sha256, source.media_copy_id, providerSku, "a".repeat(64), "b".repeat(64), now, now, now),
        db.prepare(`
      INSERT INTO paid_order_lines (
        id, paid_order_id, shopify_line_item_id, line_position, quantity,
        base_product_id, configured_product_id, design_revision_id,
        projection_version, print_geometry_key, print_asset_id,
        print_asset_sha256, shopify_variant_id, printify_variant_id,
        variant_mapping_snapshot_id, colour, size, line_capability_sha256,
        created_at, retail_price_minor_units
      ) VALUES (?, ?, 'gid://shopify/LineItem/2002', 2, 1, ?, ?, ?, ?, ?, ?, ?,
        ?, 202, ?, 'Black', 'L', ?, ?, 8000)
    `).bind(lineId, source.paid_order_id, source.base_product_id, source.configured_product_id, source.design_revision_id, source.projection_version, source.print_geometry_key, source.print_asset_id, source.print_asset_sha256, SECOND_SHOPIFY_VARIANT_ID, source.variant_mapping_snapshot_id, "c".repeat(64), now),
    ]);
}
function shopifyFulfilmentFetcher(includeSecondLine: boolean) {
    let primaryRemaining = 2;
    let secondaryRemaining = includeSecondLine ? 1 : 0;
    const quantities: number[] = [];
    const fetcher = vi.fn<typeof fetch>((input, init) => {
        const url = fetchInputUrl(input);
        if (url.endsWith("/admin/oauth/access_token")) {
            return Promise.resolve(Response.json({
                access_token: "admin-token",
                expires_in: 86399,
                scope: "read_merchant_managed_fulfillment_orders,write_merchant_managed_fulfillment_orders",
            }));
        }
        const body = requestBody(init);
        if (body.includes("BentShirtFulfilmentOrders")) {
            return Promise.resolve(Response.json({
                data: {
                    order: {
                        fulfillmentOrders: {
                            nodes: [{
                                    assignedLocation: {
                                        location: { id: "gid://shopify/Location/3001" },
                                    },
                                    id: "gid://shopify/FulfillmentOrder/4001",
                                    lineItems: {
                                        nodes: [
                                            {
                                                id: "gid://shopify/FulfillmentOrderLineItem/5001",
                                                lineItem: { id: "gid://shopify/LineItem/2001" },
                                                remainingQuantity: primaryRemaining,
                                            },
                                            ...(includeSecondLine ? [{
                                                    id: "gid://shopify/FulfillmentOrderLineItem/5002",
                                                    lineItem: { id: "gid://shopify/LineItem/2002" },
                                                    remainingQuantity: secondaryRemaining,
                                                }] : []),
                                        ],
                                        pageInfo: { hasNextPage: false },
                                    },
                                    status: "OPEN",
                                }],
                            pageInfo: { hasNextPage: false },
                        },
                        id: "gid://shopify/Order/1001",
                    },
                },
            }));
        }
        if (!body.includes("BentShirtCreateFulfilment")) {
            throw new Error("Unexpected Shopify fulfilment request.");
        }
        const previousCount = quantities.length;
        if (body.includes("FulfillmentOrderLineItem/5001") &&
            body.includes('"quantity":2')) {
            if (primaryRemaining !== 2)
                throw new Error("Primary line was fulfilled twice.");
            quantities.push(2);
            primaryRemaining = 0;
        }
        if (body.includes("FulfillmentOrderLineItem/5002") &&
            body.includes('"quantity":1')) {
            if (secondaryRemaining !== 1)
                throw new Error("Secondary line was fulfilled twice.");
            quantities.push(1);
            secondaryRemaining = 0;
        }
        if (quantities.length === previousCount) {
            throw new Error("Unexpected Shopify fulfilment line mapping.");
        }
        return Promise.resolve(Response.json({
            data: {
                fulfillmentCreate: {
                    fulfillment: {
                        id: `gid://shopify/Fulfillment/${String(6000 + quantities.length)}`,
                    },
                    userErrors: [],
                },
            },
        }));
    });
    return { fetcher, quantities };
}
function printifyShipmentEvent(options: {
    readonly eventId: string;
    readonly sku: string | readonly string[];
    readonly trackingNumber: string;
    readonly type: "created" | "delivered";
    readonly carrierCode?: string;
    readonly trackingUrl?: string;
}): Record<string, unknown> {
    const carrier = {
        code: options.carrierCode ?? "Australia Post",
        tracking_number: options.trackingNumber,
        tracking_url: options.trackingUrl ?? `https://auspost.com.au/track/${options.trackingNumber}`,
    };
    const common = {
        carrier,
        shop_id: Number(PRINTIFY_SHOP_ID),
        skus: typeof options.sku === "string" ? [options.sku] : options.sku,
    };
    return {
        created_at: "2026-08-30T01:00:00Z",
        id: options.eventId,
        resource: {
            data: options.type === "created"
                ? { ...common, shipped_at: "2026-08-30T00:30:00Z" }
                : { ...common, delivered_at: "2026-09-02T02:00:00Z" },
            id: "printify-order-1",
            type: "order",
        },
        type: options.type === "created"
            ? "order:shipment:created"
            : "order:shipment:delivered",
    };
}
async function printifyWebhookRequest(payload: Record<string, unknown>) {
    const body = JSON.stringify(payload);
    return new Request(`https://api.example.com${PRINTIFY_SHIPMENT_WEBHOOK_PATH}`, {
        body,
        headers: {
            "content-type": "application/json",
            "x-pfy-signature": await printifyWebhookSignature(body),
        },
        method: "POST",
    });
}
async function printifyWebhookSignature(body: string) {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(PRINTIFY_WEBHOOK_SECRET), { hash: "SHA-256", name: "HMAC" }, false, ["sign"]);
    const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
    return `sha256=${bytesToHex(new Uint8Array(signature))}`;
}
async function shipmentState() {
    const shipmentCount = await tableCount("printify_shipments");
    const delivered = await testPlatform().env.DB.prepare(`
    SELECT COUNT(*) AS count FROM printify_shipments WHERE status = 'delivered'
  `).first<{
        count: number;
    }>();
    const line = await testPlatform().env.DB.prepare(`
    SELECT SUM(shipped_quantity) AS shipped_quantity
    FROM printify_fulfilment_order_lines
  `).first<{
        shipped_quantity: number;
    }>();
    const order = await testPlatform().env.DB.prepare(`
    SELECT status FROM paid_orders
  `).first<{
        status: string;
    }>();
    return {
        delivered: delivered?.count ?? 0,
        fulfilledLines: line?.shipped_quantity ?? 0,
        paidOrderStatus: order?.status ?? null,
        shipmentCount,
    };
}
async function paidOrderState() {
    return testPlatform().env.DB.prepare(`
    SELECT status, fraud_result, address_validation_result,
      production_lease_id, production_lease_expires_at,
      validation_checked_at, fulfilment_locked_at,
      delivery_address_sha256, delivery_address_json
    FROM paid_orders
  `).first<{
        address_validation_result: string;
        delivery_address_json: string | null;
        delivery_address_sha256: string | null;
        fraud_result: string;
        fulfilment_locked_at: number | null;
        production_lease_expires_at: number | null;
        production_lease_id: string | null;
        status: string;
        validation_checked_at: number | null;
    }>();
}
async function validOrderPayload(): Promise<Record<string, unknown>> {
    const identity = await seedOrderIdentity();
    await testPlatform().env.DB.prepare(`
    INSERT INTO order_management_capabilities (
      token_hash, shopify_cart_id, expires_at, created_at
    ) VALUES (?, 'gid://shopify/Cart/cart-token?key=cart-secret', ?, ?)
  `).bind(await sha256Hex(ORDER_CAPABILITY), NOW + 60000, NOW - 1000).run();
    const lineCapability = await signCartLineCapability({
        baseProductId: BASE_PRODUCT_ID,
        color: "Black",
        configuredProductId: CONFIGURED_PRODUCT_ID,
        designRevisionId: REVISION_ID,
        expiresAt: NOW + 60000,
        issuedAt: NOW - 1000,
        printAssetId: ASSET_ID,
        printAssetSha256: identity.sha256,
        printGeometryKey: "dtg:4500x5100",
        printifyVariantId: 201,
        projectionVersion: "safe-margin-v1",
        quantity: 2,
        shopifyVariantId: SHOPIFY_VARIANT_ID,
        size: "M",
        variantMappingSnapshotId: MAPPING_ID,
        version: 1,
    }, SIGNING_SECRET);
    return {
        admin_graphql_api_id: "gid://shopify/Order/1001",
        cart_token: "cart-token",
        currency: "AUD",
        current_total_price: "70.00",
        line_items: [{
                admin_graphql_api_id: "gid://shopify/LineItem/2001",
                properties: [{ name: "_lineCapability", value: lineCapability }],
                quantity: 2,
                variant_id: 101,
            }],
        name: "#1001",
        note_attributes: [{
                name: "_orderManagementCapability",
                value: ORDER_CAPABILITY,
            }],
    } satisfies Record<string, unknown>;
}
async function seedOrderIdentity() {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", ASSET));
    const sha256 = bytesToHex(digest);
    const storageKey = `print-assets/${CONFIGURED_PRODUCT_ID}/${sha256}.png`;
    await testPlatform().env.DESIGN_ARTWORK.put(storageKey, ASSET, { sha256: digest });
    const db = testPlatform().env.DB;
    await db.batch([
        db.prepare(`
      INSERT INTO designs (
        id, owner_id, artwork_key, content_type, byte_size, sha256,
        crop_x, crop_y, crop_zoom, placement_x, placement_y, placement_width,
        depth, status, version, finalized_at, created_at, updated_at
      ) VALUES (?, NULL, ?, 'image/png', 8, ?, 0.5, 0.5, 1, 0.3, 0.3,
        0.2, 5, 'ready', 1, ?, ?, ?)
    `).bind(DESIGN_ID, `designs/${DESIGN_ID}/${sha256}.png`, sha256, NOW, NOW, NOW),
        db.prepare(`
      INSERT INTO design_revisions (
        id, design_id, fingerprint, artwork_key, content_type, byte_size,
        artwork_width, artwork_height, sha256, crop_x, crop_y, crop_zoom,
        placement_x, placement_y, placement_width, depth, created_at
      ) VALUES (?, ?, 'fixture', ?, 'image/png', 8, 3000, 4000, ?,
        0.5, 0.5, 1, 0, 0, 0.08, 1, ?)
    `).bind(REVISION_ID, DESIGN_ID, `designs/${DESIGN_ID}/${sha256}.png`, sha256, NOW),
    ]);
    await db.batch([
        db.prepare(`
      INSERT INTO products (
        id, base_product_id, design_id, design_revision_id,
        shopify_handle, status, created_at
      ) VALUES (?, ?, NULL, NULL, 'bent-shirt', 'active', ?)
    `).bind(BASE_PRODUCT_ID, BASE_PRODUCT_ID, NOW),
        db.prepare(`
      INSERT INTO products (
        id, base_product_id, design_id, design_revision_id, placement_x,
        placement_y, placement_width, placement_depth, projection_version,
        shopify_handle, status, created_at
      ) VALUES (?, ?, ?, ?, 0.3, 0.3, 0.2, 5, 'safe-margin-v1',
        'bent-shirt', 'active', ?)
    `).bind(CONFIGURED_PRODUCT_ID, BASE_PRODUCT_ID, DESIGN_ID, REVISION_ID, NOW),
        db.prepare(`
      INSERT INTO printify_catalogue_snapshots (
        id, shop_id, blueprint_id, print_provider_id, retrieved_at,
        source_urls_json, variant_count, base_product_id, base_product_slug
      ) VALUES (?, ?, 1, 1, ?, '[]', 1, ?, 'staple-tee')
    `).bind(CATALOGUE_ID, PRINTIFY_SHOP_ID, NOW, BASE_PRODUCT_ID),
    ]);
    await db.batch([
        db.prepare(`
      INSERT INTO shopify_variant_mapping_snapshots (
        id, catalogue_snapshot_id, shopify_product_id, shopify_product_handle,
        shopify_product_title, retrieved_at, source_url, variant_count,
        base_product_id, base_product_slug
      ) VALUES (?, ?, 'gid://shopify/Product/1', 'bent-shirt', 'bent.shop',
        ?, 'https://example.invalid/product', 1, ?, 'staple-tee')
    `).bind(MAPPING_ID, CATALOGUE_ID, NOW, BASE_PRODUCT_ID),
        db.prepare(`
      INSERT INTO printify_catalogue_variants (
        snapshot_id, printify_variant_id, colour, size, available,
        decoration_method, print_width, print_height, shipping_first_item,
        shipping_additional_item, shipping_currency, handling_days_from,
        handling_days_to
      ) VALUES (?, 201, 'Black', 'M', 1, 'dtg', 4500, 5100,
        1000, 500, 'AUD', 1, 3)
    `).bind(CATALOGUE_ID),
        db.prepare(`
      INSERT INTO shopify_variant_mappings (
        snapshot_id, shopify_variant_id, printify_variant_id, colour, size,
        sku, shopify_available
      ) VALUES (?, ?, 201, 'Black', 'M', 'BENT-BLACK-M', 1)
    `).bind(MAPPING_ID, SHOPIFY_VARIANT_ID),
        db.prepare(`
      INSERT INTO print_assets (
        id, configured_product_id, design_revision_id, base_product_id,
        projection_version, geometry_key, storage_key, content_type, byte_size,
        width_px, height_px, sha256, status, created_at, updated_at, ready_at
      ) VALUES (?, ?, ?, ?, 'safe-margin-v1', 'dtg:4500x5100', ?,
        'image/png', 8, 4500, 5100, ?, 'ready', ?, ?, ?)
    `).bind(ASSET_ID, CONFIGURED_PRODUCT_ID, REVISION_ID, BASE_PRODUCT_ID, storageKey, sha256, NOW, NOW, NOW),
    ]);
    return { sha256 };
}
async function webhookRequest(payload: Record<string, unknown>, options: {
    signature?: string;
    shopDomain?: string;
    webhookId?: string;
} = {}) {
    const body = JSON.stringify(payload);
    const signature = options.signature ?? await webhookSignature(body);
    return new Request(`https://api.example.com${SHOPIFY_ORDERS_PAID_WEBHOOK_PATH}`, {
        body,
        headers: {
            "content-type": "application/json",
            "x-shopify-api-version": "2026-07",
            "x-shopify-hmac-sha256": signature,
            "x-shopify-shop-domain": options.shopDomain ?? SHOP_DOMAIN,
            "x-shopify-topic": "orders/paid",
            "x-shopify-triggered-at": "2026-08-29T01:00:00Z",
            "x-shopify-webhook-id": options.webhookId ?? WEBHOOK_ID,
        },
        method: "POST",
    });
}
async function webhookSignature(body: string) {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(WEBHOOK_SECRET), { hash: "SHA-256", name: "HMAC" }, false, ["sign"]);
    const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
    let binary = "";
    for (const byte of new Uint8Array(signature))
        binary += String.fromCharCode(byte);
    return btoa(binary);
}
function readLineCapability(payload: Record<string, unknown>) {
    const property = firstLineProperty(payload);
    const value = property["value"];
    if (typeof value !== "string")
        throw new Error("Fixture capability is invalid.");
    return value;
}
function setFirstLineProperty(payload: Record<string, unknown>, value: string) {
    firstLineProperty(payload)["value"] = value;
}
function setFirstLineQuantity(payload: Record<string, unknown>, quantity: number) {
    const lineItems = payload["line_items"];
    if (!Array.isArray(lineItems) || !isRecord(lineItems[0])) {
        throw new Error("Fixture line is invalid.");
    }
    lineItems[0]["quantity"] = quantity;
}
function firstLineProperty(payload: Record<string, unknown>) {
    const lineItems = payload["line_items"];
    if (!Array.isArray(lineItems) || !isRecord(lineItems[0])) {
        throw new Error("Fixture line is invalid.");
    }
    const properties = lineItems[0]["properties"];
    if (!Array.isArray(properties) || !isRecord(properties[0])) {
        throw new Error("Fixture properties are invalid.");
    }
    return properties[0];
}
async function openException() {
    return testPlatform().env.DB.prepare(`
    SELECT code FROM fulfilment_exceptions WHERE status = 'open'
  `).first<{
        code: string;
    }>();
}
async function tableCount(table: string) {
    if (!/^[a-z_]+$/u.test(table))
        throw new Error("Invalid fixture table.");
    const result = await testPlatform().env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{
        count: number;
    }>();
    return result?.count ?? 0;
}
async function sha256Hex(value: string) {
    return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
}
function bytesToHex(bytes: Uint8Array) {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
