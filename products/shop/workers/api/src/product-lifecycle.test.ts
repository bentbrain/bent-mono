import { protectedConfig } from "./protected-config";
import { readFile, readdir } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from "jose";
import { getPlatformProxy, type PlatformProxy } from "wrangler";
import { operationsAudience, verifyOperationsIdentity } from "./operations-identity";
import { handleProductLifecycleRequest, PRODUCT_LIFECYCLE_PATH } from "./product-lifecycle";
import { PAID_ORDER_PRODUCT_RECOVERY_PATH, PAID_ORDER_PROVIDER_RECOVERY_PATH, PAID_ORDER_RECOVERY_PATH } from "./paid-order-recovery";
let platform: PlatformProxy<Env> | undefined;
let signing: Awaited<ReturnType<typeof generateKeyPair>> | undefined;
let keys: JWTVerifyGetKey | undefined;
const secret = "test-operations-secret";
const ownerId = protectedConfig("githubOwnerId");
function db() { if (!platform)
    throw new Error("No test database"); return platform.env.DB; }
function signingKey() { if (!signing)
    throw new Error("No signing key"); return signing.privateKey; }
function keySet() { if (!keys)
    throw new Error("No public keys"); return keys; }
const environment = () => ({ DB: db(), BENT_SHIRT_OPERATIONS_SECRET: secret, OPERATIONS_ENVIRONMENT: "development" });
beforeAll(async () => {
    platform = await getPlatformProxy<Env>({ environment: "", persist: false, remoteBindings: false });
    const directory = new URL("../drizzle/", import.meta.url);
    for (const name of (await readdir(directory)).filter(name => name.endsWith(".sql")).sort()) {
        const sql = await readFile(new URL(name, directory), "utf8");
        for (const statement of sql.split("--> statement-breakpoint").map(value => value.trim()).filter(Boolean))
            await db().prepare(statement).run();
    }
    signing = await generateKeyPair("RS256");
    keys = createLocalJWKSet({ keys: [{ ...await exportJWK(signing.publicKey), kid: "test" }] });
});
afterAll(async () => platform?.dispose());
async function tokenFor(request: Request, body: string, claims: Record<string, string> = {}) {
    return new SignJWT({ repository_id: protectedConfig("githubRepositoryId"), repository_owner_id: ownerId, ref: "refs/heads/main", workflow_ref: "bentbrain/bent-mono/.github/workflows/product-lifecycle.yml@refs/heads/main", event_name: "workflow_dispatch", runner_environment: "github-hosted", environment: "Preview", actor: "bentbrain", actor_id: ownerId, run_id: "12345", ...claims })
        .setProtectedHeader({ alg: "RS256", kid: "test" }).setIssuer("https://token.actions.githubusercontent.com")
        .setAudience(await operationsAudience(request, "development", body)).setIssuedAt().setNotBefore("0s").setExpirationTime("5m").setJti(crypto.randomUUID()).sign(signingKey());
}
async function call(input: unknown, claims: Record<string, string> = {}) {
    const body = JSON.stringify(input);
    const request = new Request(`https://api.example.com${PRODUCT_LIFECYCLE_PATH}`, { method: "POST", body, headers: { "content-type": "application/json", "x-bent-shirt-operations-secret": secret } });
    request.headers.set("authorization", `Bearer ${await tokenFor(request, body, claims)}`);
    const response = await handleProductLifecycleRequest(request, environment(), (request, env, body) => verifyOperationsIdentity(request, env, body, keySet()));
    if (!response)
        throw new Error("Missing lifecycle response");
    return response;
}
function command(productId: string, from = "active", to = "suspended") {
    return { commandId: crypto.randomUUID(), productId, from, to, reason: "Complaint review case 123", confirmation: `${to === "retired" ? "RETIRE" : "UNPUBLISH"} ${productId}` };
}
async function productState(id: string) { return (await db().prepare("SELECT status FROM products WHERE id = ?").bind(id).first<{
    status: string;
}>())?.status; }
describe("configured product lifecycle", () => {
    it("records staff suspension and recovery, and cannot replay an old command to suspend again", async () => {
        const fixture = await seed();
        const suspension = command(fixture.productId);
        expect((await call(suspension, { actor: "operator", actor_id: "777" })).status).toBe(200);
        expect(await productState(fixture.productId)).toBe("suspended");
        expect((await call(command(fixture.productId, "suspended", "active"))).status).toBe(200);
        expect((await call(suspension, { actor: "operator", actor_id: "777" })).status).toBe(200);
        expect(await productState(fixture.productId)).toBe("active");
        expect((await call({ ...suspension, reason: "Different request" }, { actor: "operator", actor_id: "777" })).status).toBe(409);
        expect((await db().prepare("SELECT count(*) AS count FROM product_lifecycle_transitions WHERE product_id = ?").bind(fixture.productId).first<{
            count: number;
        }>())?.count).toBe(2);
    });
    it("requires the verified owner and exact confirmation for irreversible unpublish", async () => {
        const fixture = await seed();
        const input = command(fixture.productId, "active", "unpublished");
        expect((await call(input, { actor: "operator", actor_id: "777" })).status).toBe(403);
        expect((await call({ ...input, confirmation: "yes" })).status).toBe(400);
        expect((await call(input)).status).toBe(200);
        expect((await call(command(fixture.productId, "unpublished", "active"))).status).toBe(400);
        await expect(db().prepare("UPDATE products SET status = 'active' WHERE id = ?").bind(fixture.productId).run()).rejects.toThrow(/cannot be republished/);
        expect((await call(command(fixture.productId, "unpublished", "retired"))).status).toBe(200);
        expect(await productState(fixture.productId)).toBe("retired");
    });
    it("allows only one concurrent transition from the expected state", async () => {
        const fixture = await seed();
        const results = await Promise.all([call(command(fixture.productId)), call(command(fixture.productId, "active", "unpublished"))]);
        expect(results.map(result => result.status).sort()).toEqual([200, 409]);
    });
    it("does not allow a new UUID to recreate an unavailable configured product", async () => {
        const fixture = await seed();
        expect((await call(command(fixture.productId))).status).toBe(200);
        await expect(db().prepare("INSERT INTO products(id, base_product_id, design_id, design_revision_id, shopify_handle, status, created_at) SELECT ?, base_product_id, design_id, design_revision_id, shopify_handle, 'active', created_at FROM products WHERE id = ?").bind(crypto.randomUUID(), fixture.productId).run()).rejects.toThrow(/unavailable after lifecycle/);
    });
    it("defers suspension while an order lease is live, then preserves its paid evidence in exception review", async () => {
        const fixture = await seed();
        const orderId = await seedPaidOrder(fixture);
        await db().prepare("UPDATE paid_orders SET production_lease_id = 'hold-check', production_lease_expires_at = ? WHERE id = ?").bind(Date.now() + 60000, orderId).run();
        const input = command(fixture.productId);
        expect((await call(input)).status).toBe(409);
        await db().prepare("UPDATE paid_orders SET production_lease_id = NULL, production_lease_expires_at = NULL WHERE id = ?").bind(orderId).run();
        expect((await call(input)).status).toBe(200);
        expect((await db().prepare("SELECT status FROM paid_orders WHERE id = ?").bind(orderId).first<{
            status: string;
        }>())?.status).toBe("exception_review");
        expect((await db().prepare("SELECT code FROM fulfilment_exceptions WHERE paid_order_id = ? AND status = 'open'").bind(orderId).first<{
            code: string;
        }>())?.code).toBe("PRODUCT_LIFECYCLE_REVIEW");
        expect((await db().prepare("SELECT count(*) AS count FROM paid_order_lines WHERE paid_order_id = ?").bind(orderId).first<{
            count: number;
        }>())?.count).toBe(1);
        expect((await call(command(fixture.productId, "suspended", "active"))).status).toBe(200);
        expect((await db().prepare("SELECT status FROM fulfilment_exceptions WHERE paid_order_id = ?").bind(orderId).first<{
            status: string;
        }>())?.status).toBe("resolved");
    });
    it.each(["creating", "submitting"])("defers a transition during an active Printify %s lease", async (status) => {
        const fixture = await seed();
        const orderId = await seedPaidOrder(fixture);
        const hash = "a".repeat(64), now = Date.now();
        await db().prepare("UPDATE paid_orders SET status = 'fulfilment_locked', fulfilment_locked_at = ?, validation_checked_at = ?, shopify_order_updated_at = ?, delivery_address_sha256 = ?, delivery_address_json = '{}' WHERE id = ?").bind(now, now, new Date(now).toISOString(), hash, orderId).run();
        await db().prepare(`INSERT INTO printify_fulfilment_orders(id, paid_order_id, external_id, label, provider_order_id, request_sha256, readback_sha256, status, lease_id, lease_expires_at, created_at, updated_at, verified_at)
      VALUES (?, ?, ?, '#test', ?, ?, ?, ?, 'provider-request', ?, ?, ?, ?)`)
            .bind(orderId, orderId, orderId, orderId, hash, hash, status, now + 60000, now, now, now).run();
        const input = command(fixture.productId);
        expect((await call(input)).status).toBe(409);
        await db().prepare("UPDATE printify_fulfilment_orders SET status = 'on_hold', lease_id = NULL, lease_expires_at = NULL WHERE id = ?").bind(orderId).run();
        expect((await call(input)).status).toBe(200);
        expect((await db().prepare("SELECT status FROM paid_orders WHERE id = ?").bind(orderId).first<{
            status: string;
        }>())?.status).toBe("fulfilment_locked");
        expect((await db().prepare("SELECT status FROM fulfilment_exceptions WHERE paid_order_id = ?").bind(orderId).first<{
            status: string;
        }>())?.status).toBe("open");
        expect((await call(command(fixture.productId, "suspended", "active"))).status).toBe(200);
        expect((await db().prepare("SELECT status FROM fulfilment_exceptions WHERE paid_order_id = ?").bind(orderId).first<{
            status: string;
        }>())?.status).toBe("resolved");
    });
    it("keeps shipment reconciliation available for an order already sent to production", async () => {
        const fixture = await seed(), orderId = await seedPaidOrder(fixture), now = Date.now(), hash = "a".repeat(64);
        await db().prepare("UPDATE paid_orders SET status = 'fulfilment_locked', fulfilment_locked_at = ?, validation_checked_at = ?, shopify_order_updated_at = ?, delivery_address_sha256 = ?, delivery_address_json = '{}' WHERE id = ?").bind(now, now, new Date(now).toISOString(), hash, orderId).run();
        await db().prepare(`INSERT INTO printify_fulfilment_orders(id, paid_order_id, external_id, label, provider_order_id, request_sha256, readback_sha256, status, created_at, updated_at, verified_at, submitted_at)
      VALUES (?, ?, ?, '#test', ?, ?, ?, 'in_production', ?, ?, ?, ?)`)
            .bind(orderId, orderId, orderId, orderId, hash, hash, now, now, now, now).run();
        expect((await call(command(fixture.productId))).status).toBe(200);
        expect(await productState(fixture.productId)).toBe("suspended");
        expect((await db().prepare("SELECT count(*) AS count FROM fulfilment_exceptions WHERE paid_order_id = ? AND status = 'open'").bind(orderId).first<{
            count: number;
        }>())?.count).toBe(0);
    });
    it("rejects unexpected fields rather than retaining extra request data", async () => {
        expect((await call({ ...command(crypto.randomUUID()), customerData: "not an audit field" })).status).toBe(400);
    });
    it.each([
        { actor_id: "777", actor: "bentbrain", workflow_ref: "other/workflow" },
        { ref: "refs/heads/other" }, { environment: "Production" },
        { repository_id: "42" }, { repository_owner_id: "42" }, { event_name: "pull_request" },
    ])("rejects an identity from another trust context: %j", async (claims) => {
        expect((await call(command(crypto.randomUUID()), claims)).status).toBe(401);
    });
    it("binds the workflow signature to the exact request body", async () => {
        const original = JSON.stringify(command(crypto.randomUUID()));
        const request = new Request(`https://api.example.com${PRODUCT_LIFECYCLE_PATH}`, { method: "POST" });
        request.headers.set("authorization", `Bearer ${await tokenFor(request, original)}`);
        expect(await verifyOperationsIdentity(request, environment(), original + " ", keySet())).toBeUndefined();
    });
    it.each([[PAID_ORDER_RECOVERY_PATH, "paid-order-validation-recovery.yml"], [PAID_ORDER_PRODUCT_RECOVERY_PATH, "paid-order-product-recovery.yml"], [PAID_ORDER_PROVIDER_RECOVERY_PATH, "paid-order-provider-recovery.yml"]])("requires the exact %s workflow and first run attempt", async (path, workflow) => {
        const request = new Request(`https://api.example.com${path}`, { method: "POST" });
        const body = JSON.stringify({ operation: "plan", orderId: crypto.randomUUID(), expectedSource: "a".repeat(40) });
        const claims = { workflow_ref: `bentbrain/bent-mono/.github/workflows/${workflow}@refs/heads/main`, run_attempt: "1" };
        request.headers.set("authorization", `Bearer ${await tokenFor(request, body, claims)}`);
        expect(await verifyOperationsIdentity(request, environment(), body, keySet())).toMatchObject({ owner: true });
        expect(await verifyOperationsIdentity(request, environment(), body + " ", keySet())).toBeUndefined();
        request.headers.set("authorization", `Bearer ${await tokenFor(request, body, { ...claims, run_attempt: "2" })}`);
        expect(await verifyOperationsIdentity(request, environment(), body, keySet())).toBeUndefined();
        request.headers.set("authorization", `Bearer ${await tokenFor(request, body)}`);
        expect(await verifyOperationsIdentity(request, environment(), body, keySet())).toBeUndefined();
    });
});
async function seed() {
    const designId = crypto.randomUUID(), revisionId = crypto.randomUUID(), productId = crypto.randomUUID();
    const baseProductId = "a51b7acf-77e9-4762-83c4-62d96dd8942c";
    const now = Date.now(), hash = "a".repeat(64), key = `designs/${designId}/artwork.png`;
    await db().batch([
        db().prepare("INSERT INTO designs(id, owner_id, artwork_key, content_type, byte_size, sha256, crop_x, crop_y, crop_zoom, placement_x, placement_y, placement_width, depth, status, version, finalized_at, created_at, updated_at) VALUES (?, NULL, ?, 'image/png', 8, ?, 0.5, 0.5, 1, 0.3, 0.3, 0.2, 5, 'ready', 1, ?, ?, ?)").bind(designId, key, hash, now, now, now),
        db().prepare("INSERT INTO design_revisions(id, design_id, fingerprint, artwork_key, content_type, byte_size, artwork_width, artwork_height, sha256, crop_x, crop_y, crop_zoom, placement_x, placement_y, placement_width, depth, created_at) VALUES (?, ?, ?, ?, 'image/png', 8, 3000, 4000, ?, 0.5, 0.5, 1, 0, 0, 0.08, 1, ?)").bind(revisionId, designId, designId, key, hash, now),
        db().prepare("INSERT INTO products(id, base_product_id, design_id, design_revision_id, placement_x, placement_y, placement_width, placement_depth, projection_version, shopify_handle, status, created_at) VALUES (?, ?, ?, ?, 0.3, 0.3, 0.2, 5, 'safe-margin-v1', 'bent-shirt', 'active', ?)").bind(productId, baseProductId, designId, revisionId, now),
    ]);
    return { designId, revisionId, productId, baseProductId };
}
async function seedPaidOrder(fixture: Awaited<ReturnType<typeof seed>>) {
    const orderId = crypto.randomUUID(), assetId = crypto.randomUUID(), now = Date.now(), hash = "a".repeat(64);
    await db().batch([
        db().prepare("INSERT INTO printify_catalogue_snapshots(id, shop_id, blueprint_id, print_provider_id, retrieved_at, source_urls_json, variant_count, base_product_id, base_product_slug) VALUES (?, 'test', 1, 1, ?, '[]', 1, ?, 'staple-tee')").bind(orderId, now, fixture.baseProductId),
        db().prepare("INSERT INTO shopify_variant_mapping_snapshots(id, catalogue_snapshot_id, shopify_product_id, shopify_product_handle, shopify_product_title, retrieved_at, source_url, variant_count, base_product_id, base_product_slug) VALUES (?, ?, 'gid://shopify/Product/1', 'bent-shirt', 'bent.shop', ?, 'https://example.invalid', 1, ?, 'staple-tee')").bind(orderId, orderId, now, fixture.baseProductId),
        db().prepare("INSERT INTO shopify_variant_mappings(snapshot_id, shopify_variant_id, printify_variant_id, colour, size, shopify_available) VALUES (?, 'gid://shopify/ProductVariant/1', 1, 'White', 'M', 1)").bind(orderId),
        db().prepare("INSERT INTO paid_orders(id, shopify_order_id, shopify_order_name, source_payload_sha256, currency_code, total_minor_units, status, production_hold_expires_at, created_at, updated_at) VALUES (?, ?, '#test', ?, 'AUD', 6500, 'production_hold', ?, ?, ?)").bind(orderId, orderId, hash, now + 3600000, now, now),
        db().prepare("INSERT INTO print_assets(id, configured_product_id, design_revision_id, base_product_id, projection_version, geometry_key, storage_key, content_type, byte_size, width_px, height_px, sha256, status, created_at, updated_at, ready_at) VALUES (?, ?, ?, ?, 'safe-margin-v1', 'dtg:10x10', ?, 'image/png', 8, 10, 10, ?, 'ready', ?, ?, ?)").bind(assetId, fixture.productId, fixture.revisionId, fixture.baseProductId, `print-assets/${assetId}.png`, hash, now, now, now),
        db().prepare("INSERT INTO paid_order_lines(id, paid_order_id, shopify_line_item_id, line_position, quantity, base_product_id, configured_product_id, design_revision_id, projection_version, print_geometry_key, print_asset_id, print_asset_sha256, shopify_variant_id, printify_variant_id, variant_mapping_snapshot_id, colour, size, line_capability_sha256, created_at) VALUES (?, ?, ?, 1, 1, ?, ?, ?, 'safe-margin-v1', 'dtg:10x10', ?, ?, 'gid://shopify/ProductVariant/1', 1, ?, 'White', 'M', ?, ?)").bind(crypto.randomUUID(), orderId, orderId, fixture.baseProductId, fixture.productId, fixture.revisionId, assetId, hash, orderId, hash, now),
    ]);
    return orderId;
}
