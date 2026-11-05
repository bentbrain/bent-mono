import { protectedConfig } from "./protected-config";
import { COTTON_TOTE_BASE_PRODUCT_ID } from "@forever-tee/contracts";
import { readFile, readdir } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from "jose";
import { getPlatformProxy, type PlatformProxy } from "wrangler";
import { operationsAudience, verifyOperationsIdentity } from "./operations-identity";
import { handleFeaturedProductsRequest, FEATURED_PRODUCTS_OPERATIONS_PATH } from "./featured-products";
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
const environment = () => ({ DB: db(), BENT_SHIRT_OPERATIONS_SECRET: secret, FOREVER_TEE_API_SHARED_SECRET: secret, OPERATIONS_ENVIRONMENT: "development" });
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
    return new SignJWT({ repository_id: protectedConfig("githubRepositoryId"), repository_owner_id: ownerId, ref: "refs/heads/main", workflow_ref: "bentbrain/bent-mono/.github/workflows/featured-products.yml@refs/heads/main", event_name: "workflow_dispatch", runner_environment: "github-hosted", environment: "Preview", actor: "bentbrain", actor_id: ownerId, run_id: "12345", ...claims })
        .setProtectedHeader({ alg: "RS256", kid: "test" }).setIssuer("https://token.actions.githubusercontent.com")
        .setAudience(await operationsAudience(request, "development", body)).setIssuedAt().setNotBefore("0s").setExpirationTime("5m").setJti(crypto.randomUUID()).sign(signingKey());
}
async function call(input: unknown, claims: Record<string, string> = {}) {
    const body = JSON.stringify(input);
    const request = new Request(`https://api.example.com${FEATURED_PRODUCTS_OPERATIONS_PATH}`, { method: "POST", body, headers: { "content-type": "application/json", "x-bent-shirt-operations-secret": secret } });
    request.headers.set("authorization", `Bearer ${await tokenFor(request, body, claims)}`);
    const response = await handleFeaturedProductsRequest(request, environment(), (request, env, body) => verifyOperationsIdentity(request, env, body, keySet()));
    if (!response)
        throw new Error("Missing lifecycle response");
    return response;
}
async function revision() { return (await db().prepare("SELECT revision FROM featured_product_state WHERE id = 1").first<{
    revision: number;
}>())?.revision ?? 0; }
async function command(productId: string) { return { commandId: crypto.randomUUID(), expectedRevision: await revision(), products: [{ slot: 1, productId }] }; }
async function publicRead(secretValue = secret) {
    const response = await handleFeaturedProductsRequest(new Request("https://api.example.com/v2/internal/featured-products", { headers: { "x-forever-tee-service-secret": secretValue } }), environment());
    if (!response)
        throw new Error("Missing featured response");
    return response;
}
describe("featured configuration", () => {
    it("requires service authentication and reports an empty configuration", async () => {
        expect((await publicRead("wrong")).status).toBe(401);
        expect((await publicRead()).status).toBe(503);
    });
    it("replaces slots atomically, records history and ignores old replays", async () => {
        const first = await seed(), second = await seed();
        const original = await command(first.productId);
        expect((await call(original)).status).toBe(200);
        const next = { ...await command(second.productId), products: [{ slot: 6, productId: second.productId }, { slot: 2, productId: first.productId }] };
        expect((await call(next)).status).toBe(200);
        expect((await call(original)).status).toBe(200);
        const response = await publicRead();
        expect(response.headers.get("cache-control")).toBe("private, no-store");
        expect(await response.json()).toEqual({ products: [next.products[1], next.products[0]] });
        expect((await call({ ...original, products: [{ slot: 1, productId: second.productId }] })).status).toBe(409);
        const history = await db().prepare("SELECT previous_products_json, products_json FROM featured_product_changes WHERE command_id = ?").bind(next.commandId).first<{
            previous_products_json: string;
            products_json: string;
        }>();
        expect(JSON.parse(history?.previous_products_json ?? "null")).toEqual(original.products);
        expect(JSON.parse(history?.products_json ?? "null")).toEqual([next.products[1], next.products[0]]);
    });
    it("allows only one concurrent update from the same revision", async () => {
        const first = await seed(), second = await seed();
        const a = await command(first.productId), b = await command(second.productId);
        const results = await Promise.all([call(a), call(b)]);
        expect(results.map(result => result.status).sort()).toEqual([200, 409]);
        expect(await revision()).toBe(a.expectedRevision + 1);
    });
    it("does not accept conflicting bodies for the same concurrent command", async () => {
        const first = await seed(), second = await seed();
        const a = await command(first.productId), b = { ...a, products: [{ slot: 1, productId: second.productId }] };
        const results = await Promise.all([call(a), call(b)]);
        expect(results.map(result => result.status).sort()).toEqual([200, 409]);
    });
    it("rejects inactive or incomplete families and duplicate designs without altering slots", async () => {
        const fixture = await seed(), before = await (await publicRead()).json();
        await db().prepare("UPDATE products SET status = 'suspended' WHERE design_id = ? AND base_product_id = ?").bind(fixture.designId, COTTON_TOTE_BASE_PRODUCT_ID).run();
        expect((await call(await command(fixture.productId))).status).toBe(409);
        expect((await call(await command(crypto.randomUUID()))).status).toBe(409);
        const complete = await seed();
        const tote = await db().prepare("SELECT id FROM products WHERE design_id = ? AND base_product_id = ?").bind(complete.designId, COTTON_TOTE_BASE_PRODUCT_ID).first<{
            id: string;
        }>();
        expect((await call({ ...await command(complete.productId), products: [{ slot: 1, productId: complete.productId }, { slot: 2, productId: tote?.id }] })).status).toBe(409);
        expect(await (await publicRead()).json()).toEqual(before);
    });
    it("filters a featured design after suspension and leaves purchasing controls unchanged", async () => {
        const fixture = await seed();
        await db().prepare("INSERT OR REPLACE INTO operational_controls(control_key, enabled, reason, updated_at) VALUES ('sales_pause', 1, 'Owner lock', ?)").bind(Date.now()).run();
        expect((await call(await command(fixture.productId))).status).toBe(200);
        await db().prepare("UPDATE products SET status = 'suspended' WHERE id = ?").bind(fixture.productId).run();
        expect((await publicRead()).status).toBe(503);
        expect((await db().prepare("SELECT enabled, reason FROM operational_controls WHERE control_key = 'sales_pause'").first())).toMatchObject({ enabled: 1, reason: "Owner lock" });
    });
    it("rejects invalid slots, empty lists and extra request fields", async () => {
        const input = await command(crypto.randomUUID());
        for (const products of [[], [{ slot: 0, productId: input.products[0]?.productId }], [{ slot: 7, productId: input.products[0]?.productId }], [...input.products, ...input.products]]) {
            expect((await call({ ...input, products })).status).toBe(400);
        }
        expect((await call({ ...input, extra: "not allowed" })).status).toBe(400);
    });
    it("requires owner and the exact featured workflow identity", async () => {
        const input = await command(crypto.randomUUID());
        expect((await call(input, { actor: "operator", actor_id: "777" })).status).toBe(403);
        for (const claims of [{ workflow_ref: "bentbrain/bent-mono/.github/workflows/product-lifecycle.yml@refs/heads/main" }, { ref: "refs/heads/other" }, { environment: "Production" }, { repository_id: "42" }, { event_name: "pull_request" }]) {
            expect((await call(input, claims)).status).toBe(401);
        }
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
    await db().prepare("INSERT INTO products(id, base_product_id, design_id, design_revision_id, placement_x, placement_y, placement_width, placement_depth, projection_version, shopify_handle, status, created_at) VALUES (?, ?, ?, ?, 0.3, 0.3, 0.2, 5, 'safe-margin-v1', 'cotton-tote', 'active', ?)").bind(crypto.randomUUID(), COTTON_TOTE_BASE_PRODUCT_ID, designId, revisionId, now).run();
    return { designId, revisionId, productId, baseProductId };
}
