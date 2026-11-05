import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getPlatformProxy, type PlatformProxy } from "wrangler";
import { handleVariantMappingRequest, runScheduledVariantMappingRefresh, VARIANT_MAPPING_PATH, VARIANT_MAPPING_REFRESH_PATH, } from "./variant-mapping-api";
const OPERATIONS_SECRET = "operations-test-secret";
const SERVICE_SECRET = "service-test-secret";
const SHOPIFY_PRODUCT_ID = "gid://shopify/Product/100";
const BLACK_VARIANT_ID = "gid://shopify/ProductVariant/101";
const WHITE_VARIANT_ID = "gid://shopify/ProductVariant/102";
const TOTE_BLACK_VARIANT_ID = "gid://shopify/ProductVariant/301";
const TOTE_CREAM_VARIANT_ID = "gid://shopify/ProductVariant/302";
const CATALOGUE_SNAPSHOT_ID = "42eb18be-453b-497a-a28c-9f4131e470dc";
let platform: PlatformProxy<Env> | undefined;
function testPlatform() {
    if (!platform)
        throw new Error("Test bindings are unavailable.");
    return platform;
}
function workerEnv() {
    return {
        BENT_SHIRT_OPERATIONS_SECRET: OPERATIONS_SECRET,
        DB: testPlatform().env.DB,
        FOREVER_TEE_API_SHARED_SECRET: SERVICE_SECRET,
        SHOPIFY_ADMIN_STORE_DOMAIN: "bent-shirt.myshopify.com",
        SHOPIFY_CLIENT_ID: "client-test-id",
        SHOPIFY_CLIENT_SECRET: "client-test-secret",
    };
}
const shopifyFetcher: typeof fetch = (input, init) => Promise.resolve(requestUrl(input).endsWith("/admin/oauth/access_token")
    ? Response.json({
        access_token: "admin-test-token",
        expires_in: 86399,
        scope: "read_products",
    })
    : Response.json({ data: { product: requestBody(init).includes("cotton-tote")
                ? shopifyProduct("cotton-tote", [
                    shopifyVariant(TOTE_BLACK_VARIANT_ID, "Black", true, "TOTE-BLACK", "One size"),
                    shopifyVariant(TOTE_CREAM_VARIANT_ID, "Cream", true, "TOTE-CREAM", "One size"),
                ])
                : shopifyProduct("bent-shirt", [
                    shopifyVariant(BLACK_VARIANT_ID, "Black", true, "BENT-BLACK-XS"),
                    shopifyVariant(WHITE_VARIANT_ID, "White", true, "BENT-WHITE-XS"),
                ]) } }));
