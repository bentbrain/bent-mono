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
    await testPlatform().env.DB.prepare(`
    CREATE TABLE designs (
      id TEXT PRIMARY KEY NOT NULL,
      artwork_key TEXT NOT NULL,
      status TEXT NOT NULL
    )
  `).run();
    await testPlatform().env.DB.prepare(`
    CREATE TABLE products (
      id TEXT PRIMARY KEY NOT NULL,
      design_id TEXT
    )
  `).run();
    await testPlatform().env.DB.prepare(`
    INSERT INTO designs (id, artwork_key, status)
    VALUES ('featured-design', 'designs/featured/artwork/hash', 'ready')
  `).run();
    await testPlatform().env.DB.prepare(`
    INSERT INTO products (id, design_id)
    VALUES ('featured-product', 'featured-design')
  `).run();
});
afterAll(async () => platform?.dispose());
describe("image-based product colour migration", () => {
    it("gives existing and future records the white uncertainty fallback", async () => {
        const migration = await readFile(new URL("../drizzle/0027_image_based_default_product_color.sql", import.meta.url), "utf8");
        for (const rawStatement of migration.split("--> statement-breakpoint")) {
            const statement = rawStatement.trim();
            if (statement)
                await testPlatform().env.DB.prepare(statement).run();
        }
        expect(await testPlatform().env.DB.prepare(`
      SELECT default_product_color, default_product_color_model
      FROM designs WHERE id = 'featured-design'
    `).first()).toEqual({
            default_product_color: "White",
            default_product_color_model: null,
        });
        expect(await testPlatform().env.DB.prepare(`
      SELECT default_color FROM products WHERE id = 'featured-product'
    `).first()).toEqual({ default_color: "White" });
        await testPlatform().env.DB.prepare(`
      INSERT INTO products (id, design_id) VALUES ('future-product', NULL)
    `).run();
        expect(await testPlatform().env.DB.prepare(`
      SELECT default_color FROM products WHERE id = 'future-product'
    `).first()).toEqual({ default_color: "White" });
    });
    it("backfills the featured family and distinguishes it from fallback designs", async () => {
        await testPlatform().env.DB.prepare("\n      UPDATE designs SET id = '" + "c2bf0318-784a-4dda-b82b-9534aed42903" + "'\n      WHERE id = 'featured-design'\n    ").run();
        await testPlatform().env.DB.prepare("\n      UPDATE products SET design_id = '" + "c2bf0318-784a-4dda-b82b-9534aed42903" + "'\n      WHERE id = 'featured-product'\n    ").run();
        await testPlatform().env.DB.prepare(`
      INSERT INTO designs (id, artwork_key, status)
      VALUES ('fallback-design', 'designs/fallback/artwork/hash', 'ready')
    `).run();
        const migration = await readFile(new URL("../drizzle/0028_product_color_analysis_state.sql", import.meta.url), "utf8");
        for (const rawStatement of migration.split("--> statement-breakpoint")) {
            const statement = rawStatement.trim();
            if (statement)
                await testPlatform().env.DB.prepare(statement).run();
        }
        const statuses = await testPlatform().env.DB.prepare(`
      SELECT id, default_product_color, default_product_color_model,
        default_product_color_status
      FROM designs ORDER BY id
    `).all();
        expect(statuses.results).toEqual([
            {
                default_product_color: "Black",
                default_product_color_model: "featured-product-backfill-v1",
                default_product_color_status: "complete",
                id: "c2bf0318-784a-4dda-b82b-9534aed42903",
            },
            {
                default_product_color: "White",
                default_product_color_model: null,
                default_product_color_status: "fallback",
                id: "fallback-design",
            },
        ]);
        expect(await testPlatform().env.DB.prepare(`
      SELECT default_color FROM products WHERE id = 'featured-product'
    `).first()).toEqual({ default_color: "Black" });
    });
});
