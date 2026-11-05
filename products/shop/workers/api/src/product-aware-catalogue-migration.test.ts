import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getPlatformProxy, type PlatformProxy } from "wrangler";
let platform: PlatformProxy<Env> | undefined;
function testPlatform() {
    if (!platform)
        throw new Error("Test bindings are unavailable.");
    return platform;
}
beforeAll(async () => {
    platform = await getPlatformProxy<Env>({ environment: "", persist: false });
    await applyMigration("0009_printify_catalogue_snapshots.sql");
    await applyMigration("0010_shopify_variant_mappings.sql");
    await seedLegacyShirtHistory();
    await applyMigration("0012_product_aware_catalogues.sql");
});
afterAll(async () => platform?.dispose());
describe("product-aware catalogue migration", () => {
    it("preserves legacy shirt history under the stable Staple Tee identity", async () => {
        const catalogue = await testPlatform().env.DB.prepare(`
      SELECT base_product_id, base_product_slug, blueprint_id
      FROM printify_catalogue_snapshots WHERE id = 'legacy-catalogue'
    `).first<{
            base_product_id: string;
            base_product_slug: string;
            blueprint_id: number;
        }>();
        expect(catalogue).toEqual({
            base_product_id: "a51b7acf-77e9-4762-83c4-62d96dd8942c",
            base_product_slug: "staple-tee",
            blueprint_id: 440,
        });
        const mapping = await testPlatform().env.DB.prepare(`
      SELECT base_product_id, base_product_slug, catalogue_snapshot_id
      FROM shopify_variant_mapping_snapshots WHERE id = 'legacy-mapping'
    `).first<{
            base_product_id: string;
            base_product_slug: string;
            catalogue_snapshot_id: string;
        }>();
        expect(mapping).toEqual({
            base_product_id: "a51b7acf-77e9-4762-83c4-62d96dd8942c",
            base_product_slug: "staple-tee",
            catalogue_snapshot_id: "legacy-catalogue",
        });
    });
    it("accepts Cream DTG tote variants while retaining immutability", async () => {
        await testPlatform().env.DB.prepare("\n      INSERT INTO printify_catalogue_snapshots (\n        id, shop_id, base_product_id, base_product_slug, blueprint_id,\n        print_provider_id, retrieved_at, source_urls_json, variant_count\n      ) VALUES (\n        'tote-catalogue', '123',\n        '" + "97b629d7-1d3b-4d2a-a586-537168141e97" + "', 'cotton-tote',\n        553, 34, 1787616000000, '[]', 1\n      )\n    ").run();
        await testPlatform().env.DB.prepare(`
      INSERT INTO printify_catalogue_variants (
        snapshot_id, printify_variant_id, colour, size, available,
        decoration_method, print_width, print_height, shipping_first_item,
        shipping_additional_item, shipping_currency, handling_days_from,
        handling_days_to
      ) VALUES (
        'tote-catalogue', 70646, 'Cream', 'One size', 1, 'dtg', 2835,
        3425, 639, 139, 'USD', 3, 6
      )
    `).run();
        await expect(testPlatform().env.DB.prepare(`
      UPDATE printify_catalogue_variants SET available = 0
      WHERE snapshot_id = 'tote-catalogue'
    `).run()).rejects.toThrow("catalogue variants are immutable");
    });
});
async function applyMigration(name: string) {
    const sql = await readFile(new URL(`../drizzle/${name}`, import.meta.url), "utf8");
    for (const rawStatement of sql.split("--> statement-breakpoint")) {
        const statement = rawStatement.trim();
        if (statement)
            await testPlatform().env.DB.prepare(statement).run();
    }
}
async function seedLegacyShirtHistory() {
    await testPlatform().env.DB.batch([
        testPlatform().env.DB.prepare(`
      INSERT INTO printify_catalogue_snapshots (
        id, shop_id, blueprint_id, print_provider_id, retrieved_at,
        source_urls_json, variant_count
      ) VALUES ('legacy-catalogue', '123', 440, 34, 1787529600000, '[]', 1)
    `),
        testPlatform().env.DB.prepare(`
      INSERT INTO printify_catalogue_variants (
        snapshot_id, printify_variant_id, colour, size, available,
        decoration_method, print_width, print_height, shipping_first_item,
        shipping_additional_item, shipping_currency, handling_days_from,
        handling_days_to
      ) VALUES (
        'legacy-catalogue', 44001, 'Black', 'S', 1, 'dtg', 3600, 4200,
        639, 139, 'USD', 3, 6
      )
    `),
        testPlatform().env.DB.prepare(`
      INSERT INTO shopify_variant_mapping_snapshots (
        id, catalogue_snapshot_id, shopify_product_id,
        shopify_product_handle, shopify_product_title, retrieved_at,
        source_url, variant_count
      ) VALUES (
        'legacy-mapping', 'legacy-catalogue', 'gid://shopify/Product/1',
        'bent-shirt', 'bent.shop', 1787529600000,
        'https://example.myshopify.com/admin/api/2026-07/graphql.json', 1
      )
    `),
        testPlatform().env.DB.prepare(`
      INSERT INTO shopify_variant_mappings (
        snapshot_id, shopify_variant_id, printify_variant_id, colour, size,
        sku, shopify_available
      ) VALUES (
        'legacy-mapping', 'gid://shopify/ProductVariant/1', 44001,
        'Black', 'S', 'BENT-BLACK-S', 1
      )
    `),
    ]);
}
