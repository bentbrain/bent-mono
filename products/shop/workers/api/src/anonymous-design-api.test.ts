import { withDatabasePrepare } from "./test-database";
import { completePendingProductFamilies } from "./pending-product-families";
import { ensureStoryVideoJobs } from "./story-video-jobs";
import { storyVideoEvents } from "./story-video-events";
import { productImageResponse, productPreviewResponse } from "./product-images";
import { executeArtworkPreparation, recoverArtworkPreparation } from "./artwork-preparation-jobs";
import { fixtureR2Streams } from "./testing/r2-proxy-streams";
import { printPng } from "./testing/print-png";
import { readFile } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getPlatformProxy, type PlatformProxy } from "wrangler";
import { Effect, Schema } from "effect";
import { artworkPreviewKey } from "./artwork-preview";
import { deleteOwnedDesign, drainDesignAssetDeletions } from "./design-deletion";
import { projectEditorPlacement, SavedDesignsSchema, SavedDesignPageSchema, type ProductPlacement, } from "@forever-tee/contracts";
import { handleAnonymousDesignRequest, PROCESSING_LEASE_MS, } from "./anonymous-design-api";
import { handleRequest } from "./index";
import { SAVED_DESIGNS_QUERY } from "./saved-design-pages";
import { productPurchaseReadiness } from "./product-purchase-readiness";
import { PRINT_BUFFER_BUDGET, printBufferAdmission } from "./print-asset-memory";
import { consumePrintAssetQueue, enqueuePrintAssetJobs, recoverPrintAssetJobs, executePrintAssetFamily } from "./print-asset-jobs";
import { deferProvider, takeProviderToken } from "./provider-admission";
import { SafetyScreeningFailure, type SafetyScreeningClient, type SafetyScreeningDecision, } from "./openai-safety-screening";
import { ProductColorAnalysisFailure, type ProductColorAnalysisClient, type ProductColorAnalysisDecision, } from "./product-color-analysis";
import { reconcileConfiguredProductPrintAssets, withPrintAssetRenderSlot, } from "./print-assets";
const SECRET = "worker-test-shared-secret";
const OPERATIONS_SECRET = "worker-test-operations-secret";
const FAMILY_CONFIGURATION: NonNullable<Env["STORY_VIDEO_FAMILY_CONFIGURATION"]> = "1";
const OWNER_A = "a".repeat(64);
const OWNER_B = "b".repeat(64);
const BASE_PRODUCT_ID = "a51b7acf-77e9-4762-83c4-62d96dd8942c";
const TOTE_BASE_PRODUCT_ID = "97b629d7-1d3b-4d2a-a586-537168141e97";
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
let imageTransformCount = 0;
let activeImageOutputs = 0;
let peakImageOutputs = 0;
let failImageProcessing = false;
let largePrintOutput = false;
let failSegmentation = false;
let failInlinePreview = false;
let ownerRateAllowed = true;
let imageRateAllowed = true;
let legacyMutationAllowed = true;
let imageProcessingWait = Promise.resolve();
let markImageProcessingStarted: (() => void) | undefined;
let releaseImageProcessing: (() => void) | undefined;
let imageOutputWait = Promise.resolve();
let markImageOutputStarted: (() => void) | undefined;
let releaseImageOutput: (() => void) | undefined;
let safetyScreeningResult: Effect.Effect<SafetyScreeningDecision, SafetyScreeningFailure> = Effect.succeed({
    decision: "allowed",
    model: "omni-moderation-2024-09-26",
});
let safetyScreeningWait = Promise.resolve();
let markSafetyScreeningStarted: (() => void) | undefined;
let releaseSafetyScreening: (() => void) | undefined;
let moderationPreviewBytes = 0;
let productColorAnalysisResult: Effect.Effect<ProductColorAnalysisDecision, ProductColorAnalysisFailure> = Effect.succeed({ color: "Black", model: "gpt-5.6-luna" });
let platform: PlatformProxy<Env> | undefined;
function pngDimensions(bytes: Uint8Array) {
    if (bytes.byteLength < 24 || bytes[0] !== 137 || bytes[1] !== 80 ||
        bytes[2] !== 78 || bytes[3] !== 71)
        return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { height: view.getUint32(20), width: view.getUint32(16) };
}
function fakePng(width: number, height: number) {
    return printPng(width, height);
}
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}
function testPlatform() {
    if (!platform)
        throw new Error("Test bindings are unavailable.");
    return platform;
}
function workerEnv(options: {
    readonly productColorAnalysis?: ProductColorAnalysisClient;
} = { productColorAnalysis: fakeProductColorAnalysis }) {
    const bindings = testPlatform().env;
    const storyVideos = bindings.STORY_VIDEOS;
    if (!storyVideos)
        throw new Error("Story video test binding is unavailable.");
    return {
        DB: bindings.DB,
        DESIGN_ARTWORK: fixtureR2Streams(bindings.DESIGN_ARTWORK),
        STORY_VIDEOS: storyVideos,
        IMAGES: fakeImages,
        OWNER_MUTATION_RATE_LIMIT: fakeRateLimit(() => ownerRateAllowed),
        IMAGE_PROCESS_RATE_LIMIT: fakeRateLimit(() => imageRateAllowed),
        LEGACY_IMAGE_PROCESS_RATE_LIMIT: fakeRateLimit(() => imageRateAllowed),
        LEGACY_MUTATION_RATE_LIMIT: fakeRateLimit(() => legacyMutationAllowed),
        BENT_SHIRT_OPERATIONS_SECRET: OPERATIONS_SECRET,
        FOREVER_TEE_API_SHARED_SECRET: SECRET,
        OPENAI_API_KEY: "not-used-by-injected-test-client",
        SAFETY_SCREENING: fakeSafetyScreening,
        ...(options.productColorAnalysis ? { PRODUCT_COLOR_ANALYSIS: options.productColorAnalysis } : {}),
        STORY_VIDEO_FAMILY_CONFIGURATION: FAMILY_CONFIGURATION,
    };
}
function fakeRateLimit(allowed: () => boolean) {
    return { limit() { return Promise.resolve({ success: allowed() }); } };
}
const fakeImages: ImagesBinding = {
    text() { throw new Error("Image text is not used by this fixture."); },
    hosted: {
        createDirectUpload() { throw new Error("Hosted uploads are not used by this fixture."); },
        image() {
            throw new Error("Hosted Images is not used in this test.");
        },
        list() {
            return Promise.reject(new Error("Hosted Images is not used in this test."));
        },
        upload() {
            return Promise.reject(new Error("Hosted Images is not used in this test."));
        },
    },
    async info(stream) {
        const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
        const dimensions = pngDimensions(bytes);
        if (dimensions !== null) {
            return {
                fileSize: bytes.byteLength,
                format: "image/png",
                height: dimensions.height,
                width: dimensions.width,
            };
        }
        return { fileSize: bytes.byteLength, format: bytes[0] === 82 ? "image/webp" : "image/jpeg", height: 4000, width: 3000 };
    },
    input(stream: ReadableStream<Uint8Array>) {
        const intrinsicDimensions = new Response(stream).arrayBuffer().then((buffer) => pngDimensions(new Uint8Array(buffer)));
        const drawnStreams: Promise<ArrayBuffer>[] = [];
        let height = 0;
        let paidTransform = false;
        let width = 0;
        const transformer = {
            transform(options: ImageTransform) {
                if (options.segment === "foreground")
                    paidTransform = true;
                if (width === 0 && height === 0) {
                    width = options.width ?? 0;
                    height = options.height ?? 0;
                }
                return transformer;
            },
            draw(image: ReadableStream<Uint8Array> | ImageTransformer) {
                // Grouped compositions draw staged R2 streams directly. Consume those
                // inputs as Images does, so their source pipes can settle before cleanup.
                if (image instanceof ReadableStream)
                    drawnStreams.push(new Response(image).arrayBuffer());
                return transformer;
            },
            async output(options: ImageOutputOptions) {
                const dimensions = await intrinsicDimensions;
                await Promise.all(drawnStreams);
                if (width === 0 && height === 0) {
                    width = dimensions?.width ?? 3000;
                    height = dimensions?.height ?? 4000;
                }
                activeImageOutputs += 1;
                peakImageOutputs = Math.max(peakImageOutputs, activeImageOutputs);
                try {
                    await new Promise<void>((resolve) => setTimeout(resolve, 10));
                    markImageOutputStarted?.();
                    await imageOutputWait;
                    if (paidTransform)
                        imageTransformCount += 1;
                    if (paidTransform || (options.format === "image/webp" && options.quality === 100)) {
                        markImageProcessingStarted?.();
                        await imageProcessingWait;
                    }
                    const output = largePrintOutput && width > 2000
                        ? printPng(width, height, { paddingBytes: 22000000 }) : fakePng(width, height);
                    return {
                        response() {
                            // The real Images response is a byte stream with bounded BYOB
                            // reads. Node's Response(Buffer) fixture otherwise loses that.
                            return new Response(new ReadableStream<Uint8Array>({ type: "bytes", start(controller) {
                                    controller.enqueue(new Uint8Array(output));
                                    controller.close();
                                } }), {
                                status: failImageProcessing || (failSegmentation && paidTransform) ||
                                    (failInlinePreview && options.format === "image/webp" && options.quality === 90 && width <= 1600)
                                    ? 503
                                    : 200,
                                headers: { "content-type": "image/png" },
                            });
                        },
                        contentType() {
                            return "image/png";
                        },
                        image() {
                            return new ReadableStream<Uint8Array>({
                                start(controller) {
                                    controller.enqueue(output);
                                    controller.close();
                                },
                            });
                        },
                    };
                }
                finally {
                    activeImageOutputs -= 1;
                }
            },
        };
        return transformer;
    },
};
const fakeSafetyScreening: SafetyScreeningClient = {
    screen: (preview) => Effect.promise(async () => {
        moderationPreviewBytes = preview.bytes.byteLength;
        markSafetyScreeningStarted?.();
        await safetyScreeningWait;
    }).pipe(Effect.flatMap(() => safetyScreeningResult)),
};
const fakeProductColorAnalysis: ProductColorAnalysisClient = {
    analyze() {
        return productColorAnalysisResult;
    },
};
function delayImageProcessing() {
    let started: (() => void) | undefined;
    const processingStarted = new Promise<void>((resolve) => {
        started = resolve;
    });
    imageProcessingWait = new Promise<void>((resolve) => {
        releaseImageProcessing = resolve;
    });
    markImageProcessingStarted = started;
    return processingStarted;
}
function delayImageOutput() {
    let started: (() => void) | undefined;
    const outputStarted = new Promise<void>((resolve) => {
        started = resolve;
    });
    imageOutputWait = new Promise<void>((resolve) => {
        releaseImageOutput = resolve;
    });
    markImageOutputStarted = started;
    return outputStarted;
}
function delaySafetyScreening() {
    let started: (() => void) | undefined;
    const screeningStarted = new Promise<void>((resolve) => {
        started = resolve;
    });
    safetyScreeningWait = new Promise<void>((resolve) => {
        releaseSafetyScreening = resolve;
    });
    markSafetyScreeningStarted = started;
    return screeningStarted;
}
async function request(path: string, init: RequestInit = {}, owner = OWNER_A) {
    const headers = new Headers(init.headers);
    headers.set("x-forever-tee-service-secret", SECRET);
    headers.set("x-forever-tee-owner-id", owner);
    const response = await handleAnonymousDesignRequest(new Request(`https://api.example.com${path}`, { ...init, headers }), workerEnv());
    if (!response)
        throw new Error("Anonymous route was not handled.");
    return response;
}
async function rawRequest(path: string, init: RequestInit = {}) {
    return handleRequest(new Request(`https://api.example.com${path}`, init), workerEnv());
}
async function anonymousRawRequest(path: string, init: RequestInit = {}) {
    const response = await handleAnonymousDesignRequest(new Request(`https://api.example.com${path}`, init), workerEnv());
    if (!response)
        throw new Error("Anonymous route was not handled.");
    return response;
}
async function applyMigrations() {
    const db = testPlatform().env.DB;
    for (let index = 0; index <= 19; index += 1) {
        const prefix = String(index).padStart(4, "0");
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
        ];
        const name = files.find((candidate) => candidate.startsWith(prefix));
        if (!name)
            throw new Error(`Migration ${prefix} is missing.`);
        const sql = await readFile(new URL(`../drizzle/${name}`, import.meta.url), "utf8");
        for (const statement of sql.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) {
            await db.prepare(statement).run();
        }
    }
    const productionResources = await readFile(new URL("../drizzle/0021_printify_production_resources.sql", import.meta.url), "utf8");
    for (const statement of productionResources.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) {
        await db.prepare(statement).run();
    }
    const slots = await readFile(new URL("../drizzle/0022_print_asset_render_slots.sql", import.meta.url), "utf8");
    for (const statement of slots.split("--> statement-breakpoint")
        .map((value) => value.trim()).filter(Boolean)) {
        await db.prepare(statement).run();
    }
    const storageMaintenance = await readFile(new URL("../drizzle/0025_storage_maintenance.sql", import.meta.url), "utf8");
    for (const statement of storageMaintenance.split("--> statement-breakpoint")
        .map((value) => value.trim()).filter(Boolean)) {
        await db.prepare(statement).run();
    }
    const safetyScreening = await readFile(new URL("../drizzle/0026_portrait_safety_screening.sql", import.meta.url), "utf8");
    for (const statement of safetyScreening.split("--> statement-breakpoint")
        .map((value) => value.trim()).filter(Boolean)) {
        await db.prepare(statement).run();
    }
    const defaultProductColor = await readFile(new URL("../drizzle/0027_image_based_default_product_color.sql", import.meta.url), "utf8");
    for (const statement of defaultProductColor.split("--> statement-breakpoint")
        .map((value) => value.trim()).filter(Boolean)) {
        await db.prepare(statement).run();
    }
    const productColorAnalysisState = await readFile(new URL("../drizzle/0028_product_color_analysis_state.sql", import.meta.url), "utf8");
    for (const statement of productColorAnalysisState.split("--> statement-breakpoint")
        .map((value) => value.trim()).filter(Boolean)) {
        await db.prepare(statement).run();
    }
    const deletions = await readFile(new URL("../drizzle/0029_design_asset_deletions.sql", import.meta.url), "utf8");
    for (const statement of deletions.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) {
        await db.prepare(statement).run();
    }
    const recovery = await readFile(new URL("../drizzle/0033_print_recovery_and_scheduled_indexes.sql", import.meta.url), "utf8");
    await db.batch(recovery.split("--> statement-breakpoint")
        .map((value) => value.trim()).filter(Boolean).map((statement) => db.prepare(statement)));
    await db.prepare(await readFile(new URL("../drizzle/0034_saved_design_pages.sql", import.meta.url), "utf8")).run();
    const printJobs = await readFile(new URL("../drizzle/0036_print_job_outbox.sql", import.meta.url), "utf8");
    await db.batch(printJobs.split("--> statement-breakpoint").map(value => db.prepare(value.trim())));
    const printAdmission = await readFile(new URL("../drizzle/0037_print_running_admission.sql", import.meta.url), "utf8");
    await db.batch(printAdmission.split("--> statement-breakpoint").map(value => db.prepare(value.trim())));
    const composition = await readFile(new URL("../drizzle/0039_featured_media_composition.sql", import.meta.url), "utf8");
    for (const statement of composition.split("--> statement-breakpoint").map(value => value.trim()).filter(Boolean))
        await db.prepare(statement).run();
    const productImages = await readFile(new URL("../drizzle/0041_product_image_jobs.sql", import.meta.url), "utf8");
    for (const statement of productImages.split("--> statement-breakpoint"))
        await db.prepare(statement).run();
    const recursivePlacement = await readFile(new URL("../drizzle/0040_recursive_video_placement.sql", import.meta.url), "utf8");
    for (const statement of recursivePlacement.split("--> statement-breakpoint").map(value => value.trim()).filter(Boolean))
        await db.prepare(statement).run();
    const artworkPreparation = await readFile(new URL("../drizzle/0043_artwork_preparation_jobs.sql", import.meta.url), "utf8");
    for (const statement of artworkPreparation.split("--> statement-breakpoint"))
        await db.prepare(statement.trim()).run();
    const artworkSources = await readFile(new URL("../drizzle/0042_design_artwork_sources.sql", import.meta.url), "utf8");
    for (const statement of artworkSources.split("--> statement-breakpoint").map(value => value.trim()).filter(Boolean))
        await db.prepare(statement).run();
    await db.prepare(await readFile(new URL("../drizzle/0044_video_preview_revisions.sql", import.meta.url), "utf8")).run();
    const printStaging = await readFile(new URL("../drizzle/0038_print_staging.sql", import.meta.url), "utf8");
    await db.batch(printStaging.split("--> statement-breakpoint").map(value => db.prepare(value.trim())));
}
async function seedPrintGeometries() {
    const now = Date.now();
    await testPlatform().env.DB.batch([
        testPlatform().env.DB.prepare(`
      INSERT INTO printify_catalogue_snapshots (
        id, shop_id, blueprint_id, print_provider_id, retrieved_at,
        source_urls_json, variant_count, base_product_id, base_product_slug
      ) VALUES ('shirt-catalogue', 'shop', 1, 1, ?, '[]', 1, ?, 'staple-tee')
    `).bind(now, BASE_PRODUCT_ID),
        testPlatform().env.DB.prepare(`
      INSERT INTO printify_catalogue_variants (
        snapshot_id, printify_variant_id, colour, size, available,
        decoration_method, print_width, print_height, shipping_first_item,
        shipping_additional_item, shipping_currency, handling_days_from,
        handling_days_to
      ) VALUES ('shirt-catalogue', 1, 'Black', 'M', 1, 'dtg', 4500, 5100,
        1000, 500, 'AUD', 1, 3)
    `),
        testPlatform().env.DB.prepare(`
      INSERT INTO printify_catalogue_snapshots (
        id, shop_id, blueprint_id, print_provider_id, retrieved_at,
        source_urls_json, variant_count, base_product_id, base_product_slug
      ) VALUES ('tote-catalogue', 'shop', 2, 1, ?, '[]', 1, ?, 'cotton-tote')
    `).bind(now, TOTE_BASE_PRODUCT_ID),
        testPlatform().env.DB.prepare(`
      INSERT INTO printify_catalogue_variants (
        snapshot_id, printify_variant_id, colour, size, available,
        decoration_method, print_width, print_height, shipping_first_item,
        shipping_additional_item, shipping_currency, handling_days_from,
        handling_days_to
      ) VALUES ('tote-catalogue', 2, 'Cream', 'One size', 1, 'dtg', 3600, 4200,
        1000, 500, 'AUD', 1, 3)
    `),
    ]);
}
function printCatalogueStatements(snapshotId: string, baseProductId: string, handle: string) {
    const db = testPlatform().env.DB;
    const mappingId = `accepted-${snapshotId}`;
    return [db.prepare(`INSERT INTO shopify_variant_mapping_snapshots (
    id, catalogue_snapshot_id, shopify_product_id, shopify_product_handle,
    shopify_product_title, retrieved_at, source_url, variant_count, base_product_id, base_product_slug
  ) SELECT ?, id, 'gid://shopify/Product/' || ?, ?, 'fixture', retrieved_at,
    'https://example.invalid/catalogue', variant_count, base_product_id, base_product_slug
    FROM printify_catalogue_snapshots WHERE id = ?`)
            .bind(mappingId, baseProductId, handle, snapshotId),
        db.prepare(`INSERT INTO shopify_variant_mappings (
    snapshot_id, shopify_variant_id, printify_variant_id, colour, size, sku, shopify_available
  ) SELECT ?, 'gid://shopify/ProductVariant/' || printify_variant_id,
    printify_variant_id, colour, size, NULL, 1 FROM printify_catalogue_variants WHERE snapshot_id = ?`)
            .bind(mappingId, snapshotId)];
}
async function acceptPrintCatalogue(snapshotId: string, baseProductId: string, handle: string) {
    await testPlatform().env.DB.batch(printCatalogueStatements(snapshotId, baseProductId, handle));
}
async function seedCurrentShirtGeometries(geometries: readonly {
    width: number;
    height: number;
}[], revision = 1, accepted = true) {
    const db = testPlatform().env.DB;
    const snapshotId = revision === 1 ? "phone-shirt-catalogue" : `phone-shirt-catalogue-${String(revision)}`;
    await db.prepare(`
    INSERT INTO printify_catalogue_snapshots
      (id, shop_id, blueprint_id, print_provider_id, retrieved_at,
        source_urls_json, variant_count, base_product_id, base_product_slug)
    SELECT ?, shop_id, blueprint_id, print_provider_id,
      retrieved_at + ?, source_urls_json, ?, base_product_id, base_product_slug
    FROM printify_catalogue_snapshots WHERE id = 'shirt-catalogue'
  `).bind(snapshotId, revision, Math.max(1, geometries.length)).run();
    for (const [index, geometry] of geometries.entries()) {
        await db.prepare(`
      INSERT INTO printify_catalogue_variants
        (snapshot_id, printify_variant_id, colour, size, available,
          decoration_method, print_width, print_height, shipping_first_item,
          shipping_additional_item, shipping_currency, handling_days_from, handling_days_to)
      VALUES (?, ?, 'Black', ?, 1, 'dtg', ?, ?, 1000, 500, 'AUD', 1, 3)
    `).bind(snapshotId, index + 1, String(index), geometry.width, geometry.height).run();
    }
    if (accepted)
        await acceptPrintCatalogue(snapshotId, BASE_PRODUCT_ID, "bent-shirt");
}
async function createDraft() {
    const response = await request("/v2/design-drafts", { method: "POST" });
    const payload: unknown = await response.json();
    if (typeof payload !== "object" || payload === null || !("id" in payload) || typeof payload.id !== "string") {
        throw new Error("Draft response did not include an id.");
    }
    return payload.id;
}
async function makeDraftReady(id: string, dimensions = { height: 4000, width: 3000 }) {
    const artwork = new Uint8Array([1, 2, 3, 4]);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", artwork));
    const sha256 = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
    const artworkKey = `designs/${id}/artwork/${sha256}`;
    await testPlatform().env.DB.prepare(`
    UPDATE designs SET artwork_key = ?, content_type = 'image/png', byte_size = 4,
      artwork_width = ?, artwork_height = ?, sha256 = ?, status = 'ready'
    WHERE id = ?
  `).bind(artworkKey, dimensions.width, dimensions.height, sha256, id).run();
    await testPlatform().env.DESIGN_ARTWORK.put(artworkKey, artwork, {
        sha256: digest,
    });
}
async function configure(id: string, expectedVersion = 0, owner = OWNER_A, baseProductId = BASE_PRODUCT_ID, placement?: ProductPlacement) {
    return request("/v2/configured-products", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            baseProductId,
            designId: id,
            expectedVersion,
            ...(placement ? { placement } : {}),
        }),
    }, owner);
}
async function configureFamily(id: string, expectedVersion = 0, owner = OWNER_A, baseProductIds = [BASE_PRODUCT_ID, TOTE_BASE_PRODUCT_ID]) {
    return request("/v2/configured-product-families", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ designId: id, expectedVersion, baseProductIds }),
    }, owner);
}
// These exercise complete creation/deletion flows across local D1 and R2.
// Leave room for the emulators when builds share a constrained CI runner.
describe("saved designs", { timeout: 15000 }, () => {
    async function seedHistory(count: number) {
        const db = testPlatform().env.DB;
        await db.prepare(`WITH RECURSIVE sequence(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM sequence WHERE n < ?)
      INSERT INTO designs(id, owner_id, artwork_key, content_type, byte_size, sha256,
        crop_x, crop_y, crop_zoom, placement_x, placement_y, placement_width, depth,
        status, finalized_at, created_at, updated_at)
      SELECT '00000000-0000-4000-8000-' || printf('%012d',n), ?, 'history/' || n, 'image/png', 4, 'hash',
        0.5, 0.5, 1, 0.3, 0.3, 0.2, 5, 'ready', 1700000000000 + n/3, 1700000000000, 1700000000000 FROM sequence
    `).bind(count, OWNER_A).run();
        await db.prepare(`INSERT INTO products(id, base_product_id, design_id, shopify_handle, status, created_at)
      SELECT '10000000' || substr(id,9), ?, id, 'bent-shirt', 'active', 1700000000000 FROM designs WHERE artwork_key LIKE 'history/%'
    `).bind(BASE_PRODUCT_ID).run();
    }
    async function page(cursor?: string, owner = OWNER_A) {
        const response = await request(`/v2/design-drafts?page=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, {}, owner);
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("private, no-store");
        return Schema.decodeUnknownSync(SavedDesignPageSchema)(await response.json());
    }
    it("pages tied timestamps without losing stable items when designs finish or disappear", async () => {
        await seedHistory(85);
        const baseline = Schema.decodeUnknownSync(SavedDesignsSchema)(await (await request("/v2/design-drafts")).json());
        const first = await page();
        expect(first.items).toEqual(baseline.slice(0, 40));
        if (!first.nextCursor || !first.items[0] || !baseline[52])
            throw new Error("Expected a multi-page history.");
        const db = testPlatform().env.DB;
        // Delete the cursor row too: continuation relies on its values, not its presence.
        const cursorId = first.items.at(-1)?.id;
        if (!cursorId)
            throw new Error("Missing cursor row.");
        await db.prepare("UPDATE designs SET deleted_at=1 WHERE id IN (?,?)").bind(cursorId, baseline[52].id).run();
        const newer = await createDraft();
        await makeDraftReady(newer);
        expect((await configureFamily(newer)).status).toBe(201);
        const second = await page(first.nextCursor);
        if (!second.nextCursor)
            throw new Error("Expected final page.");
        const last = await page(second.nextCursor);
        expect(last.nextCursor).toBeNull();
        const remainder = [...second.items, ...last.items];
        expect(remainder).toEqual(baseline.slice(40).filter(item => item.id !== baseline[52]?.id));
        expect(new Set([...first.items, ...remainder].map(item => item.id)).size).toBe(84);
        expect((await page()).items[0]?.id).toBe(newer);
        expect(await page(undefined, OWNER_B)).toEqual({ items: [], nextCursor: null });
        expect((await anonymousRawRequest("/v2/design-drafts?page=1")).status).toBe(401);
    });
    it("bounds large histories and uses the owner/order index for initial and deep pages", async () => {
        await seedHistory(10000);
        const start = performance.now();
        const first = await page();
        expect(first.items).toHaveLength(40);
        expect(JSON.stringify(first).length).toBeLessThan(8000);
        const db = testPlatform().env.DB;
        for (const { condition, parameters } of [
            { condition: "", parameters: [OWNER_A] },
            { condition: "AND (designs.finalized_at, designs.id) < (?, ?)", parameters: [OWNER_A, 1700000000300, "00000000-0000-4000-8000-000000000900"] },
        ]) {
            const plan = await db.prepare(`EXPLAIN QUERY PLAN ${SAVED_DESIGNS_QUERY} ${condition} ORDER BY designs.finalized_at DESC, designs.id DESC LIMIT 41`)
                .bind(...parameters).all<{
                detail: string;
            }>();
            expect(plan.results.some(row => row.detail.includes("designs_owner_finalized_idx"))).toBe(true);
            // Only the product-per-design choice may sort, never the owner history.
            expect(plan.results.filter(row => row.detail.includes("TEMP B-TREE FOR ORDER BY"))).toHaveLength(1);
            if (condition)
                expect(plan.results.some(row => row.detail.includes("(finalized_at,id)<(?,?)"))).toBe(true);
        }
        console.info("Saved-design page fixture", JSON.stringify({ history: 10000, returned: first.items.length,
            jsonBytes: JSON.stringify(first).length, elapsedMs: Math.round(performance.now() - start) }));
    });
    it("rejects invalid and unbounded pagination requests", async () => {
        for (const query of ["page=0", "page=2", "page=1&limit=10000", "page=1&page=1", "cursor=x", "page=1&cursor=", "page=1&cursor=x",
            "page=1&cursor=v1.9999999999999999.00000000-0000-4000-8000-000000000001", "page=1&cursor=x&cursor=y"]) {
            expect((await request(`/v2/design-drafts?${query}`)).status).toBe(400);
        }
    });
    it("lists one mockup per completed design for its owner, newest first", async () => {
        const first = await createDraft();
        await makeDraftReady(first);
        expect((await configureFamily(first)).status).toBe(201);
        const second = await createDraft();
        await makeDraftReady(second);
        expect((await configure(second, 0, OWNER_A, TOTE_BASE_PRODUCT_ID)).status).toBe(201);
        await createDraft();
        const list = await request("/v2/design-drafts");
        expect(list.headers.get("cache-control")).toBe("private, no-store");
        const saved = Schema.decodeUnknownSync(SavedDesignsSchema)(await list.json());
        expect(saved.map((design) => ({ id: design.id, color: design.color }))).toEqual([
            { id: second, color: "Cream" },
            { id: first, color: "White" },
        ]);
        expect(await (await request("/v2/design-drafts", {}, OWNER_B)).json()).toEqual([]);
        expect((await anonymousRawRequest("/v2/design-drafts")).status).toBe(401);
    });
    it("revokes public access and removes artwork, old previews, videos and unused print assets", async () => {
        const id = await createDraft();
        await makeDraftReady(id);
        await configureFamily(id);
        const db = testPlatform().env.DB;
        const before = await db.prepare("SELECT artwork_key, sha256 FROM designs WHERE id = ?")
            .bind(id).first<{
            artwork_key: string;
            sha256: string;
        }>();
        if (!before)
            throw new Error("Expected design");
        const product = await db.prepare("SELECT id, design_revision_id FROM products WHERE design_id = ? LIMIT 1")
            .bind(id).first<{
            id: string;
            design_revision_id: string;
        }>();
        if (!product)
            throw new Error("Expected configured product");
        const preview = artworkPreviewKey(id, before.sha256);
        const olderPreview = `designs/${id}/artwork-preview-old.webp`;
        await workerEnv().DESIGN_ARTWORK.put(preview, "preview");
        await workerEnv().DESIGN_ARTWORK.put(olderPreview, "old-preview");
        const video = `story-videos/${product.design_revision_id}/video.mp4`;
        await workerEnv().STORY_VIDEOS.put(video, "video");
        await db.prepare(`INSERT INTO story_video_jobs
      (id, product_id, design_revision_id, colour, renderer_version, story_key, status, attempt_count, created_at, updated_at)
      VALUES (?, ?, ?, 'Black', 'story-video-renderer-v7', ?, 'queued', 0, ?, ?)
    `).bind(crypto.randomUUID(), product.id, product.design_revision_id, video, Date.now(), Date.now()).run();
        expect((await request(`/v2/design-drafts/${id}`, { method: "DELETE" }, OWNER_B)).status).toBe(404);
        expect((await request(`/v2/design-drafts/${id}`, { method: "DELETE" })).status).toBe(200);
        expect((await request(`/v2/design-drafts/${id}`)).status).toBe(404);
        expect((await rawRequest(`/v1/designs/${id}`)).status).toBe(404);
        expect((await rawRequest(`/v1/products/${product.id}`)).status).toBe(404);
        expect(await (await request("/v2/design-drafts")).json()).toEqual([]);
        for (const key of [before.artwork_key, preview, olderPreview]) {
            expect(await workerEnv().DESIGN_ARTWORK.head(key)).toBeNull();
        }
        expect(await workerEnv().STORY_VIDEOS.head(video)).toBeNull();
        expect((await db.prepare("SELECT id FROM print_assets WHERE configured_product_id = ?").bind(product.id).all()).results).toEqual([]);
        expect((await db.prepare("SELECT id FROM design_revisions WHERE design_id = ?").bind(id).all()).results).toEqual([]);
        expect((await request(`/v2/design-drafts/${id}`, { method: "DELETE" })).status).toBe(200);
    });
    it("retries failed object deletion from the durable queue", async () => {
        const id = await createDraft();
        await makeDraftReady(id);
        await configure(id);
        const env = workerEnv();
        const key = (await env.DB.prepare("SELECT artwork_key FROM designs WHERE id = ?").bind(id).first<{
            artwork_key: string;
        }>())?.artwork_key;
        if (!key)
            throw new Error("Expected artwork");
        const bucket = env.DESIGN_ARTWORK;
        const failingEnv = { ...env, DESIGN_ARTWORK: {
                list: bucket.list.bind(bucket),
                delete: () => Promise.reject(new Error("R2 unavailable")),
            } };
        expect(await deleteOwnedDesign(failingEnv, OWNER_A, id)).toMatchObject({ id });
        expect(await bucket.head(key)).not.toBeNull();
        expect((await env.DB.prepare("SELECT storage_key FROM design_asset_deletions WHERE design_id = ?").bind(id).all()).results.length).toBeGreaterThan(0);
        await drainDesignAssetDeletions(env);
        expect(await bucket.head(key)).toBeNull();
        expect((await env.DB.prepare("SELECT storage_key FROM design_asset_deletions WHERE design_id = ?").bind(id).all()).results).toEqual([]);
    });
    it("keeps a shared print file until its last design is deleted", async () => {
        const first = await createDraft();
        await makeDraftReady(first);
        await configure(first);
        const second = await createDraft();
        await makeDraftReady(second);
        await configure(second);
        const env = workerEnv();
        const shared = await env.DB.prepare(`
      SELECT objects.storage_key, count(*) AS references_count FROM print_assets AS assets
      JOIN print_asset_objects AS objects ON objects.sha256 = assets.object_sha256
      GROUP BY objects.sha256 HAVING count(*) = 2
    `).first<{
            storage_key: string;
            references_count: number;
        }>();
        if (!shared)
            throw new Error("Expected the shared print file");
        await deleteOwnedDesign(env, OWNER_A, first);
        expect(await env.DESIGN_ARTWORK.head(shared.storage_key)).not.toBeNull();
        expect((await rawRequest(`/v1/designs/${second}`)).status).toBe(200);
        await deleteOwnedDesign(env, OWNER_A, second);
        expect(await env.DESIGN_ARTWORK.head(shared.storage_key)).toBeNull();
    });
});
beforeAll(async () => {
    vi.stubGlobal("IdentityTransformStream", TransformStream);
    // Node has no FixedLengthStream; the R2 proxy fixture adapter above handles
    // length loss across that transport. Native qualification uses workerd's.
    vi.stubGlobal("FixedLengthStream", class extends TransformStream<Uint8Array, Uint8Array> {
        constructor(readonly byteLength: number) { super(); }
    });
    platform = await getPlatformProxy<Env>({
        configPath: new URL("../wrangler.jsonc", import.meta.url).pathname,
        persist: false,
        remoteBindings: false,
    });
    await applyMigrations();
    await seedPrintGeometries();
}, 30000);
afterEach(() => {
    // A completed request must release its print buffers; resetting this pool
    // would hide unfinished stream work and let later tests inherit the leak.
    expect(printBufferAdmission.occupied).toBe(0);
});
beforeEach(async () => {
    imageTransformCount = 0;
    activeImageOutputs = 0;
    peakImageOutputs = 0;
    failImageProcessing = false;
    largePrintOutput = false;
    failSegmentation = false;
    failInlinePreview = false;
    ownerRateAllowed = true;
    imageRateAllowed = true;
    legacyMutationAllowed = true;
    imageProcessingWait = Promise.resolve();
    markImageProcessingStarted = undefined;
    releaseImageProcessing = undefined;
    imageOutputWait = Promise.resolve();
    markImageOutputStarted = undefined;
    releaseImageOutput = undefined;
    safetyScreeningResult = Effect.succeed({
        decision: "allowed",
        model: "omni-moderation-2024-09-26",
    });
    safetyScreeningWait = Promise.resolve();
    markSafetyScreeningStarted = undefined;
    releaseSafetyScreening = undefined;
    moderationPreviewBytes = 0;
    productColorAnalysisResult = Effect.succeed({
        color: "Black",
        model: "gpt-5.6-luna",
    });
    // One ordered D1 batch avoids repeated emulator round trips for every test.
    // All application requests still execute against the real local D1 bindings.
    await testPlatform().env.DB.batch([
        testPlatform().env.DB.prepare("DELETE FROM provider_admission"),
        testPlatform().env.DB.prepare("DELETE FROM design_asset_deletions"),
        testPlatform().env.DB.prepare("DELETE FROM story_video_jobs"),
        testPlatform().env.DB.prepare("DELETE FROM print_assets"),
        testPlatform().env.DB.prepare("DELETE FROM print_asset_objects"),
        testPlatform().env.DB.prepare("DELETE FROM shopify_variant_mappings"),
        testPlatform().env.DB.prepare("DELETE FROM shopify_variant_mapping_snapshots"),
        testPlatform().env.DB.prepare("DELETE FROM printify_catalogue_variants WHERE snapshot_id LIKE 'phone-shirt-catalogue%'"),
        testPlatform().env.DB.prepare("DELETE FROM printify_catalogue_snapshots WHERE id LIKE 'phone-shirt-catalogue%'"),
        testPlatform().env.DB.prepare("DELETE FROM design_upload_grants"),
        testPlatform().env.DB.prepare("DELETE FROM products"),
        testPlatform().env.DB.prepare("DELETE FROM design_revisions"),
        testPlatform().env.DB.prepare("DELETE FROM designs"),
        testPlatform().env.DB.prepare("DELETE FROM paid_operation_usage"),
        testPlatform().env.DB.prepare(`
      UPDATE print_asset_render_slots
      SET lease_id = NULL, lease_expires_at = NULL
    `),
        testPlatform().env.DB.prepare(`
      INSERT INTO products (
        id, base_product_id, design_id, design_revision_id, shopify_handle,
        status, created_at, deleted_at
      ) VALUES (?, ?, NULL, NULL, 'bent-shirt', 'active', ?, NULL)
    `).bind(BASE_PRODUCT_ID, BASE_PRODUCT_ID, Date.now()),
        testPlatform().env.DB.prepare(`
      INSERT INTO products (
        id, base_product_id, design_id, design_revision_id, shopify_handle,
        status, created_at, deleted_at
      ) VALUES (?, ?, NULL, NULL, 'cotton-tote', 'active', ?, NULL)
    `).bind(TOTE_BASE_PRODUCT_ID, TOTE_BASE_PRODUCT_ID, Date.now()),
        ...printCatalogueStatements("shirt-catalogue", BASE_PRODUCT_ID, "bent-shirt"),
        ...printCatalogueStatements("tote-catalogue", TOTE_BASE_PRODUCT_ID, "cotton-tote"),
    ]);
});
afterAll(async () => platform?.dispose());
describe("anonymous draft ownership", () => {
    it("expires obsolete path capabilities before service or storage work and logging", async () => {
        const env = { ...workerEnv(), WEB_ORIGIN: "https://shop.example.com", get DB(): never {
                throw new Error("Obsolete upload requests must not access the database.");
            } };
        const response = await handleRequest(new Request(`https://api.example.com/v2/design-upload-grants/${"a".repeat(43)}`, {
            method: "PUT", body: "private artwork", headers: { origin: "https://shop.example.com" },
        }), env);
        expect(response.status).toBe(410);
        expect(await response.json()).toMatchObject({ error: { code: "UPLOAD_EXPIRED" } });
        expect(response.headers.get("x-request-id")).toMatch(/^[a-f0-9-]{36}$/);
        expect(response.headers.get("access-control-allow-origin")).toBe("https://shop.example.com");
    });
    it("correlates early non-design service rejections", async () => {
        const response = await rawRequest("/v2/internal/sales-intake", {
            headers: { "x-request-id": "launch-service-request" },
        });
        expect(response.status).toBe(401);
        expect(response.headers.get("x-request-id")).toBe("launch-service-request");
    });
    it.each(["https://shop.example.com", "https://untrusted.example.com"])("limits browser network timings to allowed origins: %s", async (origin) => {
        const response = await handleRequest(new Request("https://api.example.com/v2/design-upload-grants/test", {
            method: "OPTIONS", headers: { origin },
        }), { ...workerEnv(), WEB_ORIGIN: "https://shop.example.com" });
        expect(response.headers.get("timing-allow-origin"))
            .toBe(origin === "https://shop.example.com" ? origin : null);
    });
    it("returns correlation and timing headers from the Worker boundary", async () => {
        const response = await rawRequest("/v2/design-drafts", {
            headers: { "x-request-id": "request-123" },
        });
        expect(response.status).toBe(401);
        expect(response.headers.get("x-request-id")).toBe("request-123");
        expect(response.headers.get("server-timing")).toMatch(/^worker;dur=\d+$/);
    });
    it("requires service authentication for the paid preview endpoint", async () => {
        const denied = await anonymousRawRequest("/v2/background-removal?quality=preview", {
            method: "POST",
            headers: { "content-type": "image/jpeg" },
            body: JPEG_BYTES,
        });
        expect(denied.status).toBe(401);
        const allowed = await request("/v2/background-removal?quality=preview", {
            method: "POST",
            headers: { "content-type": "image/jpeg" },
            body: JPEG_BYTES,
        });
        expect(allowed.status).toBe(200);
        expect(allowed.headers.get("content-type")).toBe("image/png");
    });
    it.each(["/v1/background-removal", "/v1/background-removal/", "/v1/%62ackground-removal", "/v1/designs", "/v1/products"])("retires obsolete writes before admission or body decode: %s", async path => {
        const decode = vi.spyOn(Request.prototype, "arrayBuffer");
        const incoming = new Request(`https://api.example.com${path}`, { method: "POST", body: JPEG_BYTES });
        const response = await handleRequest(incoming, workerEnv());
        expect(decode).not.toHaveBeenCalled();
        expect(response.status).toBe(410);
        expect(response.headers.get("Deprecation")).toBe("true");
        expect(imageTransformCount).toBe(0);
    });
    it("allows more than fifty unfinished designs without a rolling daily cap", async () => {
        const db = testPlatform().env.DB;
        const now = Date.now();
        await db.batch(Array.from({ length: 51 }, () => {
            const id = crypto.randomUUID();
            return db.prepare(`
        INSERT INTO designs (
          id, owner_id, artwork_key, content_type, byte_size, sha256,
          crop_x, crop_y, crop_zoom, placement_x, placement_y, placement_width,
          depth, status, version, created_at, updated_at
        ) VALUES (?, ?, ?, 'image/png', 4, '', 0.5, 0.5, 1,
          0.39, 0.43, 0.22, 5, 'ready', 0, ?, ?)
      `).bind(id, OWNER_A, `designs/${id}/artwork`, now, now);
        }));
        expect((await request("/v2/design-drafts", { method: "POST" })).status).toBe(201);
        expect(await db.prepare("SELECT COUNT(*) AS count FROM designs WHERE owner_id = ? AND finalized_at IS NULL").bind(OWNER_A).first("count")).toBe(52);
    });
    it("blocks bursts of new drafts with a short retry window", async () => {
        imageRateAllowed = false;
        const response = await request("/v2/design-drafts", { method: "POST" });
        expect(response.status).toBe(429);
        expect(response.headers.get("Retry-After")).toBe("60");
        const count = await testPlatform().env.DB.prepare("SELECT COUNT(*) AS count FROM designs WHERE owner_id = ?").bind(OWNER_A).first();
        expect(count?.["count"]).toBe(0);
    });
    it.each(["artwork", "artwork/background-removal"])("rejects legacy %s before processing for owned, unowned and missing targets", async suffix => {
        const owned = await createDraft();
        const unowned = await createDraft();
        await testPlatform().env.DB.prepare("UPDATE designs SET owner_id = NULL WHERE id = ?").bind(unowned).run();
        for (const id of [owned, unowned, crypto.randomUUID(), "%31" + "1111111-1111-4111-8111-111111111111"]) {
            const decode = vi.spyOn(Request.prototype, "arrayBuffer");
            const incoming = new Request(`https://api.example.com/v1/designs/${id}/${suffix}`, {
                method: "PUT", headers: { "content-type": "image/jpeg", "content-length": String(JPEG_BYTES.length) }, body: JPEG_BYTES,
            });
            const screen = vi.spyOn(fakeSafetyScreening, "screen");
            const info = vi.spyOn(fakeImages, "info");
            const response = await handleRequest(incoming, workerEnv());
            expect(decode).not.toHaveBeenCalled();
            expect(response.status).toBe(410);
            expect(imageTransformCount).toBe(0);
            expect(screen).not.toHaveBeenCalled();
            expect(info).not.toHaveBeenCalled();
        }
    });
    it("returns a retry hint when owner mutation rate limiting rejects a request", async () => {
        ownerRateAllowed = false;
        const response = await request("/v2/design-drafts", { method: "POST" });
        expect(response.status).toBe(429);
        expect(response.headers.get("Retry-After")).toBe("60");
    });
    it("keeps authenticated v2 screening before artwork storage", async () => {
        const id = await createDraft();
        const grant = await request(`/v2/design-drafts/${id}/upload-grants`, { method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ expectedVersion: 0, contentType: "image/jpeg", maxBytes: JPEG_BYTES.byteLength }),
        });
        const payload: unknown = await grant.json();
        if (!isRecord(payload) || typeof payload["uploadUrl"] !== "string") throw new Error("Missing upload grant");
        safetyScreeningResult = Effect.succeed({ decision: "flagged", model: "omni-moderation-2024-09-26" });
        const response = await rawRequest(uploadRequestPath(payload["uploadUrl"]), { method: "PUT",
            headers: { "content-type": "image/jpeg", "content-length": String(JPEG_BYTES.byteLength) }, body: JPEG_BYTES,
        });
        expect(response.status).toBe(422);
        expect((await testPlatform().env.DESIGN_ARTWORK.list({ prefix: `designs/${id}/` })).objects).toHaveLength(0);
    });
    it("creates an owned draft and hides it from another owner", async () => {
        const id = await createDraft();
        expect((await request(`/v2/design-drafts/${id}`)).status).toBe(200);
        expect((await request(`/v2/design-drafts/${id}`, {}, OWNER_B)).status).toBe(404);
        const row = await testPlatform().env.DB.prepare("SELECT owner_id FROM designs WHERE id = ?").bind(id).first();
        expect(row).toEqual({ owner_id: OWNER_A });
    });
    it("prevents v1 PUT and PATCH from mutating an owned v2 draft", async () => {
        const id = await createDraft();
        const settings = { cropX: 0.5, cropY: 0.5, cropZoom: 1, placementX: 0.4, placementY: 0.4, placementWidth: 0.2, depth: 5 };
        const patchResponse = await rawRequest(`/v1/designs/${id}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(settings),
        });
        const putResponse = await rawRequest(`/v1/designs/${id}/artwork`, {
            method: "PUT",
            headers: {
                "content-length": "4",
                "content-type": "image/jpeg",
                "x-design-settings": JSON.stringify(settings),
            },
            body: JPEG_BYTES,
        });
        expect(patchResponse.status).toBe(410);
        expect(putResponse.status).toBe(410);
        expect((await request(`/v2/design-drafts/${id}`)).status).toBe(200);
    });
    it("uses expectedVersion and denies finalized mutations", async () => {
        const id = await createDraft();
        const mutation = {
            expectedVersion: 0,
            settings: { cropX: 0.5, cropY: 0.5, cropZoom: 1, placementX: 0.4, placementY: 0.4, placementWidth: 0.2, depth: 5 },
        };
        const first = await request(`/v2/design-drafts/${id}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(mutation),
        });
        expect(first.status).toBe(200);
        expect((await first.json())).toMatchObject({ version: 1 });
        expect((await request(`/v2/design-drafts/${id}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(mutation),
        })).status).toBe(409);
        await testPlatform().env.DB.prepare("UPDATE designs SET finalized_at = ? WHERE id = ?").bind(Date.now(), id).run();
        expect((await request(`/v2/design-drafts/${id}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ...mutation, expectedVersion: 1 }),
        })).status).toBe(409);
    });
    it("rejects editor settings outside renderer-safe semantic bounds", async () => {
        const id = await createDraft();
        const response = await request(`/v2/design-drafts/${id}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                expectedVersion: 0,
                settings: {
                    cropX: 0.5,
                    cropY: 0.5,
                    cropZoom: 2.61,
                    depth: 9,
                    placementWidth: 0.48,
                    placementX: 0.6,
                    placementY: 0.4,
                },
            }),
        });
        expect(response.status).toBe(400);
    });
    it("claims legacy drafts only through the bounded mutation", async () => {
        const id = crypto.randomUUID();
        const now = Date.now();
        await testPlatform().env.DB.prepare(`
      INSERT INTO designs (
        id, owner_id, artwork_key, content_type, byte_size, sha256,
        crop_x, crop_y, crop_zoom, placement_x, placement_y, placement_width,
        depth, status, version, finalized_at, legacy_claim_expires_at,
        created_at, updated_at, deleted_at
      ) VALUES (?, NULL, ?, 'application/octet-stream', 0, '', 0.5, 0.5, 1,
        0.39, 0.43, 0.22, 5, 'creating', 0, NULL, ?, ?, ?, NULL)
    `).bind(id, `designs/${id}/pending`, now + 60000, now, now).run();
        expect((await request(`/v2/design-drafts/${id}`)).status).toBe(404);
        expect((await request(`/v2/design-drafts/${id}/claim`, { method: "POST" })).status).toBe(200);
        expect((await request(`/v2/design-drafts/${id}/claim`, { method: "POST" }, OWNER_B)).status).toBe(404);
    });
});
async function progressiveFixture() {
    const id = await createDraft();
    const queued: string[] = [];
    let sendFails = false;
    const env = { ...workerEnv(), PRINT_ASSET_JOBS: { send(message: {
                artworkJobId: string;
            } | {
                configuredProductId: string;
            }) {
                if (sendFails)
                    return Promise.reject(new Error("Queue unavailable"));
                if ("artworkJobId" in message)
                    queued.push(message.artworkJobId);
                return Promise.resolve();
            } } };
    async function upload(expectedVersion = 0) {
        const grant = await handleAnonymousDesignRequest(new Request(`https://api.example.com/v2/design-drafts/${id}/upload-grants`, {
            method: "POST", headers: { "content-type": "application/json", "x-forever-tee-service-secret": SECRET, "x-forever-tee-owner-id": OWNER_A },
            body: JSON.stringify({ expectedVersion, contentType: "image/jpeg", maxBytes: 4, progressive: true }),
        }), env);
        const payload: unknown = await grant?.json();
        if (!isRecord(payload) || typeof payload["uploadUrl"] !== "string")
            throw new Error("Expected grant");
        return handleAnonymousDesignRequest(new Request(payload["uploadUrl"], {
            method: "PUT", headers: { "content-type": "image/jpeg" }, body: JPEG_BYTES,
        }), env);
    }
    return { id, queued, env, upload, failQueue: (value: boolean) => { sendFails = value; } };
}
function uploadRequestPath(uploadUrl: string) {
    const url = new URL(uploadUrl);
    return url.pathname + url.search;
}
describe("upload grants", () => {
    // This fixture checks D1/R2 lifecycle ordering and cleanup, not elapsed time.
    // Allow the local Worker proxy to finish those operations on hosted runners.
    it("queues cached videos before print preparation completes and retains their source afterward", async () => {
        const fixture = await progressiveFixture();
        expect((await fixture.upload())?.status).toBe(202);
        const deliveries: string[] = [];
        const env = { ...fixture.env, STORY_VIDEO_JOBS: { send(message: {
                    designRevisionId: string;
                }) {
                    deliveries.push(message.designRevisionId);
                    return Promise.resolve();
                } } };
        const configure = () => handleAnonymousDesignRequest(new Request("https://api.example.com/v2/configured-product-families", {
            method: "POST", headers: { "content-type": "application/json", "x-forever-tee-service-secret": SECRET, "x-forever-tee-owner-id": OWNER_A },
            body: JSON.stringify({ designId: fixture.id, expectedVersion: 1, baseProductIds: [BASE_PRODUCT_ID, TOTE_BASE_PRODUCT_ID] }),
        }), env, undefined, ids => ensureStoryVideoJobs(env, ids));
        expect((await configure())?.status).toBe(201);
        const readJobs = () => env.DB.prepare(`SELECT j.id, j.story_key, j.design_revision_id, r.artwork_key, r.artwork_width, r.artwork_height
      FROM story_video_jobs j JOIN products p ON p.id = j.product_id JOIN design_revisions r ON r.id = j.design_revision_id
      WHERE p.design_id = ? ORDER BY j.id`).bind(fixture.id).all<{
            id: string;
            story_key: string;
            design_revision_id: string;
            artwork_key: string;
            artwork_width: number;
            artwork_height: number;
        }>();
        const early = await readJobs();
        expect(early.results).toHaveLength(4);
        expect(deliveries).toHaveLength(1);
        expect(early.results.every(job => job.artwork_key.includes("/preparation/") && job.artwork_width <= 1024 && job.artwork_height <= 1024)).toBe(true);
        const products = await env.DB.prepare("SELECT id, design_revision_id FROM products WHERE design_id = ?")
            .bind(fixture.id).all<{
            id: string;
            design_revision_id: string | null;
        }>();
        for (const product of products.results) {
            expect(product.design_revision_id).toBeNull();
            expect(await productPurchaseReadiness(env.DB, product.id)).toEqual({ ready: false });
            expect((await storyVideoEvents(new Request("https://api.example.com/events", { method: "HEAD" }), env.DB, product.id)).status).toBe(200);
        }
        expect((await configure())?.status).toBe(201);
        expect((await readJobs()).results).toEqual(early.results);
        const preparationJob = fixture.queued[0];
        if (!preparationJob)
            throw new Error("Missing preparation job");
        expect(await executeArtworkPreparation(env, preparationJob)).toBe(true);
        await completePendingProductFamilies(env.DB, ids => ensureStoryVideoJobs(env, ids));
        expect((await readJobs()).results).toEqual(early.results);
        for (const job of early.results)
            expect(await env.DESIGN_ARTWORK.head(job.artwork_key)).not.toBeNull();
        expect(await env.DB.prepare("SELECT artwork_width, artwork_height FROM design_revisions WHERE id = ?")
            .bind(fixture.id).first()).toEqual({ artwork_width: 3000, artwork_height: 4000 });
        expect(await deleteOwnedDesign(env, OWNER_A, fixture.id)).toMatchObject({ id: fixture.id });
        await drainDesignAssetDeletions(env);
        for (const job of early.results)
            expect(await env.DESIGN_ARTWORK.head(job.artwork_key)).toBeNull();
    }, 15000);
    it.each([false, true])("configures a zero-depth family during progressive artwork preparation, background removed: %s", async (removeBackground) => {
        const fixture = await progressiveFixture();
        expect((await fixture.upload())?.status).toBe(202);
        expect((await request(`/v2/design-drafts/${fixture.id}`, {
            method: "PATCH", headers: { "content-type": "application/json" },
            body: JSON.stringify({ expectedVersion: 1, settings: {
                    cropX: 0.5, cropY: 0.5, cropZoom: 1, placementX: 0.4,
                    placementY: 0.4, placementWidth: 0.2, depth: 0, removeBackground,
                } }),
        })).status).toBe(200);
        await fixture.env.DB.prepare("UPDATE designs SET default_product_color_status = 'complete' WHERE id = ?")
            .bind(fixture.id).run();
        const response = await configureFamily(fixture.id, 2);
        expect(response.status).toBe(201);
        expect(await response.json()).toMatchObject({ products: [
                { designRevisionId: null, preparationId: fixture.id },
                { designRevisionId: null, preparationId: fixture.id },
            ] });
        const products = await fixture.env.DB.prepare(`SELECT id, placement_depth, print_mode, video_design_revision_id
      FROM products WHERE design_id = ?`).bind(fixture.id)
            .all<{
            id: string;
            placement_depth: number;
            print_mode: string;
            video_design_revision_id: string;
        }>();
        expect(products.results).toHaveLength(2);
        for (const product of products.results) {
            expect(product).toMatchObject({ placement_depth: 0, print_mode: "recursive" });
            expect(product.video_design_revision_id).not.toBe(fixture.id);
            expect(await productPurchaseReadiness(fixture.env.DB, product.id)).toEqual({ ready: false });
        }
        expect((await configureFamily(fixture.id, 2)).status).toBe(201);
        await ensureStoryVideoJobs(fixture.env, products.results.map(product => product.id));
        expect(await fixture.env.DB.prepare("SELECT count(*) AS count FROM story_video_jobs").first()).toEqual({ count: 0 });
        const jobId = fixture.queued[0];
        if (!jobId)
            throw new Error("Missing artwork job");
        expect(await executeArtworkPreparation(fixture.env, jobId)).toBe(true);
        await completePendingProductFamilies(fixture.env.DB, ids => enqueuePrintAssetJobs(fixture.env, ids));
        const finalized = await fixture.env.DB.prepare(`SELECT p.design_revision_id, p.placement_depth, p.print_mode,
      r.artwork_width, r.artwork_height FROM products p JOIN design_revisions r ON r.id = p.design_revision_id
      WHERE p.design_id = ?`).bind(fixture.id).all();
        expect(finalized.results).toEqual([0, 1].map(() => ({ design_revision_id: fixture.id,
            placement_depth: 0, print_mode: "recursive", artwork_width: 3000, artwork_height: 4000 })));
        expect(await fixture.env.DB.prepare("SELECT count(*) AS count FROM print_asset_jobs WHERE configured_product_id IN (SELECT id FROM products WHERE design_id = ?)")
            .bind(fixture.id).first()).toEqual({ count: 2 });
    });
    it("freezes both products before full artwork, preserves preview recovery, and fills immutable revisions afterwards", async () => {
        const fixture = await progressiveFixture();
        expect((await fixture.upload())?.status).toBe(202);
        const response = await configureFamily(fixture.id, 1);
        expect(response.status).toBe(201);
        expect(await response.json()).toMatchObject({ products: [
                { designRevisionId: null, preparationId: fixture.id }, { designRevisionId: null, preparationId: fixture.id },
            ] });
        const pending = await fixture.env.DB.prepare("SELECT id, design_revision_id FROM products WHERE design_id = ?")
            .bind(fixture.id).all<{
            id: string;
            design_revision_id: string | null;
        }>();
        expect(pending.results).toHaveLength(2);
        expect(pending.results.every(product => product.design_revision_id === null)).toBe(true);
        expect(await fixture.env.DB.prepare("SELECT id FROM design_revisions WHERE design_id = ? AND fingerprint NOT LIKE 'video-preview-v1:%'").bind(fixture.id).first()).toBeNull();
        const draft: unknown = await (await request(`/v2/design-drafts/${fixture.id}`)).json();
        expect(draft).toMatchObject({ finalized: true, status: "creating" });
        expect((await request(`/v2/design-drafts/${fixture.id}/upload-grants`, { method: "POST",
            headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedVersion: 2, contentType: "image/jpeg", maxBytes: 4 }) })).status).toBe(409);
        expect((await configureFamily(fixture.id, 1)).status).toBe(201);
        for (const product of pending.results) {
            expect(await productPurchaseReadiness(fixture.env.DB, product.id)).toEqual({ ready: false });
            const preview = await productPreviewResponse(new Request(`https://api.example.com/v2/internal/configured-products/${product.id}/preview/${fixture.id}`, { headers: { "x-forever-tee-service-secret": SECRET } }), fixture.env);
            expect(preview?.status).toBe(200);
            const image = await productImageResponse(new Request(`https://api.example.com/v2/internal/configured-products/${product.id}/images/flat/black?revision=${fixture.id}`, { method: "HEAD", headers: { "x-forever-tee-service-secret": SECRET } }), fixture.env);
            expect(image?.status).toBe(202);
        }
        const job = fixture.queued[0];
        if (!job)
            throw new Error("Missing job");
        expect(await executeArtworkPreparation(fixture.env, job)).toBe(true);
        const published: string[][] = [];
        await completePendingProductFamilies(fixture.env.DB, async (ids) => { published.push(ids); await enqueuePrintAssetJobs(fixture.env, ids); });
        expect(published).toHaveLength(1);
        const final = await fixture.env.DB.prepare("SELECT design_revision_id FROM products WHERE design_id = ?").bind(fixture.id).all();
        expect(final.results).toEqual([{ design_revision_id: fixture.id }, { design_revision_id: fixture.id }]);
        const revision = await fixture.env.DB.prepare("SELECT artwork_width, artwork_height, artwork_key FROM design_revisions WHERE id = ?")
            .bind(fixture.id).first<{
            artwork_width: number;
            artwork_height: number;
            artwork_key: string;
        }>();
        expect(revision).toMatchObject({ artwork_width: 3000, artwork_height: 4000 });
        expect(revision?.artwork_key).not.toContain("/preparation/");
        expect(await fixture.env.DB.prepare("SELECT count(*) AS count FROM print_asset_jobs WHERE configured_product_id IN (SELECT id FROM products WHERE design_id = ?)")
            .bind(fixture.id).first()).toEqual({ count: 2 });
    });
    it("finishes a source already running when Continue freezes its settings and recovers a failed outbox handoff", async () => {
        const fixture = await progressiveFixture();
        await fixture.upload();
        const jobId = fixture.queued[0];
        if (!jobId)
            throw new Error("Missing job");
        const started = delayImageProcessing();
        const running = executeArtworkPreparation(fixture.env, jobId);
        await started;
        try {
            expect((await configureFamily(fixture.id, 1)).status).toBe(201);
        }
        finally {
            releaseImageProcessing?.();
        }
        expect(await running).toBe(true);
        await expect(completePendingProductFamilies(fixture.env.DB, () => Promise.reject(new Error("Outbox unavailable")))).rejects.toThrow("Outbox unavailable");
        const publish = vi.fn().mockResolvedValue(undefined);
        await completePendingProductFamilies(fixture.env.DB, publish);
        expect(publish).toHaveBeenCalledTimes(1);
        expect(await fixture.env.DB.prepare("SELECT count(*) AS count FROM design_revisions WHERE design_id = ?").bind(fixture.id).first()).toEqual({ count: 2 });
        expect(await fixture.env.DB.prepare("SELECT count(*) AS count FROM products WHERE design_revision_id = ?").bind(fixture.id).first()).toEqual({ count: 2 });
    });
    it.each([0, 5])("rejects unsafe full-source dimensions instead of promoting the preview into a print revision at depth %s", async (depth) => {
        const fixture = await progressiveFixture();
        await fixture.upload();
        await fixture.env.DB.prepare("UPDATE designs SET depth = ? WHERE id = ?").bind(depth, fixture.id).run();
        expect((await configureFamily(fixture.id, 1)).status).toBe(201);
        const jobId = fixture.queued[0];
        if (!jobId)
            throw new Error("Missing job");
        await executeArtworkPreparation(fixture.env, jobId);
        await fixture.env.DB.prepare("UPDATE designs SET artwork_width = 100, artwork_height = 100 WHERE id = ?").bind(fixture.id).run();
        const publish = vi.fn();
        await completePendingProductFamilies(fixture.env.DB, publish);
        expect(publish).not.toHaveBeenCalled();
        expect(await fixture.env.DB.prepare("SELECT id FROM design_revisions WHERE design_id = ? AND fingerprint NOT LIKE 'video-preview-v1:%'").bind(fixture.id).first()).toBeNull();
    });
    it("recovers a failed queue send and retries failed artwork after the products are frozen", async () => {
        const fixture = await progressiveFixture();
        fixture.failQueue(true);
        expect((await fixture.upload())?.status).toBe(202);
        const job = await fixture.env.DB.prepare("SELECT id, source_key FROM artwork_preparation_jobs WHERE design_id = ?")
            .bind(fixture.id).first<{
            id: string;
            source_key: string;
        }>();
        if (!job)
            throw new Error("Expected durable job");
        expect(fixture.queued).toHaveLength(0);
        expect((await configureFamily(fixture.id, 1)).status).toBe(201);
        fixture.failQueue(false);
        await fixture.env.DB.prepare("UPDATE artwork_preparation_jobs SET next_attempt_at = 0 WHERE id = ?").bind(job.id).run();
        await recoverArtworkPreparation(fixture.env);
        expect(fixture.queued).toEqual([job.id]);
        failImageProcessing = true;
        for (let attempt = 0; attempt < 3; attempt++)
            expect(await executeArtworkPreparation(fixture.env, job.id)).toBe(false);
        expect(await (await request(`/v2/design-drafts/${fixture.id}`)).json()).toMatchObject({
            status: "creating", previewReady: true, artworkProcessingStatus: "failed",
        });
        await fixture.env.DB.prepare("UPDATE artwork_preparation_jobs SET updated_at = 0 WHERE id = ?").bind(job.id).run();
        await recoverArtworkPreparation(fixture.env);
        expect(await fixture.env.DESIGN_ARTWORK.head(job.source_key)).not.toBeNull();
        expect((await request(`/v2/design-drafts/${fixture.id}/artwork-processing`, {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ artworkJobId: job.id }),
        }, OWNER_B)).status).toBe(404);
        expect((await request(`/v2/design-drafts/${fixture.id}/artwork-processing`, {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ artworkJobId: job.id }),
        })).status).toBe(202);
        failImageProcessing = false;
        expect(await executeArtworkPreparation(fixture.env, job.id)).toBe(true);
        expect(await (await request(`/v2/design-drafts/${fixture.id}`)).json()).toMatchObject({ status: "ready" });
        expect(await fixture.env.DESIGN_ARTWORK.head(job.source_key)).toBeNull();
    });
    it("fences a running old job when a replacement upload reserves the draft", async () => {
        const fixture = await progressiveFixture();
        await fixture.upload();
        const jobId = fixture.queued[0];
        if (!jobId)
            throw new Error("Expected durable job");
        const started = delayImageProcessing();
        const oldJob = executeArtworkPreparation(fixture.env, jobId);
        await started;
        const replacement = fixture.upload(1);
        try {
            await vi.waitFor(async () => {
                expect(await fixture.env.DB.prepare("SELECT artwork_job_id, version FROM designs WHERE id = ?")
                    .bind(fixture.id).first()).toEqual({ artwork_job_id: null, version: 2 });
            });
        }
        finally {
            releaseImageProcessing?.();
            await oldJob;
        }
        expect((await replacement)?.status).toBe(202);
        await oldJob;
        const nextJobId = fixture.queued[1];
        if (!nextJobId)
            throw new Error("Expected replacement job");
        expect(await (await request(`/v2/design-drafts/${fixture.id}`)).json()).toMatchObject({
            status: "creating", artworkJobId: nextJobId, artworkProcessingStatus: "pending",
        });
        const rows = await fixture.env.DB.prepare("SELECT artwork_key FROM design_artwork_sources WHERE design_id = ?")
            .bind(fixture.id).all<{
            artwork_key: string;
        }>();
        expect(rows.results.every(row => row.artwork_key.includes(nextJobId))).toBe(true);
        expect(await executeArtworkPreparation(fixture.env, nextJobId)).toBe(true);
    });
    it("rejects a changed staged source and retains a failed current source for draft recovery", async () => {
        const fixture = await progressiveFixture();
        await fixture.upload();
        const job = await fixture.env.DB.prepare("SELECT id, source_key FROM artwork_preparation_jobs WHERE design_id = ?")
            .bind(fixture.id).first<{
            id: string;
            source_key: string;
        }>();
        if (!job)
            throw new Error("Expected durable job");
        await fixture.env.DESIGN_ARTWORK.put(job.source_key, new Uint8Array([0xff, 0xd8, 0xff, 1]));
        for (let attempt = 0; attempt < 3; attempt++)
            expect(await executeArtworkPreparation(fixture.env, job.id)).toBe(false);
        await fixture.env.DB.prepare("UPDATE artwork_preparation_jobs SET updated_at = 0 WHERE id = ?").bind(job.id).run();
        await recoverArtworkPreparation(fixture.env);
        expect(await fixture.env.DESIGN_ARTWORK.head(job.source_key)).not.toBeNull();
        expect(await (await request(`/v2/design-drafts/${fixture.id}`)).json()).toMatchObject({ status: "creating", artworkProcessingStatus: "failed" });
    });
    it("does not persist a flagged progressive photo or enqueue its full-resolution job", async () => {
        const fixture = await progressiveFixture();
        safetyScreeningResult = Effect.succeed({ decision: "flagged", model: "omni-moderation-2024-09-26" });
        expect((await fixture.upload())?.status).toBe(422);
        expect(fixture.queued).toHaveLength(0);
        expect((await fixture.env.DESIGN_ARTWORK.list({ prefix: `designs/${fixture.id}/` })).objects).toHaveLength(0);
        expect(await fixture.env.DB.prepare("SELECT id FROM artwork_preparation_jobs WHERE design_id = ?").bind(fixture.id).first()).toBeNull();
    });
    it("publishes a screened preview, persists edits while pending, and commits the unchanged full-resolution path", async () => {
        const id = await createDraft();
        const queued: string[] = [];
        const env = { ...workerEnv(), PRINT_ASSET_JOBS: { send(message: {
                    artworkJobId: string;
                } | {
                    configuredProductId: string;
                }) {
                    if ("artworkJobId" in message)
                        queued.push(message.artworkJobId);
                    return Promise.resolve();
                } } };
        const grant = await handleAnonymousDesignRequest(new Request(`https://api.example.com/v2/design-drafts/${id}/upload-grants`, {
            method: "POST", headers: { "content-type": "application/json", "x-forever-tee-service-secret": SECRET, "x-forever-tee-owner-id": OWNER_A },
            body: JSON.stringify({ expectedVersion: 0, contentType: "image/jpeg", maxBytes: 4, progressive: true }),
        }), env);
        const payload: unknown = await grant?.json();
        if (!isRecord(payload) || typeof payload["uploadUrl"] !== "string")
            throw new Error("Expected grant");
        const upload = await handleAnonymousDesignRequest(new Request(payload["uploadUrl"], {
            method: "PUT", headers: { "content-type": "image/jpeg" }, body: JPEG_BYTES,
        }), env);
        expect(upload?.status).toBe(202);
        expect(queued).toHaveLength(1);
        const jobId = queued[0];
        if (!jobId)
            throw new Error("Expected durable job");
        const early: unknown = await (await request(`/v2/design-drafts/${id}`)).json();
        expect(early).toMatchObject({ status: "creating", previewReady: true, artworkJobId: jobId });
        if (!isRecord(early) || !isRecord(early["settings"]))
            throw new Error("Expected settings");
        expect(typeof early["maximumCropZoom"]).toBe("number");
        const settings = { ...early["settings"], cropX: 0.3, depth: 2, removeBackground: false };
        const saved = await request(`/v2/design-drafts/${id}`, { method: "PATCH", headers: { "content-type": "application/json" },
            body: JSON.stringify({ expectedVersion: 1, settings }) });
        expect(saved.status).toBe(200);
        expect((await request(`/v2/design-drafts/${id}/artwork-sources/original`)).status).toBe(200);
        const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
        let activeHashes = 0;
        let peakHashes = 0;
        const hashSpy = vi.spyOn(crypto.subtle, "digest").mockImplementation(async (algorithm, data) => {
            activeHashes += 1;
            peakHashes = Math.max(peakHashes, activeHashes);
            try {
                await new Promise(resolve => setTimeout(resolve, 10));
                return await originalDigest(algorithm, data);
            }
            finally {
                activeHashes -= 1;
            }
        });
        try {
            expect(await executeArtworkPreparation(env, jobId)).toBe(true);
            expect(peakHashes).toBe(1);
        }
        finally {
            hashSpy.mockRestore();
        }
        const final: unknown = await (await request(`/v2/design-drafts/${id}`)).json();
        expect(final).toMatchObject({ status: "ready", version: 3, artworkProcessingStatus: "complete", settings });
        // A save started before completion must not restore its low-resolution
        // metadata over the full source after the job commits.
        expect((await request(`/v2/design-drafts/${id}`, { method: "PATCH", headers: { "content-type": "application/json" },
            body: JSON.stringify({ expectedVersion: 2, settings }) })).status).toBe(409);
        const sourceRows = await env.DB.prepare("SELECT kind, width, height FROM design_artwork_sources WHERE design_id = ?").bind(id).all();
        expect(sourceRows.results).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: "original", width: 3000, height: 4000 }),
            expect.objectContaining({ kind: "cutout", width: 3000, height: 4000 }),
        ]));
        expect(await executeArtworkPreparation(env, jobId)).toBe(true);
        await recoverArtworkPreparation(env);
        expect(queued).toHaveLength(1);
    });
    it.each(["none", "original", "cutout"])("overlaps artwork storage and settles both writes before readiness or recovery, failure=%s", async (failure) => {
        const id = await createDraft();
        const grant = await request(`/v2/design-drafts/${id}/upload-grants`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ expectedVersion: 0, contentType: "image/jpeg", maxBytes: 4 }),
        });
        const payload: unknown = await grant.json();
        if (!isRecord(payload) || typeof payload["uploadUrl"] !== "string")
            throw new Error("Expected grant");
        function pendingWrite() {
            let release: () => void = () => { throw new Error("Write barrier was not initialized"); };
            const promise = new Promise<void>(resolve => { release = resolve; });
            return { promise, resolve: release };
        }
        const original = pendingWrite();
        const cutout = pendingWrite();
        const started = new Set<string>();
        const env = workerEnv();
        const bucket = new Proxy(env.DESIGN_ARTWORK, {
            get(target, property) {
                if (property === "put")
                    return async (...args: Parameters<R2Bucket["put"]>) => {
                        const [key] = args;
                        const kind = key.includes("/original/") ? "original" : key.includes("/artwork/") ? "cutout" : undefined;
                        if (kind) {
                            started.add(kind);
                            await (kind === "original" ? original.promise : cutout.promise);
                            if (kind === failure)
                                throw new Error("Storage fixture unavailable");
                        }
                        return target.put(...args);
                    };
                const value: unknown = Reflect.get(target, property);
                return value;
            },
        });
        let settled = false;
        const upload = handleAnonymousDesignRequest(new Request(payload["uploadUrl"], {
            method: "PUT", headers: { "content-type": "image/jpeg" }, body: JPEG_BYTES,
        }), { ...env, DESIGN_ARTWORK: bucket }).then(response => { settled = true; return response; });
        try {
            await vi.waitFor(() => { expect(started).toEqual(new Set(["original", "cutout"])); }, { timeout: 1500 });
            expect(await env.DB.prepare("SELECT status, version FROM designs WHERE id = ?").bind(id).first())
                .toEqual({ status: "processing", version: 1 });
            expect((await configure(id, 1)).status).toBe(409);
            (failure === "cutout" ? cutout : original).resolve();
            // Give the released write time to succeed or fail. The other operation
            // still owns its buffer and must finish before readiness or lease recovery.
            await new Promise(resolve => setTimeout(resolve, 30));
            expect(settled).toBe(false);
            expect(await env.DB.prepare("SELECT status FROM designs WHERE id = ?").bind(id).first())
                .toEqual({ status: "processing" });
        }
        finally {
            original.resolve();
            cutout.resolve();
            await upload;
        }
        const response = await upload;
        expect(response?.status).toBe(failure === "none" ? 200 : 503);
        if (failure === "none") {
            for (const stage of ["artwork-hash", "artwork-storage", "artwork-commit"]) {
                expect(response?.headers.get("server-timing")).toMatch(new RegExp(`${stage};dur=\\d+`));
            }
        }
        const sources = await env.DB.prepare("SELECT artwork_key, sha256, width, height FROM design_artwork_sources WHERE design_id = ?")
            .bind(id).all<{
            artwork_key: string;
            sha256: string;
            width: number;
            height: number;
        }>();
        expect(sources.results).toHaveLength(failure === "none" ? 2 : 0);
        for (const source of sources.results) {
            const stored = await env.DESIGN_ARTWORK.get(source.artwork_key);
            if (!stored)
                throw new Error("Expected stored artwork");
            expect(new Uint8Array(await stored.arrayBuffer())).toEqual(fakePng(3000, 4000));
            expect(source).toMatchObject({ width: 3000, height: 4000 });
        }
        expect(await env.DB.prepare("SELECT status FROM designs WHERE id = ?").bind(id).first())
            .toEqual({ status: failure === "none" ? "ready" : "creating" });
    });
    it.each([
        { contentType: "image/png", bytes: fakePng(3000, 4000) },
        { contentType: "image/webp", bytes: new Uint8Array([82, 73, 70, 70, 4, 0, 0, 0, 87, 69, 66, 80]) },
    ])("stores a screened $contentType upload with the correct new artwork media type", async ({ contentType, bytes }) => {
        const id = await createDraft();
        const grant = await request(`/v2/design-drafts/${id}/upload-grants`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ expectedVersion: 0, contentType, maxBytes: bytes.byteLength }),
        });
        expect(grant.status).toBe(201);
        const payload: unknown = await grant.json();
        if (!isRecord(payload) || typeof payload["uploadUrl"] !== "string")
            throw new Error("Expected grant");
        const response = await anonymousRawRequest(uploadRequestPath(payload["uploadUrl"]), {
            method: "PUT", headers: { "content-type": contentType }, body: bytes,
        });
        expect(response.status).toBe(200);
        expect(await testPlatform().env.DB.prepare("SELECT content_type, artwork_width, artwork_height FROM designs WHERE id = ?")
            .bind(id).first()).toEqual({ content_type: "image/webp", artwork_width: 3000, artwork_height: 4000 });
    });
    it("leaves a capacity-rejected grant usable after memory is released", async () => {
        const id = await createDraft();
        const grant = await request(`/v2/design-drafts/${id}/upload-grants`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ expectedVersion: 0, contentType: "image/jpeg", maxBytes: 4 }),
        });
        const payload: unknown = await grant.json();
        if (!isRecord(payload) || typeof payload["uploadUrl"] !== "string")
            throw new Error("Expected grant");
        const path = uploadRequestPath(payload["uploadUrl"]);
        const release = printBufferAdmission.reserve(60000000);
        try {
            const response = await anonymousRawRequest(path, { method: "PUT", headers: { "content-type": "image/jpeg" }, body: JPEG_BYTES });
            expect(response.status).toBe(503);
            expect(await response.json()).toMatchObject({ error: { code: "IMAGE_CAPACITY_BUSY" } });
            expect(await testPlatform().env.DB.prepare("SELECT used_at FROM design_upload_grants WHERE design_id = ?").bind(id).first()).toEqual({ used_at: null });
        }
        finally {
            release();
        }
        expect((await anonymousRawRequest(path, { method: "PUT", headers: { "content-type": "image/jpeg" }, body: JPEG_BYTES })).status).toBe(200);
    });
    it("retains both screened sources, restores the selection, and freezes a non-recursive family", async () => {
        const id = await createDraft();
        const grant = await request(`/v2/design-drafts/${id}/upload-grants`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ expectedVersion: 0, contentType: "image/jpeg", maxBytes: 4 }),
        });
        const payload: unknown = await grant.json();
        if (!isRecord(payload) || typeof payload["uploadUrl"] !== "string")
            throw new Error("Expected grant");
        expect((await anonymousRawRequest(uploadRequestPath(payload["uploadUrl"]), {
            method: "PUT", headers: { "content-type": "image/jpeg" }, body: JPEG_BYTES,
        })).status).toBe(200);
        const sources = await testPlatform().env.DB.prepare("SELECT kind, artwork_key, sha256 FROM design_artwork_sources WHERE design_id = ? ORDER BY kind")
            .bind(id).all<{
            kind: string;
            artwork_key: string;
            sha256: string;
        }>();
        expect(sources.results.map(source => source.kind)).toEqual(["cutout", "original"]);
        const originalKey = sources.results.find(source => source.kind === "original")?.artwork_key;
        const cutoutKey = sources.results.find(source => source.kind === "cutout")?.artwork_key;
        expect(originalKey).not.toBe(cutoutKey);
        expect((await request(`/v2/design-drafts/${id}/artwork-sources/original`, {}, OWNER_B)).status).toBe(404);
        const original = sources.results.find(source => source.kind === "original");
        if (!original)
            throw new Error("Expected original source");
        await testPlatform().env.DESIGN_ARTWORK.delete(artworkPreviewKey(id, original.sha256));
        expect((await request(`/v2/design-drafts/${id}/artwork-sources/original`)).status).toBe(200);
        const cached = await testPlatform().env.DESIGN_ARTWORK.head(artworkPreviewKey(id, original.sha256));
        expect(cached?.httpMetadata?.contentType).toBe("image/webp");
        expect(cached?.customMetadata?.["sha256"]).toMatch(/^[a-f0-9]{64}$/);
        const transforms = imageTransformCount;
        expect((await request(`/v2/design-drafts/${id}/artwork-sources/original`)).status).toBe(200);
        expect(imageTransformCount).toBe(transforms);
        const settings = { cropX: 0.5, cropY: 0.5, cropZoom: 1, placementX: 0.4, placementY: 0.4, placementWidth: 0.2, depth: 0 };
        for (const [version, removeBackground] of [[1, false], [2, true], [3, false]] satisfies [
            number,
            boolean
        ][]) {
            expect((await request(`/v2/design-drafts/${id}`, {
                method: "PATCH", headers: { "content-type": "application/json" },
                body: JSON.stringify({ expectedVersion: version, settings: { ...settings, removeBackground } }),
            })).status).toBe(200);
            expect(await (await request(`/v2/design-drafts/${id}`)).json()).toMatchObject({
                hasOriginalArtwork: true, settings: { removeBackground, depth: 0 },
            });
            expect(await testPlatform().env.DB.prepare("SELECT artwork_key FROM designs WHERE id = ?").bind(id).first())
                .toEqual({ artwork_key: removeBackground ? cutoutKey : originalKey });
        }
        await testPlatform().env.DB.prepare("UPDATE designs SET default_product_color_status = 'complete' WHERE id = ?").bind(id).run();
        const configured = await configureFamily(id, 4);
        expect(configured.status).toBe(201);
        const products = await testPlatform().env.DB.prepare(`SELECT products.id, products.design_revision_id, products.placement_depth, revisions.artwork_key
      FROM products JOIN design_revisions revisions ON revisions.id = products.design_revision_id WHERE products.design_id = ?`).bind(id)
            .all<{
            id: string;
            design_revision_id: string;
            placement_depth: number;
            artwork_key: string;
        }>();
        expect(products.results).toHaveLength(2);
        expect(products.results.every(row => row.placement_depth === 0 && row.artwork_key === originalKey)).toBe(true);
        for (const product of products.results) {
            const headers = { "x-forever-tee-service-secret": SECRET };
            expect((await rawRequest(`/v2/internal/configured-products/${product.id}`, { headers })).status).toBe(200);
            expect((await rawRequest(`/v2/internal/design-revisions/${product.design_revision_id}/artwork`, { headers })).status).toBe(200);
            expect((await rawRequest(`/v2/internal/configured-products/${product.id}/story-videos/black`, { headers })).status).toBe(204);
        }
        expect((await request(`/v2/design-drafts/${id}/artwork-sources/original`)).status).toBe(404);
        expect((await request(`/v2/design-drafts/${id}`, { method: "DELETE" })).status).toBe(200);
        expect((await testPlatform().env.DB.prepare("SELECT * FROM design_artwork_sources WHERE design_id = ?").bind(id).all()).results).toHaveLength(0);
    }, 30000);
    it.each([false, true])("returns a prepared cutout with a safe fallback on preview failure: %s", async (previewFails) => {
        failInlinePreview = previewFails;
        const id = await createDraft();
        const grant = await request(`/v2/design-drafts/${id}/upload-grants`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ expectedVersion: 0, contentType: "image/jpeg", maxBytes: 4 }),
        });
        const payload: unknown = await grant.json();
        if (!isRecord(payload) || typeof payload["uploadUrl"] !== "string") {
            throw new Error("Expected an upload grant.");
        }
        const response = await anonymousRawRequest(uploadRequestPath(payload["uploadUrl"]), {
            method: "PUT",
            headers: { "content-type": "image/jpeg" },
            body: JPEG_BYTES,
        });
        expect(response.status).toBe(200);
        const result: unknown = await response.json();
        if (previewFails) {
            expect(result).not.toHaveProperty("preview");
        }
        else {
            expect(result).toHaveProperty("preview.contentType", "image/webp");
            expect(result).toHaveProperty("preview.base64");
            const row = await testPlatform().env.DB.prepare("SELECT sha256 FROM designs WHERE id = ?")
                .bind(id).first<{
                sha256: string;
            }>();
            if (!row)
                throw new Error("Expected stored artwork.");
            const cached = await testPlatform().env.DESIGN_ARTWORK.head(artworkPreviewKey(id, row.sha256));
            expect(cached?.httpMetadata?.contentType).toBe("image/webp");
        }
        expect(imageTransformCount).toBe(1);
    });
    it("rejects paid work at the image limiter before transforming", async () => {
        const id = await createDraft();
        const grant = await request(`/v2/design-drafts/${id}/upload-grants`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ expectedVersion: 0, contentType: "image/jpeg", maxBytes: 4 }),
        });
        const payload: unknown = await grant.json();
        if (typeof payload !== "object" || payload === null || !("uploadUrl" in payload) || typeof payload.uploadUrl !== "string") {
            throw new Error("Grant response did not include an upload URL.");
        }
        imageRateAllowed = false;
        const response = await anonymousRawRequest(uploadRequestPath(payload.uploadUrl), {
            method: "PUT",
            headers: { "content-type": "image/jpeg" },
            body: JPEG_BYTES,
        });
        expect(response.status).toBe(429);
        expect(response.headers.get("Retry-After")).toBe("60");
        expect(imageTransformCount).toBe(0);
    });
    it("ignores historical daily usage when processing another portrait", async () => {
        const id = await createDraft();
        const grant = await request(`/v2/design-drafts/${id}/upload-grants`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ expectedVersion: 0, contentType: "image/jpeg", maxBytes: 4 }),
        });
        const payload: unknown = await grant.json();
        if (!isRecord(payload) || typeof payload["uploadUrl"] !== "string") {
            throw new Error("Grant response did not include an upload URL.");
        }
        const usageDate = new Date().toISOString().slice(0, 10);
        await testPlatform().env.DB.batch(["deployment", `owner:${OWNER_A}`].map(key => testPlatform().env.DB.prepare(`
        INSERT INTO paid_operation_usage (quota_key, usage_date, operation_count, updated_at)
        VALUES (?, ?, 1000000, ?)
      `).bind(key, usageDate, Date.now())));
        const response = await anonymousRawRequest(uploadRequestPath(payload["uploadUrl"]), {
            method: "PUT",
            headers: { "content-type": "image/jpeg" },
            body: JPEG_BYTES,
        });
        expect(response.status).toBe(200);
        const preview = await request("/v2/background-removal?quality=preview", {
            method: "POST",
            headers: { "content-type": "image/jpeg" },
            body: JPEG_BYTES,
        });
        expect(preview.status).toBe(200);
    });
    it("stores only a hash and binds a five-minute one-use capability", async () => {
        const id = await createDraft();
        const response = await request(`/v2/design-drafts/${id}/upload-grants`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ expectedVersion: 0, contentType: "image/jpeg", maxBytes: 1024 }),
        });
        expect(response.status).toBe(201);
        const payload: unknown = await response.json();
        if (typeof payload !== "object" || payload === null || !("uploadUrl" in payload) || typeof payload.uploadUrl !== "string") {
            throw new Error("Grant response did not include an upload URL.");
        }
        const grantUrl = new URL(payload.uploadUrl);
        expect(grantUrl.pathname).toBe("/v2/design-upload-grants");
        const rawToken = grantUrl.searchParams.get("token");
        expect(rawToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
        const row = await testPlatform().env.DB.prepare(`
      SELECT token_hash, design_id, owner_id, expected_version, content_type,
        max_bytes, expires_at, used_at FROM design_upload_grants
    `).first();
        expect(row).toMatchObject({
            design_id: id,
            owner_id: OWNER_A,
            expected_version: 0,
            content_type: "image/jpeg",
            max_bytes: 1024,
            used_at: null,
        });
        expect(row?.["token_hash"]).not.toBe(rawToken);
        const expiresAt = row?.["expires_at"];
        if (typeof expiresAt !== "number")
            throw new Error("Grant expiry is missing.");
        expect(expiresAt - Date.now()).toBeLessThanOrEqual(5 * 60 * 1000);
        expect(expiresAt - Date.now()).toBeGreaterThan(4 * 60 * 1000);
    });
    it("rejects cross-owner issuance, stale versions, and oversized constraints", async () => {
        const id = await createDraft();
        const body = JSON.stringify({ expectedVersion: 0, contentType: "image/jpeg", maxBytes: 1024 });
        expect((await request(`/v2/design-drafts/${id}/upload-grants`, { method: "POST", headers: { "content-type": "application/json" }, body }, OWNER_B)).status).toBe(404);
        expect((await request(`/v2/design-drafts/${id}/upload-grants`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedVersion: 1, contentType: "image/jpeg", maxBytes: 1024 }) })).status).toBe(409);
        expect((await request(`/v2/design-drafts/${id}/upload-grants`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedVersion: 0, contentType: "image/jpeg", maxBytes: 21 * 1024 * 1024 }) })).status).toBe(400);
    });
    it("uses a matching upload capability exactly once", async () => {
        const id = await createDraft();
        const grantResponse = await request(`/v2/design-drafts/${id}/upload-grants`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ expectedVersion: 0, contentType: "image/jpeg", maxBytes: 4 }),
        });
        const payload: unknown = await grantResponse.json();
        if (typeof payload !== "object" || payload === null || !("uploadUrl" in payload) || typeof payload.uploadUrl !== "string") {
            throw new Error("Grant response did not include an upload URL.");
        }
        const uploadUrl = payload.uploadUrl;
        const upload = () => anonymousRawRequest(uploadRequestPath(uploadUrl), {
            method: "PUT",
            headers: { "content-type": "image/jpeg" },
            body: JPEG_BYTES,
        });
        const first = await upload();
        expect(first.status).toBe(200);
        expect(await first.json()).toMatchObject({ id, version: 1 });
        expect((await upload()).status).toBe(404);
        const stored = await testPlatform().env.DB.prepare("SELECT used_at FROM design_upload_grants").first();
        expect(typeof stored?.["used_at"]).toBe("number");
        expect(imageTransformCount).toBe(1);
        expect(moderationPreviewBytes).toBeGreaterThan(0);
        const design = await testPlatform().env.DB.prepare(`SELECT artwork_key, sha256, safety_screening_decision,
        safety_screening_model, default_product_color,
        default_product_color_model FROM designs WHERE id = ?`).bind(id).first<{
            artwork_key: string;
            default_product_color: string;
            default_product_color_model: string | null;
            safety_screening_decision: string | null;
            safety_screening_model: string | null;
            sha256: string;
        }>();
        expect(design).toMatchObject({
            default_product_color: "Black",
            default_product_color_model: "gpt-5.6-luna",
            safety_screening_decision: "allowed",
            safety_screening_model: "omni-moderation-2024-09-26",
        });
        const object = design
            ? await testPlatform().env.DESIGN_ARTWORK.head(design.artwork_key)
            : null;
        expect(object?.checksums.sha256
            ? Array.from(new Uint8Array(object.checksums.sha256), (byte) => byte.toString(16).padStart(2, "0")).join("")
            : undefined).toBe(design?.sha256);
    });
    it("uses Clef through the default AI binding and persists its result", async () => {
        const id = await createDraft();
        const grant = await request(`/v2/design-drafts/${id}/upload-grants`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ expectedVersion: 0, contentType: "image/jpeg", maxBytes: 4 }),
        });
        const payload: unknown = await grant.json();
        if (!isRecord(payload) || typeof payload["uploadUrl"] !== "string") {
            throw new Error("Expected an upload grant.");
        }
        const run = vi.fn(() => Promise.resolve({
            model: "clef-flash",
            answers: { color: { type: "choice", choice: "Black", probabilities: { Black: 0.9, White: 0.1 }, confidence: 0.9 } },
        }));
        const background: Promise<unknown>[] = [];
        const uploaded = await handleAnonymousDesignRequest(new Request(payload["uploadUrl"], {
            method: "PUT", headers: { "content-type": "image/jpeg" }, body: JPEG_BYTES,
        }), { ...workerEnv({}), AI: { run } }, { waitUntil: task => { background.push(task); } });
        expect(uploaded?.status).toBe(200);
        await Promise.all(background);
        expect(run).toHaveBeenCalledOnce();
        await expect(testPlatform().env.DB.prepare(`
      SELECT default_product_color, default_product_color_model, default_product_color_status
      FROM designs WHERE id = ?
    `).bind(id).first()).resolves.toEqual({
            default_product_color: "Black", default_product_color_model: "clef-flash", default_product_color_status: "complete",
        });
    });
    it("keeps white as the default when colour analysis is unavailable", async () => {
        productColorAnalysisResult = Effect.fail(new ProductColorAnalysisFailure({ kind: "timeout" }));
        const id = await createDraft();
        const grantResponse = await request(`/v2/design-drafts/${id}/upload-grants`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                contentType: "image/jpeg",
                expectedVersion: 0,
                maxBytes: 4,
            }),
        });
        const payload: unknown = await grantResponse.json();
        if (!isRecord(payload) || typeof payload["uploadUrl"] !== "string") {
            throw new Error("Grant response did not include an upload URL.");
        }
        const response = await anonymousRawRequest(uploadRequestPath(payload["uploadUrl"]), {
            body: JPEG_BYTES,
            headers: { "content-type": "image/jpeg" },
            method: "PUT",
        });
        expect(response.status).toBe(200);
        await expect(testPlatform().env.DB.prepare(`
      SELECT default_product_color, default_product_color_model,
        default_product_color_status
      FROM designs WHERE id = ?
    `).bind(id).first()).resolves.toEqual({
            default_product_color: "White",
            default_product_color_model: null,
            default_product_color_status: "fallback",
        });
    });
    it.each([false, true])("returns before slow colour analysis and completes after a background switch: %s", async (switchBackground) => {
        const id = await createDraft();
        const grantResponse = await request(`/v2/design-drafts/${id}/upload-grants`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                contentType: "image/jpeg",
                expectedVersion: 0,
                maxBytes: 4,
            }),
        });
        const payload: unknown = await grantResponse.json();
        if (!isRecord(payload) || typeof payload["uploadUrl"] !== "string") {
            throw new Error("Grant response did not include an upload URL.");
        }
        let finishAnalysis: (() => void) | undefined;
        const slowAnalysis: ProductColorAnalysisClient = {
            analyze: () => Effect.async((resume) => {
                finishAnalysis = () => {
                    resume(Effect.succeed({
                        color: "Black",
                        model: "gpt-5.6-luna",
                    }));
                };
            }),
        };
        const background: Promise<unknown>[] = [];
        const response = await handleAnonymousDesignRequest(new Request(payload["uploadUrl"], {
            body: JPEG_BYTES,
            headers: { "content-type": "image/jpeg" },
            method: "PUT",
        }), { ...workerEnv(), PRODUCT_COLOR_ANALYSIS: slowAnalysis }, { waitUntil: (task) => { background.push(task); } });
        expect(response?.status).toBe(200);
        expect(background).toHaveLength(3);
        expect(await testPlatform().env.DB.prepare(`
      SELECT default_product_color, default_product_color_model,
        default_product_color_status
      FROM designs WHERE id = ?
    `).bind(id).first()).toEqual({
            default_product_color: "White",
            default_product_color_model: null,
            default_product_color_status: "pending",
        });
        const pendingConfiguration = await configureFamily(id, 1);
        await expect((await request(`/v2/design-drafts/${id}`)).json()).resolves.toMatchObject({
            defaultColor: "White",
            defaultColorStatus: "pending",
        });
        expect(pendingConfiguration.status).toBe(503);
        expect(pendingConfiguration.headers.get("retry-after")).toBe("1");
        await expect(pendingConfiguration.json()).resolves.toEqual({
            error: {
                code: "PRODUCT_COLOR_PENDING",
                message: "Product colour analysis is still in progress.",
            },
        });
        if (switchBackground) {
            expect((await request(`/v2/design-drafts/${id}`, {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ expectedVersion: 1, settings: {
                        cropX: 0.5, cropY: 0.5, cropZoom: 1, placementX: 0.4,
                        placementY: 0.4, placementWidth: 0.2, depth: 5, removeBackground: false,
                    } }),
            })).status).toBe(200);
        }
        finishAnalysis?.();
        await Promise.all(background);
        await expect((await request(`/v2/design-drafts/${id}`)).json()).resolves.toMatchObject({
            defaultColor: "Black",
            defaultColorStatus: "complete",
        });
        expect(await testPlatform().env.DB.prepare(`
      SELECT default_product_color, default_product_color_model,
        default_product_color_status
      FROM designs WHERE id = ?
    `).bind(id).first()).toEqual({
            default_product_color: "Black",
            default_product_color_model: "gpt-5.6-luna",
            default_product_color_status: "complete",
        });
        const configured = await configureFamily(id, switchBackground ? 2 : 1);
        expect(configured.status).toBe(201);
        await expect(configured.json()).resolves.toMatchObject({
            products: [
                { defaultColor: "Black" },
                { defaultColor: "Black" },
            ],
        });
    });
    it("blocks a flagged portrait without storing artwork or decision details", async () => {
        safetyScreeningResult = Effect.succeed({
            decision: "flagged",
            model: "omni-moderation-2024-09-26",
        });
        const id = await createDraft();
        const grantResponse = await request(`/v2/design-drafts/${id}/upload-grants`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ expectedVersion: 0, contentType: "image/jpeg", maxBytes: 4 }),
        });
        const payload: unknown = await grantResponse.json();
        if (typeof payload !== "object" || payload === null ||
            !("uploadUrl" in payload) || typeof payload.uploadUrl !== "string") {
            throw new Error("Grant response did not include an upload URL.");
        }
        const response = await anonymousRawRequest(uploadRequestPath(payload.uploadUrl), {
            method: "PUT",
            headers: { "content-type": "image/jpeg" },
            body: JPEG_BYTES,
        });
        expect(response.status).toBe(422);
        await expect(response.json()).resolves.toEqual({
            error: {
                code: "PORTRAIT_NOT_ACCEPTED",
                message: "That photo can't be used. Please choose another.",
            },
        });
        expect(response.headers.get("server-timing")).toMatch(/^safety-screening;dur=\d+$/);
        expect(imageTransformCount).toBe(1);
        expect(moderationPreviewBytes).toBeGreaterThan(0);
        expect((await testPlatform().env.DESIGN_ARTWORK.list({
            prefix: `designs/${id}/`,
        })).objects).toHaveLength(0);
        const state = await testPlatform().env.DB.prepare(`
      SELECT status, version, safety_screening_decision,
        safety_screening_model FROM designs WHERE id = ?
    `).bind(id).first();
        expect(state).toEqual({
            safety_screening_decision: null,
            safety_screening_model: null,
            status: "creating",
            version: 1,
        });
        const products = await testPlatform().env.DB.prepare("SELECT COUNT(*) AS count FROM products WHERE design_id = ?").bind(id).first();
        expect(products).toEqual({ count: 0 });
    });
    it("waits for concurrent screening and segmentation failures before writing nothing", async () => {
        safetyScreeningResult = Effect.fail(new SafetyScreeningFailure({
            kind: "request",
        }));
        failSegmentation = true;
        const id = await createDraft();
        const grantResponse = await request(`/v2/design-drafts/${id}/upload-grants`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ expectedVersion: 0, contentType: "image/jpeg", maxBytes: 4 }),
        });
        const payload: unknown = await grantResponse.json();
        if (typeof payload !== "object" || payload === null ||
            !("uploadUrl" in payload) || typeof payload.uploadUrl !== "string") {
            throw new Error("Grant response did not include an upload URL.");
        }
        const imageProcessingStarted = delayImageProcessing();
        const safetyScreeningStarted = delaySafetyScreening();
        const upload = anonymousRawRequest(uploadRequestPath(payload.uploadUrl), {
            method: "PUT",
            headers: { "content-type": "image/jpeg" },
            body: JPEG_BYTES,
        });
        await Promise.all([imageProcessingStarted, safetyScreeningStarted]);
        releaseImageProcessing?.();
        releaseSafetyScreening?.();
        const response = await upload;
        expect(response.status).toBe(503);
        expect(response.headers.get("retry-after")).toBe("5");
        await expect(response.json()).resolves.toEqual({
            error: {
                code: "DEPENDENCY_UNAVAILABLE",
                message: "Photo screening is temporarily unavailable. Please try again.",
            },
        });
        expect((await testPlatform().env.DESIGN_ARTWORK.list({
            prefix: `designs/${id}/`,
        })).objects).toHaveLength(0);
        const state = await testPlatform().env.DB.prepare(`
      SELECT status, safety_screening_decision, safety_screening_model
      FROM designs WHERE id = ?
    `).bind(id).first();
        expect(state).toEqual({
            safety_screening_decision: null,
            safety_screening_model: null,
            status: "creating",
        });
    });
    it("atomically consumes a concurrent replay before paid image processing", async () => {
        const id = await createDraft();
        const grantResponse = await request(`/v2/design-drafts/${id}/upload-grants`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ expectedVersion: 0, contentType: "image/jpeg", maxBytes: 4 }),
        });
        const payload: unknown = await grantResponse.json();
        if (typeof payload !== "object" || payload === null || !("uploadUrl" in payload) || typeof payload.uploadUrl !== "string") {
            throw new Error("Grant response did not include an upload URL.");
        }
        const path = uploadRequestPath(payload.uploadUrl);
        const upload = () => anonymousRawRequest(path, {
            method: "PUT",
            headers: { "content-type": "image/jpeg" },
            body: JPEG_BYTES,
        });
        const responses = await Promise.all([upload(), upload()]);
        expect(responses.map(({ status }) => status).sort()).toEqual([200, 409]);
        expect(imageTransformCount).toBe(1);
    });
    it("consumes a failed processing grant and allows a fresh grant at the reserved version", async () => {
        const id = await createDraft();
        const grantResponse = await request(`/v2/design-drafts/${id}/upload-grants`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ expectedVersion: 0, contentType: "image/jpeg", maxBytes: 4 }),
        });
        const payload: unknown = await grantResponse.json();
        if (typeof payload !== "object" || payload === null || !("uploadUrl" in payload) || typeof payload.uploadUrl !== "string") {
            throw new Error("Grant response did not include an upload URL.");
        }
        failImageProcessing = true;
        const failed = await anonymousRawRequest(uploadRequestPath(payload.uploadUrl), {
            method: "PUT",
            headers: { "content-type": "image/jpeg" },
            body: JPEG_BYTES,
        });
        expect(failed.status).toBe(503);
        const usageDate = new Date().toISOString().slice(0, 10);
        const usage = await testPlatform().env.DB.prepare(`
      SELECT operation_count FROM paid_operation_usage
      WHERE quota_key = ? AND usage_date = ?
    `).bind(`owner:${OWNER_A}`, usageDate).first();
        expect(usage).toBeNull();
        const recoverable = await request(`/v2/design-drafts/${id}`);
        expect(await recoverable.json()).toMatchObject({ status: "creating", version: 1 });
        expect((await configure(id, 1)).status).toBe(409);
        expect((await request(`/v2/design-drafts/${id}/upload-grants`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ expectedVersion: 1, contentType: "image/jpeg", maxBytes: 4 }),
        })).status).toBe(201);
    });
    it.each([false, true])("keeps accepted artwork alive through settlement when the client stops waiting, failure=%s", async (failure) => {
        const id = await createDraft();
        await makeDraftReady(id);
        const grantResponse = await request(`/v2/design-drafts/${id}/upload-grants`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ expectedVersion: 0, contentType: "image/jpeg", maxBytes: 4 }),
        });
        const payload: unknown = await grantResponse.json();
        if (typeof payload !== "object" || payload === null || !("uploadUrl" in payload) || typeof payload.uploadUrl !== "string") {
            throw new Error("Grant response did not include an upload URL.");
        }
        const processingStarted = delayImageProcessing();
        failImageProcessing = failure;
        const background: Promise<unknown>[] = [];
        const upload = handleRequest(new Request(payload.uploadUrl, {
            method: "PUT",
            headers: { "content-type": "image/jpeg" },
            body: JPEG_BYTES,
        }), workerEnv(), { waitUntil: task => { background.push(task); } });
        await processingStarted;
        try {
            const reserved = await request(`/v2/design-drafts/${id}`);
            expect(await reserved.json()).toMatchObject({ status: "creating", version: 1 });
            expect((await configure(id, 1)).status).toBe(409);
            expect(background).toHaveLength(1);
            let settled = false;
            const retained = Promise.all(background).then(() => { settled = true; });
            await Promise.resolve();
            expect(settled).toBe(false);
            releaseImageProcessing?.();
            // The runtime-retained promise includes the fenced commit or release,
            // independently of the caller awaiting the HTTP response.
            await retained;
            const ready = await request(`/v2/design-drafts/${id}`);
            expect(await ready.json()).toMatchObject({ status: failure ? "creating" : "ready", version: 1 });
            expect((await upload).status).toBe(failure ? 503 : 200);
        }
        finally {
            releaseImageProcessing?.();
            await upload;
        }
    });
    it("recovers an expired processing lease and issues a fresh grant at the reserved version", async () => {
        const id = await createDraft();
        await makeDraftReady(id);
        await testPlatform().env.DB.prepare(`
      UPDATE designs SET status = 'processing', version = 1, updated_at = ?
      WHERE id = ?
    `).bind(Date.now() - PROCESSING_LEASE_MS - 1, id).run();
        const grant = await request(`/v2/design-drafts/${id}/upload-grants`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ expectedVersion: 1, contentType: "image/jpeg", maxBytes: 4 }),
        });
        expect(grant.status).toBe(201);
        const recovered = await testPlatform().env.DB.prepare("SELECT status, version FROM designs WHERE id = ?").bind(id).first();
        expect(recovered).toEqual({ status: "creating", version: 1 });
        expect((await configure(id, 1)).status).toBe(409);
    });
    it("keeps a recent processing lease locked and issues no replacement grant", async () => {
        const id = await createDraft();
        await testPlatform().env.DB.prepare(`
      UPDATE designs SET status = 'processing', version = 1, updated_at = ?
      WHERE id = ?
    `).bind(Date.now(), id).run();
        const grant = await request(`/v2/design-drafts/${id}/upload-grants`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ expectedVersion: 1, contentType: "image/jpeg", maxBytes: 4 }),
        });
        expect(grant.status).toBe(409);
        const state = await testPlatform().env.DB.prepare(`
      SELECT designs.status, designs.version,
        (SELECT COUNT(*) FROM design_upload_grants) AS grant_count
      FROM designs WHERE id = ?
    `).bind(id).first();
        expect(state).toEqual({ status: "processing", version: 1, grant_count: 0 });
    });
});
describe("owner-aware product configuration", () => {
    it("bounds concurrent portrait admission to the shared burst", async () => {
        const db = testPlatform().env.DB;
        const burst = await Promise.all(Array.from({ length: 50 }, () => takeProviderToken(db, "portrait", 1000)));
        expect(burst.filter(result => result.allowed)).toHaveLength(40);
    });
    it("admits preview plus upload for 100 designs over a modeled minute", async () => {
        const db = testPlatform().env.DB;
        await db.prepare(`INSERT INTO provider_admission (provider, tokens, updated_at, blocked_until)
      VALUES ('portrait', 0, 1000, 0)`).run();
        for (let index = 1; index <= 100; index += 1) {
            const results = await Promise.all([
                takeProviderToken(db, "portrait", 1000 + index * 600),
                takeProviderToken(db, "portrait", 1000 + index * 600),
            ]);
            expect(results.every(result => result.allowed)).toBe(true);
        }
        // This verifies 200 real D1 admissions with an injected clock. Its runner
        // budget is not a production throughput or latency assertion.
    }, 30000);
    it("does not move the provider refill clock backwards", async () => {
        const db = testPlatform().env.DB;
        await takeProviderToken(db, "printify", 1000);
        await takeProviderToken(db, "printify", 900);
        expect(await db.prepare("SELECT updated_at FROM provider_admission WHERE provider = 'printify'").first())
            .toEqual({ updated_at: 1000 });
    });
    it("preserves the longest shared provider cooldown", async () => {
        const db = testPlatform().env.DB;
        await takeProviderToken(db, "printify", 1000);
        await deferProvider(db, 120, 1000);
        await deferProvider(db, 10, 1000);
        expect(await takeProviderToken(db, "printify", 2000)).toEqual({ allowed: false, retryAfterSeconds: 119 });
        expect((await takeProviderToken(db, "printify", 121000)).allowed).toBe(true);
    });
    function printBatch(id: string) {
        const ack = vi.fn();
        const retry = vi.fn();
        const message = { id: crypto.randomUUID(), timestamp: new Date(), attempts: 1,
            body: { configuredProductId: id }, ack, retry };
        return { queue: "forever-tee-print-assets-development", messages: [message],
            metadata: { metrics: { backlogCount: 1, backlogBytes: 100 } },
            ackAll: vi.fn(), retryAll: vi.fn(), ack, retry };
    }
    async function configuredWithoutPrintAssets() {
        const id = await createDraft();
        await makeDraftReady(id);
        const response = await configure(id);
        const product: unknown = await response.json();
        if (!isRecord(product) || typeof product["id"] !== "string")
            throw new Error("Missing product.");
        await testPlatform().env.DB.prepare("DELETE FROM print_assets WHERE configured_product_id = ?")
            .bind(product["id"]).run();
        return product["id"];
    }
    async function queuedPrintFamily() {
        const id = await createDraft();
        await makeDraftReady(id);
        const env = { ...workerEnv(), PRINT_EXECUTION_RELEASE_ID: "native-123", PRINT_ASSET_JOBS: { send: () => Promise.resolve() } };
        await env.DB.prepare(`CREATE TABLE IF NOT EXISTS native_video_release_control (
      singleton INTEGER PRIMARY KEY, paused INTEGER, current_release_id TEXT
    )`).run();
        await env.DB.prepare(`INSERT INTO native_video_release_control VALUES (1, 0, 'native-123')
      ON CONFLICT (singleton) DO UPDATE SET paused = 0, current_release_id = 'native-123'`).run();
        await env.DB.prepare(`CREATE TABLE IF NOT EXISTS native_video_release_events (
      release_id TEXT NOT NULL, stage TEXT NOT NULL, payload TEXT NOT NULL CHECK (json_valid(payload)),
      created_at INTEGER NOT NULL, PRIMARY KEY (release_id, stage)
    )`).run();
        await env.DB.prepare(`INSERT INTO native_video_release_events VALUES ('native-123', 'verified', ?, ?)
      ON CONFLICT (release_id, stage) DO NOTHING`)
            .bind(JSON.stringify({ worker: { printExecutor: { releaseId: "native-123" } } }), Date.now()).run();
        const response = await handleAnonymousDesignRequest(new Request("https://api.example.com/v2/configured-product-families", {
            method: "POST",
            headers: { "content-type": "application/json", "x-forever-tee-owner-id": OWNER_A,
                "x-forever-tee-service-secret": SECRET },
            body: JSON.stringify({ baseProductIds: [BASE_PRODUCT_ID, TOTE_BASE_PRODUCT_ID],
                designId: id, expectedVersion: 0 }),
        }), env);
        expect(response?.status).toBe(201);
        const products = await env.DB.prepare("SELECT id, base_product_id FROM products WHERE design_id = ?")
            .bind(id).all<{
            id: string;
            base_product_id: string;
        }>();
        const shirt = products.results.find(product => product.base_product_id === BASE_PRODUCT_ID);
        const tote = products.results.find(product => product.base_product_id === TOTE_BASE_PRODUCT_ID);
        if (!shirt || !tote)
            throw new Error("Expected both family products.");
        return { env, shirtId: shirt.id, toteId: tote.id };
    }
    it("makes both products purchase-ready when final PNGs exceed the source upload cap", { timeout: 30000 }, async () => {
        const family = await queuedPrintFamily();
        largePrintOutput = true;
        await consumePrintAssetQueue(printBatch(family.shirtId), family.env);
        const assets = await family.env.DB.prepare(`SELECT status, byte_size, width_px, height_px, last_error
      FROM print_assets WHERE configured_product_id IN (?, ?) ORDER BY width_px`)
            .bind(family.shirtId, family.toteId).all<{
            status: string;
            byte_size: number;
            width_px: number;
            height_px: number;
            last_error: string | null;
        }>();
        expect(assets.results).toHaveLength(2);
        expect(assets.results.every(asset => asset.status === "ready" && asset.byte_size > 20 * 1024 * 1024), JSON.stringify(assets.results)).toBe(true);
        expect(await family.env.DB.prepare("SELECT count(*) AS count FROM print_asset_jobs WHERE status = 'ready'")
            .first()).toEqual({ count: 2 });
        for (const id of [family.shirtId, family.toteId]) {
            expect(await productPurchaseReadiness(family.env.DB, id)).toEqual({ ready: true });
        }
        await family.env.DB.prepare("UPDATE print_assets SET byte_size = 100000001 WHERE configured_product_id = ?")
            .bind(family.shirtId).run();
        expect(await productPurchaseReadiness(family.env.DB, family.shirtId)).toEqual({ ready: false });
        expect((await family.env.DB.prepare("SELECT * FROM print_asset_staging").all()).results).toHaveLength(0);
        expect(printBufferAdmission.occupied).toBe(0);
    });
    it("durably dispatches each revision without holding queue delivery for image completion", async () => {
        const family = await queuedPrintFamily();
        const fetch = vi.fn(() => Promise.resolve(new Response(null, { status: 202 })));
        const getByName = vi.fn(() => ({ fetch }));
        const env = { ...family.env, PRINT_EXECUTION_MODE: "durable-object", PRINT_EXECUTIONS: { getByName } };
        const before = imageTransformCount;
        const batch = printBatch(family.shirtId);
        await consumePrintAssetQueue(batch, env);
        expect(batch.ack).toHaveBeenCalledOnce();
        expect(fetch).toHaveBeenCalledOnce();
        expect(imageTransformCount).toBe(before);
        const revision = await env.DB.prepare("SELECT design_revision_id FROM products WHERE id = ?").bind(family.shirtId)
            .first<{
            design_revision_id: string;
        }>();
        expect(getByName).toHaveBeenCalledWith(revision?.design_revision_id, { locationHint: "oc" });
        await consumePrintAssetQueue(printBatch(family.toteId), env);
        expect(getByName).toHaveBeenLastCalledWith(revision?.design_revision_id, { locationHint: "oc" });
    });
    it("retries failed durable handoff without falling back to long queue rendering", async () => {
        const family = await queuedPrintFamily();
        const env = { ...family.env, PRINT_EXECUTION_MODE: "durable-object", PRINT_EXECUTIONS: {
                getByName: () => ({ fetch: () => Promise.resolve(new Response(null, { status: 503 })) }),
            } };
        const before = imageTransformCount;
        const batch = printBatch(family.shirtId);
        await consumePrintAssetQueue(batch, env);
        expect(batch.ack).not.toHaveBeenCalled();
        expect(batch.retry).toHaveBeenCalledWith({ delaySeconds: 15 });
        expect(imageTransformCount).toBe(before);
    });
    it("retries a paused queue delivery without acknowledging or rendering it", async () => {
        const family = await queuedPrintFamily();
        await family.env.DB.prepare("UPDATE native_video_release_control SET paused = 1").run();
        const batch = printBatch(family.shirtId);
        const before = imageTransformCount;
        await consumePrintAssetQueue(batch, family.env);
        expect(batch.ack).not.toHaveBeenCalled();
        expect(batch.retry).toHaveBeenCalledWith({ delaySeconds: 15 });
        expect(imageTransformCount).toBe(before);
        expect(await family.env.DB.prepare("SELECT attempt_count FROM print_asset_jobs WHERE configured_product_id = ?")
            .bind(family.shirtId).first()).toEqual({ attempt_count: 0 });
    });
    it("defers occupied print memory without consuming attempts or recording an asset failure", async () => {
        const family = await queuedPrintFamily();
        const revision = await family.env.DB.prepare("SELECT design_revision_id FROM products WHERE id = ?")
            .bind(family.shirtId).first<{
            design_revision_id: string;
        }>();
        if (!revision)
            throw new Error("Missing print revision.");
        const before = imageTransformCount;
        const release = printBufferAdmission.reserve(PRINT_BUFFER_BUDGET);
        try {
            expect(await executePrintAssetFamily(family.env, family.shirtId, {
                provider: "durable-object", executorEnteredAtMs: Date.now(), revisionId: revision.design_revision_id,
            })).toBe(0);
            const jobs = await family.env.DB.prepare(`SELECT status, attempt_count FROM print_asset_jobs
        WHERE configured_product_id IN (?, ?)`)
                .bind(family.shirtId, family.toteId).all();
            expect(jobs.results).toEqual([
                { status: "pending", attempt_count: 0 }, { status: "pending", attempt_count: 0 },
            ]);
            expect(await family.env.DB.prepare("SELECT count(*) AS count FROM print_assets WHERE status = 'failed'")
                .first()).toEqual({ count: 0 });
            expect(imageTransformCount).toBe(before);
        }
        finally {
            release();
        }
        expect(printBufferAdmission.occupied).toBe(0);
    });
    it("retains paused print work without rendering or consuming an attempt, then resumes the matching release", async () => {
        const family = await queuedPrintFamily();
        const revision = await family.env.DB.prepare("SELECT design_revision_id FROM products WHERE id = ?")
            .bind(family.shirtId).first<{
            design_revision_id: string;
        }>();
        if (!revision)
            throw new Error("Missing print revision.");
        const execution = { provider: "durable-object", executorEnteredAtMs: Date.now(), revisionId: revision.design_revision_id } satisfies Parameters<typeof executePrintAssetFamily>[2];
        const before = imageTransformCount;
        await family.env.DB.prepare("UPDATE native_video_release_control SET paused = 1").run();
        expect(await executePrintAssetFamily(family.env, family.shirtId, execution)).toBeGreaterThan(Date.now());
        expect(imageTransformCount).toBe(before);
        expect(await family.env.DB.prepare("SELECT attempt_count, status FROM print_asset_jobs WHERE configured_product_id = ?")
            .bind(family.shirtId).first()).toEqual({ attempt_count: 0, status: "dispatched" });
        await family.env.DB.prepare("UPDATE native_video_release_control SET paused = 0").run();
        expect(await executePrintAssetFamily(family.env, family.shirtId, execution)).toBeUndefined();
        expect(await family.env.DB.prepare("SELECT status FROM print_asset_jobs WHERE configured_product_id = ?")
            .bind(family.shirtId).first()).toEqual({ status: "ready" });
    });
    it.each(["paused = 1", "current_release_id = 'native-456'"])("fences a claim when %s changes after the preliminary read", async (update) => {
        const family = await queuedPrintFamily();
        const db = family.env.DB;
        const revision = await db.prepare("SELECT design_revision_id FROM products WHERE id = ?")
            .bind(family.shirtId).first<{
            design_revision_id: string;
        }>();
        if (!revision)
            throw new Error("Missing print revision.");
        function beforeClaim(statement: D1PreparedStatement): D1PreparedStatement {
            return {
                bind: (...values) => beforeClaim(statement.bind(...values)),
                first: statement.first.bind(statement),
                run: statement.run.bind(statement),
                raw: statement.raw.bind(statement),
                all: async <T>() => {
                    await db.prepare(`UPDATE native_video_release_control SET ${update}`).run();
                    return statement.all<T>();
                },
            };
        }
        const racingDb = withDatabasePrepare(db, sql => sql.includes("UPDATE print_asset_jobs SET status = 'running'")
            ? beforeClaim(db.prepare(sql)) : db.prepare(sql));
        const before = imageTransformCount;
        await executePrintAssetFamily({ ...family.env, DB: racingDb }, family.shirtId, {
            provider: "durable-object", executorEnteredAtMs: Date.now(), revisionId: revision.design_revision_id,
        });
        expect(imageTransformCount).toBe(before);
        expect(await db.prepare("SELECT attempt_count, status FROM print_asset_jobs WHERE configured_product_id = ?")
            .bind(family.shirtId).first()).toEqual({ attempt_count: 0, status: "dispatched" });
    });
    it("retires stale executor wakeups after rollback while the old queue path recovers their durable jobs", async () => {
        const family = await queuedPrintFamily();
        const revision = await family.env.DB.prepare("SELECT design_revision_id FROM products WHERE id = ?")
            .bind(family.shirtId).first<{
            design_revision_id: string;
        }>();
        if (!revision)
            throw new Error("Missing print revision.");
        await family.env.DB.prepare("UPDATE native_video_release_control SET current_release_id = 'native-456'").run();
        const before = imageTransformCount;
        expect(await executePrintAssetFamily(family.env, family.shirtId, {
            provider: "durable-object", executorEnteredAtMs: Date.now(), revisionId: revision.design_revision_id,
        })).toBeUndefined();
        expect(imageTransformCount).toBe(before);
        expect(await family.env.DB.prepare("SELECT attempt_count, status FROM print_asset_jobs WHERE configured_product_id = ?")
            .bind(family.shirtId).first()).toEqual({ attempt_count: 0, status: "dispatched" });
        await consumePrintAssetQueue(printBatch(family.shirtId), family.env);
        expect(await family.env.DB.prepare("SELECT status FROM print_asset_jobs WHERE configured_product_id = ?")
            .bind(family.shirtId).first()).toEqual({ status: "ready" });
    });
    it.each([
        { releaseId: "native-501", stage: "verified", generation: "native-123", admitted: true },
        { releaseId: "native-502", stage: "verified", generation: undefined, admitted: false },
        { releaseId: "native-503", stage: "worker-verified", generation: "native-123", admitted: false },
        { releaseId: "native-504", stage: "verified", generation: "native-456", admitted: false },
    ])("authorizes restored execution only through the current verified generation: $releaseId", async (scenario) => {
        const family = await queuedPrintFamily();
        const db = family.env.DB;
        const revision = await db.prepare("SELECT design_revision_id FROM products WHERE id = ?")
            .bind(family.shirtId).first<{
            design_revision_id: string;
        }>();
        if (!revision)
            throw new Error("Missing print revision.");
        const worker = scenario.generation ? { printExecutor: { releaseId: scenario.generation } } : {};
        await db.prepare("INSERT INTO native_video_release_events VALUES (?, ?, ?, ?)")
            .bind(scenario.releaseId, scenario.stage, JSON.stringify({ worker }), Date.now()).run();
        await db.prepare("UPDATE native_video_release_control SET current_release_id = ?")
            .bind(scenario.releaseId).run();
        const before = imageTransformCount;
        await executePrintAssetFamily(family.env, family.shirtId, {
            provider: "durable-object", executorEnteredAtMs: Date.now(), revisionId: revision.design_revision_id,
        });
        expect(await db.prepare("SELECT status, attempt_count FROM print_asset_jobs WHERE configured_product_id = ?")
            .bind(family.shirtId).first()).toEqual(scenario.admitted
            ? { status: "ready", attempt_count: 1 } : { status: "dispatched", attempt_count: 0 });
        if (!scenario.admitted)
            expect(imageTransformCount).toBe(before);
        expect(await db.prepare("SELECT count(*) AS ready FROM print_assets WHERE configured_product_id IN (?, ?) AND status = 'ready'")
            .bind(family.shirtId, family.toteId).first()).toEqual({ ready: scenario.admitted ? 2 : 0 });
    });
    it("allows five independent durable families to start and admits the sixth only after capacity releases", async () => {
        const families = [];
        for (let index = 0; index < 6; index += 1)
            families.push(await queuedPrintFamily());
        const executions = [];
        for (const family of families) {
            const revision = await family.env.DB.prepare("SELECT design_revision_id FROM products WHERE id = ?")
                .bind(family.shirtId).first<{
                design_revision_id: string;
            }>();
            if (!revision)
                throw new Error("Missing family revision.");
            executions.push({ family, revisionId: revision.design_revision_id });
        }
        const started = delayImageOutput();
        const running = executions.slice(0, 5).map(({ family, revisionId }) => executePrintAssetFamily(family.env, family.shirtId, {
            provider: "durable-object", executorEnteredAtMs: Date.now(), revisionId,
        }));
        const sixth = executions[5];
        if (!sixth)
            throw new Error("Missing sixth family.");
        try {
            await started;
            await vi.waitFor(async () => {
                expect(await sixth.family.env.DB.prepare("SELECT count(*) AS running FROM print_asset_jobs WHERE status = 'running'")
                    .first()).toEqual({ running: 10 });
            }, { timeout: 5000 });
            const retryAt = await executePrintAssetFamily(sixth.family.env, sixth.family.shirtId, {
                provider: "durable-object", executorEnteredAtMs: Date.now(), revisionId: sixth.revisionId,
            });
            expect(retryAt).toBeDefined();
            expect(await sixth.family.env.DB.prepare("SELECT attempt_count FROM print_asset_jobs WHERE configured_product_id = ?")
                .bind(sixth.family.shirtId).first()).toEqual({ attempt_count: 0 });
        }
        finally {
            releaseImageOutput?.();
            await Promise.all(running);
        }
        expect(await executePrintAssetFamily(sixth.family.env, sixth.family.shirtId, {
            provider: "durable-object", executorEnteredAtMs: Date.now(), revisionId: sixth.revisionId,
        })).toBeUndefined();
        expect(await sixth.family.env.DB.prepare("SELECT count(*) AS ready FROM print_asset_jobs WHERE status = 'ready'")
            .first()).toEqual({ ready: 12 });
    }, 30000);
    it.each([202, 503])("reserves the free slot for the oldest due family and retries its missing wakeup when handoff returns %s", async (handoffStatus) => {
        const occupied = [];
        for (let index = 0; index < 4; index += 1)
            occupied.push(await queuedPrintFamily());
        const older = await queuedPrintFamily();
        const db = older.env.DB;
        await db.prepare("UPDATE print_asset_jobs SET status = 'running', lease_id = 'occupied', next_attempt_at = ?")
            .bind(Date.now() + 960000).run();
        await db.prepare("UPDATE print_asset_jobs SET status = 'dispatched', lease_id = NULL, created_at = 1 WHERE configured_product_id IN (?, ?)")
            .bind(older.shirtId, older.toteId).run();
        const olderRevision = await db.prepare("SELECT design_revision_id FROM products WHERE id = ?")
            .bind(older.shirtId).first<{
            design_revision_id: string;
        }>();
        if (!olderRevision)
            throw new Error("Missing older revision.");
        const fetch = vi.fn(() => Promise.resolve(new Response(null, { status: handoffStatus })));
        const getByName = vi.fn(() => ({ fetch }));
        const before = imageTransformCount;
        for (let wave = 0; wave < 3; wave += 1) {
            const newer = await queuedPrintFamily();
            const revision = await db.prepare("SELECT design_revision_id FROM products WHERE id = ?")
                .bind(newer.shirtId).first<{
                design_revision_id: string;
            }>();
            if (!revision)
                throw new Error("Missing newer revision.");
            // The executor has a self binding, but deliberately no API dispatch mode variable.
            expect(await executePrintAssetFamily({ ...newer.env, PRINT_EXECUTIONS: { getByName } }, newer.shirtId, {
                provider: "durable-object", executorEnteredAtMs: Date.now(), revisionId: revision.design_revision_id,
            })).toBe(0);
            expect(await db.prepare("SELECT attempt_count FROM print_asset_jobs WHERE configured_product_id = ?")
                .bind(newer.shirtId).first()).toEqual({ attempt_count: 0 });
        }
        expect(imageTransformCount).toBe(before);
        expect(getByName.mock.calls).toEqual(Array.from({ length: 3 }, () => [olderRevision.design_revision_id, { locationHint: "oc" }]));
        expect(fetch).toHaveBeenCalledTimes(3);
        await executePrintAssetFamily(older.env, older.shirtId, {
            provider: "durable-object", executorEnteredAtMs: Date.now(), revisionId: olderRevision.design_revision_id,
        });
        expect((await db.prepare("SELECT status, attempt_count FROM print_asset_jobs WHERE configured_product_id IN (?, ?)")
            .bind(older.shirtId, older.toteId).all()).results).toEqual([
            { status: "ready", attempt_count: 1 }, { status: "ready", attempt_count: 1 },
        ]);
    }, 30000);
    it("excludes future failure backoffs and live sibling leases from FIFO priority", async () => {
        const blocked = [];
        for (let index = 0; index < 6; index += 1)
            blocked.push(await queuedPrintFamily());
        const next = await queuedPrintFamily();
        const db = next.env.DB;
        await db.prepare("UPDATE print_asset_jobs SET status = 'pending', next_attempt_at = ?, created_at = 1")
            .bind(Date.now() + 60000).run();
        const active = blocked[0];
        if (!active)
            throw new Error("Missing active family.");
        await db.prepare("UPDATE print_asset_jobs SET status = 'running', lease_id = 'active' WHERE configured_product_id = ?")
            .bind(active.shirtId).run();
        await db.prepare("UPDATE print_asset_jobs SET status = 'dispatched' WHERE configured_product_id IN (?, ?, ?)")
            .bind(active.toteId, next.shirtId, next.toteId).run();
        const revision = await db.prepare("SELECT design_revision_id FROM products WHERE id = ?")
            .bind(next.shirtId).first<{
            design_revision_id: string;
        }>();
        if (!revision)
            throw new Error("Missing next revision.");
        expect(await executePrintAssetFamily(next.env, next.shirtId, {
            provider: "durable-object", executorEnteredAtMs: Date.now(), revisionId: revision.design_revision_id,
        })).toBeUndefined();
        expect(await db.prepare("SELECT status FROM print_asset_jobs WHERE configured_product_id = ?")
            .bind(next.shirtId).first()).toEqual({ status: "ready" });
        const activeRevision = await db.prepare("SELECT design_revision_id FROM products WHERE id = ?")
            .bind(active.toteId).first<{
            design_revision_id: string;
        }>();
        if (!activeRevision)
            throw new Error("Missing active revision.");
        expect(await executePrintAssetFamily(active.env, active.toteId, {
            provider: "durable-object", executorEnteredAtMs: Date.now(), revisionId: activeRevision.design_revision_id,
        })).toBeGreaterThan(Date.now());
        expect(await db.prepare("SELECT status, attempt_count FROM print_asset_jobs WHERE configured_product_id = ?")
            .bind(active.toteId).first()).toEqual({ status: "dispatched", attempt_count: 0 });
    }, 30000);
    it("renders and reconciles a fresh product against accepted geometry despite a newer unmapped catalogue", async () => {
        await seedCurrentShirtGeometries([{ width: 6000, height: 7000 }], 1, false);
        const { env, shirtId } = await queuedPrintFamily();
        await consumePrintAssetQueue(printBatch(shirtId), env);
        const geometries = () => env.DB.prepare("SELECT geometry_key FROM print_assets WHERE configured_product_id = ? ORDER BY geometry_key")
            .bind(shirtId).all<{
            geometry_key: string;
        }>();
        expect((await geometries()).results).toEqual([{ geometry_key: "dtg:4500x5100" }]);
        expect(await productPurchaseReadiness(env.DB, shirtId)).toEqual({ ready: true });
        await env.DB.prepare("DELETE FROM print_assets WHERE configured_product_id = ?").bind(shirtId).run();
        expect(await productPurchaseReadiness(env.DB, shirtId)).toEqual({ ready: false });
        expect(await reconcileConfiguredProductPrintAssets(env)).toMatchObject({ productsReconciled: 1, productsFailed: 0 });
        expect((await geometries()).results).toEqual([{ geometry_key: "dtg:4500x5100" }]);
        expect(await productPurchaseReadiness(env.DB, shirtId)).toEqual({ ready: true });
        expect(await reconcileConfiguredProductPrintAssets(env)).toMatchObject({ productsReconciled: 0, productsFailed: 0 });
    });
    it("prepares both family products from one queue wakeup within the four-output limit", async () => {
        const { env, shirtId, toteId } = await queuedPrintFamily();
        await seedCurrentShirtGeometries([
            { width: 3619, height: 4089 },
            { width: 4150, height: 4690 },
            { width: 4682, height: 5291 },
        ]);
        const started = delayImageOutput();
        peakImageOutputs = 0;
        const batch = printBatch(toteId);
        const processing = consumePrintAssetQueue(batch, env);
        try {
            await started;
            await vi.waitFor(() => { expect(activeImageOutputs).toBe(4); }, { timeout: 1000 });
            expect(await env.DB.prepare("SELECT count(*) AS running FROM print_asset_jobs WHERE status = 'running'")
                .first()).toEqual({ running: 2 });
            const before = imageTransformCount;
            const duplicate = printBatch(shirtId);
            await consumePrintAssetQueue(duplicate, env);
            expect(duplicate.ack).toHaveBeenCalledOnce();
            expect(imageTransformCount).toBe(before);
        }
        finally {
            releaseImageOutput?.();
            await processing;
        }
        expect(peakImageOutputs).toBe(4);
        expect(batch.ack).toHaveBeenCalledOnce();
        expect(batch.retry).not.toHaveBeenCalled();
        expect(await env.DB.prepare("SELECT count(*) AS ready FROM print_asset_jobs WHERE status = 'ready' AND attempt_count = 1")
            .first()).toEqual({ ready: 2 });
        expect(await env.DB.prepare("SELECT count(*) AS ready FROM print_assets WHERE status = 'ready'")
            .first()).toEqual({ ready: 4 });
    });
    it("shares one verified portrait read within a family and leaves other revisions queued", async () => {
        const first = await queuedPrintFamily();
        const second = await queuedPrintFamily();
        const bucket = first.env.DESIGN_ARTWORK;
        const read = vi.fn((key: string) => bucket.get(key));
        const env = { ...first.env, DESIGN_ARTWORK: new Proxy(bucket, {
                get(target, key) {
                    const value: unknown = Reflect.get(target, key);
                    return key === "get" ? read : value;
                },
            }) };
        await consumePrintAssetQueue(printBatch(first.toteId), env);
        expect(read.mock.calls.filter(([key]) => !key.startsWith("print-assets/staging/v1/"))).toHaveLength(1);
        expect(await env.DB.prepare("SELECT count(*) AS ready FROM print_asset_jobs WHERE status = 'ready'")
            .first()).toEqual({ ready: 2 });
        expect(await env.DB.prepare("SELECT status FROM print_asset_jobs WHERE configured_product_id IN (?, ?)")
            .bind(second.shirtId, second.toteId).all()).toMatchObject({ results: [{ status: "dispatched" }, { status: "dispatched" }] });
    });
    it("retries a failed sibling through the successful product's original wakeup", async () => {
        const { env, shirtId, toteId } = await queuedPrintFamily();
        // Only the shirt geometry is unsafe at this source resolution.
        await seedCurrentShirtGeometries([{ width: 12000, height: 12000 }]);
        const batch = printBatch(toteId);
        await consumePrintAssetQueue(batch, env);
        expect(batch.ack).not.toHaveBeenCalled();
        expect(batch.retry).toHaveBeenCalledWith({ delaySeconds: 15 });
        expect(await env.DB.prepare("SELECT status, attempt_count FROM print_asset_jobs WHERE configured_product_id = ?")
            .bind(toteId).first()).toEqual({ status: "ready", attempt_count: 1 });
        expect(await env.DB.prepare("SELECT status, attempt_count FROM print_asset_jobs WHERE configured_product_id = ?")
            .bind(shirtId).first()).toEqual({ status: "pending", attempt_count: 1 });
        // A duplicate sibling delivery cannot defeat its backoff.
        await consumePrintAssetQueue(printBatch(shirtId), env);
        expect(await env.DB.prepare("SELECT attempt_count FROM print_asset_jobs WHERE configured_product_id = ?")
            .bind(shirtId).first()).toEqual({ attempt_count: 1 });
        await seedCurrentShirtGeometries([{ width: 4000, height: 5000 }], 2);
        await env.DB.prepare("UPDATE print_asset_jobs SET next_attempt_at = 0 WHERE configured_product_id = ?")
            .bind(shirtId).run();
        const retry = printBatch(toteId);
        await consumePrintAssetQueue(retry, env);
        expect(retry.ack).toHaveBeenCalledOnce();
        expect(retry.retry).not.toHaveBeenCalled();
        expect(await env.DB.prepare("SELECT status, attempt_count FROM print_asset_jobs WHERE configured_product_id = ?")
            .bind(shirtId).first()).toEqual({ status: "ready", attempt_count: 2 });
    });
    it("does not take a sibling from an unexpired consumer lease", async () => {
        const { env, shirtId, toteId } = await queuedPrintFamily();
        await env.DB.prepare("UPDATE print_asset_jobs SET status = 'running', lease_id = 'other-consumer', next_attempt_at = ? WHERE configured_product_id = ?")
            .bind(Date.now() + 960000, shirtId).run();
        await consumePrintAssetQueue(printBatch(toteId), env);
        expect(await env.DB.prepare("SELECT status, attempt_count, lease_id FROM print_asset_jobs WHERE configured_product_id = ?")
            .bind(shirtId).first()).toEqual({ status: "running", attempt_count: 0, lease_id: "other-consumer" });
        expect(await env.DB.prepare("SELECT status FROM print_asset_jobs WHERE configured_product_id = ?")
            .bind(toteId).first()).toEqual({ status: "ready" });
    });
    it("prepares queued shirt geometries in parallel without exceeding three outputs", async () => {
        const id = await configuredWithoutPrintAssets();
        await seedCurrentShirtGeometries([
            { width: 3619, height: 4089 },
            { width: 4150, height: 4690 },
            { width: 4682, height: 5291 },
            { width: 4500, height: 5100 },
        ]);
        const env = { ...workerEnv(), PRINT_EXECUTION_RELEASE_ID: "native-123", PRINT_ASSET_JOBS: { send: () => Promise.resolve() } };
        await env.DB.prepare(`CREATE TABLE IF NOT EXISTS native_video_release_control (
      singleton INTEGER PRIMARY KEY, paused INTEGER, current_release_id TEXT
    )`).run();
        await env.DB.prepare(`INSERT INTO native_video_release_control VALUES (1, 0, 'native-123')
      ON CONFLICT (singleton) DO UPDATE SET paused = 0, current_release_id = 'native-123'`).run();
        await enqueuePrintAssetJobs(env, [id]);
        const started = delayImageOutput();
        peakImageOutputs = 0;
        const batch = printBatch(id);
        const processing = consumePrintAssetQueue(batch, env);
        try {
            await started;
            await vi.waitFor(() => { expect(activeImageOutputs).toBe(3); }, { timeout: 1000 });
            expect(await env.DB.prepare("SELECT status FROM print_asset_jobs WHERE configured_product_id = ?")
                .bind(id).first()).toEqual({ status: "running" });
        }
        finally {
            releaseImageOutput?.();
            await processing;
        }
        expect(peakImageOutputs).toBe(3);
        expect(batch.ack).toHaveBeenCalledOnce();
        expect(batch.retry).not.toHaveBeenCalled();
        expect(await env.DB.prepare("SELECT count(*) AS ready FROM print_assets WHERE configured_product_id = ? AND status = 'ready'")
            .bind(id).first()).toEqual({ ready: 4 });
    });
    it("adopts a missing legacy job despite long retry backoff and transfers recovery ownership once", async () => {
        const family = await queuedPrintFamily();
        const send = vi.fn(() => Promise.resolve());
        const env = { ...family.env, PRINT_ASSET_JOBS: { send } };
        await env.DB.prepare("DELETE FROM print_asset_jobs WHERE configured_product_id = ?").bind(family.shirtId).run();
        await env.DB.prepare(`INSERT INTO print_asset_retries
      (configured_product_id, attempt_count, claim_id, next_attempt_at, last_attempt_at)
      VALUES (?, 12, NULL, ?, ?)`)
            .bind(family.shirtId, Date.now() + 8 * 60 * 60000, Date.now() - 60000).run();
        await Promise.all([recoverPrintAssetJobs(env), recoverPrintAssetJobs(env)]);
        expect(send).toHaveBeenCalledOnce();
        expect(send).toHaveBeenCalledWith({ configuredProductId: family.shirtId });
        expect(await env.DB.prepare("SELECT status, attempt_count FROM print_asset_jobs WHERE configured_product_id = ?")
            .bind(family.shirtId).first()).toEqual({ status: "dispatched", attempt_count: 0 });
        expect(await reconcileConfiguredProductPrintAssets(env)).toEqual({ productsFailed: 0, productsReconciled: 0 });
        await consumePrintAssetQueue(printBatch(family.shirtId), env);
        expect(await productPurchaseReadiness(env.DB, family.shirtId)).toEqual({ ready: true });
        expect(await env.DB.prepare("SELECT status, attempt_count FROM print_asset_jobs WHERE configured_product_id = ?")
            .bind(family.shirtId).first()).toEqual({ status: "ready", attempt_count: 1 });
    });
    it("does not adopt a live legacy render claim or admit legacy work during a release pause", async () => {
        const { env, shirtId } = await queuedPrintFamily();
        await env.DB.prepare("DELETE FROM print_asset_jobs WHERE configured_product_id = ?").bind(shirtId).run();
        await env.DB.prepare(`INSERT INTO print_asset_retries
      (configured_product_id, attempt_count, claim_id, next_attempt_at, last_attempt_at)
      VALUES (?, 1, 'legacy-render', ?, ?)`)
            .bind(shirtId, Date.now() + 300000, Date.now()).run();
        await recoverPrintAssetJobs(env);
        const job = () => env.DB.prepare("SELECT status FROM print_asset_jobs WHERE configured_product_id = ?").bind(shirtId).first();
        expect(await job()).toBeNull();
        await env.DB.prepare("UPDATE print_asset_retries SET next_attempt_at = 0").run();
        await env.DB.prepare("UPDATE native_video_release_control SET paused = 1").run();
        await recoverPrintAssetJobs(env);
        expect(await job()).toBeNull();
        await env.DB.prepare("UPDATE native_video_release_control SET paused = 0").run();
        await recoverPrintAssetJobs(env);
        expect(await job()).toEqual({ status: "dispatched" });
    });
    it("adopts at most three missing products per sweep and leaves inactive products alone", async () => {
        const { env } = await queuedPrintFamily();
        const missing: string[] = [];
        for (let index = 0; index < 5; index++) {
            const productId = await configuredWithoutPrintAssets();
            missing.push(productId);
            await env.DB.prepare(`INSERT INTO print_asset_retries
        (configured_product_id, attempt_count, claim_id, next_attempt_at, last_attempt_at)
        VALUES (?, 1, NULL, ?, ?)`)
                .bind(productId, Date.now() + 60000, Date.now()).run();
        }
        await env.DB.prepare("UPDATE products SET status = 'inactive' WHERE id = ?").bind(missing[0]).run();
        const before = await env.DB.prepare("SELECT count(*) AS count FROM print_asset_jobs").first<{
            count: number;
        }>();
        if (!before)
            throw new Error("Missing job count.");
        await recoverPrintAssetJobs(env);
        expect(await env.DB.prepare("SELECT count(*) AS count FROM print_asset_jobs").first())
            .toEqual({ count: before.count + 3 });
        await recoverPrintAssetJobs(env);
        expect(await env.DB.prepare("SELECT count(*) AS count FROM print_asset_jobs").first())
            .toEqual({ count: before.count + 4 });
        expect(await env.DB.prepare("SELECT configured_product_id FROM print_asset_jobs WHERE configured_product_id = ?")
            .bind(missing[0]).first()).toBeNull();
    }, 15000);
    it("does not adopt complete legacy products for newer unaccepted catalogue geometry", async () => {
        const { env, shirtId, toteId } = await queuedPrintFamily();
        await consumePrintAssetQueue(printBatch(shirtId), env);
        await env.DB.prepare("DELETE FROM print_asset_jobs WHERE configured_product_id IN (?, ?)").bind(shirtId, toteId).run();
        await seedCurrentShirtGeometries([{ width: 6000, height: 7000 }], 1, false);
        await env.DB.prepare(`INSERT INTO print_asset_retries
      (configured_product_id, attempt_count, claim_id, next_attempt_at, last_attempt_at)
      VALUES (?, 1, NULL, 0, 0)`).bind(shirtId).run();
        await recoverPrintAssetJobs(env);
        expect((await env.DB.prepare("SELECT configured_product_id FROM print_asset_jobs").all()).results).toEqual([]);
        expect(await productPurchaseReadiness(env.DB, shirtId)).toEqual({ ready: true });
    });
    it("recovers a lost queue send and renders from the durable outbox", async () => {
        const id = await configuredWithoutPrintAssets();
        const send = vi.fn().mockRejectedValueOnce(new Error("Queue unavailable")).mockResolvedValue(undefined);
        const env = { ...workerEnv(), PRINT_ASSET_JOBS: { send } };
        await enqueuePrintAssetJobs(env, [id]);
        expect(send).toHaveBeenCalledTimes(1);
        await recoverPrintAssetJobs(env);
        expect(send).toHaveBeenCalledTimes(1);
        await env.DB.prepare("UPDATE print_asset_jobs SET next_attempt_at = 0 WHERE configured_product_id = ?")
            .bind(id).run();
        await recoverPrintAssetJobs(env);
        expect(send).toHaveBeenCalledTimes(2);
        const batch = printBatch(id);
        await consumePrintAssetQueue(batch, env);
        expect(batch.ack).toHaveBeenCalledOnce();
        expect(batch.retry).not.toHaveBeenCalled();
        expect(await env.DB.prepare("SELECT status FROM print_asset_jobs WHERE configured_product_id = ?")
            .bind(id).first()).toEqual({ status: "ready" });
        expect(await env.DB.prepare("SELECT status FROM print_assets WHERE configured_product_id = ?")
            .bind(id).first()).toEqual({ status: "ready" });
    });
    it("fences duplicate consumers and recovers an interrupted consumer after lease expiry", async () => {
        const id = await configuredWithoutPrintAssets();
        const env = { ...workerEnv(), PRINT_ASSET_JOBS: { send() { return Promise.resolve(); } } };
        await enqueuePrintAssetJobs(env, [id]);
        await env.DB.prepare(`UPDATE print_asset_jobs SET status = 'running', lease_id = 'interrupted',
      next_attempt_at = ? WHERE configured_product_id = ?`).bind(Date.now() + 960000, id).run();
        const duplicate = printBatch(id);
        const before = imageTransformCount;
        await consumePrintAssetQueue(duplicate, env);
        expect(imageTransformCount).toBe(before);
        expect(duplicate.ack).toHaveBeenCalledOnce();
        await env.DB.prepare("UPDATE print_asset_jobs SET next_attempt_at = 0 WHERE configured_product_id = ?")
            .bind(id).run();
        await recoverPrintAssetJobs(env);
        const outputStarted = delayImageOutput();
        const original = consumePrintAssetQueue(printBatch(id), env);
        await outputStarted;
        await consumePrintAssetQueue(printBatch(id), env);
        releaseImageOutput?.();
        await original;
        expect(await env.DB.prepare("SELECT status, attempt_count FROM print_asset_jobs WHERE configured_product_id = ?")
            .bind(id).first()).toEqual({ status: "ready", attempt_count: 1 });
    });
    it("defers provider failures without allowing duplicate messages to bypass the retry delay", async () => {
        const id = await configuredWithoutPrintAssets();
        const env = { ...workerEnv(), PRINT_ASSET_JOBS: { send() { return Promise.resolve(); } } };
        await enqueuePrintAssetJobs(env, [id]);
        failImageProcessing = true;
        const batch = printBatch(id);
        await consumePrintAssetQueue(batch, env);
        expect(batch.retry).toHaveBeenCalledWith({ delaySeconds: 15 });
        const before = imageTransformCount;
        await consumePrintAssetQueue(printBatch(id), env);
        expect(imageTransformCount).toBe(before);
        expect(await env.DB.prepare("SELECT status, attempt_count FROM print_asset_jobs WHERE configured_product_id = ?")
            .bind(id).first()).toEqual({ status: "pending", attempt_count: 1 });
    });
    it("durably hands print work to a queue before returning the configured family", async () => {
        const id = await createDraft();
        await makeDraftReady(id);
        const messages: unknown[] = [];
        const env = { ...workerEnv(), PRINT_ASSET_JOBS: {
                send(message: unknown) { messages.push(message); return Promise.resolve(); },
            } };
        const before = imageTransformCount;
        const response = await handleAnonymousDesignRequest(new Request("https://api.example.com/v2/configured-product-families", {
            method: "POST",
            headers: { "content-type": "application/json", "x-forever-tee-owner-id": OWNER_A,
                "x-forever-tee-service-secret": SECRET },
            body: JSON.stringify({ baseProductIds: [BASE_PRODUCT_ID, TOTE_BASE_PRODUCT_ID],
                designId: id, expectedVersion: 0 }),
        }), env);
        expect(response?.status).toBe(201);
        expect(messages).toHaveLength(2);
        expect(imageTransformCount).toBe(before);
    });
    it("returns the product page record before checkout print assets finish", async () => {
        const id = await createDraft();
        await makeDraftReady(id);
        const outputStarted = delayImageOutput();
        const background: Promise<unknown>[] = [];
        const responsePromise = handleAnonymousDesignRequest(new Request("https://api.example.com/v2/configured-product-families", {
            body: JSON.stringify({
                baseProductIds: [BASE_PRODUCT_ID, TOTE_BASE_PRODUCT_ID],
                designId: id,
                expectedVersion: 0,
            }),
            headers: {
                "content-type": "application/json",
                "x-forever-tee-owner-id": OWNER_A,
                "x-forever-tee-service-secret": SECRET,
            },
            method: "POST",
        }), workerEnv(), { waitUntil: (task) => { background.push(task); } }).then((response) => {
            if (!response)
                throw new Error("Anonymous route was not handled.");
            return response;
        });
        let responseReady = false;
        void responsePromise.then(() => { responseReady = true; });
        await outputStarted;
        await Promise.resolve();
        const returnedBeforePrintAssets = responseReady;
        releaseImageOutput?.();
        const response = await responsePromise;
        await Promise.all(background);
        expect(returnedBeforePrintAssets).toBe(true);
        expect(response.status).toBe(201);
        expect(await testPlatform().env.DB.prepare(`
      SELECT count(*) AS count FROM print_assets WHERE status = 'ready'
    `).first()).toEqual({ count: 2 });
    });
    it("reuses one content-addressed print blob for identical rendered bytes", async () => {
        const first = await createDraft();
        const second = await createDraft();
        await makeDraftReady(first);
        await makeDraftReady(second);
        expect((await configure(first)).status).toBe(201);
        expect((await configure(second)).status).toBe(201);
        const state = await testPlatform().env.DB.prepare(`
      SELECT
        (SELECT count(*) FROM print_assets WHERE status = 'ready') AS assets,
        (SELECT count(*) FROM print_asset_objects) AS objects,
        (SELECT count(DISTINCT object_sha256) FROM print_assets) AS object_links
    `).first();
        expect(state).toEqual({ assets: 2, object_links: 1, objects: 1 });
    });
    it("backfills exact print assets with recoverable historical dimensions", async () => {
        const id = await createDraft();
        await makeDraftReady(id);
        const configured: unknown = await (await configure(id)).json();
        if (typeof configured !== "object" || configured === null ||
            !("id" in configured) || typeof configured.id !== "string") {
            throw new Error("Configured product response did not include an id.");
        }
        await testPlatform().env.DB.batch([
            testPlatform().env.DB.prepare("DELETE FROM print_assets WHERE configured_product_id = ?").bind(configured.id),
            testPlatform().env.DB.prepare(`
        UPDATE design_revisions
        SET artwork_width = NULL, artwork_height = NULL
        WHERE id = (SELECT design_revision_id FROM products WHERE id = ?)
      `).bind(configured.id),
        ]);
        const modernProjection = await rawRequest(`/v2/internal/operations/print-assets-refresh?configuredProductId=${configured.id}`, {
            method: "POST",
            headers: {
                "x-bent-shirt-operations-secret": OPERATIONS_SECRET,
            },
        });
        expect(modernProjection.status).toBe(200);
        expect(await modernProjection.json()).toEqual({
            productsFailed: 0,
            productsReconciled: 1,
        });
        expect(await testPlatform().env.DB.prepare(`
      SELECT projection_version, status, width_px, height_px
      FROM print_assets WHERE configured_product_id = ?
    `).bind(configured.id).first()).toEqual({
            height_px: 5100,
            projection_version: "safe-margin-v1",
            status: "ready",
            width_px: 4500,
        });
        await testPlatform().env.DB.batch([
            testPlatform().env.DB.prepare("DELETE FROM print_assets WHERE configured_product_id = ?").bind(configured.id),
            testPlatform().env.DB.prepare(`
        UPDATE products SET projection_version = 'legacy-shirt-v1'
        WHERE id = ?
      `).bind(configured.id),
        ]);
        expect((await rawRequest("/v2/internal/operations/print-assets-refresh", { method: "POST" })).status).toBe(401);
        const reconciliation = await rawRequest(`/v2/internal/operations/print-assets-refresh?configuredProductId=${configured.id}`, {
            method: "POST",
            headers: {
                "x-bent-shirt-operations-secret": OPERATIONS_SECRET,
            },
        });
        expect(reconciliation.status).toBe(200);
        expect(await reconciliation.json()).toEqual({
            productsFailed: 0,
            productsReconciled: 1,
        });
        expect(await testPlatform().env.DB.prepare(`
      SELECT projection_version, status, width_px, height_px
      FROM print_assets WHERE configured_product_id = ?
    `).bind(configured.id).first()).toEqual({
            height_px: 5100,
            projection_version: "legacy-shirt-v1",
            status: "ready",
            width_px: 4500,
        });
        await expect(reconcileConfiguredProductPrintAssets(workerEnv()))
            .resolves.toEqual({ productsFailed: 0, productsReconciled: 0 });
    });
    // These multi-product flows include configuration and real D1/R2 emulator
    // traffic before recovery. Match the saved-design integration-test budget.
    it("recovers later print assets when the oldest product has missing artwork", { timeout: 15000 }, async () => {
        const db = testPlatform().env.DB;
        const first = await createDraft();
        const second = await createDraft();
        for (const id of [first, second]) {
            await makeDraftReady(id);
            expect((await configure(id)).status).toBe(201);
        }
        await db.batch([
            db.prepare("DELETE FROM print_assets"),
            db.prepare("UPDATE products SET created_at = 1 WHERE design_id = ?").bind(first),
            db.prepare("UPDATE products SET created_at = 2 WHERE design_id = ?").bind(second),
        ]);
        const source = await db.prepare("SELECT artwork_key FROM designs WHERE id = ?")
            .bind(first).first<{
            artwork_key: string;
        }>();
        if (!source)
            throw new Error("Missing recovery fixture artwork.");
        await testPlatform().env.DESIGN_ARTWORK.delete(source.artwork_key);
        await expect(reconcileConfiguredProductPrintAssets(workerEnv()))
            .resolves.toEqual({ productsFailed: 1, productsReconciled: 1 });
        expect(await db.prepare(`
      SELECT count(*) AS count FROM print_assets
      JOIN products ON products.id = print_assets.configured_product_id
      WHERE products.design_id = ? AND print_assets.status = 'ready'
    `).bind(second).first()).toEqual({ count: 1 });
        await expect(reconcileConfiguredProductPrintAssets(workerEnv()))
            .resolves.toEqual({ productsFailed: 0, productsReconciled: 0 });
    });
    it("backs off print failures, caps the delay and retries repaired source data", async () => {
        const db = testPlatform().env.DB;
        const id = await createDraft();
        await makeDraftReady(id);
        expect((await configure(id)).status).toBe(201);
        await db.prepare("DELETE FROM print_assets").run();
        const source = await db.prepare("SELECT artwork_key FROM designs WHERE id = ?")
            .bind(id).first<{
            artwork_key: string;
        }>();
        if (!source)
            throw new Error("Missing recovery fixture artwork.");
        await testPlatform().env.DESIGN_ARTWORK.delete(source.artwork_key);
        let now = Date.now();
        const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
        try {
            for (const delay of [15 * 60000, 30 * 60000, 60 * 60000]) {
                await expect(reconcileConfiguredProductPrintAssets(workerEnv()))
                    .resolves.toEqual({ productsFailed: 1, productsReconciled: 0 });
                expect(await db.prepare("SELECT next_attempt_at, claim_id FROM print_asset_retries").first())
                    .toEqual({ next_attempt_at: now + delay, claim_id: null });
                now += delay - 1;
                await expect(reconcileConfiguredProductPrintAssets(workerEnv()))
                    .resolves.toEqual({ productsFailed: 0, productsReconciled: 0 });
                now += 1;
            }
            await db.prepare("UPDATE print_asset_retries SET attempt_count = 16").run();
            await reconcileConfiguredProductPrintAssets(workerEnv());
            expect(await db.prepare("SELECT next_attempt_at, attempt_count FROM print_asset_retries").first())
                .toEqual({ next_attempt_at: now + 24 * 60 * 60000, attempt_count: 16 });
            await testPlatform().env.DESIGN_ARTWORK.put(source.artwork_key, new Uint8Array([1, 2, 3, 4]));
            now += 24 * 60 * 60000;
            await expect(reconcileConfiguredProductPrintAssets(workerEnv()))
                .resolves.toEqual({ productsFailed: 0, productsReconciled: 1 });
            expect((await db.prepare("SELECT * FROM print_asset_retries").all()).results).toEqual([]);
        }
        finally {
            clock.mockRestore();
        }
    });
    it("claims print retries once across duplicate invocations and recovers expired claims", async () => {
        const db = testPlatform().env.DB;
        const id = await createDraft();
        await makeDraftReady(id);
        expect((await configure(id)).status).toBe(201);
        await db.prepare("DELETE FROM print_assets").run();
        const outputStarted = delayImageOutput();
        const first = reconcileConfiguredProductPrintAssets(workerEnv());
        await outputStarted;
        try {
            await expect(reconcileConfiguredProductPrintAssets(workerEnv()))
                .resolves.toEqual({ productsFailed: 0, productsReconciled: 0 });
            // A replacement claim must survive a late completion from the old owner.
            await db.prepare("UPDATE print_asset_retries SET claim_id = 'replacement'").run();
        }
        finally {
            releaseImageOutput?.();
        }
        await expect(first).resolves.toEqual({ productsFailed: 0, productsReconciled: 1 });
        expect(await db.prepare("SELECT claim_id FROM print_asset_retries").first())
            .toEqual({ claim_id: "replacement" });
        await db.batch([
            db.prepare("DELETE FROM print_assets"),
            db.prepare("UPDATE print_asset_retries SET next_attempt_at = ?").bind(Date.now() - 1),
        ]);
        const results = await Promise.all([
            reconcileConfiguredProductPrintAssets(workerEnv()),
            reconcileConfiguredProductPrintAssets(workerEnv()),
        ]);
        expect(results.reduce((total, result) => total + result.productsReconciled, 0)).toBe(1);
        expect(results.reduce((total, result) => total + result.productsFailed, 0)).toBe(0);
        expect((await db.prepare("SELECT * FROM print_asset_retries").all()).results).toEqual([]);
    });
    it("bounds print recovery to three products without starving due retries behind fresh work", { timeout: 15000 }, async () => {
        const db = testPlatform().env.DB;
        const designs: string[] = [];
        for (let index = 0; index < 4; index += 1) {
            const id = await createDraft();
            designs.push(id);
            await makeDraftReady(id);
            expect((await configure(id)).status).toBe(201);
        }
        await db.prepare("DELETE FROM print_assets").run();
        const retryDesign = designs.at(-1);
        if (!retryDesign)
            throw new Error("Missing retry fixture.");
        await db.prepare(`
      INSERT INTO print_asset_retries
      SELECT id, 1, NULL, 0, ? FROM products WHERE design_id = ?
    `).bind(Date.now() - 60000, retryDesign).run();
        await expect(reconcileConfiguredProductPrintAssets(workerEnv()))
            .resolves.toEqual({ productsFailed: 0, productsReconciled: 3 });
        expect(await db.prepare(`
      SELECT count(*) AS count FROM print_assets
      JOIN products ON products.id = print_assets.configured_product_id
      WHERE products.design_id = ? AND print_assets.status = 'ready'
    `).bind(retryDesign).first()).toEqual({ count: 1 });
        await expect(reconcileConfiguredProductPrintAssets(workerEnv()))
            .resolves.toEqual({ productsFailed: 0, productsReconciled: 1 });
        expect(peakImageOutputs).toBeLessThanOrEqual(3);
    });
    it("caps rendering across simultaneous Worker requests and releases every lease", async () => {
        let active = 0;
        let peak = 0;
        await Promise.all(Array.from({ length: 8 }, () => withPrintAssetRenderSlot(testPlatform().env.DB, async () => {
            active += 1;
            peak = Math.max(peak, active);
            try {
                await new Promise<void>((resolve) => setTimeout(resolve, 30));
            }
            finally {
                active -= 1;
            }
        })));
        expect(peak).toBe(3);
        expect(await testPlatform().env.DB.prepare(`
      SELECT count(*) AS count FROM print_asset_render_slots
      WHERE lease_id IS NOT NULL OR lease_expires_at IS NOT NULL
    `).first()).toEqual({ count: 0 });
    });
    it("configures a complete family atomically and retries without another revision", async () => {
        const id = await createDraft();
        await makeDraftReady(id);
        await testPlatform().env.DB.prepare(`
      UPDATE designs SET default_product_color = 'Black',
        default_product_color_model = 'gpt-5.6-luna'
      WHERE id = ?
    `).bind(id).run();
        const response = await configureFamily(id);
        expect(response.status).toBe(201);
        const first: unknown = await response.json();
        if (!isRecord(first) || !Array.isArray(first["products"])) {
            throw new Error("Configured family response did not include products.");
        }
        expect(first["products"]).toEqual([
            expect.objectContaining({ defaultColor: "Black" }),
            expect.objectContaining({ defaultColor: "Black" }),
        ]);
        expect(await (await configureFamily(id)).json()).toEqual(first);
        const state = await testPlatform().env.DB.prepare(`
      SELECT version, (SELECT count(*) FROM products WHERE design_id = ?) AS products,
        (SELECT count(*) FROM design_revisions WHERE design_id = ?) AS revisions,
        (SELECT count(*) FROM print_assets WHERE status = 'ready') AS ready_assets
      FROM designs WHERE id = ?
    `).bind(id, id, id).first();
        expect(state).toEqual({
            products: 2,
            ready_assets: 2,
            revisions: 1,
            version: 1,
        });
        expect(peakImageOutputs).toBe(1);
        const assets = await testPlatform().env.DB.prepare(`
      SELECT assets.geometry_key,
        coalesce(objects.storage_key, assets.storage_key) AS storage_key
      FROM print_assets AS assets
      LEFT JOIN print_asset_objects AS objects
        ON objects.sha256 = assets.object_sha256
      ORDER BY assets.geometry_key
    `).all<{
            geometry_key: string;
            storage_key: string;
        }>();
        expect(assets.results.map(({ geometry_key }) => geometry_key)).toEqual([
            "dtg:3600x4200",
            "dtg:4500x5100",
        ]);
        for (const asset of assets.results) {
            expect(await testPlatform().env.DESIGN_ARTWORK.head(asset.storage_key))
                .not.toBeNull();
        }
    });
    it("keeps a configured product unavailable until failed rendering recovers", async () => {
        const id = await createDraft();
        await makeDraftReady(id);
        failImageProcessing = true;
        expect((await configure(id)).status).toBe(503);
        expect(await testPlatform().env.DB.prepare(`
      SELECT status FROM print_assets
    `).first()).toEqual({ status: "failed" });
        failImageProcessing = false;
        expect((await configure(id, 1)).status).toBe(201);
        expect(await testPlatform().env.DB.prepare(`
      SELECT status, width_px, height_px FROM print_assets
    `).first()).toEqual({ height_px: 5100, status: "ready", width_px: 4500 });
    });
    it("protects family ownership, versions, admission, and supported product bounds", async () => {
        const id = await createDraft();
        await makeDraftReady(id);
        expect((await configureFamily(id, 0, OWNER_B)).status).toBe(404);
        expect((await configureFamily(id, 1)).status).toBe(409);
        expect((await configureFamily(id, 0, OWNER_A, [BASE_PRODUCT_ID, BASE_PRODUCT_ID])).status).toBe(400);
        expect((await configureFamily(id, 0, OWNER_A, [BASE_PRODUCT_ID, crypto.randomUUID()])).status).toBe(404);
        ownerRateAllowed = false;
        expect((await configureFamily(id)).status).toBe(429);
        const state = await testPlatform().env.DB.prepare("SELECT finalized_at, version FROM designs WHERE id = ?").bind(id).first();
        expect(state).toEqual({ finalized_at: null, version: 0 });
    });
    it("exposes a shared source-resolution zoom ceiling that prepares both products", async () => {
        const id = await createDraft();
        await makeDraftReady(id, { width: 3024, height: 4032 });
        await seedCurrentShirtGeometries([{ width: 4682, height: 5291 }]);
        await testPlatform().env.DB.prepare("UPDATE designs SET crop_zoom=2.4766158320992075 WHERE id=?").bind(id).run();
        expect((await configureFamily(id)).status).toBe(422);
        const draft: unknown = await (await request(`/v2/design-drafts/${id}`)).json();
        if (typeof draft !== "object" || draft === null || !("maximumCropZoom" in draft) || typeof draft.maximumCropZoom !== "number") {
            throw new Error("Expected a source-resolution zoom limit.");
        }
        expect(draft.maximumCropZoom).toBeCloseTo(1.524, 3);
        await testPlatform().env.DB.prepare("UPDATE designs SET crop_zoom=? WHERE id=?").bind(draft.maximumCropZoom, id).run();
        const response = await configureFamily(id);
        expect(response.status).toBe(201);
        expect((await testPlatform().env.DB.prepare("SELECT id FROM products WHERE design_id=?").bind(id).all()).results).toHaveLength(2);
    });
    it("cannot advertise a zoom limit without both accepted supplier geometries", async () => {
        const id = await createDraft();
        await makeDraftReady(id);
        await seedCurrentShirtGeometries([]);
        expect(await (await request(`/v2/design-drafts/${id}`)).json()).toMatchObject({ maximumCropZoom: null });
    });
    it("prepares both products for the reported phone photo using current supplier geometry", async () => {
        const id = await createDraft();
        await makeDraftReady(id, { width: 2316, height: 3088 });
        await seedCurrentShirtGeometries([
            { width: 3619, height: 4089 },
            { width: 4150, height: 4690 },
            { width: 4682, height: 5291 },
        ]);
        await testPlatform().env.DB.prepare(`
      UPDATE designs SET crop_x = 0.44583333333333336, crop_y = 0.5375,
        crop_zoom = 0.976271186440678 WHERE id = ?
    `).bind(id).run();
        expect((await configureFamily(id)).status).toBe(201);
        const configured = await testPlatform().env.DB.prepare(`
      SELECT base_product_id FROM products WHERE design_id = ? AND status = 'active'
    `).bind(id).all();
        expect(configured.results).toHaveLength(2);
    });
    it("checks every geometry in the latest supplier snapshot", async () => {
        const id = await createDraft();
        await makeDraftReady(id, { width: 2000, height: 2500 });
        await seedCurrentShirtGeometries([
            { width: 3619, height: 4089 },
            { width: 4682, height: 5291 },
        ]);
        expect((await configure(id)).status).toBe(422);
    });
    it("keeps the draft recoverable when current supplier geometry is missing", async () => {
        const id = await createDraft();
        await makeDraftReady(id);
        await seedCurrentShirtGeometries([]);
        for (const response of [await configureFamily(id), await configure(id)]) {
            expect(response.status).toBe(503);
            expect(await response.json()).toMatchObject({ error: { code: "PRINT_GEOMETRY_UNAVAILABLE" } });
        }
        expect(await testPlatform().env.DB.prepare("SELECT finalized_at, version FROM designs WHERE id = ?")
            .bind(id).first()).toEqual({ finalized_at: null, version: 0 });
    });
    it("rejects excessive enlargement before finalizing either product", async () => {
        const id = await createDraft();
        await makeDraftReady(id, { width: 3000, height: 4000 });
        await testPlatform().env.DB.prepare("UPDATE designs SET crop_zoom = 2 WHERE id = ?")
            .bind(id).run();
        expect((await configureFamily(id)).status).toBe(422);
        expect((await configure(id)).status).toBe(422);
        expect(await testPlatform().env.DB.prepare("SELECT finalized_at, version FROM designs WHERE id = ?")
            .bind(id).first()).toEqual({ finalized_at: null, version: 0 });
    });
    it("does not partially finalize an unsafe family and still permits the safe product alone", async () => {
        const id = await createDraft();
        await makeDraftReady(id, { height: 2500, width: 2000 });
        expect((await configureFamily(id)).status).toBe(422);
        expect((await configure(id, 0, OWNER_A, TOTE_BASE_PRODUCT_ID)).status).toBe(201);
    });
    it("adds a missing sibling to an existing finalized product without changing it", async () => {
        const id = await createDraft();
        await makeDraftReady(id);
        const shirt: unknown = await (await configure(id)).json();
        expect((await configureFamily(id, 0)).status).toBe(409);
        expect((await configureFamily(id, 1)).status).toBe(201);
        expect(await (await configure(id)).json()).toEqual(shirt);
    });
    it("serializes a family against settings changes and competing family requests", async () => {
        const id = await createDraft();
        await makeDraftReady(id);
        const settings = request(`/v2/design-drafts/${id}`, {
            method: "PATCH", headers: { "content-type": "application/json" },
            body: JSON.stringify({ expectedVersion: 0, settings: {
                    cropX: 0.5, cropY: 0.5, cropZoom: 1, placementX: 0.4, placementY: 0.4, placementWidth: 0.2, depth: 5,
                } }),
        });
        const results = await Promise.all([configureFamily(id), settings]);
        expect(results.filter((response) => response.ok)).toHaveLength(1);
        const second = await createDraft();
        await makeDraftReady(second);
        const families = await Promise.all([configureFamily(second), configureFamily(second)]);
        expect(families.map((response) => response.status)).toEqual([201, 201]);
        expect(await families[0].json()).toEqual(await families[1].json());
    });
    it("serializes a complete family against upload reservation", async () => {
        const id = await createDraft();
        await makeDraftReady(id);
        const grant = await request(`/v2/design-drafts/${id}/upload-grants`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ expectedVersion: 0, contentType: "image/jpeg", maxBytes: 4 }),
        });
        const payload: unknown = await grant.json();
        if (typeof payload !== "object" || payload === null || !("uploadUrl" in payload) || typeof payload.uploadUrl !== "string") {
            throw new Error("Missing upload grant.");
        }
        const results = await Promise.all([configureFamily(id), anonymousRawRequest(uploadRequestPath(payload.uploadUrl), {
                method: "PUT", headers: { "content-type": "image/jpeg" }, body: JPEG_BYTES,
            })]);
        expect(results.filter((response) => response.ok)).toHaveLength(1);
        const count = await testPlatform().env.DB.prepare("SELECT count(*) AS count FROM products WHERE design_id = ?").bind(id).first();
        expect(count?.["count"]).toBe(results[0].ok ? 2 : 0);
    });
    it("atomically snapshots and finalizes an owned draft while keeping public reads", async () => {
        const id = await createDraft();
        await makeDraftReady(id);
        const response = await configure(id);
        expect(response.status).toBe(201);
        const product: unknown = await response.json();
        if (typeof product !== "object" || product === null || !("id" in product) || typeof product.id !== "string") {
            throw new Error("Configured product response did not include an id.");
        }
        const state = await testPlatform().env.DB.prepare(`
      SELECT designs.finalized_at, designs.version, products.design_revision_id
      FROM designs JOIN products ON products.design_id = designs.id
      WHERE designs.id = ? AND products.status = 'active'
    `).bind(id).first();
        expect(typeof state?.["finalized_at"]).toBe("number");
        expect(state?.["version"]).toBe(1);
        expect(typeof state?.["design_revision_id"]).toBe("string");
        expect((await request(`/v2/design-drafts/${id}`, {}, OWNER_B)).status).toBe(404);
        expect((await rawRequest(`/v1/products/${product.id}`)).status).toBe(200);
        expect((await rawRequest(`/v1/designs/${id}`)).status).toBe(200);
    });
    it("requires the owner and current version", async () => {
        const id = await createDraft();
        await makeDraftReady(id);
        expect((await configure(id, 0, OWNER_B)).status).toBe(404);
        expect((await configure(id, 1)).status).toBe(409);
        expect((await rawRequest("/v1/products", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ baseProductId: BASE_PRODUCT_ID, designId: id }),
        })).status).toBe(410);
    });
    it("reuses a finalized revision once for each base product", async () => {
        const id = await createDraft();
        await makeDraftReady(id);
        const legacyClientPlacement = { x: 0.2, y: 0.25, width: 0.4, depth: 3 };
        const shirt = await configure(id, 0, OWNER_A, BASE_PRODUCT_ID, legacyClientPlacement);
        expect(shirt.status).toBe(201);
        const tote = await configure(id, 1, OWNER_A, TOTE_BASE_PRODUCT_ID, legacyClientPlacement);
        const retriedTote = await configure(id, 1, OWNER_A, TOTE_BASE_PRODUCT_ID, legacyClientPlacement);
        expect(tote.status).toBe(201);
        expect(retriedTote.status).toBe(201);
        const products = await testPlatform().env.DB.prepare(`
      SELECT base_product_id, design_revision_id, placement_x, placement_y,
        placement_width, placement_depth, projection_version
      FROM products WHERE design_id = ? AND status = 'active'
      ORDER BY base_product_id
    `).bind(id).all();
        expect(products.results).toHaveLength(2);
        expect(products.results[0]?.["design_revision_id"])
            .toBe(products.results[1]?.["design_revision_id"]);
        const designSettings = {
            depth: 5,
            placementWidth: 0.22,
            placementX: 0.39,
            placementY: 0.43,
        };
        expect(products.results).toEqual([
            {
                base_product_id: TOTE_BASE_PRODUCT_ID,
                design_revision_id: products.results[0]?.["design_revision_id"],
                placement_depth: 5,
                placement_width: projectEditorPlacement(designSettings, "cotton-tote").width,
                placement_x: projectEditorPlacement(designSettings, "cotton-tote").x,
                placement_y: projectEditorPlacement(designSettings, "cotton-tote").y,
                projection_version: "safe-margin-v1",
            },
            {
                base_product_id: BASE_PRODUCT_ID,
                design_revision_id: products.results[1]?.["design_revision_id"],
                placement_depth: 5,
                placement_width: projectEditorPlacement(designSettings, "staple-tee").width,
                placement_x: projectEditorPlacement(designSettings, "staple-tee").x,
                placement_y: projectEditorPlacement(designSettings, "staple-tee").y,
                projection_version: "safe-margin-v1",
            },
        ]);
    });
    it("blocks only the product whose resolution requirement is unsafe", async () => {
        const id = await createDraft();
        await makeDraftReady(id, { height: 2500, width: 2000 });
        const shirt = await configure(id, 0, OWNER_A, BASE_PRODUCT_ID);
        expect(shirt.status).toBe(422);
        expect(await shirt.json()).toEqual({
            error: {
                code: "PRODUCT_PROJECTION_UNSAFE",
                message: "The artwork resolution is too low for the staple-tee projection.",
            },
        });
        expect((await configure(id, 0, OWNER_A, TOTE_BASE_PRODUCT_ID)).status)
            .toBe(201);
        const configured = await testPlatform().env.DB.prepare(`
      SELECT base_product_id FROM products
      WHERE design_id = ? AND status = 'active'
    `).bind(id).all();
        expect(configured.results).toEqual([
            { base_product_id: TOTE_BASE_PRODUCT_ID },
        ]);
    });
    it("ignores legacy client placement and generates the safe projection", async () => {
        const id = await createDraft();
        await makeDraftReady(id);
        const response = await configure(id, 0, OWNER_A, BASE_PRODUCT_ID, { x: 0.8, y: 0.4, width: 0.3, depth: 5 });
        expect(response.status).toBe(201);
        expect(await response.json()).toMatchObject({
            placement: projectEditorPlacement({
                depth: 5,
                placementWidth: 0.22,
                placementX: 0.39,
                placementY: 0.43,
            }, "staple-tee"),
            projectionVersion: "safe-margin-v1",
        });
    });
    it("serializes configuration against concurrent settings mutation", async () => {
        const id = await createDraft();
        await makeDraftReady(id);
        const settings = request(`/v2/design-drafts/${id}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                expectedVersion: 0,
                settings: { cropX: 0.5, cropY: 0.5, cropZoom: 1, placementX: 0.4, placementY: 0.4, placementWidth: 0.2, depth: 5 },
            }),
        });
        const responses = await Promise.all([configure(id), settings]);
        expect(responses.filter(({ status }) => status < 300)).toHaveLength(1);
        const state = await testPlatform().env.DB.prepare(`
      SELECT designs.finalized_at, designs.version,
        (SELECT COUNT(*) FROM products WHERE design_id = designs.id) AS product_count
      FROM designs WHERE id = ?
    `).bind(id).first();
        expect(state?.["version"]).toBe(1);
        const productCount = state?.["product_count"];
        const finalizedAt = state?.["finalized_at"];
        expect(productCount === 1
            ? typeof finalizedAt === "number"
            : finalizedAt === null).toBe(true);
    });
    it("serializes configuration against upload reservation", async () => {
        const id = await createDraft();
        await makeDraftReady(id);
        const grantResponse = await request(`/v2/design-drafts/${id}/upload-grants`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ expectedVersion: 0, contentType: "image/jpeg", maxBytes: 4 }),
        });
        const payload: unknown = await grantResponse.json();
        if (typeof payload !== "object" || payload === null || !("uploadUrl" in payload) || typeof payload.uploadUrl !== "string") {
            throw new Error("Grant response did not include an upload URL.");
        }
        const upload = anonymousRawRequest(uploadRequestPath(payload.uploadUrl), {
            method: "PUT",
            headers: { "content-type": "image/jpeg" },
            body: JPEG_BYTES,
        });
        const responses = await Promise.all([configure(id), upload]);
        expect(responses.filter(({ status }) => status < 300)).toHaveLength(1);
        expect(imageTransformCount).toBe(responses[1].status === 200 ? 1 : 0);
    });
    it("preserves public reads for a legacy configured cart", async () => {
        const id = crypto.randomUUID();
        const now = Date.now();
        await testPlatform().env.DB.prepare(`
      INSERT INTO designs (
        id, owner_id, artwork_key, content_type, byte_size, sha256,
        crop_x, crop_y, crop_zoom, placement_x, placement_y, placement_width,
        depth, status, version, finalized_at, legacy_claim_expires_at,
        created_at, updated_at, deleted_at
      ) VALUES (?, NULL, ?, 'image/png', 4, ?, 0.5, 0.5, 1, 0.39, 0.43,
        0.22, 5, 'ready', 0, NULL, ?, ?, ?, NULL)
    `).bind(id, `designs/${id}/artwork/legacy`, "d".repeat(64), now + 60000, now, now).run();
        const productId = crypto.randomUUID();
        await testPlatform().env.DB.prepare(`
      INSERT INTO products (
        id, base_product_id, design_id, design_revision_id, shopify_handle,
        status, created_at, deleted_at
      ) VALUES (?, ?, ?, NULL, 'bent-shirt', 'active', ?, NULL)
    `).bind(productId, BASE_PRODUCT_ID, id, now).run();
        expect((await rawRequest(`/v1/products/${productId}`)).status).toBe(200);
        expect((await rawRequest(`/v1/designs/${id}`)).status).toBe(200);
    });
});


describe("artwork authorization at the router and storage boundary", () => {
    async function mediaDesign() {
        const id = await createDraft();
        await makeDraftReady(id);
        const row = await testPlatform().env.DB.prepare("SELECT sha256, artwork_key FROM designs WHERE id = ?")
            .bind(id).first<{ sha256: string; artwork_key: string }>();
        if (!row) throw new Error("Missing media fixture");
        await testPlatform().env.DESIGN_ARTWORK.put(artworkPreviewKey(id, row.sha256), new Uint8Array([8, 9]));
        return { id, ...row };
    }
    async function publish(id: string, revision = false) {
        const db = testPlatform().env.DB;
        const productId = crypto.randomUUID(), revisionId = crypto.randomUUID();
        if (revision) await db.prepare(`INSERT INTO design_revisions (
            id, design_id, fingerprint, artwork_key, content_type, byte_size, sha256,
            crop_x, crop_y, crop_zoom, placement_x, placement_y, placement_width, depth, created_at
        ) SELECT ?, id, ?, artwork_key, content_type, byte_size, sha256,
            crop_x, crop_y, crop_zoom, placement_x, placement_y, placement_width, depth, created_at
            FROM designs WHERE id = ?`).bind(revisionId, revisionId, id).run();
        await db.prepare(`INSERT INTO products(id, base_product_id, design_id, design_revision_id, shopify_handle, status, created_at)
            VALUES (?, ?, ?, ?, ?, 'active', ?)`).bind(productId, BASE_PRODUCT_ID, id, revision ? revisionId : null, productId, Date.now()).run();
        return { productId, revisionId };
    }
    it.each(["artwork", "artwork/preview"])("denies private and guessed %s before storage", async suffix => {
        const { id } = await mediaDesign();
        const get = vi.spyOn(testPlatform().env.DESIGN_ARTWORK, "get");
        for (const target of [id, crypto.randomUUID()]) {
            const response = await rawRequest(`/v1/designs/${target}/${suffix}`);
            expect(response.status).toBe(404);
            expect(await response.text()).not.toContain(OWNER_A);
        }
        expect(get).not.toHaveBeenCalled();
    });
    it.each([false, true])("serves only active public references, including legacy null revisions: revision=%s", async revision => {
        const { id, sha256 } = await mediaDesign();
        const { productId, revisionId } = await publish(id, revision);
        const encodedId = id.replace(/^./, character => `%${character.charCodeAt(0).toString(16)}`);
        const paths = [id, encodedId].flatMap(target => [`/v1/designs/${target}/artwork`, `/v1/designs/${target}/artwork/preview?revision=${sha256}`]);
        for (const path of paths) {
            const response = await rawRequest(path);
            expect(response.status).toBe(200);
            expect(response.headers.get("cache-control")).toBe("no-store");
        }
        if (revision) {
            await testPlatform().env.DB.prepare("UPDATE design_revisions SET sha256 = ? WHERE id = ?").bind("f".repeat(64), revisionId).run();
            for (const path of paths) expect((await rawRequest(path)).status).toBe(404);
            await testPlatform().env.DB.prepare("UPDATE design_revisions SET sha256 = ? WHERE id = ?").bind(sha256, revisionId).run();
        }
        await testPlatform().env.DB.prepare("UPDATE products SET deleted_at = ? WHERE id = ?").bind(Date.now(), productId).run();
        for (const path of paths) expect((await rawRequest(path)).status).toBe(404);
        await testPlatform().env.DB.prepare("UPDATE products SET deleted_at = NULL, status = 'unpublished' WHERE id = ?").bind(productId).run();
        await testPlatform().env.DB.prepare("UPDATE designs SET finalized_at = ? WHERE id = ?").bind(Date.now(), id).run();
        for (const path of paths) expect((await rawRequest(path)).status).toBe(404);
        await testPlatform().env.DB.prepare("UPDATE products SET status = 'active' WHERE id = ?").bind(productId).run();
        await testPlatform().env.DB.prepare("UPDATE designs SET status = 'deleted', deleted_at = ? WHERE id = ?").bind(Date.now(), id).run();
        for (const path of paths) expect((await rawRequest(path)).status).toBe(404);
    });
    it("supports finalized owner artwork and display previews without source rows, preserving source restrictions", async () => {
        const { id, sha256, artwork_key } = await mediaDesign();
        for (const finalized of [false, true]) {
            await testPlatform().env.DB.prepare("UPDATE designs SET finalized_at = ? WHERE id = ?").bind(finalized ? Date.now() : null, id).run();
            for (const suffix of ["artwork", "artwork/preview"]) {
                const path = `/v2/design-drafts/${id}/${suffix}`;
                expect((await rawRequest(path)).status).toBe(401);
                expect((await request(path, {}, OWNER_B)).status).toBe(404);
                const response = await request(path);
                expect(response.status).toBe(200);
                expect(response.headers.get("cache-control")).toBe("private, no-store");
            }
            expect((await request(`/v2/design-drafts/${id}/artwork-sources/cutout`)).status).toBe(404);
        }
        await testPlatform().env.DB.prepare(`INSERT INTO design_artwork_sources(design_id, kind, artwork_key, sha256, byte_size, width, height)
            VALUES (?, 'cutout', ?, ?, 4, 3000, 4000)`).bind(id, artwork_key, sha256).run();
        expect((await request(`/v2/design-drafts/${id}/artwork-sources/cutout`)).status).toBe(404);
        await testPlatform().env.DB.prepare("UPDATE designs SET finalized_at = NULL WHERE id = ?").bind(id).run();
        expect((await request(`/v2/design-drafts/${id}/artwork-sources/cutout`)).status).toBe(200);
    });
    it.each([
        { suffix: "artwork", phase: "get" }, { suffix: "artwork/preview", phase: "get" },
        { suffix: "artwork", phase: "read" }, { suffix: "artwork/preview", phase: "read" },
    ])("rechecks publication after asynchronous $suffix $phase", async ({ suffix, phase }) => {
        const { id } = await mediaDesign();
        const { productId } = await publish(id);
        const env = workerEnv();
        let reads = 0;
        const revoke = () => env.DB.prepare("UPDATE products SET status = 'unpublished' WHERE id = ?").bind(productId).run();
        const bucket = new Proxy(env.DESIGN_ARTWORK, { get(target, property) {
            if (property === "get") return async (key: string) => {
                const object = await target.get(key);
                if (phase === "get") await revoke();
                if (!object) return null;
                return new Proxy(object, { get(stored, member) {
                    if (member === "arrayBuffer") return async () => {
                        reads++;
                        const bytes = await stored.arrayBuffer();
                        if (phase === "read") await revoke();
                        return bytes;
                    };
                    const reflected: unknown = Reflect.get(stored, member);
                    return reflected;
                } });
            };
            const reflected: unknown = Reflect.get(target, property);
            return reflected;
        } });
        const response = await handleRequest(new Request(`https://api.example.com/v1/designs/${id}/${suffix}`), { ...env, DESIGN_ARTWORK: bucket });
        expect(response.status).toBe(404);
        expect(reads).toBe(phase === "get" ? 0 : 1);
    });
    it("rechecks publication after storing a generated preview", async () => {
        const { id, sha256 } = await mediaDesign();
        const { productId } = await publish(id);
        const env = workerEnv();
        await env.DESIGN_ARTWORK.delete(artworkPreviewKey(id, sha256));
        const bucket = new Proxy(env.DESIGN_ARTWORK, { get(target, property) {
            if (property === "put") return async (...args: Parameters<R2Bucket["put"]>) => {
                const result = await target.put(...args);
                await env.DB.prepare("UPDATE products SET status = 'unpublished' WHERE id = ?").bind(productId).run();
                return result;
            };
            const reflected: unknown = Reflect.get(target, property);
            return reflected;
        } });
        const response = await handleRequest(new Request(`https://api.example.com/v1/designs/${id}/artwork/preview`), { ...env, DESIGN_ARTWORK: bucket });
        expect(response.status).toBe(404);
        expect(await env.DESIGN_ARTWORK.head(artworkPreviewKey(id, sha256))).not.toBeNull();
        expect((await rawRequest(`/v1/designs/${id}/artwork/preview`)).status).toBe(404);
    });
    it.each(["unpublish", "delete", "owner-delete"])("denies revocation during preview generation: %s", async action => {
        const { id, sha256 } = await mediaDesign();
        const { productId } = await publish(id);
        await testPlatform().env.DESIGN_ARTWORK.delete(artworkPreviewKey(id, sha256));
        const started = delayImageOutput();
        const completion = action === "owner-delete" ? request(`/v2/design-drafts/${id}/artwork/preview`)
            : rawRequest(`/v1/designs/${id}/artwork/preview`);
        await started;
        if (action === "unpublish") await testPlatform().env.DB.prepare("UPDATE products SET status = 'unpublished' WHERE id = ?").bind(productId).run();
        else await testPlatform().env.DB.prepare("UPDATE designs SET status = 'deleted', deleted_at = ? WHERE id = ?").bind(Date.now(), id).run();
        releaseImageOutput?.();
        expect((await completion).status).toBe(404);
    });
});
