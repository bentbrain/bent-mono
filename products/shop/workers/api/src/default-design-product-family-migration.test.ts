import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getPlatformProxy, type PlatformProxy } from "wrangler";
const SAMPLE_PRODUCT_ID = "d2dd07c1-dbbf-4d1a-8df7-9c43b4a7dfc4";
const SAMPLE_TOTE_PRODUCT_ID = "55b53491-a09d-4f50-b9f6-73fbd3fabff9";
const TOTE_BASE_PRODUCT_ID = "97b629d7-1d3b-4d2a-a586-537168141e97";
let platform: PlatformProxy<Env> | undefined;
function testPlatform() {
    if (!platform)
        throw new Error("Test bindings are unavailable.");
    return platform;
}
beforeAll(async () => {
    platform = await getPlatformProxy<Env>({ environment: "", persist: false });
    await testPlatform().env.DB.prepare(`
    CREATE TABLE products (
      id TEXT PRIMARY KEY NOT NULL,
      base_product_id TEXT NOT NULL,
      design_id TEXT,
      design_revision_id TEXT,
      placement_x REAL,
      placement_y REAL,
      placement_width REAL,
      placement_depth INTEGER,
      projection_version TEXT,
      shopify_handle TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      deleted_at INTEGER
    )
  `).run();
    await testPlatform().env.DB.prepare(`
    CREATE UNIQUE INDEX products_active_design_revision_base_product_unique_idx
      ON products (design_revision_id, base_product_id)
      WHERE design_revision_id IS NOT NULL AND status = 'active'
  `).run();
    await testPlatform().env.DB.prepare("\n    INSERT INTO products (\n      id, base_product_id, design_id, design_revision_id,\n      placement_x, placement_y, placement_width, placement_depth,\n      projection_version, shopify_handle, status, created_at, deleted_at\n    ) VALUES (?, '" + "a51b7acf-77e9-4762-83c4-62d96dd8942c" + "',\n      '" + "c2bf0318-784a-4dda-b82b-9534aed42903" + "',\n      'sample-revision', 0.39, 0.43, 0.22, 5,\n      'legacy-shirt-v1', 'bent-shirt', 'active', 1786831200000, NULL)\n  ").bind(SAMPLE_PRODUCT_ID).run();
});
afterAll(async () => platform?.dispose());
describe("default design product family migration", () => {
    it("adds one compatible tote projection and remains idempotent", async () => {
        const migration = await readFile(new URL("../drizzle/0014_default_design_product_family.sql", import.meta.url), "utf8");
        await testPlatform().env.DB.prepare(migration).run();
        await testPlatform().env.DB.prepare(migration).run();
        const tote = await testPlatform().env.DB.prepare(`
      SELECT id, base_product_id, design_id, design_revision_id,
        placement_x, placement_y, placement_width, placement_depth,
        projection_version, shopify_handle
      FROM products
      WHERE base_product_id = ? AND status = 'active'
    `).bind(TOTE_BASE_PRODUCT_ID).first<{
            base_product_id: string;
            design_id: string;
            design_revision_id: string;
            id: string;
            placement_depth: number;
            placement_width: number;
            placement_x: number;
            placement_y: number;
            projection_version: string;
            shopify_handle: string;
        }>();
        expect(tote).toMatchObject({
            base_product_id: TOTE_BASE_PRODUCT_ID,
            design_id: "c2bf0318-784a-4dda-b82b-9534aed42903",
            design_revision_id: "sample-revision",
            id: SAMPLE_TOTE_PRODUCT_ID,
            placement_depth: 5,
            projection_version: "safe-margin-v1",
            shopify_handle: "cotton-tote",
        });
        expect(tote?.placement_x).toBe(0.399157);
        expect(tote?.placement_y).toBe(0.435827);
        expect(tote?.placement_width).toBe(0.201686);
        const family = await testPlatform().env.DB.prepare(`
      SELECT COUNT(*) AS count FROM products
      WHERE design_revision_id = 'sample-revision' AND status = 'active'
    `).first<{
            count: number;
        }>();
        expect(family?.count).toBe(2);
    });
});
