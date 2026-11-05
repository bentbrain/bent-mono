import { protectedConfig } from "./protected-config";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getPlatformProxy, type PlatformProxy } from "wrangler";
import { handleImmutableProductRequest } from "./immutable-product-api";
const SECRET = "immutable-product-test-secret";
const BASE_PRODUCT_ID = "a51b7acf-77e9-4762-83c4-62d96dd8942c";
const PRODUCT_ID = "47cba7a2-498e-44cc-9769-b37641e6a63a";
const DESIGN_ID = protectedConfig("resource_83abf907850d");
const REVISION_ID = "59ccdb2a-21d7-4018-9f21-6d369cc69e54";
const OTHER_REVISION_ID = "96789e31-4b36-490b-9aec-a9b0ddd95a22";
const SHA256 = "0f4636c78f65d3639ece5a064b5ae753e3408614a14fb18ab4d7540d2c248543";
const ARTWORK_KEY = `designs/${DESIGN_ID}/artwork/${SHA256}`;
const ARTWORK = new Uint8Array([137, 80, 78, 71]);
let platform: PlatformProxy<Env> | undefined;
function sha256Base64(sha256: string) {
    const pairs = sha256.match(/.{2}/g) ?? [];
    let binary = "";
    for (const pair of pairs) {
        binary += String.fromCharCode(Number.parseInt(pair, 16));
    }
    return btoa(binary);
}
async function checksum(value: Uint8Array) {
    const input = new ArrayBuffer(value.byteLength);
    new Uint8Array(input).set(value);
    return crypto.subtle.digest("SHA-256", input);
}
function testPlatform() {
    if (!platform)
        throw new Error("Test bindings are unavailable.");
    return platform;
}
function workerEnv(storyVideoRenderer?: {
    readonly fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}) {
    const bindings = testPlatform().env;
    return {
        BENT_SHIRT_OPERATIONS_SECRET: "operations-test-secret",
        DB: bindings.DB,
        DESIGN_ARTWORK: bindings.DESIGN_ARTWORK,
        IMAGES: bindings.IMAGES,
        FOREVER_TEE_API_SHARED_SECRET: SECRET,
        OPENAI_API_KEY: "openai-test-key",
        ...(storyVideoRenderer
            ? { STORY_VIDEO_RENDERER: storyVideoRenderer }
            : {}),
    };
}
async function request(path: string, init: RequestInit = {}, storyVideoRenderer?: {
    readonly fetch: (input: RequestInfo | URL, requestInit?: RequestInit) => Promise<Response>;
}) {
    const headers = new Headers(init.headers);
    headers.set("x-forever-tee-service-secret", SECRET);
    const response = await handleImmutableProductRequest(new Request(`https://api.example.com${path}`, { ...init, headers }), workerEnv(storyVideoRenderer));
    if (!response)
        throw new Error("Immutable product route was not handled.");
    return response;
}
async function applyMigrations() {
    const files = [
        "0000_loving_king_bedlam.sql",
        "0001_faulty_taskmaster.sql",
        "0002_separate_product_design_ids.sql",
        "0003_idempotent-configured-products.sql",
        "0004_immutable_revision_ledger.sql",
        "0005_catch_up_revision_links.sql",
        "0006_anonymous_draft_capabilities.sql",
        "0008_operational_controls.sql",
        "0009_printify_catalogue_snapshots.sql",
        "0010_shopify_variant_mappings.sql",
        "0011_reusable_design_revisions.sql",
        "0012_product_aware_catalogues.sql",
        "0013_versioned_product_projections.sql",
        "0015_story_video_jobs.sql",
        "0016_story_video_renderer_v5.sql",
        "0018_story_video_execution_fence.sql",
        "0026_portrait_safety_screening.sql",
        "0027_image_based_default_product_color.sql",
        "0028_product_color_analysis_state.sql",
        "0029_design_asset_deletions.sql",
        "0019_paid_order_foundation.sql",
        "0020_protected_customer_data_hardening.sql",
        "0025_storage_maintenance.sql",
        "0031_order_management.sql",
        "0032_featured_products.sql",
        "0036_print_job_outbox.sql",
        "0039_featured_media_composition.sql",
        "0040_recursive_video_placement.sql",
        "0041_product_image_jobs.sql",
        "0042_design_artwork_sources.sql",
        "0043_artwork_preparation_jobs.sql",
        "0044_video_preview_revisions.sql",
    ];
    for (const name of files) {
        const sql = await readFile(new URL(`../drizzle/${name}`, import.meta.url), "utf8");
        const statements = sql
            .split("--> statement-breakpoint")
            .map((value) => value.trim())
            .filter(Boolean);
        for (const statement of statements) {
            await testPlatform().env.DB.prepare(statement).run();
        }
    }
}
async function seedSnapshot() {
    const now = Date.now();
    await testPlatform().env.DB.prepare(`
    INSERT INTO designs (
      id, owner_id, artwork_key, content_type, byte_size, sha256,
      crop_x, crop_y, crop_zoom, placement_x, placement_y, placement_width,
      depth, status, version, finalized_at, legacy_claim_expires_at,
      created_at, updated_at, deleted_at
    ) VALUES (?, NULL, ?, 'image/png', ?, ?, 0.5, 0.5, 1, 0.39, 0.43,
      0.22, 5, 'ready', 1, ?, NULL, ?, ?, NULL)
  `).bind(DESIGN_ID, ARTWORK_KEY, ARTWORK.byteLength, SHA256, now, now, now).run();
    await testPlatform().env.DB.prepare(`
    INSERT INTO design_revisions (
      id, design_id, fingerprint, artwork_key, content_type, byte_size,
      sha256, crop_x, crop_y, crop_zoom, placement_x, placement_y,
      placement_width, depth, created_at
    ) VALUES (?, ?, 'revision-v1:test', ?, 'image/png', ?, ?, 0.5, 0.5, 1,
      0.39, 0.43, 0.22, 5, ?)
  `).bind(REVISION_ID, DESIGN_ID, ARTWORK_KEY, ARTWORK.byteLength, SHA256, now).run();
    await testPlatform().env.DB.batch([
        testPlatform().env.DB.prepare(`
      INSERT INTO products (
        id, base_product_id, design_id, design_revision_id, shopify_handle,
        placement_x, placement_y, placement_width, placement_depth,
        status, created_at, deleted_at
      ) VALUES (?, ?, NULL, NULL, 'bent-shirt', NULL, NULL, NULL, NULL, 'active', ?, NULL)
    `).bind(BASE_PRODUCT_ID, BASE_PRODUCT_ID, now),
        testPlatform().env.DB.prepare(`
      INSERT INTO products (
        id, base_product_id, design_id, design_revision_id, shopify_handle,
        placement_x, placement_y, placement_width, placement_depth,
        projection_version, status, created_at, deleted_at
      ) VALUES (?, ?, ?, ?, 'bent-shirt', 0.39, 0.43, 0.22, 5,
        'legacy-shirt-v1', 'active', ?, NULL)
    `).bind(PRODUCT_ID, BASE_PRODUCT_ID, DESIGN_ID, REVISION_ID, now),
    ]);
    await testPlatform().env.DESIGN_ARTWORK.put(ARTWORK_KEY, ARTWORK, {
        sha256: await checksum(ARTWORK),
    });
}
beforeAll(async () => {
    platform = await getPlatformProxy<Env>({
        configPath: new URL("../wrangler.jsonc", import.meta.url).pathname,
        persist: false,
        remoteBindings: false,
    });
    await applyMigrations();
});
beforeEach(async () => {
    await testPlatform().env.DB.batch([
        testPlatform().env.DB.prepare("DELETE FROM story_video_jobs"),
        testPlatform().env.DB.prepare("DELETE FROM design_upload_grants"),
        testPlatform().env.DB.prepare("DELETE FROM products"),
        testPlatform().env.DB.prepare("DELETE FROM design_revisions"),
        testPlatform().env.DB.prepare("DELETE FROM designs"),
    ]);
    await seedSnapshot();
});
afterAll(async () => platform?.dispose());
describe("immutable configured-product API", () => {
    it("exposes preparation state only through the authenticated active-product route", async () => {
        const path = `/v2/internal/configured-products/${PRODUCT_ID}/purchase-readiness`;
        expect((await handleImmutableProductRequest(new Request(`https://api.example.com${path}`), workerEnv()))?.status).toBe(401);
        // No accepted catalogue or print files exist for this legacy fixture.
        expect(await (await request(path)).json()).toEqual({ ready: false });
        await testPlatform().env.DB.prepare("INSERT INTO print_asset_jobs (configured_product_id, next_attempt_at, created_at, updated_at) VALUES (?, ?, ?, ?)")
            .bind(PRODUCT_ID, Date.now(), Date.now(), Date.now()).run();
        const pending = await request(path);
        expect(pending.headers.get("Cache-Control")).toBe("no-store");
        expect(await pending.json()).toEqual({ ready: false });
        await testPlatform().env.DB.prepare("UPDATE products SET status = 'suspended' WHERE id = ?").bind(PRODUCT_ID).run();
        expect((await request(path)).status).toBe(404);
    });
    it("requires service authentication before revealing route state", async () => {
        const response = await handleImmutableProductRequest(new Request(`https://api.example.com/v2/internal/configured-products/${PRODUCT_ID}`), workerEnv());
        expect(response?.status).toBe(401);
        expect(await response?.json()).toEqual({
            error: {
                code: "UNAUTHORIZED",
                message: "Service authentication is required.",
            },
        });
    });
    it("exposes the authenticated Worker release capability", async () => {
        const response = await request("/v2/internal/capabilities");
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            capabilities: [
                "cart-product-context-v1",
                "anonymous-drafts-v2",
                "saved-designs-v1",
                "saved-design-pages-v1",
                "order-management-v1",
                "featured-products-v1",
                "immutable-product-snapshots-v1",
                "printify-catalogue-snapshots-v1",
                "portrait-safety-screening-v1",
                "product-projections-v1",
                "sales-pause-v1",
                "shopify-printify-variant-mapping-v1",
                "story-video-media-v1",
            ],
            release: "bent-shirt-pilot-m2-v1",
        });
    });
    it("withholds the release capability when operations configuration is missing", async () => {
        const bindings = testPlatform().env;
        const response = await handleImmutableProductRequest(new Request("https://api.example.com/v2/internal/capabilities", {
            headers: { "x-forever-tee-service-secret": SECRET },
        }), {
            DB: bindings.DB,
            DESIGN_ARTWORK: bindings.DESIGN_ARTWORK,
            FOREVER_TEE_API_SHARED_SECRET: SECRET,
        });
        expect(response?.status).toBe(503);
        expect(await response?.json()).toEqual({
            error: {
                code: "CONFIGURATION_ERROR",
                message: "operations configuration is missing: BENT_SHIRT_OPERATIONS_SECRET.",
            },
        });
    });
    it("returns the active product's immutable revision snapshot", async () => {
        const response = await request(`/v2/internal/configured-products/${PRODUCT_ID}`);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            configuredProductId: PRODUCT_ID,
            baseProductId: BASE_PRODUCT_ID,
            baseProductSlug: "staple-tee",
            designId: DESIGN_ID,
            designRevisionId: REVISION_ID,
            placement: { x: 0.39, y: 0.43, width: 0.22, depth: 5 },
            projectionVersion: "legacy-shirt-v1",
            artworkSha256: SHA256,
            contentType: "image/png",
            byteSize: ARTWORK.byteLength,
            shopifyHandle: "bent-shirt",
            artworkUrl: `/v2/internal/design-revisions/${REVISION_ID}/artwork`,
        });
    });
    it("keeps deleted products out of active lookup but available by exact history", async () => {
        await testPlatform().env.DB.prepare("UPDATE products SET status = 'deleted', deleted_at = ? WHERE id = ?").bind(Date.now(), PRODUCT_ID).run();
        const active = await request(`/v2/internal/configured-products/${PRODUCT_ID}`);
        const historical = await request(`/v2/internal/configured-products/${PRODUCT_ID}/revisions/${REVISION_ID}`);
        const wrongRevision = await request(`/v2/internal/configured-products/${PRODUCT_ID}/revisions/${OTHER_REVISION_ID}`);
        expect(active.status).toBe(404);
        expect(historical.status).toBe(200);
        expect(wrongRevision.status).toBe(404);
    });
    it("streams immutable revision bytes with authoritative headers", async () => {
        const response = await request(`/v2/internal/design-revisions/${REVISION_ID}/artwork`);
        expect(response.status).toBe(200);
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(ARTWORK);
        expect(response.headers.get("content-type")).toBe("image/png");
        expect(response.headers.get("content-length")).toBe(String(ARTWORK.byteLength));
        expect(response.headers.get("etag")).toBe(`"${SHA256}"`);
        expect(response.headers.get("content-digest")).toBe(`sha-256=:${sha256Base64(SHA256)}:`);
        expect(response.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    });
    it("reports pending story media, then streams the immutable R2 result", async () => {
        const storyKey = `story-videos/v7/${REVISION_ID}/${PRODUCT_ID}/black.mp4`;
        const now = Date.now();
        await testPlatform().env.DB.prepare(`
      INSERT INTO story_video_jobs (
        id, product_id, design_revision_id, colour, renderer_version,
        story_key, status, attempt_count, created_at, updated_at
      ) VALUES (?, ?, ?, 'Black', 'story-video-renderer-v7', ?,
        'queued', 0, ?, ?)
    `).bind(crypto.randomUUID(), PRODUCT_ID, REVISION_ID, storyKey, now, now).run();
        const path = `/v2/internal/configured-products/${PRODUCT_ID}/story-videos/black`;
        const pending = await request(path, { method: "HEAD" });
        expect(pending.status).toBe(202);
        expect(pending.headers.get("retry-after")).toBe("2");
        const video = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]);
        await testPlatform().env.DB.prepare(`
      UPDATE story_video_jobs
      SET status = 'ready', output_byte_size = ?, rendered_at = ?, updated_at = ?
      WHERE story_key = ?
    `).bind(video.byteLength, now, now, storyKey).run();
        const renderer = {
            fetch: vi.fn((_input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(new Response(init?.method === "HEAD" ? null : video, {
                headers: {
                    "content-length": String(video.byteLength),
                    "content-type": "video/mp4",
                    etag: '"story-video"',
                },
            }))),
        };
        const ready = await request(path, {}, renderer);
        expect(ready.status).toBe(200);
        expect(new Uint8Array(await ready.arrayBuffer())).toEqual(video);
        expect(ready.headers.get("content-type")).toBe("video/mp4");
        expect(ready.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
        expect(renderer.fetch).toHaveBeenCalledWith("https://story-video.internal/video", {
            headers: { "x-story-video-key": storyKey },
            method: "GET",
        });
    });
    it("bounded-hashes compatible legacy objects that predate stored checksums", async () => {
        await testPlatform().env.DESIGN_ARTWORK.put(ARTWORK_KEY, ARTWORK);
        const response = await request(`/v2/internal/design-revisions/${REVISION_ID}/artwork`);
        expect(response.status).toBe(200);
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(ARTWORK);
    });
    it("rejects same-length object bytes whose checksum differs from the ledger", async () => {
        const wrongBytes = new Uint8Array([1, 2, 3, 4]);
        await testPlatform().env.DESIGN_ARTWORK.put(ARTWORK_KEY, wrongBytes, {
            sha256: await checksum(wrongBytes),
        });
        const response = await request(`/v2/internal/design-revisions/${REVISION_ID}/artwork`);
        expect(response.status).toBe(503);
    });
    it("supports HEAD and conditional immutable artwork reads", async () => {
        const head = await request(`/v2/internal/design-revisions/${REVISION_ID}/artwork`, { method: "HEAD" });
        const conditional = await request(`/v2/internal/design-revisions/${REVISION_ID}/artwork`, { headers: { "if-none-match": `"${SHA256}"` } });
        expect(head.status).toBe(200);
        expect((await head.arrayBuffer()).byteLength).toBe(0);
        expect(head.headers.get("content-length")).toBe(String(ARTWORK.byteLength));
        expect(conditional.status).toBe(304);
        expect((await conditional.arrayBuffer()).byteLength).toBe(0);
    });
    it("returns not found for absent revision metadata or artwork", async () => {
        const absentRevision = await request(`/v2/internal/design-revisions/${OTHER_REVISION_ID}/artwork`);
        await testPlatform().env.DB.prepare("UPDATE design_revisions SET artwork_key = 'missing/object' WHERE id = ?").bind(REVISION_ID).run();
        const absentObject = await request(`/v2/internal/design-revisions/${REVISION_ID}/artwork`);
        expect(absentRevision.status).toBe(404);
        expect(absentObject.status).toBe(404);
    });
    it("rejects artwork whose stored length disagrees with immutable metadata", async () => {
        await testPlatform().env.DESIGN_ARTWORK.put(ARTWORK_KEY, new Uint8Array([1, 2]));
        const response = await request(`/v2/internal/design-revisions/${REVISION_ID}/artwork`);
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({
            error: {
                code: "DEPENDENCY_UNAVAILABLE",
                message: "Revision artwork is unavailable.",
            },
        });
    });
});
