import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getPlatformProxy, type PlatformProxy } from "wrangler";
import { productPurchaseReadiness } from "./product-purchase-readiness";
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
describe("product-wide print purchase readiness", () => {
    it("keeps verified legacy products ready and follows the accepted catalogue", async () => {
        await seedNewerUnmappedCatalogue();
        expect(await productPurchaseReadiness(testPlatform().env.DB, CONFIGURED_PRODUCT_ID)).toEqual({ ready: true });
    });
    it.each(["pending", "dispatched", "running", "ready"])("does not trust a %s job without assets", async (status) => {
        const db = testPlatform().env.DB;
        await db.prepare("INSERT INTO print_asset_jobs (configured_product_id, status, next_attempt_at, created_at, updated_at) VALUES (?, ?, 0, 0, 0)")
            .bind(CONFIGURED_PRODUCT_ID, status).run();
        await db.prepare("DELETE FROM print_assets").run();
        expect(await productPurchaseReadiness(db, CONFIGURED_PRODUCT_ID)).toEqual({ ready: false });
    });
    it("requires the ready job commit for queued products", async () => {
        const db = testPlatform().env.DB;
        await db.prepare("INSERT INTO print_asset_jobs (configured_product_id, status, next_attempt_at, created_at, updated_at) VALUES (?, 'running', 0, 0, 0)")
            .bind(CONFIGURED_PRODUCT_ID).run();
        expect(await productPurchaseReadiness(db, CONFIGURED_PRODUCT_ID)).toEqual({ ready: false });
        await db.prepare("UPDATE print_asset_jobs SET status = 'ready'").run();
        expect(await productPurchaseReadiness(db, CONFIGURED_PRODUCT_ID)).toEqual({ ready: true });
    });
    it.each([
        "status = 'failed'", "status = 'pending'", "status = 'deleted'",
        "projection_version = 'legacy-shirt-v1'", "geometry_key = 'dtg:4000x4000'",
        "width_px = 4000", "height_px = 4000", "sha256 = '" + "z".repeat(64) + "'",
        "storage_key = 'unrelated/object.png'", "deleted_at = 1",
        "base_product_id = '" + CONFIGURED_PRODUCT_ID + "'",
    ])("rejects an asset with %s", async (update) => {
        const db = testPlatform().env.DB;
        await db.prepare(`UPDATE print_assets SET ${update}`).run();
        expect(await productPurchaseReadiness(db, CONFIGURED_PRODUCT_ID)).toEqual({ ready: false });
    });
    it("requires the product's exact immutable revision", async () => {
        const db = testPlatform().env.DB;
        await db.prepare(`INSERT INTO design_revisions (
      id, design_id, fingerprint, artwork_key, content_type, byte_size, sha256,
      crop_x, crop_y, crop_zoom, placement_x, placement_y, placement_width, depth, created_at
    ) SELECT 'other-revision', design_id, 'other-fingerprint', artwork_key, content_type,
      byte_size, sha256, crop_x, crop_y, crop_zoom, placement_x, placement_y,
      placement_width, depth, created_at FROM design_revisions WHERE id = ?`).bind(REVISION_ID).run();
        await db.prepare("UPDATE print_assets SET design_revision_id = 'other-revision'").run();
        expect(await productPurchaseReadiness(db, CONFIGURED_PRODUCT_ID)).toEqual({ ready: false });
    });
    it("requires all geometries, including temporarily unavailable variants", async () => {
        const db = testPlatform().env.DB;
        await db.prepare(`INSERT INTO printify_catalogue_variants (
      snapshot_id, printify_variant_id, colour, size, available, decoration_method,
      print_width, print_height, shipping_first_item, shipping_additional_item,
      shipping_currency, handling_days_from, handling_days_to
    ) VALUES (?, 202, 'White', 'S', 0, 'dtg', 4000, 4000, 1000, 500, 'AUD', 1, 3)`)
            .bind(CATALOGUE_ID).run();
        expect(await productPurchaseReadiness(db, CONFIGURED_PRODUCT_ID)).toEqual({ ready: false });
        await db.prepare(`INSERT INTO print_assets (
      id, configured_product_id, design_revision_id, base_product_id, projection_version,
      geometry_key, storage_key, content_type, byte_size, width_px, height_px, sha256,
      status, created_at, updated_at, ready_at
    ) SELECT 'second-asset', configured_product_id, design_revision_id, base_product_id,
      projection_version, 'dtg:4000x4000', 'print-assets/' || configured_product_id ||
      '/dtg:4000x4000/' || sha256 || '.png', content_type, byte_size, 4000, 4000, sha256,
      'ready', created_at, updated_at, ready_at FROM print_assets WHERE id = ?`).bind(ASSET_ID).run();
        expect(await productPurchaseReadiness(db, CONFIGURED_PRODUCT_ID)).toEqual({ ready: true });
        await db.prepare("UPDATE print_assets SET status = 'failed' WHERE id = 'second-asset'").run();
        expect(await productPurchaseReadiness(db, CONFIGURED_PRODUCT_ID)).toEqual({ ready: false });
    });
    it("ignores obsolete failed geometries outside the accepted catalogue", async () => {
        const db = testPlatform().env.DB;
        await db.prepare(`INSERT INTO print_assets (
      id, configured_product_id, design_revision_id, base_product_id, projection_version,
      geometry_key, status, created_at, updated_at
    ) VALUES ('obsolete', ?, ?, ?, 'safe-margin-v1', 'dtg:1000x1000', 'failed', 0, 0)`)
            .bind(CONFIGURED_PRODUCT_ID, REVISION_ID, BASE_PRODUCT_ID).run();
        expect(await productPurchaseReadiness(db, CONFIGURED_PRODUCT_ID)).toEqual({ ready: true });
    });
    it("fails closed when no required geometry can be resolved", async () => {
        const db = testPlatform().env.DB;
        await db.prepare("DELETE FROM printify_catalogue_variants").run();
        expect(await productPurchaseReadiness(db, CONFIGURED_PRODUCT_ID)).toEqual({ ready: false });
    });
    it("fails closed when no accepted mapping exists", async () => {
        const db = testPlatform().env.DB;
        await db.prepare("DELETE FROM shopify_variant_mappings").run();
        await db.prepare("DELETE FROM shopify_variant_mapping_snapshots").run();
        expect(await productPurchaseReadiness(db, CONFIGURED_PRODUCT_ID)).toEqual({ ready: false });
    });
    it("requires content-addressed object metadata to agree with its asset", async () => {
        const db = testPlatform().env.DB;
        await db.prepare(`INSERT INTO print_asset_objects (
      sha256, storage_key, content_type, byte_size, width_px, height_px, created_at
    ) SELECT sha256, 'print-asset-objects/' || sha256 || '.png', content_type,
      byte_size, width_px, height_px, created_at FROM print_assets`).run();
        await db.prepare("UPDATE print_assets SET object_sha256 = sha256").run();
        expect(await productPurchaseReadiness(db, CONFIGURED_PRODUCT_ID)).toEqual({ ready: true });
        await db.prepare("UPDATE print_asset_objects SET width_px = 123").run();
        expect(await productPurchaseReadiness(db, CONFIGURED_PRODUCT_ID)).toEqual({ ready: false });
    });
    it("does not expose readiness for inactive products or base products", async () => {
        const db = testPlatform().env.DB;
        expect(await productPurchaseReadiness(db, BASE_PRODUCT_ID)).toBeUndefined();
        expect(await productPurchaseReadiness(db, 'missing')).toBeUndefined();
        await db.prepare("UPDATE products SET status = 'suspended' WHERE id = ?").bind(CONFIGURED_PRODUCT_ID).run();
        expect(await productPurchaseReadiness(db, CONFIGURED_PRODUCT_ID)).toBeUndefined();
    });
    it("does not treat a missing legacy job as proof that print files exist", async () => {
        const db = testPlatform().env.DB;
        await db.prepare("DELETE FROM print_assets").run();
        expect(await productPurchaseReadiness(db, CONFIGURED_PRODUCT_ID)).toEqual({ ready: false });
    });
});
async function seedIdentity() {
    const now = Date.now();
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", ASSET));
    const sha256 = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
    const storageKey = `print-assets/${CONFIGURED_PRODUCT_ID}/dtg:4500x5100/${sha256}.png`;
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
