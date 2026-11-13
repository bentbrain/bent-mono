import { withDatabasePrepare } from "./test-database";
import { protectedConfig } from "./protected-config";
import { type ProductImageEnv, consumeProductImageMessage, reconcileProductImages, productPreviewResponse, ensureProductImages, productImageTransfer, productImageResponse } from "./product-images";
import { readFile, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getPlatformProxy, type PlatformProxy } from "wrangler";
import { ensureStoryVideoJobs, consumeStoryVideoQueue, renderStoryVideoRevisionBatch, reconcileStoryVideoJobs, type StoryVideoQueueMessage, } from "./story-video-jobs";
import { storyVideoEvents } from "./story-video-events";
import { handleStoryVideoTransfer } from "./story-video-transfer";
import { createStoryVideoGrant } from "./story-video-grants";
import { LAMBDA_STORY_FUNCTION, renderLambdaVideo, validateLambdaStoryVideoEnv } from "./story-video-lambda";
import worker, { handleRequest } from "./index";
import { handleNativeVideoStatus } from "./native-video-status";
import { qualificationLambdaSend, takeQualificationFault } from "./story-video-qualification";
import { canonicalNativeIdentity, nativeIdentityDigest, parseNativeV5Target } from "./native-v5-target";
import { artworkPreviewKey } from "./artwork-preview";
const DESIGN_ID = "9bbac861-76bf-4818-957d-12770401474a";
const REVISION_ID = "a58634b2-02dd-4ac8-b449-1978df422377";
const SHIRT_ID = "d16a04d6-f742-4f69-a1f5-5276836df373";
const TOTE_ID = "3c280e35-f37d-4c76-9dc1-d6f905236bd4";
const SHIRT_BASE_ID = "a51b7acf-77e9-4762-83c4-62d96dd8942c";
const TOTE_BASE_ID = "97b629d7-1d3b-4d2a-a586-537168141e97";
const ARTWORK = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
let platform: PlatformProxy<Env> | undefined;
function deferred() {
    let resolve: () => void = () => undefined;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
}
function isFixtureCallable(value: unknown): value is (...inputs: unknown[]) => unknown {
    return typeof value === "function";
}
function testPlatform() {
    if (!platform)
        throw new Error("Test bindings are unavailable.");
    return platform;
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
        "0026_portrait_safety_screening.sql",
        "0027_image_based_default_product_color.sql",
        "0028_product_color_analysis_state.sql",
        "0036_print_job_outbox.sql",
        "0039_featured_media_composition.sql",
        "0040_recursive_video_placement.sql",
        "0041_product_image_jobs.sql",
        "0042_design_artwork_sources.sql",
        "0043_artwork_preparation_jobs.sql",
        "0044_video_preview_revisions.sql",
        "0045_native_v5_dispatches.sql",
        "0038_print_staging.sql",
    ];
    for (const name of files) {
        await applyMigration(name);
    }
}
async function applyMigration(name: string) {
    const sql = await readFile(new URL(`../drizzle/${name}`, import.meta.url), "utf8");
    for (const statement of sql
        .split("--> statement-breakpoint")
        .map((value) => value.trim())
        .filter(Boolean)) {
        await testPlatform().env.DB.prepare(statement).run();
    }
}
async function seedProductFamily() {
    const digest = await crypto.subtle.digest("SHA-256", ARTWORK);
    const sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const artworkKey = `designs/${DESIGN_ID}/artwork/${sha256}`;
    const now = Date.now();
    await testPlatform().env.DESIGN_ARTWORK.put(artworkKey, ARTWORK);
    await testPlatform().env.DB.prepare(`
    INSERT INTO designs (
      id, owner_id, artwork_key, content_type, byte_size, sha256,
      crop_x, crop_y, crop_zoom, placement_x, placement_y, placement_width,
      depth, status, version, finalized_at, created_at, updated_at
    ) VALUES (?, NULL, ?, 'image/png', ?, ?, 0.47, 0.62, 1.06,
      0.3, 0.3, 0.42, 5, 'ready', 1, ?, ?, ?)
  `).bind(DESIGN_ID, artworkKey, ARTWORK.byteLength, sha256, now, now, now).run();
    await testPlatform().env.DB.prepare(`
    INSERT INTO design_revisions (
      id, design_id, fingerprint, artwork_key, content_type, byte_size,
      artwork_width, artwork_height, sha256,
      crop_x, crop_y, crop_zoom, placement_x, placement_y,
      placement_width, depth, created_at
    ) VALUES (?, ?, 'revision-v1:story-video', ?, 'image/png', ?, 3000, 4000, ?,
      0.47, 0.62, 1.06, 0, 0, 0.08, 1, ?)
  `).bind(REVISION_ID, DESIGN_ID, artworkKey, ARTWORK.byteLength, sha256, now).run();
    await testPlatform().env.DB.batch([
        configuredProductStatement(SHIRT_ID, SHIRT_BASE_ID, "bent-shirt", now),
        configuredProductStatement(TOTE_ID, TOTE_BASE_ID, "cotton-tote", now + 1),
    ]);
    await testPlatform().env.DB.batch([
        readyPrintAssetStatement("shirt-print-asset", SHIRT_ID, SHIRT_BASE_ID, "dtg:4500x5100", 4500, 5100, sha256, now),
        readyPrintAssetStatement("tote-print-asset", TOTE_ID, TOTE_BASE_ID, "dtg:3600x4200", 3600, 4200, sha256, now),
    ]);
    await Promise.all([
        testPlatform().env.DESIGN_ARTWORK.put(`print-assets/${SHIRT_ID}/dtg:4500x5100/${sha256}.png`, ARTWORK, { sha256: new Uint8Array(digest) }),
        testPlatform().env.DESIGN_ARTWORK.put(`print-assets/${TOTE_ID}/dtg:3600x4200/${sha256}.png`, ARTWORK, { sha256: new Uint8Array(digest) }),
    ]);
}
function readyPrintAssetStatement(id: string, productId: string, baseProductId: string, geometryKey: string, width: number, height: number, sha256: string, now: number) {
    return testPlatform().env.DB.prepare(`
    INSERT INTO print_assets (
      id, configured_product_id, design_revision_id, base_product_id,
      projection_version, geometry_key, storage_key, content_type, byte_size,
      width_px, height_px, sha256, status, created_at, updated_at, ready_at
    ) VALUES (?, ?, ?, ?, 'safe-margin-v1', ?, ?, 'image/png', ?, ?, ?, ?,
      'ready', ?, ?, ?)
  `).bind(id, productId, REVISION_ID, baseProductId, geometryKey, `print-assets/${productId}/${geometryKey}/${sha256}.png`, ARTWORK.byteLength, width, height, sha256, now, now, now);
}
async function seedPrintGeometries() {
    const now = Date.now();
    await testPlatform().env.DB.batch([
        testPlatform().env.DB.prepare(`
      INSERT INTO printify_catalogue_snapshots (
        id, shop_id, blueprint_id, print_provider_id, retrieved_at,
        source_urls_json, variant_count, base_product_id, base_product_slug
      ) VALUES ('story-shirt-catalogue', 'shop', 1, 1, ?, '[]', 1, ?,
        'staple-tee')
    `).bind(now, SHIRT_BASE_ID),
        testPlatform().env.DB.prepare(`
      INSERT INTO printify_catalogue_variants (
        snapshot_id, printify_variant_id, colour, size, available,
        decoration_method, print_width, print_height, shipping_first_item,
        shipping_additional_item, shipping_currency, handling_days_from,
        handling_days_to
      ) VALUES ('story-shirt-catalogue', 1, 'Black', 'M', 1, 'dtg',
        4500, 5100, 1000, 500, 'AUD', 1, 3)
    `),
        testPlatform().env.DB.prepare(`
      INSERT INTO printify_catalogue_snapshots (
        id, shop_id, blueprint_id, print_provider_id, retrieved_at,
        source_urls_json, variant_count, base_product_id, base_product_slug
      ) VALUES ('story-tote-catalogue', 'shop', 2, 1, ?, '[]', 1, ?,
        'cotton-tote')
    `).bind(now, TOTE_BASE_ID),
        testPlatform().env.DB.prepare(`
      INSERT INTO printify_catalogue_variants (
        snapshot_id, printify_variant_id, colour, size, available,
        decoration_method, print_width, print_height, shipping_first_item,
        shipping_additional_item, shipping_currency, handling_days_from,
        handling_days_to
      ) VALUES ('story-tote-catalogue', 2, 'Cream', 'One size', 1, 'dtg',
        3600, 4200, 1000, 500, 'AUD', 1, 3)
    `),
    ]);
}
function configuredProductStatement(productId: string, baseProductId: string, handle: string, createdAt: number) {
    return testPlatform().env.DB.prepare(`
    INSERT INTO products (
      id, base_product_id, design_id, design_revision_id, shopify_handle,
      placement_x, placement_y, placement_width, placement_depth,
      projection_version, status, created_at
    ) VALUES (?, ?, ?, ?, ?, 0.3, 0.3, 0.42, 5,
      'safe-margin-v1', 'active', ?)
  `).bind(productId, baseProductId, DESIGN_ID, REVISION_ID, handle, createdAt);
}
function renderResults(payload: unknown) {
    if (typeof payload !== "object" || payload === null ||
        !("jobs" in payload))
        throw new Error("Expected renderer jobs.");
    const jobs = unknownArray(payload.jobs);
    if (!jobs)
        throw new Error("Expected renderer jobs.");
    return jobs.map((job) => {
        if (typeof job !== "object" || job === null ||
            !("storyKey" in job) || typeof job.storyKey !== "string")
            throw new Error("Expected a story key.");
        return { cache: "miss", key: job.storyKey, size: 1500000 };
    });
}
function renderRequestSummary(payload: unknown) {
    if (typeof payload !== "object" || payload === null ||
        !("batchId" in payload) || typeof payload.batchId !== "string" ||
        !("shutdownAfterBatch" in payload) ||
        typeof payload.shutdownAfterBatch !== "boolean" ||
        !("shared" in payload) || typeof payload.shared !== "object" ||
        payload.shared === null ||
        !("encoding" in payload.shared) ||
        typeof payload.shared.encoding !== "object" ||
        payload.shared.encoding === null ||
        !("crf" in payload.shared.encoding) ||
        typeof payload.shared.encoding.crf !== "number" ||
        !("frameRate" in payload.shared.encoding) ||
        typeof payload.shared.encoding.frameRate !== "number" ||
        !("frameWidth" in payload.shared.encoding) ||
        typeof payload.shared.encoding.frameWidth !== "number" ||
        !("scaleBeforeHold" in payload.shared.encoding) ||
        typeof payload.shared.encoding.scaleBeforeHold !== "boolean" ||
        !("preset" in payload.shared) || typeof payload.shared.preset !== "string" ||
        !("websiteLabel" in payload.shared) ||
        typeof payload.shared.websiteLabel !== "string" ||
        !("jobs" in payload))
        throw new Error("Expected a complete renderer request.");
    const jobs = unknownArray(payload.jobs);
    if (!jobs)
        throw new Error("Expected renderer jobs.");
    const variants = jobs.map((job) => {
        if (typeof job !== "object" || job === null ||
            !("baseProductSlug" in job) ||
            typeof job.baseProductSlug !== "string" ||
            !("color" in job) || typeof job.color !== "string")
            throw new Error("Expected a renderer product variant.");
        return `${job.baseProductSlug}:${job.color}`;
    });
    return {
        batchId: payload.batchId,
        encoding: {
            crf: payload.shared.encoding.crf,
            frameRate: payload.shared.encoding.frameRate,
            frameWidth: payload.shared.encoding.frameWidth,
            scaleBeforeHold: payload.shared.encoding.scaleBeforeHold,
        },
        preset: payload.shared.preset,
        shutdownAfterBatch: payload.shutdownAfterBatch,
        variants,
        websiteLabel: payload.shared.websiteLabel,
    };
}
function unknownArray(value: unknown): readonly unknown[] | undefined {
    return Array.isArray(value) ? value : undefined;
}
describe("story-video jobs", () => {
    beforeAll(async () => {
        platform = await getPlatformProxy<Env>({
            configPath: new URL("../wrangler.jsonc", import.meta.url).pathname,
            persist: false,
            remoteBindings: false,
        });
        await applyMigrations();
        await seedPrintGeometries();
    }, 30000);
    beforeEach(async () => {
        const videos = testPlatform().env.STORY_VIDEOS;
        if (videos)
            for (const object of (await videos.list()).objects)
                await videos.delete(object.key);
        await testPlatform().env.DB.prepare("DELETE FROM native_v5_dispatches").run();
        await testPlatform().env.DB.prepare("DELETE FROM product_image_jobs").run();
        await testPlatform().env.DB.prepare("DELETE FROM story_video_jobs").run();
        await testPlatform().env.DB.prepare("DELETE FROM print_assets").run();
        await testPlatform().env.DB.prepare("DELETE FROM products WHERE design_id IS NOT NULL").run();
        await testPlatform().env.DB.prepare("DELETE FROM design_revisions").run();
        await testPlatform().env.DB.prepare("DELETE FROM designs").run();
        await seedProductFamily();
    });
    async function nativeEnv(version = "7", grantKeyId = "qualification-key-n", codeDigest = "a".repeat(64), inputsDigest = "b".repeat(64), qualificationDigest = "c".repeat(64)) {
        const target = { schemaVersion: 1, environment: "qualification", functionArn: `arn:aws:lambda:ap-southeast-2:${protectedConfig("awsAccountId")}:function:shop-native-v5-qualification:${version}`,
            codeDigest, inputsDigest, qualificationDigest, grantKeyId };
        const prior: unknown = JSON.parse(process.env["SHOP_PROTECTED_CONFIG_JSON"] ?? "null");
        if (typeof prior !== "object" || prior === null || Array.isArray(prior)) throw new Error("Missing protected test fixture.");
        vi.stubEnv("SHOP_PROTECTED_CONFIG_JSON", JSON.stringify({ ...prior,
            nativeV5QualificationFunctionArn: target.functionArn.slice(0, target.functionArn.lastIndexOf(":")),
            nativeV5QualificationTargetDigest: await nativeIdentityDigest(canonicalNativeIdentity(target)) }));
        const env: ProductImageEnv = { ...lambdaEnv(), SHOP_NATIVE_V5_TARGET_JSON: JSON.stringify(target), SHOP_NATIVE_V5_GRANT_SECRET: "synthetic-native-grant-secret-n-00001" };
        return { env, target };
    }
    function nativeEvent(value: unknown) {
        if (typeof value !== "object" || value === null || !("jobId" in value) || typeof value.jobId !== "string" || !("grant" in value) || typeof value.grant !== "string") throw new Error("Missing native invocation identity.");
        return { jobId: value.jobId, grant: value.grant };
    }
    it("accepts the strict qualification target and rejects aliases, other environments and unknown fields", async () => {
        const { target } = await nativeEnv();
        try {
            expect(parseNativeV5Target(JSON.stringify(target))).toEqual(target);
            for (const changed of [{ environment: "production" }, { functionArn: target.functionArn.replace(/:7$/, ":$LATEST") },
                { codeDigest: "A".repeat(64) }, { grantKeyId: "key/other" }, { extra: true }]) {
                expect(() => parseNativeV5Target(JSON.stringify({ ...target, ...changed }))).toThrow();
            }
            expect(() => parseNativeV5Target(JSON.stringify(target).slice(0, -1) + ',"schemaVersion":1}')).toThrow("unique");
        } finally { vi.unstubAllEnvs(); }
    });
    it("persists native target, source, input and grant before dispatch and accepts late callbacks with current target and secret removed", async () => {
        const { env, target } = await nativeEnv();
        const requests: { jobId: string; grant: string }[] = [];
        vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
            if (!(input instanceof Request)) throw new Error("Expected the default signed Lambda request.");
            expect(decodeURIComponent(input.url)).toContain(target.functionArn);
            expect(input.headers.get("x-amz-invocation-type")).toBe("RequestResponse");
            expect(input.headers.get("x-amz-security-token")).toBe("synthetic-explicit-session-token");
            const event = nativeEvent(await input.json()); requests.push(event);
            expect(event.grant.startsWith("nv5_")).toBe(true);
            const accepted = await env.DB.prepare("SELECT dispatch_state,target_json,input_json,grant_sha256,request_sha256 FROM native_v5_dispatches WHERE job_id=? AND attempt=1").bind(event.jobId).first<{
                dispatch_state: string; target_json: string; input_json: string; grant_sha256: string; request_sha256: string;
            }>();
            expect(accepted?.dispatch_state).toBe("prepared");
            expect(accepted?.grant_sha256).toBe(await nativeIdentityDigest(event.grant));
            expect(JSON.parse(accepted?.target_json ?? "null")).toEqual(target);
            expect(JSON.parse(accepted?.input_json ?? "null")).toHaveProperty("source.sha256");
            return new Response(null, { status: 202 });
        }));
        try {
            await ensureProductImages({ ...env, STORY_VIDEO_LAMBDA_SESSION_TOKEN: "synthetic-explicit-session-token" }, [SHIRT_ID, TOTE_ID]);
            expect(requests).toHaveLength(6);
            expect(await env.DB.prepare("SELECT count(*) AS n FROM native_v5_dispatches WHERE dispatch_state='uncertain'").first()).toEqual({ n: 6 });
            const event = requests[0]; if (!event) throw new Error("Missing accepted event.");
            vi.unstubAllEnvs();
            const callbacks = { ...lambdaEnv(), STORY_VIDEO_GRANT_SECRET: "rotated-legacy-grant-secret-0000001" };
            const headers = { authorization: `Bearer ${event.grant}`, "x-image-execution-id": crypto.randomUUID(), "x-image-renderer-version": "product-images-v5" };
            const claim = await productImageTransfer(new Request(`https://api.test/v2/internal/product-image-jobs/${event.jobId}/claim`, { method: "POST", headers: { ...headers, accept: "application/vnd.bent.product-image-source" } }), callbacks);
            expect(claim?.status).toBe(201);
            expect(claim?.headers.get("x-image-source-sha256")).toBe(await nativeIdentityDigest(ARTWORK));
            if (!claim) throw new Error("Missing retained native source response.");
            expect(new Uint8Array(await claim.arrayBuffer())).toEqual(ARTWORK);
            expect((await productImageTransfer(new Request(`https://api.test/v2/internal/product-image-jobs/${event.jobId}/artwork`, { headers: { ...headers, authorization: `Bearer ${event.grant}x` } }), callbacks))?.status).toBe(403);
            const legacyGrant = await createStoryVideoGrant(callbacks.STORY_VIDEO_GRANT_SECRET, event.jobId, 1);
            expect((await productImageTransfer(new Request(`https://api.test/v2/internal/product-image-jobs/${event.jobId}/claim`, { method: "POST", headers: { ...headers, authorization: `Bearer ${legacyGrant}` } }), callbacks))?.status).toBe(403);
            const next = requests[1], original = await env.DB.prepare("SELECT artwork_key FROM design_revisions WHERE id=?").bind(REVISION_ID).first<{ artwork_key: string }>();
            if (!next || !original) throw new Error("Missing retained source fixture.");
            await env.DESIGN_ARTWORK.put(original.artwork_key, new Uint8Array(ARTWORK.length));
            expect((await productImageTransfer(new Request(`https://api.test/v2/internal/product-image-jobs/${next.jobId}/claim`, { method: "POST", headers: {
                authorization: `Bearer ${next.grant}`, "x-image-execution-id": crypto.randomUUID(), "x-image-renderer-version": "product-images-v5", accept: "application/vnd.bent.product-image-source",
            } }), callbacks))?.status).toBe(409);
        } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); }
    });
    it("retains the accepted numbered target and grant key across rotation, retries and rollback", async () => {
        const original = await nativeEnv(), requests: string[] = [];
        let laterPreviewKey: string | undefined;
        vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
            if (!(input instanceof Request)) throw new Error("Expected the signed native invocation.");
            requests.push(decodeURIComponent(input.url));
            return Promise.reject(new Error("Synthetic lost acknowledgement after dispatch."));
        }));
        try {
            await ensureProductImages(original.env, SHIRT_ID);
            expect(requests).toHaveLength(4);
            const firstInputs = await original.env.DB.prepare("SELECT job_id,input_json FROM native_v5_dispatches WHERE attempt=1 ORDER BY job_id").all<{ job_id: string; input_json: string }>();
            const revision = await original.env.DB.prepare("SELECT sha256 FROM design_revisions WHERE id=?").bind(REVISION_ID).first<{ sha256: string }>();
            if (!revision) throw new Error("Missing original source identity.");
            laterPreviewKey = artworkPreviewKey(DESIGN_ID, revision.sha256);
            const laterPreview = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]);
            await original.env.DESIGN_ARTWORK.put(laterPreviewKey, laterPreview, { customMetadata: { sha256: await nativeIdentityDigest(laterPreview) } });
            await original.env.DB.prepare("UPDATE product_image_jobs SET updated_at=? WHERE status='rendering'").bind(Date.now() - 210000).run();
            const next = await nativeEnv("8", "qualification-key-n-plus-one");
            await ensureProductImages({ ...next.env, SHOP_NATIVE_V5_RETAINED_GRANT_SECRETS_JSON: JSON.stringify({ "qualification-key-n": original.env.SHOP_NATIVE_V5_GRANT_SECRET }) }, SHIRT_ID);
            expect(requests).toHaveLength(8);
            expect(requests.every(url => url.includes(original.target.functionArn))).toBe(true);
            expect(await original.env.DB.prepare("SELECT count(*) AS n FROM native_v5_dispatches WHERE attempt=2 AND target_json=?").bind(canonicalNativeIdentity(original.target)).first()).toEqual({ n: 4 });
            expect((await original.env.DB.prepare("SELECT job_id,input_json FROM native_v5_dispatches WHERE attempt=2 ORDER BY job_id").all()).results).toEqual(firstInputs.results);
        } finally { if (laterPreviewKey) await original.env.DESIGN_ARTWORK.delete(laterPreviewKey); vi.unstubAllGlobals(); vi.unstubAllEnvs(); }
    });
    it("fails a target or grant-key swap before claiming work and preserves v4/v5 dispatch when the additive schema is absent", async () => {
        const { env, target } = await nativeEnv();
        vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(null, { status: 202 }))));
        try {
            await expect(ensureProductImages({ ...env, SHOP_NATIVE_V5_TARGET_JSON: JSON.stringify({ ...target, functionArn: target.functionArn.replace(/:7$/, ":live") }) }, SHIRT_ID)).rejects.toThrow("numbered");
            await expect(ensureProductImages({ ...env, SHOP_NATIVE_V5_TARGET_JSON: JSON.stringify({ ...target, codeDigest: "d".repeat(64) }) }, SHIRT_ID)).rejects.toThrow("independently installed");
            await expect(ensureProductImages({ ...env, OPERATIONS_ENVIRONMENT: "production" }, SHIRT_ID)).rejects.toThrow("restricted to qualification");
            await ensureProductImages({ ...env, SHOP_NATIVE_V5_GRANT_SECRET: "short" }, SHIRT_ID);
            expect(await env.DB.prepare("SELECT sum(attempt_count) AS n FROM product_image_jobs").first()).toEqual({ n: 0 });
            expect(fetch).not.toHaveBeenCalled();
            await env.DB.prepare("DELETE FROM product_image_jobs").run();
            await env.DB.prepare("ALTER TABLE native_v5_dispatches RENAME TO native_v5_dispatches_uninstalled").run();
            try {
                vi.unstubAllEnvs();
                await ensureProductImages(lambdaEnv(), SHIRT_ID);
                expect(fetch).toHaveBeenCalledTimes(4);
                expect(await env.DB.prepare("SELECT DISTINCT renderer_version FROM product_image_jobs").all()).toMatchObject({ results: [{ renderer_version: "product-images-v4" }] });
            } finally { await env.DB.prepare("ALTER TABLE native_v5_dispatches_uninstalled RENAME TO native_v5_dispatches").run(); }
        } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); }
    });
    it("counts accepted native images in the shared Lambda video concurrency lane", async () => {
        const { env } = await nativeEnv();
        let calls = 0;
        vi.stubGlobal("fetch", vi.fn(() => { calls++; return Promise.resolve(new Response(null, { status: 202 })); }));
        try {
            await ensureProductImages({ ...env, STORY_VIDEO_MAX_INFLIGHT: "4" }, [SHIRT_ID, TOTE_ID]);
            expect(calls).toBe(4);
            await ensureStoryVideoJobs(lambdaEnv(), [SHIRT_ID, TOTE_ID]);
            await renderStoryVideoRevisionBatch({ ...lambdaEnv(), STORY_VIDEO_MAX_INFLIGHT: "4" }, REVISION_ID);
            expect(calls).toBe(4);
            expect(await env.DB.prepare("SELECT count(*) AS n FROM story_video_jobs WHERE status='rendering'").first()).toEqual({ n: 0 });
        } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); }
    });
    it("deletes retained native receipts with obsolete jobs and denies their late callbacks", async () => {
        const { env } = await nativeEnv(), events: { jobId: string; grant: string }[] = [];
        vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
            if (!(input instanceof Request)) throw new Error("Expected a signed native request.");
            events.push(nativeEvent(await input.json()));
            return new Response(null, { status: 202 });
        }));
        try {
            expect(await env.DB.prepare("PRAGMA foreign_keys").first()).toEqual({ foreign_keys: 1 });
            await ensureProductImages(env, SHIRT_ID);
            await reconcileProductImages(env);
            expect(await env.DB.prepare("SELECT count(*) AS n FROM native_v5_dispatches").first()).toEqual({ n: 4 });
            await env.DB.prepare("UPDATE products SET status='suspended' WHERE id=?").bind(SHIRT_ID).run();
            await reconcileProductImages(env);
            expect(await env.DB.prepare("SELECT count(*) AS n FROM product_image_jobs").first()).toEqual({ n: 0 });
            expect(await env.DB.prepare("SELECT count(*) AS n FROM native_v5_dispatches").first()).toEqual({ n: 0 });
            const event = events[0]; if (!event) throw new Error("Missing accepted native job.");
            for (const action of ["claim", "failure"]) expect((await productImageTransfer(new Request(`https://api.test/v2/internal/product-image-jobs/${event.jobId}/${action}`, {
                method: "POST", headers: { authorization: `Bearer ${event.grant}`, "x-image-execution-id": crypto.randomUUID() },
            }), env))?.status).toBe(403);
            expect((await env.DB.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
        } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); }
    });
    it.each(["lambda", "vercel"])("rejects native admission with unretained %s work and preserves original retries and callbacks", async provider => {
        const native = await nativeEnv(), requests: { jobId: string; grant: string; url: string }[] = [];
        const legacy: ProductImageEnv = provider === "vercel" ? { ...lambdaEnv(), STORY_VIDEO_ENVIRONMENT: "development", PRODUCT_IMAGE_PROVIDER: "vercel",
            PRODUCT_IMAGE_RENDERER_BYPASS_SECRET: "test-bypass", FOREVER_TEE_API_SHARED_SECRET: "legacy-transition-shared-secret" } : lambdaEnv();
        vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
            if (!(input instanceof Request)) return Response.json({ rendererVersion: "product-images-v5" });
            requests.push({ ...nativeEvent(await input.json()), url: input.url });
            return new Response(null, { status: 202 });
        }));
        try {
            await ensureProductImages(native.env, SHIRT_ID);
            await ensureProductImages(legacy, TOTE_ID);
            expect(requests).toHaveLength(6);
            const legacyEvent = requests[4]; if (!legacyEvent) throw new Error("Missing original legacy job.");
            expect((await productImageTransfer(new Request(`https://api.test/v2/internal/product-image-jobs/${legacyEvent.jobId}/claim`, { method: "POST", headers: {
                authorization: `Bearer ${legacyEvent.grant}`, "x-image-execution-id": crypto.randomUUID(),
            } }), native.env))?.status).toBe(201);
            await native.env.DB.prepare("UPDATE product_image_jobs SET updated_at=? WHERE status='rendering'").bind(Date.now() - 210000).run();
            const before = (await native.env.DB.prepare("SELECT * FROM product_image_jobs ORDER BY id").all()).results;
            await expect(ensureProductImages(native.env, SHIRT_ID)).rejects.toThrow("historical transport and grant identity");
            expect((await native.env.DB.prepare("SELECT * FROM product_image_jobs ORDER BY id").all()).results).toEqual(before);
            expect(requests).toHaveLength(6);
            const rollback: ProductImageEnv = { ...legacy, SHOP_NATIVE_V5_RETAINED_GRANT_SECRETS_JSON: JSON.stringify({ "qualification-key-n": native.env.SHOP_NATIVE_V5_GRANT_SECRET }) };
            await reconcileProductImages(rollback);
            // A claimed legacy invocation keeps its existing completion hold.
            await native.env.DB.prepare("UPDATE product_image_jobs SET updated_at=? WHERE status='queued' AND attempt_count=1").bind(Date.now() - 41000).run();
            await reconcileProductImages(rollback);
            expect(requests).toHaveLength(12);
            expect(requests.slice(6).filter(request => request.grant.startsWith("nv5_")).every(request => decodeURIComponent(request.url).includes(native.target.functionArn))).toBe(true);
            expect(requests.slice(6).filter(request => !request.grant.startsWith("nv5_")).map(request => request.url)).toEqual([legacyEvent.url, legacyEvent.url]);
            expect(await native.env.DB.prepare("SELECT count(*) AS n FROM product_image_jobs WHERE attempt_count=2 AND status='rendering'").first()).toEqual({ n: 6 });
            expect((await productImageTransfer(new Request(`https://api.test/v2/internal/product-image-jobs/${legacyEvent.jobId}/failure`, { method: "POST", headers: {
                authorization: `Bearer ${legacyEvent.grant}`,
            } }), rollback))?.status).toBe(204);
            expect(await native.env.DB.prepare("SELECT count(*) AS n FROM product_image_jobs WHERE attempt_count=2 AND status='rendering'").first()).toEqual({ n: 6 });
        } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); }
    });
    it("keeps never-accepted native intent out of legacy dispatch after target removal", async () => {
        const { env } = await nativeEnv();
        const dispatches: string[] = [];
        vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
            if (input instanceof Request) dispatches.push(input.url);
            return Promise.resolve(Response.json({ rendererVersion: "product-images-v5" }));
        }));
        try {
            await ensureProductImages({ ...env, SHOP_NATIVE_V5_GRANT_SECRET: "short" }, SHIRT_ID);
            expect(dispatches).toEqual([]);
            expect(await env.DB.prepare("SELECT count(*) AS n FROM product_image_jobs WHERE attempt_count=0 AND dispatch_provider='native-v5'").first()).toEqual({ n: 4 });
            await ensureProductImages({ ...lambdaEnv(), PRODUCT_IMAGE_PROVIDER: "vercel", STORY_VIDEO_ENVIRONMENT: "development",
                PRODUCT_IMAGE_RENDERER_BYPASS_SECRET: "test-bypass", FOREVER_TEE_API_SHARED_SECRET: "legacy-shared-secret" }, SHIRT_ID);
            expect(dispatches).toEqual([]);
            expect(await env.DB.prepare("SELECT sum(attempt_count) AS n FROM product_image_jobs").first()).toEqual({ n: 0 });
        } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); }
    });
    it.each(["lambda", "vercel"])("preserves unaccepted %s pending jobs before first native admission", async provider => {
        const legacy: ProductImageEnv = { ...lambdaEnv(), STORY_VIDEO_GRANT_SECRET: "", ...(provider === "vercel" ? {
            PRODUCT_IMAGE_PROVIDER: "vercel", STORY_VIDEO_ENVIRONMENT: "development", PRODUCT_IMAGE_RENDERER_BYPASS_SECRET: "test-bypass",
            FOREVER_TEE_API_SHARED_SECRET: "pending-legacy-shared-secret",
        } : {}) };
        const dispatches: string[] = [];
        vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
            if (input instanceof Request) dispatches.push(input.url);
            return Promise.resolve(Response.json({ rendererVersion: "product-images-v5" }));
        }));
        try {
            await ensureProductImages(legacy, TOTE_ID);
            expect(await legacy.DB.prepare("SELECT count(*) AS n FROM product_image_jobs WHERE attempt_count=0 AND dispatch_provider IS NULL").first()).toEqual({ n: 2 });
            const before = (await legacy.DB.prepare("SELECT * FROM product_image_jobs ORDER BY id").all()).results;
            const native = await nativeEnv();
            await expect(ensureProductImages(native.env, SHIRT_ID)).rejects.toThrow("historical transport and grant identity");
            expect((await legacy.DB.prepare("SELECT * FROM product_image_jobs ORDER BY id").all()).results).toEqual(before);
            expect(dispatches).toEqual([]);
        } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); }
    });
    it("rolls back the job claim when its durable native acceptance insert fails", async () => {
        const { env } = await nativeEnv();
        await env.DB.prepare("CREATE TRIGGER reject_native_acceptance BEFORE INSERT ON native_v5_dispatches BEGIN SELECT RAISE(ABORT,'synthetic acceptance failure'); END").run();
        vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("No request may leave before durable acceptance."))));
        try {
            await ensureProductImages(env, SHIRT_ID);
            expect(fetch).not.toHaveBeenCalled();
            expect(await env.DB.prepare("SELECT sum(attempt_count) AS n FROM product_image_jobs").first()).toEqual({ n: 0 });
            expect(await env.DB.prepare("SELECT count(*) AS n FROM native_v5_dispatches").first()).toEqual({ n: 0 });
        } finally { await env.DB.prepare("DROP TRIGGER reject_native_acceptance").run(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); }
    });
    it("retains accepted grants and leases when AWS returns a synchronous FunctionError", async () => {
        const { env } = await nativeEnv(), events: { jobId: string; grant: string }[] = [];
        vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
            if (!(input instanceof Request)) throw new Error("Expected a signed Lambda invocation.");
            events.push(nativeEvent(await input.json()));
            return Response.json({ errorType: "SyntheticHandlerFailure" }, { headers: { "x-amz-function-error": "Unhandled" } });
        }));
        try {
            await ensureProductImages(env, SHIRT_ID);
            expect(events).toHaveLength(4);
            expect(await env.DB.prepare("SELECT count(*) AS n FROM native_v5_dispatches WHERE dispatch_state='accepted'").first()).toEqual({ n: 4 });
            expect(await env.DB.prepare("SELECT count(*) AS n FROM product_image_jobs WHERE status='rendering'").first()).toEqual({ n: 4 });
            const event = events[0]; if (!event) throw new Error("Missing accepted error event.");
            expect((await productImageTransfer(new Request(`https://api.test/v2/internal/product-image-jobs/${event.jobId}/failure`, { method: "POST", headers: {
                authorization: `Bearer ${event.grant}`, "x-image-renderer-version": "product-images-v5",
            } }), lambdaEnv()))?.status).toBe(204);
            expect(await env.DB.prepare("SELECT status FROM product_image_jobs WHERE id=?").bind(event.jobId).first()).toEqual({ status: "failed" });
        } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); }
    });
    it("rejects source corruption before accepting or invoking native work", async () => {
        const { env } = await nativeEnv(), source = await env.DB.prepare("SELECT artwork_key FROM design_revisions WHERE id=?").bind(REVISION_ID).first<{ artwork_key: string }>();
        if (!source) throw new Error("Missing source fixture.");
        await env.DESIGN_ARTWORK.put(source.artwork_key, new Uint8Array(ARTWORK.length));
        vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("Corrupt source must not be dispatched."))));
        try {
            await ensureProductImages(env, SHIRT_ID);
            expect(fetch).not.toHaveBeenCalled();
            expect(await env.DB.prepare("SELECT sum(attempt_count) AS n FROM product_image_jobs").first()).toEqual({ n: 0 });
            expect(await env.DB.prepare("SELECT count(*) AS n FROM native_v5_dispatches").first()).toEqual({ n: 0 });
        } finally { await env.DESIGN_ARTWORK.put(source.artwork_key, ARTWORK); vi.unstubAllGlobals(); vi.unstubAllEnvs(); }
    });
    it.each(["acknowledged", "lost-response"])("default business image route invokes the actual packaged v5 handler through the AWS boundary: %s", async (outcome) => {
        const retained = process.env["SHOP_NATIVE_V5_PROOF_DIRECTORY"];
        const directory = retained ? resolve(retained, outcome) : await mkdtemp(join(tmpdir(), "shop-native-default-"));
        if (retained) await mkdir(directory, { mode: 0o700 });
        const capsule = join(directory, "capsule"), packager = fileURLToPath(new URL("../../../scripts/testing/product-image-v5-capsule.mjs", import.meta.url));
        const packaged = await promisify(execFile)(process.execPath, [packager, capsule], { maxBuffer: 65536 });
        const manifest = await readFile(join(capsule, "capsule-manifest.json"));
        const capsuleIdentity: unknown = JSON.parse(manifest.toString("utf8"));
        if (typeof capsuleIdentity !== "object" || capsuleIdentity === null || !("sourceInputs" in capsuleIdentity) || !Array.isArray(capsuleIdentity.sourceInputs)) throw new Error("Capsule input inventory unavailable.");
        const buildId = await nativeIdentityDigest(manifest), inputsDigest = await nativeIdentityDigest(canonicalNativeIdentity(capsuleIdentity.sourceInputs));
        const qualificationReceipt = { schema: "shop.native-v5-local-fixture-qualification/v1", scope: "inactive-local", codeDigest: buildId, inputsDigest, awsImageQualified: false };
        const { env, target } = await nativeEnv("7", "qualification-key-n", buildId, inputsDigest, await nativeIdentityDigest(canonicalNativeIdentity(qualificationReceipt)));
        const sharpModule: unknown = await import(pathToFileURL(createRequire(join(capsule, "package.json")).resolve("sharp")).href);
        if (typeof sharpModule !== "object" || sharpModule === null || !("default" in sharpModule) || !isFixtureCallable(sharpModule.default)) throw new Error("Packaged Sharp export unavailable.");
        const pipeline: unknown = sharpModule.default({ create: { width: 320, height: 410, channels: 4, background: "#2468cc" } });
        if (typeof pipeline !== "object" || pipeline === null || !("png" in pipeline) || !isFixtureCallable(pipeline.png)) throw new Error("Packaged synthetic PNG pipeline unavailable.");
        const png: unknown = pipeline.png();
        if (typeof png !== "object" || png === null || !("toBuffer" in png) || !isFixtureCallable(png.toBuffer)) throw new Error("Packaged synthetic PNG output unavailable.");
        const source: unknown = await png.toBuffer();
        if (!(source instanceof Uint8Array)) throw new Error("Synthetic source bytes unavailable.");
        const sourceDigest = await nativeIdentityDigest(source), sourceKey = `designs/${DESIGN_ID}/artwork/${sourceDigest}`;
        await env.DESIGN_ARTWORK.put(sourceKey, source);
        await env.DB.batch([env.DB.prepare("UPDATE designs SET artwork_key=?,sha256=?,byte_size=? WHERE id=?").bind(sourceKey, sourceDigest, source.length, DESIGN_ID),
            env.DB.prepare("UPDATE design_revisions SET artwork_key=?,sha256=?,byte_size=? WHERE id=?").bind(sourceKey, sourceDigest, source.length, REVISION_ID)]);
        const origin = "http://127.0.0.1:34197", functionArn = target.functionArn.slice(0, target.functionArn.lastIndexOf(":"));
        vi.stubEnv("SHOP_PRODUCT_IMAGE_V5_BINDING_JSON", JSON.stringify({ schemaVersion: 1, environment: "local-proof", apiOrigin: origin,
            functionArn, qualifiedFunctionArns: [target.functionArn], buildId }));
        const module: unknown = await import(pathToFileURL(join(capsule, "product-image-v5-entry.mjs")).href);
        if (typeof module !== "object" || module === null || !("handler" in module) || !isFixtureCallable(module.handler)) throw new Error("Packaged native handler unavailable.");
        const nativeHandler = module.handler;
        const background: Promise<unknown>[] = [], calls: { path: string; status: number }[] = [], invocations: string[] = [];
        if (!env.SHOP_NATIVE_V5_GRANT_SECRET) throw new Error("Missing synthetic native grant key.");
        const serviceSecret = "native-default-service-secret";
        const runtime = { ...testPlatform().env, ...lambdaEnv(), SHOP_NATIVE_V5_TARGET_JSON: JSON.stringify(target),
            SHOP_NATIVE_V5_GRANT_SECRET: env.SHOP_NATIVE_V5_GRANT_SECRET, FOREVER_TEE_API_SHARED_SECRET: serviceSecret };
        // Callback configuration intentionally has no native target or grant key.
        const callbacks = { ...testPlatform().env, ...lambdaEnv(), FOREVER_TEE_API_SHARED_SECRET: serviceSecret };
        const context: ExecutionContext = { waitUntil: task => { background.push(task); }, passThroughOnException: () => { throw new Error("Unexpected passthrough"); },
            abort: () => { throw new Error("Unexpected abort"); }, props: {}, get exports(): never { throw new Error("Unexpected exports"); }, get tracing(): never { throw new Error("Unexpected tracing"); } };
        vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const request = input instanceof Request ? input : new Request(input, init), url = new URL(request.url);
            if (url.origin === "https://lambda.ap-southeast-2.amazonaws.com") {
                expect(decodeURIComponent(url.pathname)).toContain(target.functionArn);
                expect(request.headers.get("x-amz-invocation-type")).toBe("RequestResponse");
                const body = await request.text(), event: unknown = JSON.parse(body), identity = nativeEvent(event);
                const accepted = await env.DB.prepare("SELECT request_sha256,target_json FROM native_v5_dispatches WHERE job_id=? AND attempt=1").bind(identity.jobId).first<{ request_sha256: string; target_json: string }>();
                expect(accepted?.request_sha256).toBe(await nativeIdentityDigest(body));
                expect(accepted?.target_json).toBe(canonicalNativeIdentity(target));
                invocations.push(identity.jobId);
                const result: unknown = await nativeHandler(event, { invokedFunctionArn: target.functionArn, awsRequestId: crypto.randomUUID(), getRemainingTimeInMillis: () => 120000 });
                if (outcome === "lost-response") throw new Error("Synthetic lost AWS response after actual publication.");
                return Response.json(result);
            }
            if (url.origin === origin) {
                const response = await handleRequest(new Request(`https://api.test${url.pathname}`, { method: request.method, headers: request.headers,
                    ...(!["GET", "HEAD"].includes(request.method) ? { body: await request.arrayBuffer() } : {}) }), callbacks, context);
                calls.push({ path: url.pathname, status: response.status }); return response;
            }
            throw new Error(`Unexpected default-native proof network boundary: ${url.origin}`);
        }));
        try {
            expect(worker.fetch).toBe(handleRequest);
            const request = () => new Request(`https://api.test/v2/internal/configured-products/${SHIRT_ID}/images/flat/white`, { headers: { "x-forever-tee-service-secret": runtime.FOREVER_TEE_API_SHARED_SECRET } });
            const initial = await handleRequest(request(), runtime, context);
            expect([200, 202]).toContain(initial.status);
            if (initial.status === 200) expect(initial.headers.get("content-type")).toBe("image/webp");
            else expect(initial.headers.get("retry-after")).toBe("2");
            await initial.body?.cancel();
            await Promise.all(background);
            expect(invocations).toHaveLength(4);
            expect(calls.filter(call => call.path.endsWith("/claim") && call.status === 201)).toHaveLength(4);
            expect(calls.filter(call => call.path.endsWith("/image") && call.status === 200)).toHaveLength(4);
            const response = await handleRequest(request(), callbacks, context);
            expect(response.status).toBe(200);
            const image = new Uint8Array(await response.arrayBuffer());
            const row = await env.DB.prepare("SELECT sha256,byte_size FROM product_image_jobs WHERE product_id=? AND colour='White' AND view='flat'").bind(SHIRT_ID).first<{ sha256: string; byte_size: number }>();
            expect(await nativeIdentityDigest(image)).toBe(row?.sha256); expect(image.length).toBe(row?.byte_size);
            expect(await env.DB.prepare("SELECT count(*) AS n FROM product_image_jobs WHERE status='ready'").first()).toEqual({ n: 4 });
            expect(await env.DB.prepare("SELECT count(*) AS n FROM native_v5_dispatches WHERE dispatch_state=?").bind(outcome === "lost-response" ? "uncertain" : "accepted").first()).toEqual({ n: 4 });
            await writeFile(join(directory, "proof.json"), JSON.stringify({ scope: "inactive-local-default-native-dispatch", awsImageQualified: false, outcome, target, buildId, qualificationReceipt,
                packager: { executable: process.execPath, args: [packager, capsule], stdout: packaged.stdout, stderr: packaged.stderr }, invocations, calls, outputSha256: row?.sha256, outputBytes: image.length }), { mode: 0o600 });
        } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); if (!retained) await rm(directory, { recursive: true, force: true }); }
    }, 90000);
    it("serves revision-fenced browser artwork without admitting a render", async () => {
        const env = { ...testPlatform().env, FOREVER_TEE_API_SHARED_SECRET: "test-service-secret-at-least-random" };
        const headers = { "x-forever-tee-service-secret": env.FOREVER_TEE_API_SHARED_SECRET };
        const url = `https://api.test/v2/internal/configured-products/${SHIRT_ID}/preview/${REVISION_ID}`;
        expect((await productPreviewResponse(new Request(url), env))?.status).toBe(401);
        const response = await productPreviewResponse(new Request(url, { headers }), env);
        expect(response?.status).toBe(200);
        expect(response?.headers.get("cache-control")).toBe("private, no-store");
        const recipe: unknown = JSON.parse(response?.headers.get("x-product-preview") ?? "null");
        expect(recipe).toMatchObject({ revision: REVISION_ID, baseProductSlug: "staple-tee", settings: { cropX: .47, cropY: .62, cropZoom: 1.06 } });
        if (!response)
            throw new Error("Missing preview response");
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(ARTWORK);
        expect((await env.DB.prepare("SELECT count(*) AS n FROM product_image_jobs").first<{
            n: number;
        }>())?.n).toBe(0);
        expect((await productPreviewResponse(new Request(url.replace(REVISION_ID, crypto.randomUUID()), { headers }), env))?.status).toBe(404);
        await env.DB.prepare("UPDATE products SET status='deleted' WHERE id=?").bind(SHIRT_ID).run();
        expect((await productPreviewResponse(new Request(url, { headers }), env))?.status).toBe(404);
    });
    afterAll(async () => {
        await platform?.dispose();
    });
    it.each(["ready", "deleted"])("the first image GET returns a late %s result without a browser refetch", async (outcome) => {
        const env: ProductImageEnv = { ...lambdaEnv(), STORY_VIDEO_ENVIRONMENT: "development", PRODUCT_IMAGE_PROVIDER: "vercel", PRODUCT_IMAGE_RENDERER_BYPASS_SECRET: "test-bypass", FOREVER_TEE_API_SHARED_SECRET: `wait-${outcome}` };
        vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(null, { status: 404 }))));
        try {
            await ensureProductImages(env, SHIRT_ID);
            await env.DB.prepare("UPDATE product_image_jobs SET status='rendering'").run();
            const job = await env.DB.prepare("SELECT id,storage_key FROM product_image_jobs WHERE colour='White' AND view='flat'").first<{
                id: string;
                storage_key: string;
            }>();
            if (!job)
                throw new Error("Missing image job");
            const body = new TextEncoder().encode("RIFF0000WEBPtest"), sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", body)), v => v.toString(16).padStart(2, "0")).join("");
            await env.DESIGN_ARTWORK.put(job.storage_key, body, { customMetadata: { sha256 } });
            let settled = false;
            const response = productImageResponse(new Request(`https://api.test/v2/internal/configured-products/${SHIRT_ID}/images/flat/white`, { headers: { "x-forever-tee-service-secret": env.FOREVER_TEE_API_SHARED_SECRET ?? "" } }), env, { waitUntil: () => undefined }).then(value => { settled = true; return value; });
            await new Promise(resolve => setTimeout(resolve, 75));
            expect(settled).toBe(false);
            if (outcome === "ready")
                await env.DB.prepare("UPDATE product_image_jobs SET status='ready',sha256=?,byte_size=? WHERE id=?").bind(sha256, body.length, job.id).run();
            else
                await env.DB.prepare("UPDATE products SET status='deleted' WHERE id=?").bind(SHIRT_ID).run();
            const result = await response;
            expect(result?.status).toBe(outcome === "ready" ? 200 : 404);
            if (outcome === "ready" && result)
                expect(new Uint8Array(await result.arrayBuffer())).toEqual(body);
        }
        finally {
            vi.unstubAllGlobals();
        }
    });
    it("bounds database readiness reads while an image is still rendering", async () => {
        const env: ProductImageEnv = { ...lambdaEnv(), STORY_VIDEO_ENVIRONMENT: "development", PRODUCT_IMAGE_PROVIDER: "vercel", PRODUCT_IMAGE_RENDERER_BYPASS_SECRET: "test-bypass", FOREVER_TEE_API_SHARED_SECRET: "pending-image-reads" };
        vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(null, { status: 404 }))));
        try {
            await ensureProductImages(env, SHIRT_ID);
            await env.DB.prepare("UPDATE product_image_jobs SET status='rendering'").run();
            const outputs = await env.DB.prepare("SELECT storage_key FROM product_image_jobs").all<{
                storage_key: string;
            }>();
            for (const output of outputs.results)
                await env.DESIGN_ARTWORK.delete(output.storage_key);
            const db = env.DB;
            const reads = vi.fn((sql: string) => db.prepare(sql));
            const counted = withDatabasePrepare(db, reads);
            const response = await productImageResponse(new Request(`https://api.test/v2/internal/configured-products/${SHIRT_ID}/images/flat/white`, { headers: { "x-forever-tee-service-secret": env.FOREVER_TEE_API_SHARED_SECRET ?? "" } }), { ...env, DB: counted }, { waitUntil: () => undefined });
            expect(response?.status).toBe(202);
            expect(reads.mock.calls.filter(([sql]) => sql.includes("FROM product_image_jobs jobs"))).toHaveLength(2);
        }
        finally {
            vi.unstubAllGlobals();
        }
    });
    it.each([64, 65])("accepts the measured Preview capacity and rejects excess configuration: %s", async (capacity) => {
        const env: ProductImageEnv = { ...lambdaEnv(), STORY_VIDEO_ENVIRONMENT: "development", PRODUCT_IMAGE_PROVIDER: "vercel", PRODUCT_IMAGE_MAX_INFLIGHT: String(capacity), PRODUCT_IMAGE_RENDERER_BYPASS_SECRET: "test-bypass", FOREVER_TEE_API_SHARED_SECRET: `capacity-${String(capacity)}` };
        let renders = 0;
        vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
            if (!(input instanceof Request))
                return Promise.resolve(Response.json({ rendererVersion: "product-images-v5" }));
            renders++;
            return Promise.resolve(new Response(null, { status: 503 }));
        }));
        try {
            await ensureProductImages(env, [SHIRT_ID, TOTE_ID]);
            expect(renders).toBe(capacity === 64 ? 6 : 0);
            expect((await env.DB.prepare("SELECT count(*) AS n FROM product_image_jobs WHERE status='rendering'").first<{
                n: number;
            }>())?.n).toBe(capacity === 64 ? 6 : 0);
        }
        finally {
            vi.unstubAllGlobals();
        }
    });
    it("isolates Vercel admission from a full video lane and preserves the still ceiling", async () => {
        const env: ProductImageEnv = { ...lambdaEnv(), STORY_VIDEO_ENVIRONMENT: "development", STORY_VIDEO_MAX_INFLIGHT: "1", PRODUCT_IMAGE_PROVIDER: "vercel", PRODUCT_IMAGE_MAX_INFLIGHT: "4", PRODUCT_IMAGE_RENDERER_BYPASS_SECRET: "test-bypass", FOREVER_TEE_API_SHARED_SECRET: "isolation-secret" };
        await ensureStoryVideoJobs(env, [SHIRT_ID, TOTE_ID]);
        await env.DB.prepare("UPDATE story_video_jobs SET status='rendering' WHERE id=(SELECT id FROM story_video_jobs LIMIT 1)").run();
        const gate = deferred();
        let renders = 0;
        vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
            if (!(input instanceof Request))
                return Response.json({ rendererVersion: "product-images-v5" });
            expect(input.url).toBe(`${protectedConfig("previewRendererOrigin")}/api/internal/product-image-render`);
            renders++;
            await gate.promise;
            return new Response(null, { status: 503 });
        }));
        try {
            const work = ensureProductImages(env, [SHIRT_ID, TOTE_ID]);
            await vi.waitFor(() => { expect(renders).toBe(4); });
            gate.resolve();
            await work;
            expect(await env.DB.prepare("SELECT count(*) AS n FROM product_image_jobs WHERE status='rendering'").first()).toEqual({ n: 4 });
            expect(await env.DB.prepare("SELECT count(*) AS n FROM product_image_jobs WHERE status='queued'").first()).toEqual({ n: 2 });
            await ensureProductImages(env, [SHIRT_ID, TOTE_ID]);
            expect(renders).toBe(4);
            await env.DB.prepare("UPDATE story_video_jobs SET status='queued'").run();
            vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(null, { status: 202 }))));
            await renderStoryVideoRevisionBatch({ ...lambdaEnv(), STORY_VIDEO_MAX_INFLIGHT: "1" }, REVISION_ID);
            expect(await env.DB.prepare("SELECT count(*) AS n FROM story_video_jobs WHERE status='rendering'").first()).toEqual({ n: 1 });
        }
        finally {
            gate.resolve();
            vi.unstubAllGlobals();
        }
    });
    it("retains the release pause for the Vercel lane", async () => {
        const env: ProductImageEnv = { ...lambdaEnv(), STORY_VIDEO_ENVIRONMENT: "development", PRODUCT_IMAGE_PROVIDER: "vercel", PRODUCT_IMAGE_RENDERER_BYPASS_SECRET: "test-bypass", FOREVER_TEE_API_SHARED_SECRET: "paused-secret" };
        await env.DB.prepare("CREATE TABLE native_video_release_control (singleton INTEGER,paused INTEGER)").run();
        await env.DB.prepare("INSERT INTO native_video_release_control VALUES (1,1)").run();
        const sql = await readFile(new URL("../sql/native-image-release-controls.sql", import.meta.url), "utf8");
        for (const statement of sql.split("--> statement-breakpoint"))
            await env.DB.prepare(statement).run();
        let posts = 0;
        vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => { if (input instanceof Request)
            posts++; return Promise.resolve(Response.json({ rendererVersion: "product-images-v5" })); }));
        try {
            await ensureProductImages(env, [SHIRT_ID, TOTE_ID]);
            expect(posts).toBe(0);
            expect(await env.DB.prepare("SELECT sum(attempt_count) AS attempts FROM product_image_jobs").first()).toEqual({ attempts: 0 });
        }
        finally {
            vi.unstubAllGlobals();
            await env.DB.prepare("DROP TRIGGER product_image_pause_insert").run();
            await env.DB.prepare("DROP TRIGGER product_image_pause_update").run();
            await env.DB.prepare("DROP TABLE native_video_release_control").run();
        }
    });
    it("does not spend attempts before the Vercel renderer is deployed", async () => {
        const env: ProductImageEnv = { ...lambdaEnv(), STORY_VIDEO_ENVIRONMENT: "development", PRODUCT_IMAGE_PROVIDER: "vercel", PRODUCT_IMAGE_RENDERER_BYPASS_SECRET: "test-bypass", FOREVER_TEE_API_SHARED_SECRET: "not-deployed-secret" };
        vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(null, { status: 404 }))));
        try {
            await ensureProductImages(env, [SHIRT_ID, TOTE_ID]);
            expect(await env.DB.prepare("SELECT sum(attempt_count) AS attempts FROM product_image_jobs").first()).toEqual({ attempts: 0 });
        }
        finally {
            vi.unstubAllGlobals();
        }
    });
    it("acknowledges obsolete image versions without retrying them in the new provider lane", async () => {
        const env: ProductImageEnv = { ...lambdaEnv(), STORY_VIDEO_ENVIRONMENT: "development", PRODUCT_IMAGE_PROVIDER: "vercel", PRODUCT_IMAGE_RENDERER_BYPASS_SECRET: "test-bypass", FOREVER_TEE_API_SHARED_SECRET: "old-queue-secret" };
        vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(null, { status: 404 }))));
        try {
            await ensureProductImages(env, [SHIRT_ID, TOTE_ID]);
            await env.DB.prepare("UPDATE product_image_jobs SET renderer_version='product-images-v4'").run();
            const ack = vi.fn(), retry = vi.fn();
            await consumeProductImageMessage({ id: "old-image-message", timestamp: new Date(), attempts: 1, body: { designRevisionId: REVISION_ID, productImages: true }, ack, retry }, env);
            expect(ack).toHaveBeenCalledOnce();
            expect(retry).not.toHaveBeenCalled();
            await reconcileProductImages(env);
            expect(await env.DB.prepare("SELECT sum(attempt_count) AS attempts FROM product_image_jobs").first()).toEqual({ attempts: 0 });
        }
        finally {
            vi.unstubAllGlobals();
        }
    });
    it.each(["json", "source"])("publishes Vercel images through the fenced %s claim and releases only acknowledged jobs", async (transfer) => {
        const env: ProductImageEnv = { ...lambdaEnv(), STORY_VIDEO_ENVIRONMENT: "development", PRODUCT_IMAGE_PROVIDER: "vercel", PRODUCT_IMAGE_RENDERER_BYPASS_SECRET: "test-bypass", FOREVER_TEE_API_SHARED_SECRET: "callback-secret" };
        const bytes = new TextEncoder().encode("RIFF0000WEBPtest"), digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), v => v.toString(16).padStart(2, "0")).join("");
        let completed = 0;
        vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
            if (!(input instanceof Request))
                return Response.json({ rendererVersion: "product-images-v5" });
            const value: unknown = await input.json();
            if (typeof value !== "object" || value === null || !("jobId" in value) || typeof value.jobId !== "string" || !("grant" in value) || typeof value.grant !== "string")
                throw new Error("Invalid job");
            const endpoint = `https://api.test/v2/internal/product-image-jobs/${value.jobId}`, executionId = crypto.randomUUID(), headers = { authorization: `Bearer ${value.grant}`, "x-image-execution-id": executionId };
            const claim = await productImageTransfer(new Request(endpoint + "/claim", { method: "POST", headers: { ...headers, ...(transfer === "source" ? { accept: "application/vnd.bent.product-image-source" } : {}) } }), env);
            expect(claim?.status).toBe(201);
            const recipe: unknown = transfer === "source" ? JSON.parse(claim?.headers.get("x-image-recipe") ?? "null") : await claim?.json();
            expect(recipe).toMatchObject({ settings: { cropX: .47 } });
            if (transfer === "source") {
                expect(claim?.headers.get("x-image-source-sha256")).toMatch(/^[a-f0-9]{64}$/);
                if (!claim)
                    throw new Error("Missing source claim");
                expect(new Uint8Array(await claim.arrayBuffer())).toEqual(ARTWORK);
            }
            const duplicate = await productImageTransfer(new Request(endpoint + "/claim", { method: "POST", headers: { ...headers, "x-image-execution-id": crypto.randomUUID() } }), env);
            expect(duplicate?.status).toBe(204);
            const source = await productImageTransfer(new Request(endpoint + "/artwork", { headers }), env);
            expect(source?.headers.get("x-image-source-sha256")).toMatch(/^[a-f0-9]{64}$/);
            const uploaded = await productImageTransfer(new Request(endpoint + "/image", { method: "PUT", headers: { ...headers, "content-type": "image/webp", "content-length": String(bytes.length), "x-image-sha256": digest }, body: bytes }), env);
            expect(uploaded?.status).toBe(200);
            completed++;
            const ack: unknown = await uploaded?.json();
            if (typeof ack !== "object" || ack === null)
                throw new Error("Invalid ack");
            return Response.json({ ...ack, jobId: value.jobId, executionId });
        }));
        try {
            await ensureProductImages(env, [SHIRT_ID, TOTE_ID]);
            expect(completed).toBe(6);
            expect(await env.DB.prepare("SELECT count(*) AS n FROM product_image_jobs WHERE status='ready' AND execution_id IS NULL").first()).toEqual({ n: 6 });
            const noResizer: ImagesBinding = {
                text() { throw new Error("V5 display must not render text on first read"); },
                input() { throw new Error("V5 display must not resize on first read"); },
                info() { throw new Error("V5 display must not inspect on first read"); },
                get hosted(): never { throw new Error("V5 display must use central R2"); },
            };
            for (const color of ["white", "black"])
                for (const view of ["flat", "lifestyle"]) {
                    const response = await productImageResponse(new Request(`https://api.test/v2/internal/configured-products/${SHIRT_ID}/images/${view}/${color}?width=384`, { headers: { "x-forever-tee-service-secret": "callback-secret" } }), { ...env, IMAGES: noResizer });
                    expect(response?.status).toBe(200);
                    expect(new Uint8Array(await response?.arrayBuffer() ?? new ArrayBuffer(0))).toEqual(bytes);
                    expect(response?.headers.get("server-timing")).not.toContain("image-resize");
                }
        }
        finally {
            vi.unstubAllGlobals();
        }
    });
    it("never enqueues or renders videos for a non-recursive product family", async () => {
        const env = lambdaEnv();
        await env.DB.prepare("UPDATE products SET placement_depth = 0 WHERE id IN (?, ?)").bind(SHIRT_ID, TOTE_ID).run();
        await ensureStoryVideoJobs(env, [SHIRT_ID, TOTE_ID]);
        expect((await env.DB.prepare("SELECT id FROM story_video_jobs").all()).results).toHaveLength(0);
        await reconcileStoryVideoJobs(env);
        const events = await storyVideoEvents(new Request("https://api.invalid/events"), env.DB, SHIRT_ID);
        expect(events.status).toBe(404);
    });
    it("dispatches all six stills concurrently, deduplicates retries, and shares admission with videos", async () => {
        const env = lambdaEnv();
        await env.DB.prepare("CREATE TABLE native_video_release_control (singleton INTEGER,paused INTEGER)").run();
        await env.DB.prepare("INSERT INTO native_video_release_control VALUES (1,0)").run();
        const gate = deferred();
        let calls = 0;
        const send = vi.fn(async () => { calls++; await gate.promise; return new Response(null, { status: 202 }); });
        vi.stubGlobal("fetch", send);
        try {
            const work = ensureProductImages(env, [SHIRT_ID, TOTE_ID]);
            await vi.waitFor(() => { expect(calls).toBe(6); });
            gate.resolve();
            await work;
            await ensureProductImages(env, [SHIRT_ID, TOTE_ID]);
            expect(send).toHaveBeenCalledTimes(6);
            await ensureStoryVideoJobs(env, [SHIRT_ID, TOTE_ID]);
            await renderStoryVideoRevisionBatch(env, REVISION_ID);
            const images = await env.DB.prepare("SELECT count(*) AS n FROM product_image_jobs WHERE status='rendering'").first<{
                n: number;
            }>();
            const videos = await env.DB.prepare("SELECT count(*) AS n FROM story_video_jobs WHERE status='rendering'").first<{
                n: number;
            }>();
            expect(images?.n).toBe(6);
            expect(videos?.n).toBe(2);
        }
        finally {
            gate.resolve();
            vi.unstubAllGlobals();
            await env.DB.prepare("DROP TABLE native_video_release_control").run();
        }
    });
    it.each(["confirmed", "lost", "wrong-execution", "wrong-digest", "function-error"])("releases completed image slots only with confirmed Lambda evidence: %s", async (outcome) => {
        const env = { ...lambdaEnv(), STORY_VIDEO_MAX_INFLIGHT: "4" };
        await env.DB.prepare("CREATE TABLE native_video_release_control (singleton INTEGER,paused INTEGER)").run();
        await env.DB.prepare("INSERT INTO native_video_release_control VALUES (1,0)").run();
        const completed = deferred(), published = deferred();
        let calls = 0, writes = 0;
        const bytes = new TextEncoder().encode("RIFF0000WEBPtest");
        const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), v => v.toString(16).padStart(2, "0")).join("");
        vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
            if (!(input instanceof Request))
                throw Error("Expected signed Lambda request");
            const job: unknown = await input.json();
            if (typeof job !== "object" || job === null || !("jobId" in job) || typeof job.jobId !== "string" || !("grant" in job) || typeof job.grant !== "string" || !("storageKey" in job) || typeof job.storageKey !== "string")
                throw Error("Invalid fixture job");
            calls++;
            const executionId = crypto.randomUUID();
            const headers = { authorization: "Bearer " + job.grant, "x-image-execution-id": executionId };
            const endpoint = "https://api.test/v2/internal/product-image-jobs/" + job.jobId;
            expect((await productImageTransfer(new Request(endpoint + "/claim", { method: "POST", headers }), env))?.status).toBe(201);
            expect((await productImageTransfer(new Request(endpoint + "/image", { method: "PUT", headers: { ...headers, "content-type": "image/webp", "content-length": String(bytes.length), "x-image-sha256": digest }, body: bytes }), env))?.status).toBe(200);
            if (++writes === 4)
                published.resolve();
            await completed.promise;
            if (outcome === "lost")
                throw Error("Lost completion response");
            return Response.json({ jobId: job.jobId, executionId: outcome === "wrong-execution" ? crypto.randomUUID() : executionId,
                key: job.storageKey, size: bytes.length, sha256: outcome === "wrong-digest" ? "f".repeat(64) : digest }, outcome === "function-error" ? { headers: { "x-amz-function-error": "Unhandled" } } : undefined);
        }));
        const first = ensureProductImages(env, SHIRT_ID);
        try {
            await published.promise;
            expect(await env.DB.prepare("SELECT count(*) AS n FROM product_image_jobs WHERE status='ready' AND execution_id IS NOT NULL").first()).toEqual({ n: 4 });
            await ensureProductImages(env, TOTE_ID);
            expect(calls).toBe(4);
            completed.resolve();
            await first;
            await ensureProductImages(env, TOTE_ID);
            expect(calls).toBe(outcome === "confirmed" ? 6 : 4);
            expect(await env.DB.prepare("SELECT count(*) AS n FROM product_image_jobs WHERE execution_id IS NOT NULL").first()).toEqual({ n: outcome === "confirmed" ? 0 : 4 });
        }
        finally {
            completed.resolve();
            await first;
            vi.unstubAllGlobals();
            await env.DB.prepare("DROP TABLE native_video_release_control").run();
        }
    });
    it("fences image uploads, verifies the digest, serves R2, and revokes access immediately", async () => {
        const env = { ...lambdaEnv(), FOREVER_TEE_API_SHARED_SECRET: "test-image-service" };
        await env.DB.prepare("CREATE TABLE native_video_release_control (singleton INTEGER,paused INTEGER)").run();
        await env.DB.prepare("INSERT INTO native_video_release_control VALUES (1,0)").run();
        vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(null, { status: 202 }))));
        try {
            await ensureProductImages(env, SHIRT_ID);
            const job = await env.DB.prepare("SELECT id FROM product_image_jobs WHERE colour='White' AND view='lifestyle'").first<{
                id: string;
            }>();
            if (!job)
                throw new Error("Missing image fixture.");
            const grant = await createStoryVideoGrant(env.STORY_VIDEO_GRANT_SECRET, job.id, 1);
            const endpoint = `https://api.test/v2/internal/product-image-jobs/${job.id}`;
            const headers = { authorization: `Bearer ${grant}`, "x-image-execution-id": crypto.randomUUID() };
            expect((await productImageTransfer(new Request(`${endpoint}/artwork`, { headers }), env))?.status).toBe(409);
            expect((await productImageTransfer(new Request(`${endpoint}/claim`, { method: "POST", headers }), env))?.status).toBe(201);
            expect((await productImageTransfer(new Request(`${endpoint}/claim`, { method: "POST", headers: { ...headers, "x-image-execution-id": crypto.randomUUID() } }), env))?.status).toBe(204);
            const bytes = new TextEncoder().encode("RIFF0000WEBPtest");
            const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), v => v.toString(16).padStart(2, "0")).join("");
            const upload = () => productImageTransfer(new Request(`${endpoint}/image`, { method: "PUT", body: bytes, headers: { ...headers, "content-type": "image/webp", "content-length": String(bytes.length), "x-image-sha256": digest } }), env);
            expect((await upload())?.status).toBe(200);
            expect((await upload())?.status).toBe(200);
            const read = () => productImageResponse(new Request(`https://api.test/v2/internal/configured-products/${SHIRT_ID}/images/lifestyle/white`, { headers: { "x-forever-tee-service-secret": env.FOREVER_TEE_API_SHARED_SECRET } }), env);
            const response = await read();
            expect(response?.status).toBe(200);
            expect(await response?.arrayBuffer()).toEqual(bytes.buffer);
            await env.DB.prepare("UPDATE products SET status='suspended' WHERE id=?").bind(SHIRT_ID).run();
            expect((await read())?.status).toBe(404);
            expect((await upload())?.status).toBe(409);
        }
        finally {
            vi.unstubAllGlobals();
            await env.DB.prepare("DROP TABLE native_video_release_control").run();
        }
    });
    it("a pending image read resumes queued work without waiting for queue delivery", async () => {
        const env = { ...lambdaEnv(), FOREVER_TEE_API_SHARED_SECRET: "test-image-service" };
        await env.DB.prepare("UPDATE products SET placement_depth=0 WHERE id=?").bind(SHIRT_ID).run();
        await env.DB.prepare("CREATE TABLE native_video_release_control (singleton INTEGER,paused INTEGER)").run();
        await env.DB.prepare("INSERT INTO native_video_release_control VALUES (1,1)").run();
        const gate = await readFile(new URL("../sql/native-image-release-controls.sql", import.meta.url), "utf8");
        for (const sql of gate.split("--> statement-breakpoint").map(value => value.trim()).filter(Boolean))
            await env.DB.prepare(sql).run();
        const send = vi.fn(() => Promise.resolve(new Response(null, { status: 202 })));
        vi.stubGlobal("fetch", send);
        try {
            await ensureProductImages(env, SHIRT_ID);
            expect(send).not.toHaveBeenCalled();
            await env.DB.prepare("UPDATE native_video_release_control SET paused=0").run();
            const work: Promise<unknown>[] = [];
            const request = () => new Request(`https://api.test/v2/internal/configured-products/${SHIRT_ID}/images/flat/white`, { headers: { "x-forever-tee-service-secret": env.FOREVER_TEE_API_SHARED_SECRET } });
            expect((await productImageResponse(request(), env, { waitUntil: promise => { work.push(promise); } }))?.status).toBe(202);
            await Promise.all(work);
            expect(send).toHaveBeenCalledTimes(4);
            work.length = 0;
            await productImageResponse(request(), env, { waitUntil: promise => { work.push(promise); } });
            await Promise.all(work);
            expect(send).toHaveBeenCalledTimes(4);
        }
        finally {
            vi.unstubAllGlobals();
            await env.DB.prepare("DROP TRIGGER product_image_pause_insert").run();
            await env.DB.prepare("DROP TRIGGER product_image_pause_update").run();
            await env.DB.prepare("DROP TABLE native_video_release_control").run();
        }
    });
    it("holds old and new dispatch claims without losing queued work or interrupting an existing execution", async () => {
        const env = lambdaEnv();
        await ensureStoryVideoJobs(env, [SHIRT_ID, TOTE_ID]);
        const initial = await env.DB.prepare("SELECT id FROM story_video_jobs ORDER BY id").all<{
            id: string;
        }>();
        const active = initial.results[0];
        if (!active)
            throw new Error("Expected fixture jobs.");
        // One old invocation won the claim immediately before the pause.
        await env.DB.prepare("UPDATE story_video_jobs SET status = 'rendering', attempt_count = 1 WHERE id = ?").bind(active.id).run();
        const gate = await readFile(new URL("../sql/native-release-controls.sql", import.meta.url), "utf8");
        const statements = gate.split("--> statement-breakpoint").map(sql => env.DB.prepare(sql));
        await env.DB.batch(statements);
        try {
            // Exercise the precise pre-0018 claim query, not just the new dispatcher.
            const legacy = await env.DB.prepare(`UPDATE story_video_jobs SET status = 'rendering',
        attempt_count = attempt_count + 1, last_error = NULL, updated_at = ?
        WHERE status IN ('queued', 'failed') AND attempt_count = 0`).bind(Date.now()).run();
            expect(legacy.meta.changes).toBe(0);
            const invoke = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("No dispatch while paused."));
            vi.stubGlobal("fetch", invoke);
            await renderStoryVideoRevisionBatch(env, REVISION_ID);
            expect(invoke).not.toHaveBeenCalled();
            const jobs = await env.DB.prepare("SELECT status, attempt_count FROM story_video_jobs WHERE id != ?")
                .bind(active.id).all<{
                status: string;
                attempt_count: number;
            }>();
            expect(jobs.results).toEqual(Array.from({ length: 3 }, () => ({ status: "queued", attempt_count: 0 })));
            const completed = await env.DB.prepare("UPDATE story_video_jobs SET status = 'ready' WHERE id = ?").bind(active.id).run();
            expect(completed.meta.changes).toBe(1);
            // Installing the controls again must not clear an existing pause/owner.
            await env.DB.prepare("UPDATE native_video_release_control SET release_id = 'fixture-owner' WHERE singleton = 1").run();
            await env.DB.batch(statements);
            expect(await env.DB.prepare("SELECT paused, release_id FROM native_video_release_control").first())
                .toEqual({ paused: 1, release_id: "fixture-owner" });
            const statusEnv = { ...env, BENT_SHIRT_OPERATIONS_SECRET: "test-operations", STORY_VIDEO_RELEASE_ID: "native-123",
                STORY_VIDEO_RELEASE_COMMIT: "a".repeat(40), STORY_VIDEO_SOURCE_DIGEST: "b".repeat(64), STORY_VIDEO_IMAGE_DIGEST: `sha256:${"c".repeat(64)}` };
            const url = "https://api.invalid/v2/internal/operations/native-video-release";
            expect((await handleNativeVideoStatus(new Request(url), statusEnv))?.status).toBe(401);
            const headers = { "x-bent-shirt-operations-secret": "test-operations" };
            expect((await handleNativeVideoStatus(new Request(url, { method: "POST", headers }), statusEnv))?.status).toBe(405);
            const status = await handleNativeVideoStatus(new Request(url, { headers }), statusEnv);
            expect(status?.status).toBe(200);
            expect(await status?.json()).toMatchObject({ paused: true, pauseOwner: "fixture-owner", executionProtocol: "claim-v1", releaseId: "native-123" });
            expect((await handleNativeVideoStatus(new Request(url, { headers }), { ...statusEnv, STORY_VIDEO_IMAGE_DIGEST: "mutable:latest" }))?.status).toBe(503);
            await env.DB.prepare("UPDATE native_video_release_control SET paused = 0 WHERE singleton = 1 AND release_id = 'fixture-owner'").run();
            const resumed = await env.DB.prepare(`UPDATE story_video_jobs SET status = 'rendering', attempt_count = attempt_count + 1
        WHERE status = 'queued' AND attempt_count = 0`).run();
            expect(resumed.meta.changes).toBe(3);
        }
        finally {
            // Test-only ephemeral database. No release code deletes controls.
            await env.DB.prepare("DROP TRIGGER native_video_pause_attempt_update").run();
            await env.DB.prepare("DROP TRIGGER native_video_pause_attempt_insert").run();
            await env.DB.prepare("DROP TABLE native_video_release_control").run();
            vi.unstubAllGlobals();
        }
    });
    it.each([false, true])("dispatches immutable two-source jobs with independent placement=%s and fences artwork transfer", async (independentPlacement) => {
        const env = lambdaEnv();
        const productId = crypto.randomUUID(), outerId = crypto.randomUUID(), innerId = crypto.randomUUID();
        const nested = new Uint8Array([...ARTWORK, 99]);
        const nestedHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", nested)), byte => byte.toString(16).padStart(2, "0")).join("");
        const nestedKey = `designs/${DESIGN_ID}/artwork/${nestedHash}`;
        await env.DESIGN_ARTWORK.put(nestedKey, nested);
        await env.DB.prepare(`INSERT INTO design_revisions
      (id, design_id, fingerprint, artwork_key, content_type, byte_size, sha256,
       crop_x, crop_y, crop_zoom, placement_x, placement_y, placement_width, depth, created_at, artwork_width, artwork_height)
      SELECT ?, design_id, ?, artwork_key, content_type, byte_size, sha256,
        crop_x, crop_y, crop_zoom, placement_x, placement_y, placement_width, depth, created_at, artwork_width, artwork_height
      FROM design_revisions WHERE id = ?`).bind(outerId, `outer:${outerId}`, REVISION_ID).run();
        await env.DB.prepare(`INSERT INTO design_revisions
      (id, design_id, fingerprint, artwork_key, content_type, byte_size, sha256,
       crop_x, crop_y, crop_zoom, placement_x, placement_y, placement_width, depth, created_at, artwork_width, artwork_height)
      SELECT ?, design_id, ?, ?, content_type, ?, ?, 0.5, 0.4, 1.2,
        placement_x, placement_y, placement_width, depth, created_at, artwork_width, artwork_height
      FROM design_revisions WHERE id = ?`).bind(innerId, `inner:${innerId}`, nestedKey, nested.length, nestedHash, REVISION_ID).run();
        if (independentPlacement)
            await env.DB.prepare(`UPDATE design_revisions
      SET video_placement_x=0.267994,video_placement_y=0.48,video_placement_width=0.455717 WHERE id=?`).bind(innerId).run();
        await env.DB.prepare(`INSERT INTO products (id,base_product_id,design_id,design_revision_id,
      shopify_handle,placement_x,placement_y,placement_width,placement_depth,projection_version,status,created_at,print_mode,video_recursive_revision_id)
      VALUES (?,?,?,?,'bent-shirt',0.3,0.3,0.42,5,'safe-margin-v1','active',?,'base-image-only',?)`)
            .bind(productId, SHIRT_BASE_ID, DESIGN_ID, outerId, Date.now(), innerId).run();
        const deliveries: unknown[] = [];
        vi.stubGlobal("fetch", async (request: Request) => {
            const payload: unknown = await request.json();
            deliveries.push(payload);
            return new Response(null, { status: 202 });
        });
        try {
            await ensureStoryVideoJobs(env, productId);
            await renderStoryVideoRevisionBatch(env, outerId);
            expect(deliveries).toHaveLength(2);
            expect(deliveries[0]).toMatchObject({ schemaVersion: independentPlacement ? 3 : 2,
                artwork: { size: ARTWORK.length },
                recursiveSource: { sha256: nestedHash, size: nested.length, cropX: 0.5, cropY: 0.4, cropZoom: 1.2,
                    ...(independentPlacement ? { placement: { placementX: 0.267994, placementY: 0.48, placementWidth: 0.455717 } } : {}) } });
            const job = await env.DB.prepare("SELECT id,attempt_count,story_key FROM story_video_jobs WHERE product_id=? LIMIT 1")
                .bind(productId).first<{
                id: string;
                attempt_count: number;
                story_key: string;
            }>();
            if (!job)
                throw new Error("Missing composed job");
            const grant = await createStoryVideoGrant(env.STORY_VIDEO_GRANT_SECRET, job.id, job.attempt_count);
            const endpoint = `https://api.test/v2/internal/story-video-jobs/${job.id}`;
            const headers = { authorization: `Bearer ${grant}`, "x-video-execution-id": crypto.randomUUID() };
            expect((await handleStoryVideoTransfer(new Request(`${endpoint}/recursive-artwork`, { headers }), env))?.status).toBe(409);
            expect((await handleStoryVideoTransfer(new Request(`${endpoint}/claim`, { method: "POST", headers }), env))?.status).toBe(201);
            const original = await handleStoryVideoTransfer(new Request(`${endpoint}/artwork`, { headers }), env);
            if (!original)
                throw new Error("Missing outer artwork response");
            expect(new Uint8Array(await original.arrayBuffer())).toEqual(ARTWORK);
            const recursive = await handleStoryVideoTransfer(new Request(`${endpoint}/recursive-artwork`, { headers }), env);
            if (!recursive)
                throw new Error("Missing recursive artwork response");
            expect(new Uint8Array(await recursive.arrayBuffer())).toEqual(nested);
            expect((await handleStoryVideoTransfer(new Request(`${endpoint}/recursive-artwork`, {
                headers: { ...headers, "x-video-execution-id": crypto.randomUUID() },
            }), env))?.status).toBe(409);
            const videoHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", ARTWORK)), byte => byte.toString(16).padStart(2, "0")).join("");
            const upload = () => handleStoryVideoTransfer(new Request(`${endpoint}/video`, { method: "PUT", body: ARTWORK,
                headers: { ...headers, "content-type": "video/mp4", "content-length": String(ARTWORK.length), "x-video-sha256": videoHash } }), env);
            expect((await upload())?.status).toBe(200);
            expect((await env.STORY_VIDEOS.head(job.story_key))?.customMetadata).toMatchObject({
                recursiveSourceSha256: nestedHash, compositionVersion: independentPlacement ? "two-source-v2" : "two-source-v1",
            });
            expect((await upload())?.status).toBe(200);
            await expect(env.DB.prepare("UPDATE products SET print_mode='recursive' WHERE id=?").bind(productId).run()).rejects.toThrow(/immutable/);
            await expect(env.DB.prepare("UPDATE design_revisions SET crop_x=0.1 WHERE id=?").bind(innerId).run()).rejects.toThrow(/immutable/);
        }
        finally {
            vi.unstubAllGlobals();
        }
    });
    function lambdaEnv() {
        const bindings = testPlatform().env;
        if (!bindings.STORY_VIDEOS)
            throw new Error("Test video storage missing.");
        return { DB: bindings.DB, DESIGN_ARTWORK: bindings.DESIGN_ARTWORK, STORY_VIDEOS: bindings.STORY_VIDEOS,
            STORY_VIDEO_PROVIDER: "lambda", STORY_VIDEO_LAMBDA_FUNCTION: LAMBDA_STORY_FUNCTION,
            STORY_VIDEO_GRANT_SECRET: "test-only-grant-".repeat(4), STORY_VIDEO_LAMBDA_ACCESS_KEY_ID: "test-only",
            STORY_VIDEO_LAMBDA_SECRET_ACCESS_KEY: "test-only", STORY_VIDEO_JOBS: { send: () => Promise.resolve(undefined) },
            STORY_VIDEO_RENDERER: { fetch: () => Promise.reject(new Error("Cloudflare rendering must not run.")) } };
    }
    async function withQualificationFixture(run: (env: ReturnType<typeof lambdaEnv> & {
        STORY_VIDEO_ENVIRONMENT: string;
    }, key: string) => Promise<void>) {
        const env = { ...lambdaEnv(), STORY_VIDEO_ENVIRONMENT: "development" };
        const revision = await env.DB.prepare("SELECT artwork_key FROM design_revisions WHERE id = ?").bind(REVISION_ID).first<{
            artwork_key: string;
        }>();
        if (!revision)
            throw new Error("Missing qualification fixture revision");
        const key = revision.artwork_key;
        await env.DB.prepare("CREATE TABLE native_video_release_control (singleton INTEGER, paused INTEGER, current_release_id TEXT)").run();
        await env.DB.prepare("INSERT INTO native_video_release_control VALUES (1, 0, 'native-123')").run();
        const schema = await readFile(new URL("../sql/native-qualification.sql", import.meta.url), "utf8");
        for (const sql of schema.split(";").map(part => part.trim()).filter(Boolean))
            await env.DB.prepare(sql).run();
        try {
            await run(env, key);
        }
        finally {
            await env.DB.prepare("DROP TABLE native_video_qualification_observations").run();
            await env.DB.prepare("DROP TABLE native_video_qualification_faults").run();
            await env.DB.prepare("DROP TABLE native_video_release_control").run();
            vi.unstubAllGlobals();
        }
    }
    async function planFault(db: D1Database, point: string) {
        const now = Date.now();
        await db.prepare(`INSERT INTO native_video_qualification_faults
      (design_id, release_id, run_id, point, created_at, expires_at) VALUES (?, 'native-123', '456', ?, ?, ?)`)
            .bind(DESIGN_ID, point, now, now + 600000).run();
    }
    it("confines cloud faults to one use on an active release's unexpired Development fixture", async () => {
        await withQualificationFixture(async (env, key) => {
            await ensureStoryVideoJobs(env, SHIRT_ID);
            await planFault(env.DB, "invoke-ack");
            const job = await env.DB.prepare("SELECT id FROM story_video_jobs LIMIT 1").first<{
                id: string;
            }>();
            if (!job)
                throw new Error("Missing test job");
            for (const other of [{ ...env, STORY_VIDEO_ENVIRONMENT: "production" }, { ...env, STORY_VIDEO_ENVIRONMENT: "" },
                { ...env, STORY_VIDEO_LAMBDA_FUNCTION: "foreign" }, { ...env, STORY_VIDEO_PROVIDER: "cloudflare" }]) {
                expect(await takeQualificationFault(other, key, job.id, "invoke-ack")).toBe(false);
            }
            expect(await takeQualificationFault(env, `designs/${DESIGN_ID}/artwork/hash`, job.id, "invoke-ack")).toBe(false);
            expect(await takeQualificationFault(env, key, crypto.randomUUID(), "invoke-ack")).toBe(false);
            for (const sql of ["UPDATE native_video_release_control SET paused = 1", "UPDATE native_video_release_control SET paused = 0, current_release_id = 'native-999'"]) {
                await env.DB.prepare(sql).run();
                expect(await takeQualificationFault(env, key, job.id, "invoke-ack")).toBe(false);
            }
            await env.DB.prepare("UPDATE native_video_release_control SET current_release_id = 'native-123'").run();
            await env.DB.prepare("UPDATE native_video_qualification_faults SET created_at = ?, expires_at = ?").bind(Date.now() - 600000, Date.now() - 1).run();
            expect(await takeQualificationFault(env, key, job.id, "invoke-ack")).toBe(false);
            await env.DB.prepare("UPDATE native_video_qualification_faults SET created_at = ?, expires_at = ?").bind(Date.now(), Date.now() + 599000).run();
            const outcomes = await Promise.all([takeQualificationFault(env, key, job.id, "invoke-ack"), takeQualificationFault(env, key, job.id, "invoke-ack")]);
            expect(outcomes.filter(Boolean)).toHaveLength(1);
            expect(await takeQualificationFault(env, key, job.id, "invoke-ack")).toBe(false);
        });
    });
    it("duplicates the exact signed invocation and drops an acknowledgement only after acceptance", async () => {
        await withQualificationFixture(async (env, key) => {
            await ensureStoryVideoJobs(env, SHIRT_ID);
            const job = await env.DB.prepare("SELECT id FROM story_video_jobs LIMIT 1").first<{
                id: string;
            }>();
            if (!job)
                throw new Error("Missing test job");
            await planFault(env.DB, "invoke-duplicate");
            const bodies: string[] = [];
            const send: typeof fetch = async (input) => { if (!(input instanceof Request))
                throw new Error("Expected signed request"); bodies.push(await input.text()); return new Response(null, { status: 202 }); };
            const wrapped = qualificationLambdaSend(env, key, job.id, send);
            expect((await wrapped(new Request("https://lambda.test", { method: "POST", body: "identical-signed-payload" }))).status).toBe(202);
            expect(bodies).toEqual(["identical-signed-payload", "identical-signed-payload"]);
            await planFault(env.DB, "invoke-ack");
            await expect(wrapped(new Request("https://lambda.test", { method: "POST", body: "accepted" }))).rejects.toThrow("successful AWS acknowledgement");
            expect(bodies).toHaveLength(3);
            expect((await wrapped(new Request("https://lambda.test", { method: "POST", body: "no-more-faults" }))).status).toBe(202);
            expect(bodies).toHaveLength(4);
        });
    });
    it("retries a lost claim acknowledgement with the same fence and keeps a lost upload acknowledgement ready", async () => {
        await withQualificationFixture(async (env) => {
            await ensureStoryVideoJobs(env, SHIRT_ID);
            const job = await env.DB.prepare("SELECT id FROM story_video_jobs LIMIT 1").first<{
                id: string;
            }>();
            if (!job)
                throw new Error("Missing test job");
            await env.DB.prepare("UPDATE story_video_jobs SET status = 'rendering', attempt_count = 1 WHERE id = ?").bind(job.id).run();
            await planFault(env.DB, "claim-ack");
            await planFault(env.DB, "upload-ack");
            const grant = await createStoryVideoGrant(env.STORY_VIDEO_GRANT_SECRET, job.id, 1);
            const headers = { authorization: `Bearer ${grant}`, "x-video-execution-id": crypto.randomUUID() };
            const endpoint = `https://api.test/v2/internal/story-video-jobs/${job.id}`;
            const claim = () => handleStoryVideoTransfer(new Request(`${endpoint}/claim`, { method: "POST", headers }), env);
            expect((await claim())?.status).toBe(503);
            expect((await claim())?.status).toBe(201);
            const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", ARTWORK)), b => b.toString(16).padStart(2, "0")).join("");
            const upload = await handleStoryVideoTransfer(new Request(`${endpoint}/video`, { method: "PUT", body: ARTWORK,
                headers: { ...headers, "content-type": "video/mp4", "content-length": String(ARTWORK.length), "x-video-sha256": digest } }), env);
            expect(upload?.status).toBe(503);
            expect((await handleStoryVideoTransfer(new Request(`${endpoint}/failure`, { method: "POST", headers }), env))?.status).toBe(204);
            expect(await env.DB.prepare("SELECT status, attempt_count, execution_id FROM story_video_jobs WHERE id = ?").bind(job.id).first())
                .toEqual({ status: "ready", attempt_count: 1, execution_id: headers["x-video-execution-id"] });
            expect((await env.DB.prepare("SELECT stage, status FROM native_video_qualification_observations ORDER BY observed_at").all()).results)
                .toEqual([{ stage: "claim", status: 201 }, { stage: "claim", status: 201 }, { stage: "upload-committed", status: 200 }]);
        });
    });
    it("leaves failed initial queue sends and stopped direct dispatch for the unchanged backstop", async () => {
        for (const name of ["0021_printify_production_resources.sql", "0023_printify_fulfilment_orders.sql", "0031_order_management.sql"])
            await applyMigration(name);
        await withQualificationFixture(async (env) => {
            await planFault(env.DB, "enqueue-send");
            await planFault(env.DB, "direct-dispatch");
            const send = vi.fn().mockResolvedValue(undefined), tasks: Promise<unknown>[] = [];
            const queued = { ...env, STORY_VIDEO_JOBS: { send } };
            vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Initial dispatch must not invoke AWS")));
            await ensureStoryVideoJobs(queued, [SHIRT_ID, TOTE_ID], { waitUntil: task => { tasks.push(task); } });
            await Promise.all(tasks);
            expect(send).not.toHaveBeenCalled();
            expect((await env.DB.prepare("SELECT status, attempt_count FROM story_video_jobs").all()).results)
                .toEqual(Array.from({ length: 4 }, () => ({ status: "queued", attempt_count: 0 })));
            tasks.length = 0;
            const context: ExecutionContext = {
                waitUntil: task => { tasks.push(task); },
                passThroughOnException: () => { throw new Error("Unexpected scheduled passthrough"); },
                abort: () => { throw new Error("Unexpected scheduled abort"); },
                props: {},
                get exports(): never { throw new Error("Unexpected scheduled exports access"); },
                get tracing(): never { throw new Error("Unexpected scheduled tracing access"); },
            };
            if (!worker.scheduled)
                throw new Error("Scheduled handler unavailable");
            await worker.scheduled({ cron: "* * * * *", scheduledTime: Date.UTC(2026, 8, 5, 1, 44), noRetry: () => undefined }, { ...testPlatform().env, ...queued, SHOPIFY_CLIENT_ID: "test-client", SHOPIFY_CLIENT_SECRET: "test-secret",
                SHOPIFY_ADMIN_STORE_DOMAIN: "test.myshopify.com", PRINTIFY_API_TOKEN: "test-token", PRINTIFY_SHOP_ID: "123",
                PRINTIFY_ASSET_DELIVERY_SECRET: "test-secret" }, context);
            await Promise.all(tasks);
            expect(send).toHaveBeenCalledOnce();
            vi.stubGlobal("fetch", () => Promise.resolve(new Response(null, { status: 202 })));
            await renderStoryVideoRevisionBatch(queued, REVISION_ID);
            expect((await env.DB.prepare("SELECT status, attempt_count FROM story_video_jobs").all()).results)
                .toEqual(Array.from({ length: 4 }, () => ({ status: "rendering", attempt_count: 1 })));
        });
    });
    it("issues a termination header once, only to the claimed Development fixture execution", async () => {
        await withQualificationFixture(async (env) => {
            await ensureStoryVideoJobs(env, SHIRT_ID);
            const job = await env.DB.prepare("SELECT id FROM story_video_jobs LIMIT 1").first<{
                id: string;
            }>();
            if (!job)
                throw new Error("Missing test job");
            const executionId = crypto.randomUUID();
            await env.DB.prepare("UPDATE story_video_jobs SET status = 'rendering', attempt_count = 1, execution_id = ? WHERE id = ?").bind(executionId, job.id).run();
            await planFault(env.DB, "terminate");
            const grant = await createStoryVideoGrant(env.STORY_VIDEO_GRANT_SECRET, job.id, 1);
            const headers = { authorization: `Bearer ${grant}`, "x-video-execution-id": executionId };
            const request = () => new Request(`https://api.test/v2/internal/story-video-jobs/${job.id}/artwork`, { headers });
            const production = await handleStoryVideoTransfer(request(), { ...env, STORY_VIDEO_ENVIRONMENT: "production" });
            expect(production?.headers.has("x-native-qualification-terminate")).toBe(false);
            await production?.body?.cancel();
            const terminated = await handleStoryVideoTransfer(request(), env);
            expect(terminated?.headers.get("x-native-qualification-terminate")).toBe(job.id);
            await terminated?.body?.cancel();
            const duplicate = await handleStoryVideoTransfer(request(), env);
            expect(duplicate?.headers.has("x-native-qualification-terminate")).toBe(false);
            await duplicate?.body?.cancel();
        });
    });
    it("pins Lambda function selection to the explicit deployment environment", () => {
        const env = lambdaEnv();
        const production = "arn:aws:lambda:ap-southeast-2:" + protectedConfig("awsAccountId") + ":function:forever-tee-video-production";
        expect(validateLambdaStoryVideoEnv(env).functionArn).toBe(LAMBDA_STORY_FUNCTION);
        expect(validateLambdaStoryVideoEnv({ ...env, STORY_VIDEO_ENVIRONMENT: "production", STORY_VIDEO_LAMBDA_FUNCTION: production }).functionArn).toBe(production);
        expect(() => validateLambdaStoryVideoEnv({ ...env, STORY_VIDEO_ENVIRONMENT: "production" })).toThrow();
        expect(() => validateLambdaStoryVideoEnv({ ...env, STORY_VIDEO_LAMBDA_FUNCTION: production })).toThrow();
        for (const value of ["work", "toString", "__proto__", "Production", ""]) {
            expect(() => validateLambdaStoryVideoEnv({ ...env, STORY_VIDEO_ENVIRONMENT: value })).toThrow();
        }
    });
    function recoveryMessage() {
        const ack = vi.fn();
        const retry = vi.fn();
        const message = { id: "recovery", timestamp: new Date(), body: { designRevisionId: REVISION_ID }, attempts: 1, ack, retry };
        return { ack, retry, batch: { queue: "test", messages: [message], metadata: { metrics: { backlogCount: 1, backlogBytes: 100 } }, ackAll: vi.fn(), retryAll: vi.fn() } };
    }
    it("rejects admission above the deployed reservation before claiming or invoking", async () => {
        const env = { ...lambdaEnv(), STORY_VIDEO_MAX_INFLIGHT: "9" };
        await ensureStoryVideoJobs(env, [SHIRT_ID, TOTE_ID]);
        const send = vi.fn<typeof fetch>();
        vi.stubGlobal("fetch", send);
        await expect(renderStoryVideoRevisionBatch(env, REVISION_ID)).rejects.toThrow("Invalid video admission capacity.");
        expect(send).not.toHaveBeenCalled();
        expect((await env.DB.prepare("SELECT status, attempt_count FROM story_video_jobs").all()).results)
            .toEqual(Array.from({ length: 4 }, () => ({ status: "queued", attempt_count: 0 })));
    });
    it("leaves excess videos queued without consuming attempts until renderer capacity is available", async () => {
        const env = { ...lambdaEnv(), STORY_VIDEO_MAX_INFLIGHT: "1" };
        await ensureStoryVideoJobs(env, [SHIRT_ID, TOTE_ID]);
        const send = vi.fn(() => Promise.resolve(new Response(null, { status: 202 })));
        vi.stubGlobal("fetch", send);
        await Promise.all([renderStoryVideoRevisionBatch(env, REVISION_ID), renderStoryVideoRevisionBatch(env, REVISION_ID)]);
        expect(send).toHaveBeenCalledTimes(1);
        expect((await env.DB.prepare("SELECT status, attempt_count FROM story_video_jobs WHERE status = 'queued'").all()).results)
            .toEqual(Array.from({ length: 3 }, () => ({ status: "queued", attempt_count: 0 })));
        await env.DB.prepare("UPDATE story_video_jobs SET status = 'ready' WHERE status = 'rendering'").run();
        await renderStoryVideoRevisionBatch(env, REVISION_ID);
        expect(send).toHaveBeenCalledTimes(2);
    });
    it("keeps capacity reserved while a ready upload is still awaiting its acknowledgement", async () => {
        const notificationStarted = deferred(), releaseNotification = deferred();
        const env = { ...lambdaEnv(), STORY_VIDEO_MAX_INFLIGHT: "1", STORY_VIDEO_NOTIFICATION_MODE: "push",
            STORY_VIDEO_NOTIFICATIONS: { getByName: () => ({ fetch: async () => {
                        notificationStarted.resolve();
                        await releaseNotification.promise;
                        return new Response(null, { status: 204 });
                    } }) } };
        await ensureStoryVideoJobs(env, [SHIRT_ID, TOTE_ID]);
        const send = vi.fn(() => Promise.resolve(new Response(null, { status: 202 })));
        vi.stubGlobal("fetch", send);
        await renderStoryVideoRevisionBatch(env, REVISION_ID);
        const job = await env.DB.prepare("SELECT id FROM story_video_jobs WHERE status = 'rendering'").first<{
            id: string;
        }>();
        if (!job)
            throw new Error("Missing admitted job");
        const grant = await createStoryVideoGrant(env.STORY_VIDEO_GRANT_SECRET, job.id, 1);
        const headers = { authorization: `Bearer ${grant}`, "x-video-execution-id": crypto.randomUUID() };
        const endpoint = `https://api.test/v2/internal/story-video-jobs/${job.id}`;
        expect((await handleStoryVideoTransfer(new Request(`${endpoint}/claim`, { method: "POST", headers }), env))?.status).toBe(201);
        const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", ARTWORK)), b => b.toString(16).padStart(2, "0")).join("");
        const upload = handleStoryVideoTransfer(new Request(`${endpoint}/video`, { method: "PUT", body: ARTWORK,
            headers: { ...headers, "content-type": "video/mp4", "content-length": String(ARTWORK.length), "x-video-sha256": digest } }), env);
        try {
            await notificationStarted.promise;
            expect(await env.DB.prepare("SELECT status FROM story_video_jobs WHERE id = ?").bind(job.id).first()).toEqual({ status: "ready" });
            await renderStoryVideoRevisionBatch(env, REVISION_ID);
            expect(send).toHaveBeenCalledTimes(1);
        }
        finally {
            releaseNotification.resolve();
            await upload;
        }
        const completedAt = Date.now();
        const clock = vi.spyOn(Date, "now").mockReturnValue(completedAt + 39000);
        try {
            await renderStoryVideoRevisionBatch(env, REVISION_ID);
            expect(send).toHaveBeenCalledTimes(1);
            clock.mockReturnValue(completedAt + 40000);
            await Promise.all([renderStoryVideoRevisionBatch(env, REVISION_ID), renderStoryVideoRevisionBatch(env, REVISION_ID)]);
            expect(send).toHaveBeenCalledTimes(2);
        }
        finally {
            clock.mockRestore();
        }
    });
    it("does not replace a failed execution until its completion hold expires", async () => {
        const env = { ...lambdaEnv(), STORY_VIDEO_MAX_INFLIGHT: "1", STORY_VIDEO_JOBS: { send: vi.fn().mockResolvedValue(undefined) } };
        await ensureStoryVideoJobs(env, SHIRT_ID);
        const send = vi.fn(() => Promise.resolve(new Response(null, { status: 202 })));
        vi.stubGlobal("fetch", send);
        await renderStoryVideoRevisionBatch(env, REVISION_ID);
        const job = await env.DB.prepare("SELECT id FROM story_video_jobs WHERE status = 'rendering'").first<{
            id: string;
        }>();
        if (!job)
            throw new Error("Missing admitted job");
        const grant = await createStoryVideoGrant(env.STORY_VIDEO_GRANT_SECRET, job.id, 1);
        const headers = { authorization: `Bearer ${grant}`, "x-video-execution-id": crypto.randomUUID() };
        const endpoint = `https://api.test/v2/internal/story-video-jobs/${job.id}`;
        expect((await handleStoryVideoTransfer(new Request(`${endpoint}/claim`, { method: "POST", headers }), env))?.status).toBe(201);
        expect((await handleStoryVideoTransfer(new Request(`${endpoint}/failure`, { method: "POST", headers }), env))?.status).toBe(204);
        await renderStoryVideoRevisionBatch(env, REVISION_ID);
        expect(send).toHaveBeenCalledTimes(1);
        expect(await env.DB.prepare("SELECT status, attempt_count FROM story_video_jobs WHERE id = ?").bind(job.id).first())
            .toEqual({ status: "failed", attempt_count: 1 });
        const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 40000);
        try {
            await Promise.all([renderStoryVideoRevisionBatch(env, REVISION_ID), renderStoryVideoRevisionBatch(env, REVISION_ID)]);
            expect(send).toHaveBeenCalledTimes(2);
            expect(await env.DB.prepare("SELECT count(*) AS count FROM story_video_jobs WHERE status = 'rendering'").first()).toEqual({ count: 1 });
        }
        finally {
            clock.mockRestore();
        }
    });
    it("keeps the recovery message alive while direct dispatch is awaiting AWS rejection", async () => {
        const env = lambdaEnv();
        const started = deferred(), release = deferred();
        const tasks: Promise<unknown>[] = [];
        let calls = 0;
        vi.stubGlobal("fetch", async () => { if (++calls === 2)
            started.resolve(); await release.promise; return new Response(null, { status: 429 }); });
        try {
            await ensureStoryVideoJobs(env, SHIRT_ID, { waitUntil: task => { tasks.push(task); } });
            await started.promise;
            const recovery = recoveryMessage();
            await consumeStoryVideoQueue(recovery.batch, env);
            expect(recovery.ack).not.toHaveBeenCalled();
            expect(recovery.retry).toHaveBeenCalledWith({ delaySeconds: 5 });
            release.resolve();
            await Promise.all(tasks);
            vi.stubGlobal("fetch", () => Promise.resolve(new Response(null, { status: 202 })));
            await consumeStoryVideoQueue(recovery.batch, env);
            const rows = await env.DB.prepare("SELECT status, attempt_count FROM story_video_jobs").all();
            expect(rows.results).toEqual([{ status: "rendering", attempt_count: 2 }, { status: "rendering", attempt_count: 2 }]);
        }
        finally {
            release.resolve();
            await Promise.all(tasks);
            vi.unstubAllGlobals();
        }
    });
    it("keeps possibly accepted invocations valid until their bounded lease expires", async () => {
        const env = lambdaEnv();
        await ensureStoryVideoJobs(env, SHIRT_ID);
        const deliveries: {
            jobId: string;
            grant: string;
        }[] = [];
        vi.stubGlobal("fetch", async (request: Request) => {
            const payload: unknown = await request.json();
            if (typeof payload !== "object" || payload === null || !("jobId" in payload) || typeof payload.jobId !== "string" ||
                !("grant" in payload) || typeof payload.grant !== "string")
                throw new Error("Invalid test payload");
            deliveries.push({ jobId: payload.jobId, grant: payload.grant });
            throw new Error("Response lost after AWS acceptance");
        });
        try {
            await renderStoryVideoRevisionBatch(env, REVISION_ID);
            expect((await env.DB.prepare("SELECT status FROM story_video_jobs").all()).results).toEqual([{ status: "rendering" }, { status: "rendering" }]);
            await reconcileStoryVideoJobs(env);
            expect((await env.DB.prepare("SELECT status FROM story_video_jobs").first())?.["status"]).toBe("rendering");
            for (const delivery of deliveries) {
                const endpoint = `https://api.test/v2/internal/story-video-jobs/${delivery.jobId}`;
                const headers = { authorization: `Bearer ${delivery.grant}`, "x-video-execution-id": crypto.randomUUID() };
                expect((await handleStoryVideoTransfer(new Request(`${endpoint}/claim`, { method: "POST", headers }), env))?.status).toBe(201);
                expect((await handleStoryVideoTransfer(new Request(`${endpoint}/artwork`, { headers }), env))?.status).toBe(200);
            }
            await env.DB.prepare("UPDATE story_video_jobs SET updated_at = ?").bind(Date.now() - 201000).run();
            await reconcileStoryVideoJobs(env);
            expect((await env.DB.prepare("SELECT status FROM story_video_jobs").first())?.["status"]).toBe("queued");
        }
        finally {
            vi.unstubAllGlobals();
        }
    });
    it("acknowledges completed or inactive families instead of keeping an endless watchdog", async () => {
        const env = lambdaEnv();
        await ensureStoryVideoJobs(env, SHIRT_ID);
        await env.DB.prepare("UPDATE story_video_jobs SET status = 'ready'").run();
        const complete = recoveryMessage();
        await consumeStoryVideoQueue(complete.batch, env);
        expect(complete.ack).toHaveBeenCalledOnce();
        expect(complete.retry).not.toHaveBeenCalled();
        await env.DB.prepare("UPDATE story_video_jobs SET status = 'queued'").run();
        await env.DB.prepare("UPDATE products SET status = 'deleted' WHERE id = ?").bind(SHIRT_ID).run();
        const inactive = recoveryMessage();
        await consumeStoryVideoQueue(inactive.batch, env);
        expect(inactive.ack).toHaveBeenCalledOnce();
        const send = vi.fn();
        await reconcileStoryVideoJobs({ ...env, STORY_VIDEO_JOBS: { send } });
        expect(send).not.toHaveBeenCalled();
    });
    it("recovers a failed initial queue send from the durable job rows", async () => {
        const env = lambdaEnv();
        const send = vi.fn().mockRejectedValueOnce(new Error("Queue temporarily unavailable")).mockResolvedValue(undefined);
        const configured = { ...env, STORY_VIDEO_JOBS: { send } };
        await ensureStoryVideoJobs(configured, SHIRT_ID);
        expect((await env.DB.prepare("SELECT status FROM story_video_jobs").all()).results).toEqual([{ status: "queued" }, { status: "queued" }]);
        await reconcileStoryVideoJobs(configured);
        expect(send).toHaveBeenCalledTimes(2);
        expect(send).toHaveBeenLastCalledWith({ designRevisionId: REVISION_ID }, { delaySeconds: 0 });
    });
    it("does not adopt a previous v6 object into the physical-geometry v7 namespace", async () => {
        const env = lambdaEnv();
        await ensureStoryVideoJobs(env, SHIRT_ID);
        // Small ISO BMFF envelope, not an encoded video or a visual quality test.
        const mp4 = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0, 105, 115, 111, 109, 105, 115, 111, 50,
            0, 0, 0, 8, 109, 111, 111, 118, 0, 0, 0, 9, 109, 100, 97, 116, 1]);
        const jobs = await env.DB.prepare("SELECT story_key FROM story_video_jobs").all<{
            story_key: string;
        }>();
        for (const job of jobs.results) {
            await env.STORY_VIDEOS.put(job.story_key.replace("/v7/", "/v6/"), mp4, {
                httpMetadata: { contentType: "video/mp4" }, customMetadata: { renderTimeMs: "4100" },
            });
        }
        const invoke = vi.fn(() => Promise.resolve(new Response(null, { status: 202 })));
        vi.stubGlobal("fetch", invoke);
        try {
            await renderStoryVideoRevisionBatch(env, REVISION_ID);
            expect(invoke).toHaveBeenCalledTimes(2);
            expect((await env.DB.prepare("SELECT status FROM story_video_jobs").all()).results)
                .toEqual([{ status: "rendering" }, { status: "rendering" }]);
            expect(await Promise.all(jobs.results.map(job => env.STORY_VIDEOS.head(job.story_key))))
                .toEqual([null, null]);
        }
        finally {
            vi.unstubAllGlobals();
        }
    });
    it("does not adopt corrupt or mixed-provenance cache objects", async () => {
        const env = lambdaEnv();
        await ensureStoryVideoJobs(env, SHIRT_ID);
        const jobs = await env.DB.prepare("SELECT story_key FROM story_video_jobs ORDER BY story_key").all<{
            story_key: string;
        }>();
        for (const [index, job] of jobs.results.entries()) {
            await env.STORY_VIDEOS.put(job.story_key, ARTWORK, { httpMetadata: { contentType: "video/mp4" },
                customMetadata: index === 0 ? { renderTimeMs: "4100" } : { renderTimeMs: "4100", jobId: "wrong" } });
        }
        vi.stubGlobal("fetch", () => Promise.reject(new Error("Invalid cached objects must fail closed")));
        try {
            await expect(renderStoryVideoRevisionBatch(env, REVISION_ID)).rejects.toThrow();
            expect((await env.DB.prepare("SELECT status FROM story_video_jobs").all()).results).toEqual([{ status: "failed" }, { status: "failed" }]);
            expect((await env.STORY_VIDEOS.list()).objects).toHaveLength(2);
        }
        finally {
            vi.unstubAllGlobals();
        }
    });
    it("atomically claims one execution and ignores a duplicate execution's failure", async () => {
        const env = lambdaEnv();
        await ensureStoryVideoJobs(env, SHIRT_ID);
        const row = await env.DB.prepare("SELECT id FROM story_video_jobs LIMIT 1").first<{
            id: string;
        }>();
        if (!row)
            throw new Error("Missing test job.");
        await env.DB.prepare("UPDATE story_video_jobs SET status = 'rendering', attempt_count = 1 WHERE id = ?").bind(row.id).run();
        const grant = await createStoryVideoGrant(env.STORY_VIDEO_GRANT_SECRET, row.id, 1);
        const endpoint = `https://api.test/v2/internal/story-video-jobs/${row.id}`;
        const headers = { authorization: `Bearer ${grant}`, "x-video-execution-id": crypto.randomUUID() };
        const duplicate = { ...headers, "x-video-execution-id": crypto.randomUUID() };
        expect((await handleStoryVideoTransfer(new Request(`${endpoint}/claim`, { method: "POST", headers }), env))?.status).toBe(201);
        expect((await handleStoryVideoTransfer(new Request(`${endpoint}/claim`, { method: "POST", headers: duplicate }), env))?.status).toBe(204);
        expect((await handleStoryVideoTransfer(new Request(`${endpoint}/claim`, { method: "POST", headers }), env))?.status).toBe(201);
        expect((await handleStoryVideoTransfer(new Request(`${endpoint}/artwork`, { headers: duplicate }), env))?.status).toBe(409);
        expect((await handleStoryVideoTransfer(new Request(`${endpoint}/failure`, { method: "POST", headers: duplicate }), env))?.status).toBe(204);
        expect((await handleStoryVideoTransfer(new Request(`${endpoint}/failure`, { method: "POST", headers: { authorization: headers.authorization } }), env))?.status).toBe(204);
        expect((await env.DB.prepare("SELECT status FROM story_video_jobs WHERE id = ?").bind(row.id).first())?.["status"]).toBe("rendering");
        expect((await handleStoryVideoTransfer(new Request(`${endpoint}/artwork`, { headers }), env))?.status).toBe(200);
        expect((await handleStoryVideoTransfer(new Request(`${endpoint}/failure`, { method: "POST", headers }), env))?.status).toBe(204);
        expect((await env.DB.prepare("SELECT status FROM story_video_jobs WHERE id = ?").bind(row.id).first())?.["status"]).toBe("failed");
    });
    it.each([false, true])("invokes four Lambdas concurrently and preserves scoped grants across print completion, preview=%s", async (preview) => {
        const env = lambdaEnv();
        if (preview)
            await env.DB.prepare(`UPDATE products SET video_design_revision_id = design_revision_id,
      design_revision_id = NULL WHERE design_id = ?`).bind(DESIGN_ID).run();
        await ensureStoryVideoJobs(env, [SHIRT_ID, TOTE_ID]);
        const allStarted = deferred();
        let calls = 0;
        const video = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]);
        const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", video)), b => b.toString(16).padStart(2, "0")).join("");
        vi.stubGlobal("fetch", async (request: Request, init: RequestInit) => {
            // Cloudflare rejects redirect:error before making any outbound request.
            expect(init.redirect).toBe("manual");
            expect(request.url).toContain(encodeURIComponent(LAMBDA_STORY_FUNCTION));
            expect(request.headers.get("authorization")).toContain("AWS4-HMAC-SHA256");
            expect(request.headers.get("x-amz-invocation-type")).toBe("Event");
            const payload: unknown = await request.json();
            if (typeof payload !== "object" || payload === null || !("jobId" in payload) || typeof payload.jobId !== "string" ||
                !("grant" in payload) || typeof payload.grant !== "string" || !("storyKey" in payload) || typeof payload.storyKey !== "string")
                throw new Error("Invalid Lambda input.");
            calls++;
            if (calls === 4)
                allStarted.resolve();
            await allStarted.promise;
            const endpoint = `https://api.test/v2/internal/story-video-jobs/${payload.jobId}`;
            const headers = { authorization: `Bearer ${payload.grant}`, "x-video-execution-id": crypto.randomUUID() };
            expect((await handleStoryVideoTransfer(new Request(`${endpoint}/claim`, { method: "POST", headers }), env))?.status).toBe(201);
            const artwork = await handleStoryVideoTransfer(new Request(`${endpoint}/artwork`, { headers }), env);
            expect(artwork?.status).toBe(200);
            expect(new Uint8Array(await artwork?.arrayBuffer() ?? new ArrayBuffer(0))).toEqual(ARTWORK);
            const upload = await handleStoryVideoTransfer(new Request(`${endpoint}/video`, { method: "PUT", body: video,
                headers: { ...headers, "content-type": "video/mp4", "content-length": String(video.length), "x-video-sha256": sha256 } }), env);
            expect(upload?.status).toBe(200);
            return new Response(null, { status: 202 });
        });
        try {
            await Promise.all([renderStoryVideoRevisionBatch(env, REVISION_ID), renderStoryVideoRevisionBatch(env, REVISION_ID)]);
            expect(calls).toBe(4);
            const rows = await env.DB.prepare("SELECT status, attempt_count FROM story_video_jobs").all();
            expect(rows.results).toHaveLength(4);
            expect(rows.results.every(row => row["status"] === "ready" && row["attempt_count"] === 1)).toBe(true);
            expect((await env.STORY_VIDEOS.list()).objects).toHaveLength(4);
            if (preview) {
                const printRevisionId = crypto.randomUUID();
                await env.DB.prepare(`INSERT INTO design_revisions
          (id, design_id, fingerprint, artwork_key, content_type, byte_size, artwork_width, artwork_height,
            sha256, crop_x, crop_y, crop_zoom, placement_x, placement_y, placement_width, depth, created_at)
          SELECT ?, design_id, 'revision-v2:full-print', artwork_key, content_type, byte_size, 3000, 4000,
            sha256, crop_x, crop_y, crop_zoom, placement_x, placement_y, placement_width, depth, created_at
          FROM design_revisions WHERE id = ?`).bind(printRevisionId, REVISION_ID).run();
                await env.DB.prepare("UPDATE products SET design_revision_id = ? WHERE design_id = ?").bind(printRevisionId, DESIGN_ID).run();
                await ensureStoryVideoJobs(env, [SHIRT_ID, TOTE_ID]);
                expect(await env.DB.prepare("SELECT count(*) AS count FROM story_video_jobs WHERE design_revision_id = ?")
                    .bind(REVISION_ID).first()).toEqual({ count: 4 });
                expect((await storyVideoEvents(new Request("https://api.test/events", { method: "HEAD" }), env.DB, SHIRT_ID)).status).toBe(200);
            }
            await renderStoryVideoRevisionBatch(env, REVISION_ID);
            expect(calls).toBe(4);
        }
        finally {
            vi.unstubAllGlobals();
            allStarted.resolve();
        }
    });
    it("fences superseded grants, validates checksums and recovers a lost Lambda acknowledgement from R2", async () => {
        const env = lambdaEnv();
        await ensureStoryVideoJobs(env, [SHIRT_ID]);
        const created = await env.DB.prepare("SELECT id, story_key FROM story_video_jobs LIMIT 1").first<{
            id: string;
            story_key: string;
        }>();
        if (!created)
            throw new Error("Test job missing.");
        const row = { ...created, id: `${created.id}-v5-v6-v7` };
        await env.DB.prepare("UPDATE story_video_jobs SET id = ? WHERE id = ?").bind(row.id, created.id).run();
        await env.DB.prepare("UPDATE story_video_jobs SET status = 'rendering', attempt_count = 2 WHERE id = ?").bind(row.id).run();
        const endpoint = `https://api.test/v2/internal/story-video-jobs/${row.id}`;
        const oldToken = await createStoryVideoGrant(env.STORY_VIDEO_GRANT_SECRET, row.id, 1);
        expect((await handleStoryVideoTransfer(new Request(`${endpoint}/artwork`, { headers: { authorization: `Bearer ${oldToken}` } }), env))?.status).toBe(409);
        const token = await createStoryVideoGrant(env.STORY_VIDEO_GRANT_SECRET, row.id, 2);
        const executionId = crypto.randomUUID();
        expect((await handleStoryVideoTransfer(new Request(`${endpoint}/claim`, { method: "POST",
            headers: { authorization: `Bearer ${token}`, "x-video-execution-id": executionId } }), env))?.status).toBe(201);
        const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", ARTWORK)), b => b.toString(16).padStart(2, "0")).join("");
        const put = (digest: string) => handleStoryVideoTransfer(new Request(`${endpoint}/video`, { method: "PUT", body: ARTWORK,
            headers: { authorization: `Bearer ${token}`, "x-video-execution-id": executionId, "content-type": "video/mp4", "content-length": String(ARTWORK.length), "x-video-sha256": digest } }), env);
        expect((await put("0".repeat(64)))?.status).toBe(422);
        expect(await env.STORY_VIDEOS.head(row.story_key)).toBeNull();
        expect((await put(sha256))?.status).toBe(200);
        expect((await put(sha256))?.status).toBe(200);
        const cached = await renderLambdaVideo(env, { jobId: row.id, attempt: 2, storyKey: row.story_key,
            artwork: { sha256, size: ARTWORK.length }, baseProductSlug: "staple-tee", color: "Black", settings: {} }, "story-video-renderer-v7", () => Promise.reject(new Error("Cached video must not invoke Lambda.")));
        expect(cached.timings["lambdaCacheHit"]).toBe(1);
        await env.DB.prepare("UPDATE story_video_jobs SET status = 'ready' WHERE id = ?").bind(row.id).run();
        expect((await handleStoryVideoTransfer(new Request(`${endpoint}/artwork`, { headers: { authorization: `Bearer ${token}` } }), env))?.status).toBe(409);
    });
    it("dispatches after configuration without waiting for encoding and preserves accepted siblings on throttling", async () => {
        const env = lambdaEnv();
        let calls = 0;
        const background: Promise<unknown>[] = [];
        vi.stubGlobal("fetch", async (request: Request) => {
            const payload: unknown = await request.json();
            calls++;
            return new Response(null, { status: typeof payload === "object" && payload !== null && "color" in payload && payload.color === "White" ? 429 : 202 });
        });
        try {
            await ensureStoryVideoJobs(env, [SHIRT_ID, TOTE_ID], { waitUntil: task => { background.push(task); } });
            await Promise.all(background);
            expect(calls).toBe(4);
            const rows = await env.DB.prepare("SELECT colour,status,attempt_count FROM story_video_jobs").all();
            expect(rows.results.filter(row => row["status"] === "rendering")).toHaveLength(3);
            expect(rows.results.filter(row => row["status"] === "failed")).toEqual([{ colour: "White", status: "failed", attempt_count: 1 }]);
            vi.stubGlobal("fetch", () => { calls++; return Promise.resolve(new Response(null, { status: 202 })); });
            await renderStoryVideoRevisionBatch(env, REVISION_ID);
            expect(calls).toBe(5);
            expect((await env.DB.prepare("SELECT count(*) AS count FROM story_video_jobs WHERE status = 'rendering'").first())?.["count"]).toBe(4);
        }
        finally {
            vi.unstubAllGlobals();
        }
    });
    it("a real family-configuration request starts all four dispatches without consuming the recovery queue", async () => {
        const owner = "a".repeat(64);
        await testPlatform().env.DB.prepare(`UPDATE designs SET owner_id = ?, finalized_at = NULL, version = 0,
      artwork_width = 3000, artwork_height = 4000 WHERE id = ?`).bind(owner, DESIGN_ID).run();
        const background: Promise<unknown>[] = [];
        let calls = 0;
        vi.stubGlobal("fetch", () => { calls++; return Promise.resolve(new Response(null, { status: 202 })); });
        try {
            const response = await handleRequest(new Request("https://api.test/v2/configured-product-families", {
                method: "POST", headers: { "content-type": "application/json", "x-forever-tee-service-secret": "test-service",
                    "x-forever-tee-owner-id": owner }, body: JSON.stringify({ designId: DESIGN_ID, expectedVersion: 0,
                    baseProductIds: [SHIRT_BASE_ID, TOTE_BASE_ID] }),
            }), { ...testPlatform().env, ...lambdaEnv(), FOREVER_TEE_API_SHARED_SECRET: "test-service", STORY_VIDEO_FAMILY_CONFIGURATION: "1" }, { waitUntil: task => { background.push(task); } });
            expect(response.status).toBe(201);
            expect(background).toHaveLength(4);
            await Promise.all(background);
            expect(calls).toBe(8);
            const videos = (await testPlatform().env.DB.prepare("SELECT count(*) AS count FROM story_video_jobs WHERE status = 'rendering'").first())?.["count"];
            const images = (await testPlatform().env.DB.prepare("SELECT count(*) AS count FROM product_image_jobs WHERE status = 'rendering'").first())?.["count"];
            expect(typeof videos).toBe("number"); expect(typeof images).toBe("number");
            if (typeof videos !== "number" || typeof images !== "number") throw new Error("Missing shared admission inventory.");
            expect(videos + images).toBe(8);
            expect(await testPlatform().env.DB.prepare("SELECT count(*) AS n FROM story_video_jobs WHERE status IN ('queued','rendering') AND attempt_count<=1").first()).toEqual({ n: 4 });
        }
        finally {
            vi.unstubAllGlobals();
        }
    });
    it.each(["print queue", "print object", "video queue"])("creates a fresh family and persists both outboxes while %s acknowledgement is blocked", async (blocked) => {
        const owner = "a".repeat(64);
        await testPlatform().env.DB.prepare(`UPDATE designs SET owner_id = ?, finalized_at = NULL, version = 0,
        artwork_width = 3000, artwork_height = 4000 WHERE id = ?`).bind(owner, DESIGN_ID).run();
        // Exercise the first confirmation, not the already-configured retry path.
        await testPlatform().env.DB.batch([
            testPlatform().env.DB.prepare("DELETE FROM print_assets"),
            testPlatform().env.DB.prepare("DELETE FROM products WHERE design_id = ?").bind(DESIGN_ID),
            testPlatform().env.DB.prepare("DELETE FROM design_revisions WHERE design_id = ?").bind(DESIGN_ID),
            ...[
                { id: SHIRT_BASE_ID, slug: "staple-tee", handle: "bent-shirt", catalogue: "story-shirt-catalogue" },
                { id: TOTE_BASE_ID, slug: "cotton-tote", handle: "cotton-tote", catalogue: "story-tote-catalogue" },
            ].map(base => testPlatform().env.DB.prepare(`INSERT INTO shopify_variant_mapping_snapshots
          (id, catalogue_snapshot_id, shopify_product_id, shopify_product_handle, shopify_product_title,
            retrieved_at, source_url, variant_count, base_product_id, base_product_slug)
          VALUES (?, ?, ?, ?, 'Fixture', ?, 'https://fixture.invalid', 1, ?, ?) ON CONFLICT DO NOTHING`)
                .bind(`confirmation-${base.slug}`, base.catalogue, base.id, base.handle, Date.now(), base.id, base.slug)),
        ]);
        expect((await testPlatform().env.DB.prepare("SELECT count(*) AS count FROM products WHERE design_id = ?")
            .bind(DESIGN_ID).first())?.["count"]).toBe(0);
        const background: Promise<unknown>[] = [];
        const release = deferred();
        const entered = deferred();
        const controller = new AbortController();
        const waitForDelivery = async (kind: string) => {
            if (blocked === kind) {
                entered.resolve();
                await release.promise;
            }
        };
        let calls = 0;
        vi.stubGlobal("fetch", () => { calls++; return Promise.resolve(new Response(null, { status: 202 })); });
        const env = {
            ...testPlatform().env, ...lambdaEnv(),
            FOREVER_TEE_API_SHARED_SECRET: "test-service", STORY_VIDEO_FAMILY_CONFIGURATION: "1",
            PRINT_EXECUTION_MODE: "durable-object",
            PRINT_ASSET_JOBS: { send: () => waitForDelivery("print queue") },
            PRINT_EXECUTIONS: { getByName: () => ({ fetch: async () => {
                        await waitForDelivery("print object");
                        return new Response(null, { status: 202 });
                    } }) },
            STORY_VIDEO_JOBS: { send: () => waitForDelivery("video queue") },
        } satisfies Parameters<typeof handleRequest>[1];
        let response: Response | undefined;
        const confirmation = handleRequest(new Request("https://api.test/v2/configured-product-families", {
            method: "POST", headers: { "content-type": "application/json", "x-forever-tee-service-secret": "test-service",
                "x-forever-tee-owner-id": owner }, body: JSON.stringify({ designId: DESIGN_ID, expectedVersion: 0,
                baseProductIds: [SHIRT_BASE_ID, TOTE_BASE_ID] }), signal: controller.signal,
        }), env, { waitUntil: task => { background.push(task); } }).then(result => { response = result; });
        try {
            await Promise.race([entered.promise, confirmation.then(() => {
                    if (response?.status !== 201)
                        throw new Error(`Configuration failed before delivery: ${String(response?.status)}`);
                })]);
            controller.abort();
            // The first registered task owns configuration through both outboxes.
            const completion = background[0];
            expect(completion).toBeDefined();
            await vi.waitFor(() => { expect(response?.status).toBe(201); }, { timeout: 1000 });
            await completion;
            expect((await env.DB.prepare("SELECT count(*) AS count FROM products WHERE design_id = ?")
                .bind(DESIGN_ID).first())?.["count"]).toBe(2);
            expect((await env.DB.prepare("SELECT count(*) AS count FROM design_revisions WHERE design_id = ?")
                .bind(DESIGN_ID).first())?.["count"]).toBe(1);
            expect(await env.DB.prepare("SELECT version, finalized_at IS NOT NULL AS finalized FROM designs WHERE id = ?")
                .bind(DESIGN_ID).first()).toEqual({ version: 1, finalized: 1 });
            expect((await env.DB.prepare("SELECT count(*) AS count FROM print_asset_jobs").first())?.["count"]).toBe(2);
            expect((await env.DB.prepare("SELECT count(*) AS count FROM story_video_jobs").first())?.["count"]).toBe(4);
            await vi.waitFor(() => { expect(calls).toBe(8); }, { timeout: 1000 });
            let settled = false;
            const tracked = Promise.all(background).then(() => { settled = true; });
            await Promise.resolve();
            expect(settled).toBe(false);
            release.resolve();
            await tracked;
        }
        finally {
            release.resolve();
            await confirmation;
            await Promise.all(background);
            vi.unstubAllGlobals();
        }
    });
    it("failure callbacks requeue only the current attempt and cannot invalidate completed media", async () => {
        const env = lambdaEnv();
        const sent: string[] = [];
        const withQueue = { ...env, STORY_VIDEO_JOBS: { send: (message: StoryVideoQueueMessage) => { sent.push(message.designRevisionId); return Promise.resolve(); } } };
        await ensureStoryVideoJobs(env, SHIRT_ID);
        const row = await env.DB.prepare("SELECT id FROM story_video_jobs LIMIT 1").first<{
            id: string;
        }>();
        if (!row)
            throw new Error("Missing test job.");
        await env.DB.prepare("UPDATE story_video_jobs SET status = 'rendering', attempt_count = 1 WHERE id = ?").bind(row.id).run();
        const token = await createStoryVideoGrant(env.STORY_VIDEO_GRANT_SECRET, row.id, 1, Date.now() - 240000);
        const endpoint = `https://api.test/v2/internal/story-video-jobs/${row.id}`;
        const headers = { authorization: `Bearer ${token}` };
        expect((await handleStoryVideoTransfer(new Request(`${endpoint}/artwork`, { headers }), withQueue))?.status).toBe(403);
        expect((await handleStoryVideoTransfer(new Request(`${endpoint}/failure`, { method: "POST", headers }), withQueue))?.status).toBe(204);
        expect(sent).toEqual([REVISION_ID]);
        await env.DB.prepare("UPDATE story_video_jobs SET status = 'ready', attempt_count = 2 WHERE id = ?").bind(row.id).run();
        expect((await handleStoryVideoTransfer(new Request(`${endpoint}/failure`, { method: "POST", headers }), withQueue))?.status).toBe(204);
        expect((await env.DB.prepare("SELECT status FROM story_video_jobs WHERE id = ?").bind(row.id).first())?.["status"]).toBe("ready");
        expect(sent).toHaveLength(1);
    });
    it("marks exhausted stale renders unavailable instead of leaving them pending forever", async () => {
        const env = lambdaEnv();
        await ensureStoryVideoJobs(env, SHIRT_ID);
        await env.DB.prepare("UPDATE story_video_jobs SET status = 'rendering', attempt_count = 3, updated_at = ?").bind(Date.now() - 16 * 60000).run();
        await reconcileStoryVideoJobs(env);
        const rows = await env.DB.prepare("SELECT status, last_error FROM story_video_jobs").all();
        expect(rows.results.every(row => row["status"] === "failed" && row["last_error"] === "STALE_RENDER_EXHAUSTED")).toBe(true);
    });
    it("does not follow invocation redirects or accept Lambda execution errors", async () => {
        const env = lambdaEnv();
        const job = { jobId: crypto.randomUUID(), attempt: 1, storyKey: "story-videos/v7/unused.mp4",
            artwork: { sha256: "a".repeat(64), size: 1 }, baseProductSlug: "staple-tee", color: "White", settings: {} };
        for (const response of [new Response(null, { status: 302, headers: { location: "https://untrusted.test" } }),
            new Response("{}", { headers: { "x-amz-function-error": "Unhandled" } })]) {
            let calls = 0;
            await expect(renderLambdaVideo(env, job, "story-video-renderer-v7", (_request, init) => {
                expect(init?.redirect).toBe("manual");
                calls++;
                return Promise.resolve(response);
            })).rejects.toThrow("Lambda render invocation failed");
            expect(calls).toBe(1);
        }
    });
    it("registers all four family jobs before sending one revision message", async () => {
        const messages: StoryVideoQueueMessage[] = [];
        await ensureStoryVideoJobs({
            DB: testPlatform().env.DB, DESIGN_ARTWORK: testPlatform().env.DESIGN_ARTWORK,
            STORY_VIDEO_JOBS: { async send(message) {
                    const count = await testPlatform().env.DB.prepare("SELECT count(*) AS count FROM story_video_jobs").first();
                    expect(count?.["count"]).toBe(4);
                    messages.push(message);
                } },
        }, [SHIRT_ID, TOTE_ID]);
        expect(messages).toEqual([{ designRevisionId: REVISION_ID }]);
    });
    it.each([
        { previous: "4", next: "5", migration: "0016_story_video_renderer_v5.sql" },
        { previous: "5", next: "6", migration: "0017_story_video_renderer_v6.sql" },
        { previous: "6", next: "7", migration: "0024_story_video_renderer_v7.sql" },
    ])("queues reversible v$next replacements for active v$previous media", async ({ previous, next, migration }) => {
        const now = Date.now();
        const legacyKey = `story-videos/v${previous}/${REVISION_ID}/${SHIRT_ID}/black.mp4`;
        await testPlatform().env.DB.prepare(`
      INSERT INTO story_video_jobs (
        id, product_id, design_revision_id, colour, renderer_version,
        story_key, status, attempt_count, created_at, updated_at
      ) VALUES (?, ?, ?, 'Black', ?, ?,
        'ready', 1, ?, ?)
    `).bind(crypto.randomUUID(), SHIRT_ID, REVISION_ID, `story-video-renderer-v${previous}`, legacyKey, now, now).run();
        await applyMigration(migration);
        await applyMigration(migration);
        const jobs = await testPlatform().env.DB.prepare(`
      SELECT renderer_version, status, story_key
      FROM story_video_jobs
      WHERE product_id = ? AND colour = 'Black'
      ORDER BY renderer_version
    `).bind(SHIRT_ID).all();
        expect(jobs.results).toEqual([
            {
                renderer_version: `story-video-renderer-v${previous}`,
                status: "ready",
                story_key: legacyKey,
            },
            {
                renderer_version: `story-video-renderer-v${next}`,
                status: "queued",
                story_key: `story-videos/v${next}/${REVISION_ID}/${SHIRT_ID}/black.mp4`,
            },
        ]);
    });
    it("coalesces a two-product family into four idempotent immutable jobs", async () => {
        const queued: StoryVideoQueueMessage[] = [];
        const send = vi.fn((message: StoryVideoQueueMessage) => {
            queued.push(message);
            return Promise.resolve();
        });
        const env = {
            DB: testPlatform().env.DB,
            DESIGN_ARTWORK: testPlatform().env.DESIGN_ARTWORK,
            STORY_VIDEO_JOBS: { send },
        };
        await ensureStoryVideoJobs(env, SHIRT_ID);
        await ensureStoryVideoJobs(env, TOTE_ID);
        await ensureStoryVideoJobs(env, SHIRT_ID);
        const jobs = await testPlatform().env.DB.prepare(`
      SELECT product_id, colour, status, attempt_count, story_key
      FROM story_video_jobs ORDER BY product_id, colour
    `).all();
        expect(jobs.results).toHaveLength(4);
        expect(new Set(jobs.results.map((job) => job["story_key"])).size).toBe(4);
        expect(jobs.results.every((job) => String(job["story_key"]).startsWith("story-videos/v7/"))).toBe(true);
        expect(jobs.results.every((job) => job["status"] === "queued")).toBe(true);
        expect(queued).toEqual([
            { designRevisionId: REVISION_ID },
            { designRevisionId: REVISION_ID },
            { designRevisionId: REVISION_ID },
        ]);
        expect(send).toHaveBeenCalledWith({ designRevisionId: REVISION_ID }, { delaySeconds: 0 });
    });
    it("renders a later sibling product without repeating the completed variants", async () => {
        const started = deferred();
        const finish = deferred();
        const payloads: unknown[] = [];
        const env = {
            DB: testPlatform().env.DB,
            DESIGN_ARTWORK: testPlatform().env.DESIGN_ARTWORK,
            STORY_VIDEO_RENDERER: {
                fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
                    const payload: unknown = await new Request(input, init).json();
                    payloads.push(payload);
                    started.resolve();
                    await finish.promise;
                    return Response.json({ results: renderResults(payload) });
                }),
            },
        };
        await ensureStoryVideoJobs(env, SHIRT_ID);
        const first = renderStoryVideoRevisionBatch(env, REVISION_ID);
        await started.promise;
        await ensureStoryVideoJobs(env, TOTE_ID);
        finish.resolve();
        await first;
        await renderStoryVideoRevisionBatch(env, REVISION_ID);
        // Duplicate queue messages must not encode already-completed videos.
        await renderStoryVideoRevisionBatch(env, REVISION_ID);
        expect(payloads.map((payload) => renderRequestSummary(payload).variants))
            .toEqual([
            ["staple-tee:Black", "staple-tee:White"],
            ["cotton-tote:Black", "cotton-tote:Cream"],
        ]);
        const jobs = await env.DB.prepare(`
      SELECT status, attempt_count FROM story_video_jobs
    `).all();
        expect(jobs.results).toHaveLength(4);
        expect(jobs.results.every((job) => job["status"] === "ready" && job["attempt_count"] === 1)).toBe(true);
    });
    it("renders the four pending variants once and persists readiness", async () => {
        await ensureStoryVideoJobs({
            DB: testPlatform().env.DB,
            DESIGN_ARTWORK: testPlatform().env.DESIGN_ARTWORK,
        }, SHIRT_ID);
        await ensureStoryVideoJobs({
            DB: testPlatform().env.DB,
            DESIGN_ARTWORK: testPlatform().env.DESIGN_ARTWORK,
        }, TOTE_ID);
        let rendererPayload: unknown;
        const renderer = {
            fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
                const request = new Request(input, init);
                rendererPayload = await request.json();
                return Response.json({
                    batchId: REVISION_ID,
                    results: renderResults(rendererPayload),
                    shutdownTimeMs: 300,
                });
            }),
        };
        await renderStoryVideoRevisionBatch({
            DB: testPlatform().env.DB,
            DESIGN_ARTWORK: testPlatform().env.DESIGN_ARTWORK,
            STORY_VIDEO_RENDERER: renderer,
        }, REVISION_ID);
        expect(renderer.fetch).toHaveBeenCalledOnce();
        expect(renderRequestSummary(rendererPayload)).toEqual({
            batchId: REVISION_ID,
            encoding: { crf: 21, frameRate: 30, frameWidth: 720, scaleBeforeHold: true },
            preset: "veryfast",
            shutdownAfterBatch: false,
            variants: [
                "cotton-tote:Black",
                "cotton-tote:Cream",
                "staple-tee:Black",
                "staple-tee:White",
            ],
            websiteLabel: "shop.bent.build",
        });
        const jobs = await testPlatform().env.DB.prepare(`
      SELECT status, attempt_count, output_byte_size, rendered_at
      FROM story_video_jobs
    `).all();
        expect(jobs.results).toHaveLength(4);
        expect(jobs.results.every((job) => job["status"] === "ready")).toBe(true);
        expect(jobs.results.every((job) => job["attempt_count"] === 1)).toBe(true);
        expect(jobs.results.every((job) => job["output_byte_size"] === 1500000))
            .toBe(true);
        expect(jobs.results.every((job) => typeof job["rendered_at"] === "number"))
            .toBe(true);
    });
    it("sends immutable artwork references instead of image bytes in direct mode", async () => {
        const env = { DB: testPlatform().env.DB, DESIGN_ARTWORK: testPlatform().env.DESIGN_ARTWORK };
        const digest = await crypto.subtle.digest("SHA-256", ARTWORK);
        const sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
        await ensureStoryVideoJobs(env, SHIRT_ID);
        await renderStoryVideoRevisionBatch({
            ...env,
            STORY_VIDEO_TRANSPORT: "direct",
            STORY_VIDEO_RENDERER: {
                fetch: async (input, init) => {
                    const payload: unknown = await new Request(input, init).json();
                    expect(payload).toMatchObject({ shared: { artworkRef: {
                                size: ARTWORK.length, sha256,
                                key: `designs/${DESIGN_ID}/artwork/${sha256}`,
                            } } });
                    expect(JSON.stringify(payload)).not.toContain("base64");
                    return Response.json({ results: renderResults(payload) });
                },
            },
        }, REVISION_ID);
    });
    it("keeps each streamed success ready if the remaining renders fail", async () => {
        const env = { DB: testPlatform().env.DB, DESIGN_ARTWORK: testPlatform().env.DESIGN_ARTWORK };
        await ensureStoryVideoJobs(env, SHIRT_ID);
        await ensureStoryVideoJobs(env, TOTE_ID);
        const release = deferred();
        const firstSent = deferred();
        const encoder = new TextEncoder();
        const rendering = renderStoryVideoRevisionBatch({
            ...env,
            STORY_VIDEO_RENDERER: {
                fetch: async (input, init) => {
                    const request = new Request(input, init);
                    expect(request.headers.get("accept")).toBe("application/x-ndjson");
                    const payload: unknown = await request.json();
                    const first = renderResults(payload)[0];
                    return new Response(new ReadableStream<Uint8Array>({
                        async start(controller) {
                            controller.enqueue(encoder.encode(`${JSON.stringify({ type: "ready", ...first })}\n`));
                            firstSent.resolve();
                            await release.promise;
                            controller.enqueue(encoder.encode('{"type":"error","error":"failed"}\n'));
                            controller.close();
                        },
                    }), { headers: { "content-type": "application/x-ndjson" } });
                },
            },
        }, REVISION_ID);
        const failed = expect(rendering).rejects.toThrow("could not complete");
        await firstSent.promise;
        await vi.waitFor(async () => {
            const ready = await env.DB.prepare("SELECT count(*) AS count FROM story_video_jobs WHERE status = 'ready'")
                .first<{
                count: number;
            }>();
            expect(ready?.count).toBe(1);
        });
        release.resolve();
        await failed;
        const jobs = await env.DB.prepare("SELECT status FROM story_video_jobs").all<{
            status: string;
        }>();
        expect(jobs.results.filter((job) => job.status === "ready")).toHaveLength(1);
        expect(jobs.results.filter((job) => job.status === "failed")).toHaveLength(3);
        let retried = 0;
        await renderStoryVideoRevisionBatch({
            ...env,
            STORY_VIDEO_RENDERER: {
                fetch: async (input, init) => {
                    const results = renderResults(await new Request(input, init).json());
                    retried = results.length;
                    return Response.json({ results });
                },
            },
        }, REVISION_ID);
        expect(retried).toBe(3);
    });
    it("streams the current family snapshot on reconnect, without leaking other products", async () => {
        const env = { DB: testPlatform().env.DB, DESIGN_ARTWORK: testPlatform().env.DESIGN_ARTWORK };
        await ensureStoryVideoJobs(env, SHIRT_ID);
        await ensureStoryVideoJobs(env, TOTE_ID);
        await env.DB.prepare("UPDATE story_video_jobs SET status = 'ready'").run();
        const request = new Request("https://api.example.com/events");
        for (const productId of [SHIRT_ID, TOTE_ID]) {
            const response = await storyVideoEvents(request, env.DB, productId);
            expect(response.headers.get("content-type")).toBe("text/event-stream");
            const body = await response.text();
            expect(body.match(/event: video/g)).toHaveLength(4);
            expect(body).toContain(SHIRT_ID);
            expect(body).toContain(TOTE_ID);
            expect(body).toContain("event: complete");
            expect(body).not.toContain("story-videos/v7");
        }
        expect((await storyVideoEvents(request, env.DB, crypto.randomUUID())).status).toBe(404);
    });
    it("stops the pending status stream when a client disconnects", async () => {
        const response = await storyVideoEvents(new Request("https://api.example.com/events"), testPlatform().env.DB, SHIRT_ID);
        const reader = response.body?.getReader();
        expect((await reader?.read())?.done).toBe(false);
        await reader?.cancel();
        expect((await reader?.read())?.done).toBe(true);
    });
    it("falls back to a fresh polling snapshot when the notification object is unavailable", async () => {
        const env = { DB: testPlatform().env.DB, DESIGN_ARTWORK: testPlatform().env.DESIGN_ARTWORK };
        await ensureStoryVideoJobs(env, [SHIRT_ID, TOTE_ID]);
        await env.DB.prepare("UPDATE story_video_jobs SET status = 'ready'").run();
        const response = await storyVideoEvents(new Request("https://api.example.com/events"), env.DB, SHIRT_ID, {
            STORY_VIDEO_NOTIFICATION_MODE: "push", STORY_VIDEO_NOTIFICATIONS: {
                getByName: (revisionId) => {
                    expect(revisionId).toBe(REVISION_ID);
                    return { fetch: () => Promise.resolve(new Response(null, { status: 503 })) };
                },
            },
        });
        const body = await response.text();
        expect(body).toContain("notification-mode=poll");
        expect(body.match(/event: video/g)).toHaveLength(4);
        expect(body).toContain("event: complete");
    });
});
