import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getPlatformProxy, type PlatformProxy } from "wrangler";
import { verifyCartLineCapability } from "@forever-tee/contracts/cart-line-capability";
import { handleCartProductContextRequest } from "./cart-product-context";
import { productPurchaseReadiness } from "./product-purchase-readiness";
import { CART_LINE_CAPABILITIES_PATH, handleCartLineCapabilityRequest, } from "./cart-line-capabilities";
const SERVICE_SECRET = "service-secret";
const SIGNING_SECRET = "cart-capability-test-secret-value-123456";
const BASE_PRODUCT_ID = "a51b7acf-77e9-4762-83c4-62d96dd8942c";
const CONFIGURED_PRODUCT_ID = "189976ee-4965-45d1-8bae-6ea03a9c14bc";
const DESIGN_ID = "348bd319-df6a-4be1-b74b-dc2582ef9679";
const REVISION_ID = "401c53ee-dc17-49e5-bc04-1588a589b8b6";
const CATALOGUE_ID = "581b0c51-70c0-4f72-a292-d30030b3284e";
const MAPPING_ID = "9247ce8e-b8c1-41d5-ad50-d29fafc614ca";
const ASSET_ID = "f0584c5e-0583-453a-8f85-4fb53faabbd8";
const SHOPIFY_VARIANT_ID = "gid://shopify/ProductVariant/101";
const ASSET = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]);
let platform: PlatformProxy<Env> | undefined;
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
        FOREVER_TEE_API_SHARED_SECRET: SERVICE_SECRET,
    };
}
beforeAll(async () => {
    platform = await getPlatformProxy<Env>({ environment: "", persist: false });
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
        "0025_storage_maintenance.sql",
        "0027_image_based_default_product_color.sql",
        "0028_product_color_analysis_state.sql",
        "0036_print_job_outbox.sql",
        "0039_featured_media_composition.sql",
        "0040_recursive_video_placement.sql",
        "0041_product_image_jobs.sql",
        "0042_design_artwork_sources.sql",
        "0043_artwork_preparation_jobs.sql",
        "0044_video_preview_revisions.sql",
    ]) {
        const sql = await readFile(new URL(`../drizzle/${name}`, import.meta.url), "utf8");
        for (const rawStatement of sql.split("--> statement-breakpoint")) {
            const statement = rawStatement.trim();
            if (statement)
                await testPlatform().env.DB.prepare(statement).run();
        }
    }
});
beforeEach(async () => {
    await testPlatform().env.DB.batch([
        testPlatform().env.DB.prepare("DELETE FROM print_assets"),
        testPlatform().env.DB.prepare("DELETE FROM print_asset_objects"),
        testPlatform().env.DB.prepare("DELETE FROM shopify_variant_mappings"),
        testPlatform().env.DB.prepare("DELETE FROM shopify_variant_mapping_snapshots"),
        testPlatform().env.DB.prepare("DELETE FROM printify_catalogue_variants"),
        testPlatform().env.DB.prepare("DELETE FROM printify_catalogue_snapshots"),
        testPlatform().env.DB.prepare("DELETE FROM story_video_jobs"),
        testPlatform().env.DB.prepare("DELETE FROM products"),
        testPlatform().env.DB.prepare("DELETE FROM design_revisions"),
        testPlatform().env.DB.prepare("DELETE FROM designs"),
    ]);
    await seedIdentity();
});
afterAll(async () => platform?.dispose());
describe("cart-line capability issuance", () => {
    it("distinguishes a new product's queued print files from an unavailable variant", async () => {
        const db = testPlatform().env.DB;
        await db.prepare("INSERT INTO print_asset_jobs (configured_product_id, status, next_attempt_at, created_at, updated_at) VALUES (?, 'running', ?, ?, ?)")
            .bind(CONFIGURED_PRODUCT_ID, Date.now(), Date.now(), Date.now()).run();
        await db.prepare("UPDATE print_assets SET status = 'pending' WHERE id = ?").bind(ASSET_ID).run();
        expect(await productPurchaseReadiness(db, CONFIGURED_PRODUCT_ID)).toEqual({ ready: false });
        const response = await handledRequest({ configuredProductId: CONFIGURED_PRODUCT_ID, merchandiseId: SHOPIFY_VARIANT_ID, quantity: 1 });
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ error: { code: "PRINT_ASSETS_PENDING" } });
        await db.prepare("UPDATE print_assets SET status = 'ready' WHERE id = ?").bind(ASSET_ID).run();
        await db.prepare("UPDATE print_asset_jobs SET status = 'ready' WHERE configured_product_id = ?").bind(CONFIGURED_PRODUCT_ID).run();
        expect(await productPurchaseReadiness(db, CONFIGURED_PRODUCT_ID)).toEqual({ ready: true });
        expect((await handledRequest({ configuredProductId: CONFIGURED_PRODUCT_ID, merchandiseId: SHOPIFY_VARIANT_ID, quantity: 1 })).status).toBe(200);
    });
    it("persists a signed cart intent before printing and upgrades it only after verified artwork exists", async () => {
        const db = testPlatform().env.DB;
        await db.prepare("INSERT INTO print_asset_jobs (configured_product_id, status, next_attempt_at, created_at, updated_at) VALUES (?, 'running', ?, ?, ?)")
            .bind(CONFIGURED_PRODUCT_ID, Date.now(), Date.now(), Date.now()).run();
        await db.prepare("UPDATE print_assets SET status = 'pending' WHERE id = ?").bind(ASSET_ID).run();
        const input = { configuredProductId: CONFIGURED_PRODUCT_ID, merchandiseId: SHOPIFY_VARIANT_ID, quantity: 1 };
        const added = await handledRequest({ ...input, allowPending: true });
        expect(added.status).toBe(200);
        const pending: unknown = await added.json();
        if (!isRecord(pending) || typeof pending["capability"] !== "string")
            throw new Error("Expected cart intent");
        const intent = pending["capability"];
        // A pending intent can never authorize a paid order.
        expect(await verifyCartLineCapability(intent, SIGNING_SECRET)).toBeUndefined();
        expect((await handledRequest({ ...input, capability: intent })).status).toBe(409);
        expect((await handledRequest({ ...input, allowPending: true, merchandiseId: "gid://shopify/ProductVariant/other" })).status).toBe(409);
        await db.prepare("UPDATE print_assets SET status = 'ready' WHERE id = ?").bind(ASSET_ID).run();
        const ready = await handledRequest({ ...input, capability: intent });
        expect(ready.status).toBe(200);
        const upgraded: unknown = await ready.json();
        if (!isRecord(upgraded) || typeof upgraded["capability"] !== "string")
            throw new Error("Expected print capability");
        expect(upgraded["valid"]).toBe(true);
        expect(await verifyCartLineCapability(upgraded["capability"], SIGNING_SECRET)).toMatchObject({
            configuredProductId: CONFIGURED_PRODUCT_ID, printAssetId: ASSET_ID, quantity: 1,
        });
        expect((await handledRequest({ ...input, capability: intent, quantity: 2 })).status).toBe(409);
        expect((await handledRequest({ ...input, capability: intent.slice(0, -4) + "AAAA" })).status).toBe(409);
        await db.prepare("UPDATE products SET status = 'suspended' WHERE id = ?").bind(CONFIGURED_PRODUCT_ID).run();
        expect((await handledRequest({ ...input, capability: intent })).status).toBe(409);
    });
    it("keeps a pending source intent stable through final revision creation and rejects premature checkout", async () => {
        const db = testPlatform().env.DB;
        const jobId = crypto.randomUUID();
        await db.prepare(`INSERT INTO artwork_preparation_jobs (id, design_id, source_key, source_bytes, source_sha256,
      status, next_attempt_at, created_at, updated_at) VALUES (?, ?, 'staged-source', 8, ?, 'pending', 0, 0, 0)`)
            .bind(jobId, DESIGN_ID, "a".repeat(64)).run();
        await db.prepare("UPDATE designs SET status = 'processing', artwork_job_id = ? WHERE id = ?").bind(jobId, DESIGN_ID).run();
        await db.prepare("UPDATE products SET design_revision_id = NULL WHERE id = ?").bind(CONFIGURED_PRODUCT_ID).run();
        const input = { configuredProductId: CONFIGURED_PRODUCT_ID, merchandiseId: SHOPIFY_VARIANT_ID, quantity: 1 };
        expect(await productPurchaseReadiness(db, CONFIGURED_PRODUCT_ID)).toEqual({ ready: false });
        expect((await contextRequest())?.status).toBe(200);
        const added = await handledRequest({ ...input, allowPending: true });
        expect(added.status).toBe(200);
        const pending: unknown = await added.json();
        if (!isRecord(pending) || typeof pending["capability"] !== "string")
            throw new Error("Expected cart intent");
        const intent = pending["capability"];
        expect(await verifyCartLineCapability(intent, SIGNING_SECRET)).toBeUndefined();
        expect((await handledRequest({ ...input, capability: intent })).status).toBe(409);
        await db.prepare("UPDATE artwork_preparation_jobs SET status = 'failed' WHERE id = ?").bind(jobId).run();
        expect(await productPurchaseReadiness(db, CONFIGURED_PRODUCT_ID)).toEqual({ ready: false,
            retryArtwork: { designId: DESIGN_ID, artworkJobId: jobId } });
        await db.prepare(`INSERT INTO design_revisions (id, design_id, fingerprint, artwork_key, content_type,
      byte_size, artwork_width, artwork_height, sha256, crop_x, crop_y, crop_zoom,
      placement_x, placement_y, placement_width, depth, created_at)
      SELECT ?, design_id, 'prepared-source', artwork_key, content_type, byte_size, artwork_width, artwork_height,
      sha256, crop_x, crop_y, crop_zoom, placement_x, placement_y, placement_width, depth, created_at
      FROM design_revisions WHERE id = ?`).bind(DESIGN_ID, REVISION_ID).run();
        await db.prepare("UPDATE designs SET status = 'ready' WHERE id = ?").bind(DESIGN_ID).run();
        await db.prepare("UPDATE products SET design_revision_id = ? WHERE id = ?").bind(DESIGN_ID, CONFIGURED_PRODUCT_ID).run();
        // The old revision's otherwise valid print asset must not satisfy checkout.
        expect((await handledRequest({ ...input, capability: intent })).status).toBe(409);
        await db.prepare("UPDATE print_assets SET design_revision_id = ? WHERE id = ?").bind(DESIGN_ID, ASSET_ID).run();
        const upgraded: unknown = await (await handledRequest({ ...input, capability: intent })).json();
        if (!isRecord(upgraded) || typeof upgraded["capability"] !== "string")
            throw new Error("Expected final capability");
        expect(await verifyCartLineCapability(upgraded["capability"], SIGNING_SECRET)).toMatchObject({
            designRevisionId: DESIGN_ID, configuredProductId: CONFIGURED_PRODUCT_ID, printAssetId: ASSET_ID,
        });
    });
    it("preserves legacy readiness while rejecting inactive products and base products", async () => {
        const db = testPlatform().env.DB;
        expect(await productPurchaseReadiness(db, CONFIGURED_PRODUCT_ID)).toEqual({ ready: true });
        expect(await productPurchaseReadiness(db, BASE_PRODUCT_ID)).toBeUndefined();
        await db.prepare("UPDATE products SET status = 'suspended' WHERE id = ?").bind(CONFIGURED_PRODUCT_ID).run();
        expect(await productPurchaseReadiness(db, CONFIGURED_PRODUCT_ID)).toBeUndefined();
    });
    const contextRequest = (id = CONFIGURED_PRODUCT_ID, authenticated = true, method = "GET") => handleCartProductContextRequest(new Request(`https://api.example.com/v2/internal/cart-product-context/${id}`, { method,
        headers: authenticated ? { "x-forever-tee-service-secret": SERVICE_SECRET } : {} }), { ...testPlatform().env, FOREVER_TEE_API_SHARED_SECRET: SERVICE_SECRET });
    it("returns only the live verified cart context through the authenticated route", async () => {
        const response = await contextRequest();
        expect(response?.status).toBe(200);
        expect(response?.headers.get("cache-control")).toBe("no-store");
        expect(await response?.json()).toEqual({ productId: CONFIGURED_PRODUCT_ID, designId: DESIGN_ID, baseShopifyHandle: "bent-shirt" });
        expect((await contextRequest(CONFIGURED_PRODUCT_ID, false))?.status).toBe(401);
        expect((await contextRequest(CONFIGURED_PRODUCT_ID, true, "POST"))?.status).toBe(405);
    });
    it.each(["suspended", "unpublished", "retired"])("rejects %s products in fresh cart context reads", async (status) => {
        expect((await contextRequest())?.status).toBe(200);
        await testPlatform().env.DB.prepare("UPDATE products SET status = ? WHERE id = ?").bind(status, CONFIGURED_PRODUCT_ID).run();
        expect((await contextRequest())?.status).toBe(409);
    });
    it("retains base-product and ready-design checks", async () => {
        expect((await contextRequest(BASE_PRODUCT_ID))?.status).toBe(409);
        await testPlatform().env.DB.prepare("UPDATE products SET status = 'suspended' WHERE id = ?").bind(BASE_PRODUCT_ID).run();
        expect((await contextRequest())?.status).toBe(409);
        await testPlatform().env.DB.prepare("UPDATE products SET status = 'active' WHERE id = ?").bind(BASE_PRODUCT_ID).run();
        for (const status of ["creating", "deleted"]) {
            await testPlatform().env.DB.prepare("UPDATE designs SET status = ? WHERE id = ?").bind(status, DESIGN_ID).run();
            expect((await contextRequest())?.status).toBe(409);
        }
    });
    it("retains repository decoding failures instead of returning partial context", async () => {
        await testPlatform().env.DB.prepare("UPDATE designs SET depth = 999 WHERE id = ?").bind(DESIGN_ID).run();
        expect((await contextRequest())?.status).toBe(503);
    });
    it("signs the exact ready asset and mapped variant chain", async () => {
        await seedNewerUnmappedCatalogue();
        const response = await handledRequest({
            configuredProductId: CONFIGURED_PRODUCT_ID,
            merchandiseId: SHOPIFY_VARIANT_ID,
            quantity: 3,
        });
        expect(response.status).toBe(200);
        const payload: unknown = await response.json();
        if (!isRecord(payload) || typeof payload["capability"] !== "string") {
            throw new Error("Capability response was invalid.");
        }
        const verified = await verifyCartLineCapability(payload["capability"], SIGNING_SECRET);
        expect(verified).toMatchObject({
            baseProductId: BASE_PRODUCT_ID,
            color: "Black",
            configuredProductId: CONFIGURED_PRODUCT_ID,
            designRevisionId: REVISION_ID,
            printAssetId: ASSET_ID,
            printGeometryKey: "dtg:4500x5100",
            printifyVariantId: 201,
            quantity: 3,
            shopifyVariantId: SHOPIFY_VARIANT_ID,
            size: "M",
            variantMappingSnapshotId: MAPPING_ID,
        });
    });
    it.each(["suspended", "unpublished", "retired"])("rejects a stale cart capability after %s", async (status) => {
        const input = { configuredProductId: CONFIGURED_PRODUCT_ID, merchandiseId: SHOPIFY_VARIANT_ID, quantity: 1 };
        const issued: unknown = await (await handledRequest(input)).json();
        if (!isRecord(issued) || typeof issued["capability"] !== "string")
            throw new Error("Expected capability");
        await testPlatform().env.DB.prepare("UPDATE products SET status = ? WHERE id = ?").bind(status, CONFIGURED_PRODUCT_ID).run();
        expect((await handledRequest({ ...input, capability: issued["capability"] })).status).toBe(409);
        expect((await handledRequest(input)).status).toBe(409);
    });
    it("rejects a suspension that commits while checkout verifies the R2 asset", async () => {
        const env = workerEnv();
        const response = await handleCartLineCapabilityRequest(new Request(`https://api.example.com${CART_LINE_CAPABILITIES_PATH}`, {
            method: "POST", headers: { "content-type": "application/json", "x-forever-tee-service-secret": SERVICE_SECRET },
            body: JSON.stringify({ configuredProductId: CONFIGURED_PRODUCT_ID, merchandiseId: SHOPIFY_VARIANT_ID, quantity: 1 }),
        }), { ...env, DESIGN_ARTWORK: { head: async (key) => {
                    const object = await env.DESIGN_ARTWORK.head(key);
                    await env.DB.prepare("UPDATE products SET status = 'suspended' WHERE id = ?").bind(CONFIGURED_PRODUCT_ID).run();
                    return object;
                } } });
        expect(response?.status).toBe(409);
    });
    it("rejects a Shopify variant outside the configured Base Product", async () => {
        const response = await handledRequest({
            configuredProductId: CONFIGURED_PRODUCT_ID,
            merchandiseId: "gid://shopify/ProductVariant/other",
            quantity: 1,
        });
        expect(response.status).toBe(409);
    });
    it("revalidates the persisted token against the current quantity and chain", async () => {
        const issued = await handledRequest({
            configuredProductId: CONFIGURED_PRODUCT_ID,
            merchandiseId: SHOPIFY_VARIANT_ID,
            quantity: 3,
        });
        const issuedPayload: unknown = await issued.json();
        if (!isRecord(issuedPayload) ||
            typeof issuedPayload["capability"] !== "string")
            throw new Error("Capability response was invalid.");
        const valid = await handledRequest({
            capability: issuedPayload["capability"],
            configuredProductId: CONFIGURED_PRODUCT_ID,
            merchandiseId: SHOPIFY_VARIANT_ID,
            quantity: 3,
        });
        expect(valid.status).toBe(200);
        await expect(valid.json()).resolves.toEqual({ valid: true });
        const wrongQuantity = await handledRequest({
            capability: issuedPayload["capability"],
            configuredProductId: CONFIGURED_PRODUCT_ID,
            merchandiseId: SHOPIFY_VARIANT_ID,
            quantity: 2,
        });
        expect(wrongQuantity.status).toBe(409);
    });
    it("fails closed when the ready asset object loses integrity", async () => {
        const row = await testPlatform().env.DB.prepare(`
      SELECT coalesce(objects.storage_key, assets.storage_key) AS storage_key
      FROM print_assets AS assets
      LEFT JOIN print_asset_objects AS objects
        ON objects.sha256 = assets.object_sha256
      WHERE assets.id = ?
    `).bind(ASSET_ID).first<{
            storage_key: string;
        }>();
        if (!row)
            throw new Error("Print Asset fixture is missing.");
        await testPlatform().env.DESIGN_ARTWORK.delete(row.storage_key);
        const response = await handledRequest({
            configuredProductId: CONFIGURED_PRODUCT_ID,
            merchandiseId: SHOPIFY_VARIANT_ID,
            quantity: 1,
        });
        expect(response.status).toBe(503);
    });
});
async function handledRequest(payload: Record<string, unknown>) {
    const response = await handleCartLineCapabilityRequest(new Request(`https://api.example${CART_LINE_CAPABILITIES_PATH}`, {
        body: JSON.stringify(payload),
        headers: {
            "content-type": "application/json",
            "x-forever-tee-service-secret": SERVICE_SECRET,
        },
        method: "POST",
    }), workerEnv());
    if (!response)
        throw new Error("Capability route was not handled.");
    return response;
}
async function seedIdentity() {
    const now = Date.now();
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", ASSET));
    const sha256 = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
    const storageKey = `print-assets/${CONFIGURED_PRODUCT_ID}/dtg:4500x5100/${sha256}.png`;
    await testPlatform().env.DESIGN_ARTWORK.put(storageKey, ASSET, {
        sha256: digest,
    });
    await testPlatform().env.DB.batch([
        testPlatform().env.DB.prepare(`
      INSERT INTO designs (
        id, owner_id, artwork_key, content_type, byte_size, sha256,
        crop_x, crop_y, crop_zoom, placement_x, placement_y, placement_width,
        depth, status, version, finalized_at, created_at, updated_at
      ) VALUES (?, NULL, ?, 'image/png', 8, ?, 0.5, 0.5, 1, 0.3, 0.3,
        0.2, 5, 'ready', 1, ?, ?, ?)
    `).bind(DESIGN_ID, `designs/${DESIGN_ID}/artwork/${sha256}`, sha256, now, now, now),
        testPlatform().env.DB.prepare(`
      INSERT INTO design_revisions (
        id, design_id, fingerprint, artwork_key, content_type, byte_size,
        artwork_width, artwork_height, sha256, crop_x, crop_y, crop_zoom,
        placement_x, placement_y, placement_width, depth, created_at
      ) VALUES (?, ?, 'fixture', ?, 'image/png', 8, 3000, 4000, ?,
        0.5, 0.5, 1, 0, 0, 0.08, 1, ?)
    `).bind(REVISION_ID, DESIGN_ID, `designs/${DESIGN_ID}/artwork/${sha256}`, sha256, now),
    ]);
    await testPlatform().env.DB.batch([
        testPlatform().env.DB.prepare(`
      INSERT INTO products (
        id, base_product_id, design_id, design_revision_id, shopify_handle,
        status, created_at
      ) VALUES (?, ?, NULL, NULL, 'bent-shirt', 'active', ?)
    `).bind(BASE_PRODUCT_ID, BASE_PRODUCT_ID, now),
        testPlatform().env.DB.prepare(`
      INSERT INTO products (
        id, base_product_id, design_id, design_revision_id, placement_x,
        placement_y, placement_width, placement_depth, projection_version,
        shopify_handle, status, created_at
      ) VALUES (?, ?, ?, ?, 0.3, 0.3, 0.2, 5, 'safe-margin-v1',
        'bent-shirt', 'active', ?)
    `).bind(CONFIGURED_PRODUCT_ID, BASE_PRODUCT_ID, DESIGN_ID, REVISION_ID, now),
        testPlatform().env.DB.prepare(`
      INSERT INTO printify_catalogue_snapshots (
        id, shop_id, blueprint_id, print_provider_id, retrieved_at,
        source_urls_json, variant_count, base_product_id, base_product_slug
      ) VALUES (?, 'shop', 1, 1, ?, '[]', 1, ?, 'staple-tee')
    `).bind(CATALOGUE_ID, now, BASE_PRODUCT_ID),
        testPlatform().env.DB.prepare(`
      INSERT INTO shopify_variant_mapping_snapshots (
        id, catalogue_snapshot_id, shopify_product_id, shopify_product_handle,
        shopify_product_title, retrieved_at, source_url, variant_count,
        base_product_id, base_product_slug
      ) VALUES (?, ?, 'gid://shopify/Product/1', 'bent-shirt', 'bent.shop',
        ?, 'https://example.invalid/product', 1, ?, 'staple-tee')
    `).bind(MAPPING_ID, CATALOGUE_ID, now, BASE_PRODUCT_ID),
    ]);
    await testPlatform().env.DB.batch([
        testPlatform().env.DB.prepare(`
      INSERT INTO printify_catalogue_variants (
        snapshot_id, printify_variant_id, colour, size, available,
        decoration_method, print_width, print_height, shipping_first_item,
        shipping_additional_item, shipping_currency, handling_days_from,
        handling_days_to
      ) VALUES (?, 201, 'Black', 'M', 1, 'dtg', 4500, 5100,
        1000, 500, 'AUD', 1, 3)
    `).bind(CATALOGUE_ID),
        testPlatform().env.DB.prepare(`
      INSERT INTO shopify_variant_mappings (
        snapshot_id, shopify_variant_id, printify_variant_id, colour, size,
        sku, shopify_available
      ) VALUES (?, ?, 201, 'Black', 'M', 'BENT-BLACK-M', 1)
    `).bind(MAPPING_ID, SHOPIFY_VARIANT_ID),
        testPlatform().env.DB.prepare(`
      INSERT INTO print_assets (
        id, configured_product_id, design_revision_id, base_product_id,
        projection_version, geometry_key, storage_key, content_type, byte_size,
        width_px, height_px, sha256, status, created_at, updated_at, ready_at
      ) VALUES (?, ?, ?, ?, 'safe-margin-v1', 'dtg:4500x5100', ?,
        'image/png', 8, 4500, 5100, ?, 'ready', ?, ?, ?)
    `).bind(ASSET_ID, CONFIGURED_PRODUCT_ID, REVISION_ID, BASE_PRODUCT_ID, storageKey, sha256, now, now, now),
    ]);
}
async function seedNewerUnmappedCatalogue() {
    const snapshotId = "f62c7d4a-529f-47e0-aa68-9e10b805003e";
    await testPlatform().env.DB.batch([
        testPlatform().env.DB.prepare(`
      INSERT INTO printify_catalogue_snapshots (
        id, shop_id, blueprint_id, print_provider_id, retrieved_at,
        source_urls_json, variant_count, base_product_id, base_product_slug
      ) VALUES (?, 'shop', 1, 1, ?, '[]', 1, ?, 'staple-tee')
    `).bind(snapshotId, Date.now() + 1, BASE_PRODUCT_ID),
        testPlatform().env.DB.prepare(`
      INSERT INTO printify_catalogue_variants (
        snapshot_id, printify_variant_id, colour, size, available,
        decoration_method, print_width, print_height, shipping_first_item,
        shipping_additional_item, shipping_currency, handling_days_from,
        handling_days_to
      ) VALUES (?, 999, 'Black', 'M', 1, 'dtg', 6000, 7000,
        1000, 500, 'AUD', 1, 3)
    `).bind(snapshotId),
    ]);
}
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