function shopifyVariant(id: string, color: string, availableForSale: boolean, sku: string, size = "XS") {
    return {
        availableForSale,
        id,
        selectedOptions: [
            { name: "Color", value: color },
            { name: "Size", value: size },
        ],
        sku,
        title: `${color} / ${size}`,
    };
}
function shopifyProduct(handle: string, variants: readonly Record<string, unknown>[]) {
    return {
        handle,
        id: handle === "bent-shirt"
            ? SHOPIFY_PRODUCT_ID
            : "gid://shopify/Product/300",
        title: handle === "bent-shirt" ? "bent.shop" : "Cotton Tote",
        variants: { nodes: variants, pageInfo: { hasNextPage: false } },
    };
}
async function handledRequest(path: string, init: RequestInit = {}, fetcher: typeof fetch = shopifyFetcher) {
    const response = await handleVariantMappingRequest(new Request(`https://api.example.com${path}`, init), workerEnv(), fetcher);
    if (!response)
        throw new Error("Variant mapping route was not handled.");
    return response;
}
async function applyMigrations() {
    for (const name of [
        "0008_operational_controls.sql",
        "0009_printify_catalogue_snapshots.sql",
        "0010_shopify_variant_mappings.sql",
        "0012_product_aware_catalogues.sql",
    ]) {
        const sql = await readFile(new URL(`../drizzle/${name}`, import.meta.url), "utf8");
        for (const rawStatement of sql.split("--> statement-breakpoint")) {
            const statement = rawStatement.trim();
            if (!statement)
                continue;
            await testPlatform().env.DB.prepare(statement
                .replace("CREATE TABLE", "CREATE TABLE IF NOT EXISTS")
                .replace("CREATE INDEX", "CREATE INDEX IF NOT EXISTS")
                .replace("CREATE TRIGGER", "CREATE TRIGGER IF NOT EXISTS")).run();
        }
    }
}
async function seedCatalogue(whiteAvailable = true, snapshotId = CATALOGUE_SNAPSHOT_ID, retrievedAt = Date.now(), blackAvailable = true, includeTote = true) {
    const statements = [
        testPlatform().env.DB.prepare("DELETE FROM operational_controls"),
        testPlatform().env.DB.prepare("\n      INSERT INTO printify_catalogue_snapshots (\n        id, shop_id, base_product_id, base_product_slug, blueprint_id,\n        print_provider_id, retrieved_at, source_urls_json, variant_count\n      ) VALUES (?, 'shop-1', '" + "a51b7acf-77e9-4762-83c4-62d96dd8942c" + "',\n        'staple-tee', 440, 34, ?, '[]', 2)\n    ").bind(snapshotId, retrievedAt),
        testPlatform().env.DB.prepare(`
      INSERT INTO printify_catalogue_variants (
        snapshot_id, printify_variant_id, colour, size, available,
        decoration_method, print_width, print_height,
        shipping_first_item, shipping_additional_item, shipping_currency,
        handling_days_from, handling_days_to
      ) VALUES (?, 201, 'Black', 'XS', ?, 'DTG', 3600, 4200,
        639, 139, 'USD', 3, 6)
    `).bind(snapshotId, blackAvailable ? 1 : 0),
        testPlatform().env.DB.prepare(`
      INSERT INTO printify_catalogue_variants (
        snapshot_id, printify_variant_id, colour, size, available,
        decoration_method, print_width, print_height,
        shipping_first_item, shipping_additional_item, shipping_currency,
        handling_days_from, handling_days_to
      ) VALUES (?, 202, 'White', 'XS', ?, 'DTG', 3600, 4200,
        639, 139, 'USD', 3, 6)
    `).bind(snapshotId, whiteAvailable ? 1 : 0),
    ];
    if (includeTote) {
        const toteSnapshotId = "18ef39b7-54d2-48be-a687-4f789ab6266b";
        statements.push(testPlatform().env.DB.prepare("\n        INSERT INTO printify_catalogue_snapshots (\n          id, shop_id, base_product_id, base_product_slug, blueprint_id,\n          print_provider_id, retrieved_at, source_urls_json, variant_count\n        ) VALUES (?, 'shop-1', '" + "97b629d7-1d3b-4d2a-a586-537168141e97" + "',\n          'cotton-tote', 553, 34, ?, '[]', 2)\n      ").bind(toteSnapshotId, retrievedAt), testPlatform().env.DB.prepare(`
        INSERT INTO printify_catalogue_variants (
          snapshot_id, printify_variant_id, colour, size, available,
          decoration_method, print_width, print_height,
          shipping_first_item, shipping_additional_item, shipping_currency,
          handling_days_from, handling_days_to
        ) VALUES (?, 70603, 'Black', 'One size', 1, 'DTG', 2835, 3425,
          639, 139, 'USD', 3, 6)
      `).bind(toteSnapshotId), testPlatform().env.DB.prepare(`
        INSERT INTO printify_catalogue_variants (
          snapshot_id, printify_variant_id, colour, size, available,
          decoration_method, print_width, print_height,
          shipping_first_item, shipping_additional_item, shipping_currency,
          handling_days_from, handling_days_to
        ) VALUES (?, 70646, 'Cream', 'One size', 1, 'DTG', 2835, 3425,
          639, 139, 'USD', 3, 6)
      `).bind(toteSnapshotId));
    }
    await testPlatform().env.DB.batch(statements);
}
beforeAll(async () => {
    platform = await getPlatformProxy<Env>({ environment: "", persist: false });
    await applyMigrations();
});
beforeEach(async () => {
    await testPlatform().env.DB.batch([
        testPlatform().env.DB.prepare("DELETE FROM shopify_variant_mappings"),
        testPlatform().env.DB.prepare("DELETE FROM shopify_variant_mapping_snapshots"),
        testPlatform().env.DB.prepare("DELETE FROM printify_catalogue_variants"),
        testPlatform().env.DB.prepare("DELETE FROM printify_catalogue_snapshots"),
    ]);
    await seedCatalogue();
});
afterAll(async () => platform?.dispose());
describe("Shopify-to-Printify variant mapping", () => {
    it("requires operations authentication to refresh the mapping", async () => {
        const response = await handledRequest(VARIANT_MAPPING_REFRESH_PATH, {
            method: "POST",
        });
        expect(response.status).toBe(401);
    });
    it("persists a complete immutable mapping snapshot", async () => {
        const response = await handledRequest(VARIANT_MAPPING_REFRESH_PATH, {
            headers: { "x-bent-shirt-operations-secret": OPERATIONS_SECRET },
            method: "POST",
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
            products: [
                { baseProductSlug: "staple-tee", variantCount: 2 },
                { baseProductSlug: "cotton-tote", variantCount: 2 },
            ],
        });
        const stored = await testPlatform().env.DB.prepare("SELECT COUNT(*) AS count FROM shopify_variant_mappings").first<{
            count: number;
        }>();
        expect(stored?.count).toBe(4);
        await expect(testPlatform().env.DB.prepare(`
      UPDATE shopify_variant_mappings SET size = 'S'
    `).run()).rejects.toThrow("variant mappings are immutable");
    });
    it("returns the exact mapped variant to an authenticated service", async () => {
        await refreshMapping();
        const response = await handledRequest(`${VARIANT_MAPPING_PATH}?merchandiseId=${encodeURIComponent(BLACK_VARIANT_ID)}&baseHandle=bent-shirt`, { headers: { "x-forever-tee-service-secret": SERVICE_SECRET } });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
            available: true,
            color: "Black",
            printifyVariantId: 201,
            shopifyVariantId: BLACK_VARIANT_ID,
            size: "XS",
            sku: "BENT-BLACK-XS",
        });
    });
    it("never resolves a variant through another Base Product mapping", async () => {
        await refreshMapping();
        const tote = await handledRequest(`${VARIANT_MAPPING_PATH}?merchandiseId=${encodeURIComponent(TOTE_CREAM_VARIANT_ID)}&baseHandle=cotton-tote`, { headers: { "x-forever-tee-service-secret": SERVICE_SECRET } });
        expect(await tote.json()).toMatchObject({
            baseProductSlug: "cotton-tote",
            color: "Cream",
            printifyVariantId: 70646,
        });
        const crossed = await handledRequest(`${VARIANT_MAPPING_PATH}?merchandiseId=${encodeURIComponent(TOTE_CREAM_VARIANT_ID)}&baseHandle=bent-shirt`, { headers: { "x-forever-tee-service-secret": SERVICE_SECRET } });
        expect(crossed.status).toBe(404);
    });
    it("moves availability only when a refreshed mapping links the newer catalogue", async () => {
        await refreshMapping();
        await seedCatalogue(true, "4e164faf-404a-408a-96fe-d54432f72eca", Date.now() + 1, false, false);
        const beforeMappingRefresh = await handledRequest(`${VARIANT_MAPPING_PATH}?merchandiseId=${encodeURIComponent(BLACK_VARIANT_ID)}&baseHandle=bent-shirt`, { headers: { "x-forever-tee-service-secret": SERVICE_SECRET } });
        expect(await beforeMappingRefresh.json()).toMatchObject({ available: true });
        await refreshMapping();
        const afterMappingRefresh = await handledRequest(`${VARIANT_MAPPING_PATH}?merchandiseId=${encodeURIComponent(BLACK_VARIANT_ID)}&baseHandle=bent-shirt`, { headers: { "x-forever-tee-service-secret": SERVICE_SECRET } });
        expect(await afterMappingRefresh.json()).toMatchObject({ available: false });
    });
    it("rejects a partial Shopify catalogue", async () => {
        const partialFetcher: typeof fetch = (input, init) => Promise.resolve(requestUrl(input).endsWith("/admin/oauth/access_token")
            ? Response.json({
                access_token: "admin-test-token",
                expires_in: 86399,
                scope: "read_products",
            })
            : Response.json({ data: { product: requestBody(init).includes("cotton-tote")
                        ? shopifyProduct("cotton-tote", [
                            shopifyVariant(TOTE_BLACK_VARIANT_ID, "Black", true, "BLACK", "One size"),
                            shopifyVariant(TOTE_CREAM_VARIANT_ID, "Cream", true, "CREAM", "One size"),
                        ])
                        : shopifyProduct("bent-shirt", [
                            shopifyVariant(BLACK_VARIANT_ID, "Black", true, "BLACK"),
                        ]) } }));
        const response = await handledRequest(VARIANT_MAPPING_REFRESH_PATH, {
            headers: { "x-bent-shirt-operations-secret": OPERATIONS_SECRET },
            method: "POST",
        }, partialFetcher);
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({
            error: { code: "INVALID_VARIANT_MAPPING" },
        });
        const controls = await testPlatform().env.DB.prepare(`
      SELECT control_key, enabled FROM operational_controls
      WHERE control_key LIKE 'variant_mapping_pause:%'
      ORDER BY control_key
    `).all<{
            control_key: string;
            enabled: number;
        }>();
        expect(controls.results).toEqual([
            { control_key: "variant_mapping_pause:cotton-tote", enabled: 0 },
            { control_key: "variant_mapping_pause:staple-tee", enabled: 1 },
        ]);
    });
    it("automatically pauses sales when a scheduled mapping refresh fails", async () => {
        const failingFetcher: typeof fetch = () => Promise.reject(new Error("Shopify is offline"));
        await runScheduledVariantMappingRefresh(workerEnv(), failingFetcher);
        const control = await testPlatform().env.DB.prepare(`
      SELECT enabled, reason FROM operational_controls
      WHERE control_key = 'variant_mapping_pause:staple-tee'
    `).first<{
            enabled: number;
            reason: string;
        }>();
        expect(control).toEqual({
            enabled: 1,
            reason: "Shopify staple-tee variant mapping refresh failed.",
        });
    });
});
async function refreshMapping() {
    const response = await handledRequest(VARIANT_MAPPING_REFRESH_PATH, {
        headers: { "x-bent-shirt-operations-secret": OPERATIONS_SECRET },
        method: "POST",
    });
    expect(response.status).toBe(200);
}
function requestUrl(input: RequestInfo | URL) {
    if (typeof input === "string" || input instanceof URL) {
        return input.toString();
    }
    return input.url;
}
function requestBody(init: RequestInit | undefined) {
    return typeof init?.body === "string" ? init.body : "";
}
