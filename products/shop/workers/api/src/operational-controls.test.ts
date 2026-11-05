import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getPlatformProxy, type PlatformProxy } from "wrangler";
import { handleOperationalControlRequest, SALES_INTAKE_PATH, SALES_PAUSE_CONTROL_PATH, SALES_PAUSE_MESSAGE, setAutomaticCataloguePause, } from "./operational-controls";
const SERVICE_SECRET = "service-test-secret";
const OPERATIONS_SECRET = "operations-test-secret";
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
    };
}
async function handledRequest(path: string, init: RequestInit = {}) {
    const response = await handleOperationalControlRequest(new Request(`https://api.example.com${path}`, init), workerEnv());
    if (!response)
        throw new Error("Operational control route was not handled.");
    return response;
}
function serviceHeaders() {
    return { "x-forever-tee-service-secret": SERVICE_SECRET };
}
function operationsRequest(paused: boolean, reason: string) {
    return handledRequest(SALES_PAUSE_CONTROL_PATH, {
        body: JSON.stringify({ paused, reason }),
        headers: {
            "content-type": "application/json",
            "x-bent-shirt-operations-secret": OPERATIONS_SECRET,
        },
        method: "PUT",
    });
}
beforeAll(async () => {
    platform = await getPlatformProxy<Env>({ environment: "", persist: false });
    for (const name of [
        "0008_operational_controls.sql",
        "0009_printify_catalogue_snapshots.sql",
        "0010_shopify_variant_mappings.sql",
        "0012_product_aware_catalogues.sql",
    ]) {
        const sql = await readFile(new URL(`../drizzle/${name}`, import.meta.url), "utf8");
        for (const statement of sql.split("--> statement-breakpoint")) {
            await testPlatform().env.DB.prepare(statement
                .replace("CREATE TABLE", "CREATE TABLE IF NOT EXISTS")
                .replace("CREATE INDEX", "CREATE INDEX IF NOT EXISTS")
                .replace("CREATE TRIGGER", "CREATE TRIGGER IF NOT EXISTS")).run();
        }
    }
});
beforeEach(async () => {
    await testPlatform().env.DB.batch([
        testPlatform().env.DB.prepare("DELETE FROM operational_controls"),
        testPlatform().env.DB.prepare("DELETE FROM shopify_variant_mappings"),
        testPlatform().env.DB.prepare("DELETE FROM shopify_variant_mapping_snapshots"),
        testPlatform().env.DB.prepare("DELETE FROM printify_catalogue_variants"),
        testPlatform().env.DB.prepare("DELETE FROM printify_catalogue_snapshots"),
    ]);
    await seedLaunchSnapshots(Date.now(), Date.now());
});
afterAll(async () => {
    await platform?.dispose();
});
describe("operational controls", () => {
    it("requires service authentication for sales intake reads", async () => {
        const response = await handledRequest(SALES_INTAKE_PATH);
        expect(response.status).toBe(401);
    });
    it("defaults to open sales intake", async () => {
        const response = await handledRequest(SALES_INTAKE_PATH, {
            headers: serviceHeaders(),
        });
        expect(response.status).toBe(200);
        const payload: unknown = await response.json();
        expect(payload).toMatchObject({
            message: null,
            paused: false,
            reason: null,
        });
        expect(isRecord(payload) && typeof payload["updatedAt"] === "string")
            .toBe(true);
        expect(response.headers.get("cache-control")).toBe("no-store");
    });
    it("fails closed when the catalogue snapshot is stale", async () => {
        await testPlatform().env.DB.prepare("DELETE FROM shopify_variant_mapping_snapshots").run();
        await testPlatform().env.DB.prepare("DELETE FROM printify_catalogue_snapshots").run();
        await seedLaunchSnapshots(Date.now() - 31 * 60 * 1000, Date.now());
        const response = await handledRequest(SALES_INTAKE_PATH, {
            headers: serviceHeaders(),
        });
        expect(await response.json()).toMatchObject({
            message: SALES_PAUSE_MESSAGE,
            paused: true,
            reason: "Printify catalogue data is stale.",
        });
    });
    it("fails closed when the Shopify variant mapping is stale", async () => {
        await testPlatform().env.DB.prepare("DELETE FROM shopify_variant_mapping_snapshots").run();
        const catalogues = await testPlatform().env.DB.prepare(`
      SELECT id, base_product_slug FROM printify_catalogue_snapshots
    `).all<{
            id: string;
            base_product_slug: "staple-tee" | "cotton-tote";
        }>();
        for (const catalogue of catalogues.results) {
            await seedMappingSnapshot(Date.now() - 25 * 60 * 60 * 1000, catalogue.id, catalogue.base_product_slug);
        }
        const response = await handledRequest(SALES_INTAKE_PATH, {
            headers: serviceHeaders(),
        });
        expect(await response.json()).toMatchObject({
            message: SALES_PAUSE_MESSAGE,
            paused: true,
            reason: "Shopify variant mapping is stale.",
        });
    });
    it("requires a separate operations secret for changes", async () => {
        const response = await handledRequest(SALES_PAUSE_CONTROL_PATH, {
            body: JSON.stringify({ paused: true, reason: "incident" }),
            headers: { "content-type": "application/json" },
            method: "PUT",
        });
        expect(response.status).toBe(401);
    });
    it("pauses and resumes sales with an operator reason", async () => {
        const paused = await operationsRequest(true, " Printify incident ");
        expect(paused.status).toBe(200);
        expect(await paused.json()).toMatchObject({
            message: SALES_PAUSE_MESSAGE,
            paused: true,
            reason: "Printify incident",
        });
        const readPaused = await handledRequest(SALES_INTAKE_PATH, {
            headers: serviceHeaders(),
        });
        expect(await readPaused.json()).toMatchObject({
            message: SALES_PAUSE_MESSAGE,
            paused: true,
            reason: "Printify incident",
        });
        const resumed = await operationsRequest(false, "Incident resolved");
        expect(await resumed.json()).toMatchObject({
            message: null,
            paused: false,
            reason: "Incident resolved",
        });
    });
    it("does not clear a manual pause after catalogue recovery", async () => {
        await operationsRequest(true, "Manual launch hold");
        await setAutomaticCataloguePause(testPlatform().env.DB, false, "Printify catalogue refresh succeeded.");
        const response = await handledRequest(SALES_INTAKE_PATH, {
            headers: serviceHeaders(),
        });
        expect(await response.json()).toMatchObject({
            paused: true,
            reason: "Manual launch hold",
        });
    });
    it("rejects an empty reason", async () => {
        const response = await operationsRequest(true, " ");
        expect(response.status).toBe(400);
    });
});
async function seedLaunchSnapshots(catalogueRetrievedAt: number, mappingRetrievedAt: number) {
    const slugs: readonly ("staple-tee" | "cotton-tote")[] = [
        "staple-tee",
        "cotton-tote",
    ];
    for (const slug of slugs) {
        const catalogueSnapshotId = crypto.randomUUID();
        await seedCatalogueSnapshot(catalogueRetrievedAt, catalogueSnapshotId, slug);
        await seedMappingSnapshot(mappingRetrievedAt, catalogueSnapshotId, slug);
    }
}
function seedCatalogueSnapshot(retrievedAt: number, snapshotId: string, slug: "staple-tee" | "cotton-tote") {
    const tote = slug === "cotton-tote";
    return testPlatform().env.DB.prepare(`
    INSERT INTO printify_catalogue_snapshots (
      id, shop_id, base_product_id, base_product_slug, blueprint_id,
      print_provider_id, retrieved_at, source_urls_json, variant_count
    ) VALUES (?, '123', ?, ?, ?, 34, ?, '[]', 1)
  `).bind(snapshotId, tote
        ? "97b629d7-1d3b-4d2a-a586-537168141e97" : "a51b7acf-77e9-4762-83c4-62d96dd8942c", slug, tote ? 553 : 440, retrievedAt).run();
}
function seedMappingSnapshot(retrievedAt: number, catalogueSnapshotId: string, slug: "staple-tee" | "cotton-tote") {
    const tote = slug === "cotton-tote";
    return testPlatform().env.DB.prepare(`
    INSERT INTO shopify_variant_mapping_snapshots (
      id, catalogue_snapshot_id, base_product_id, base_product_slug,
      shopify_product_id, shopify_product_handle, shopify_product_title,
      retrieved_at, source_url, variant_count
    ) VALUES (?, ?, ?, ?, 'gid://shopify/Product/1', ?, ?, ?,
      'https://example.myshopify.com/admin/api/2026-07/graphql.json', 1)
  `).bind(crypto.randomUUID(), catalogueSnapshotId, tote
        ? "97b629d7-1d3b-4d2a-a586-537168141e97" : "a51b7acf-77e9-4762-83c4-62d96dd8942c", slug, tote ? "cotton-tote" : "bent-shirt", tote ? "Cotton Tote" : "bent.shop", retrievedAt).run();
}
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
