import { readFile } from "node:fs/promises";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getPlatformProxy, type PlatformProxy } from "wrangler";

import { artworkPreviewKey } from "./design-repository";
import { runScheduledStorageMaintenance } from "./storage-maintenance";

const DAY_MS = 24 * 60 * 60 * 1_000;
const MIGRATIONS = [
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
  "0020_protected_customer_data_hardening.sql",
  "0021_printify_production_resources.sql",
  "0022_print_asset_render_slots.sql",
  "0023_printify_fulfilment_orders.sql",
  "0024_story_video_renderer_v7.sql",
  "0025_storage_maintenance.sql",
  "0030_product_lifecycle.sql",
  "0039_featured_media_composition.sql",
    "0040_recursive_video_placement.sql",
    "0041_product_image_jobs.sql",
    "0042_design_artwork_sources.sql",
    "0043_artwork_preparation_jobs.sql",
    "0044_video_preview_revisions.sql",
];
const NOW = 1_900_000_000_000;
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const SHA_D = "d".repeat(64);
let platform: PlatformProxy<Env> | undefined;

function testPlatform() {
  if (!platform) throw new Error("Test bindings are unavailable.");
  return platform;
}

function maintenanceEnv() {
  const bindings = testPlatform().env;
  const storyVideos = bindings.STORY_VIDEOS;
  if (!storyVideos) throw new Error("Story video test binding is unavailable.");
  return {
    DB: bindings.DB,
    DESIGN_ARTWORK: bindings.DESIGN_ARTWORK,
    STORY_VIDEOS: storyVideos,
  };
}

beforeAll(async () => {
  platform = await getPlatformProxy<Env>({
    configPath: new URL("../wrangler.jsonc", import.meta.url).pathname,
    persist: false,
    remoteBindings: false,
  });
  for (const migration of MIGRATIONS) {
    const sql = await readFile(
      new URL(`../drizzle/${migration}`, import.meta.url),
      "utf8",
    );
    for (const statement of sql.split("--> statement-breakpoint")
      .map((value) => value.trim()).filter(Boolean)) {
      await testPlatform().env.DB.prepare(statement).run();
    }
  }
  await testPlatform().env.DB.prepare(`
    CREATE TABLE native_video_qualification_faults (
      design_id text NOT NULL,
      point text NOT NULL,
      PRIMARY KEY (design_id, point)
    )
  `).run();
  await testPlatform().env.DB.prepare(`
    CREATE TABLE native_video_qualification_observations (
      id text PRIMARY KEY NOT NULL,
      design_id text NOT NULL
    )
  `).run();
});

beforeEach(async () => {
  await testPlatform().env.DB.prepare("DELETE FROM storage_gc_cursors").run();
});

afterAll(async () => platform?.dispose());

describe("scheduled storage maintenance", () => {
  it("removes expired qualification records and their exact shared assets", async () => {
    const fixture = await seedConfiguredProduct(
      "11111111-1111-4111-8111-111111111111",
      SHA_A,
    );
    const logicalPrintKey = `print-assets/${fixture.productId}/dtg.png`;
    const objectKey = `print-assets/blobs/${SHA_A}.png`;
    const storyKey = `story-videos/v7/${fixture.productId}/Black.mp4`;
    await testPlatform().env.DB.batch([
      testPlatform().env.DB.prepare(`
        INSERT INTO print_asset_objects (
          sha256, storage_key, content_type, byte_size, width_px, height_px,
          created_at
        ) VALUES (?, ?, 'image/png', 3, 10, 10, ?)
      `).bind(SHA_A, objectKey, NOW - DAY_MS),
      testPlatform().env.DB.prepare(`
        INSERT INTO print_assets (
          id, configured_product_id, design_revision_id, base_product_id,
          projection_version, geometry_key, storage_key, content_type,
          byte_size, width_px, height_px, sha256, object_sha256, status,
          created_at, updated_at, ready_at
        ) VALUES (?, ?, ?, ?, 'safe-margin-v1', 'dtg:10x10', ?,
          'image/png', 3, 10, 10, ?, ?, 'ready', ?, ?, ?)
      `).bind(
        crypto.randomUUID(),
        fixture.productId,
        fixture.revisionId,
        fixture.baseProductId,
        logicalPrintKey,
        SHA_A,
        SHA_A,
        NOW - DAY_MS,
        NOW - DAY_MS,
        NOW - DAY_MS,
      ),
      storyJobStatement(
        fixture.productId,
        fixture.revisionId,
        "story-video-renderer-v7",
        storyKey,
        NOW - DAY_MS,
      ),
      testPlatform().env.DB.prepare(`
        INSERT INTO storage_test_fixtures (
          design_id, run_id, purpose, created_at, expires_at
        ) VALUES (?, '12345', 'native-qualification', ?, ?)
      `).bind(fixture.designId, NOW - 2 * DAY_MS, NOW - DAY_MS),
      testPlatform().env.DB.prepare(`
        INSERT INTO native_video_qualification_faults (design_id, point)
        VALUES (?, 'upload-ack')
      `).bind(fixture.designId),
      testPlatform().env.DB.prepare(`
        INSERT INTO native_video_qualification_observations (id, design_id)
        VALUES (?, ?)
      `).bind(crypto.randomUUID(), fixture.designId),
    ]);
    await putFixtureObjects([
      fixture.artworkKey,
      artworkPreviewKey(fixture.designId, SHA_A),
      logicalPrintKey,
      objectKey,
    ], [storyKey]);

    const report = await runScheduledStorageMaintenance(
      maintenanceEnv(),
      () => NOW,
    );

    expect(report.fixturesDeleted).toBe(1);
    expect(await count("designs", "id", fixture.designId)).toBe(0);
    expect(await count("print_asset_objects", "sha256", SHA_A)).toBe(0);
    for (const key of [
      fixture.artworkKey,
      artworkPreviewKey(fixture.designId, SHA_A),
      logicalPrintKey,
      objectKey,
    ]) {
      expect(await testPlatform().env.DESIGN_ARTWORK.head(key)).toBeNull();
    }
    expect(await maintenanceEnv().STORY_VIDEOS.head(storyKey)).toBeNull();
  });

  it("keeps a migrated physical key while another logical asset still references it", async () => {
    const fixture = await seedConfiguredProduct(
      "44444444-4444-4444-8444-444444444444",
      SHA_C,
    );
    const retained = await seedConfiguredProduct(
      "55555555-5555-4555-8555-555555555555",
      SHA_C,
    );
    const canonicalKey = `print-assets/${fixture.productId}/dtg:10x10/${SHA_C}.png`;
    const retainedLogicalKey = `print-assets/${retained.productId}/dtg:10x10/${SHA_C}.png`;
    await testPlatform().env.DB.batch([
      testPlatform().env.DB.prepare(`
        INSERT INTO print_asset_objects (
          sha256, storage_key, content_type, byte_size, width_px, height_px,
          created_at
        ) VALUES (?, ?, 'image/png', 3, 10, 10, ?)
      `).bind(SHA_C, canonicalKey, NOW - DAY_MS),
      readyPrintAssetStatement(fixture, SHA_C, canonicalKey),
      readyPrintAssetStatement(retained, SHA_C, retainedLogicalKey),
      testPlatform().env.DB.prepare(`
        INSERT INTO storage_test_fixtures (
          design_id, run_id, purpose, created_at, expires_at
        ) VALUES (?, '67890', 'native-qualification', ?, ?)
      `).bind(fixture.designId, NOW - 2 * DAY_MS, NOW - DAY_MS),
    ]);
    await testPlatform().env.DESIGN_ARTWORK.put(
      canonicalKey,
      new Uint8Array([1, 2, 3]),
    );

    const report = await runScheduledStorageMaintenance(
      maintenanceEnv(),
      () => NOW,
    );

    expect(report.fixturesDeleted).toBe(1);
    expect(await count("designs", "id", fixture.designId)).toBe(0);
    expect(await count("designs", "id", retained.designId)).toBe(1);
    expect(await count("print_asset_objects", "sha256", SHA_C)).toBe(1);
    expect(await testPlatform().env.DESIGN_ARTWORK.head(canonicalKey))
      .not.toBeNull();
  });

  it("retains the current and rollback renderer while aging out older media", async () => {
    const fixture = await seedConfiguredProduct(
      "22222222-2222-4222-8222-222222222222",
      SHA_B,
    );
    const old = NOW - 31 * DAY_MS;
    const jobs = [
      ["story-video-renderer-v4", `story-videos/v4/${fixture.productId}/Black.mp4`],
      ["story-video-renderer-v6", `story-videos/v6/${fixture.productId}/Black.mp4`],
      ["story-video-renderer-v7", `story-videos/v7/${fixture.productId}/Black.mp4`],
    ];
    for (const [renderer, key] of jobs) {
      if (!renderer || !key) throw new Error("Renderer fixture is invalid.");
      await testPlatform().env.DB.batch([
        storyJobStatement(fixture.productId, fixture.revisionId, renderer, key, old),
      ]);
      await maintenanceEnv().STORY_VIDEOS.put(key, new Uint8Array([1]));
    }

    const report = await runScheduledStorageMaintenance(
      maintenanceEnv(),
      () => NOW,
    );

    expect(report.rendererJobsDeleted).toBe(1);
    expect(await count("story_video_jobs", "renderer_version", "story-video-renderer-v4"))
      .toBe(0);
    expect(await count("story_video_jobs", "renderer_version", "story-video-renderer-v6"))
      .toBe(1);
    expect(await count("story_video_jobs", "renderer_version", "story-video-renderer-v7"))
      .toBe(1);
    expect(await maintenanceEnv().STORY_VIDEOS.head(jobs[0]?.[1] ?? "")).toBeNull();
    expect(await maintenanceEnv().STORY_VIDEOS.head(jobs[1]?.[1] ?? ""))
      .not.toBeNull();
    expect(await maintenanceEnv().STORY_VIDEOS.head(jobs[2]?.[1] ?? ""))
      .not.toBeNull();
  });

  it("sweeps old unreferenced managed objects but leaves unknown prefixes alone", async () => {
    const orphanArtwork = "designs/33333333-3333-4333-8333-333333333333/artwork.jpg";
    const orphanPrint = `print-assets/blobs/${SHA_C}.png`;
    const orphanVideo = "story-videos/v7/orphan/Black.mp4";
    const benchmark = "benchmarks/qualification/orphan.mp4";
    const unmanaged = "manual/keep-me.txt";
    const unreferencedPrintObject = `print-assets/blobs/${SHA_D}.png`;
    await testPlatform().env.DB.prepare(`
      INSERT INTO print_asset_objects (
        sha256, storage_key, content_type, byte_size, width_px, height_px,
        created_at
      ) VALUES (?, ?, 'image/png', 3, 10, 10, ?)
    `).bind(SHA_D, unreferencedPrintObject, NOW - 31 * DAY_MS).run();
    await putFixtureObjects(
      [orphanArtwork, orphanPrint, unreferencedPrintObject, unmanaged],
      [orphanVideo, benchmark, unmanaged],
    );

    const report = await runScheduledStorageMaintenance(
      maintenanceEnv(),
      () => NOW + 31 * DAY_MS,
    );

    expect(report.orphanArtworkDeleted).toBe(2);
    expect(report.orphanVideosDeleted).toBe(2);
    expect(report.printObjectsDeleted).toBe(1);
    expect(await testPlatform().env.DESIGN_ARTWORK.head(orphanArtwork)).toBeNull();
    expect(await testPlatform().env.DESIGN_ARTWORK.head(orphanPrint)).toBeNull();
    expect(await testPlatform().env.DESIGN_ARTWORK.head(unreferencedPrintObject))
      .toBeNull();
    expect(await maintenanceEnv().STORY_VIDEOS.head(orphanVideo)).toBeNull();
    expect(await maintenanceEnv().STORY_VIDEOS.head(benchmark)).toBeNull();
    expect(await testPlatform().env.DESIGN_ARTWORK.head(unmanaged)).not.toBeNull();
    expect(await maintenanceEnv().STORY_VIDEOS.head(unmanaged)).not.toBeNull();
  });

  it("starts a completed orphan scan no more than once a week", async () => {
    const key = "designs/66666666-6666-4666-8666-666666666666/artwork.jpg";
    await runScheduledStorageMaintenance(
      maintenanceEnv(),
      () => NOW + 31 * DAY_MS,
    );
    await testPlatform().env.DESIGN_ARTWORK.put(key, new Uint8Array([1]));

    await runScheduledStorageMaintenance(
      maintenanceEnv(),
      () => NOW + 32 * DAY_MS,
    );
    expect(await testPlatform().env.DESIGN_ARTWORK.head(key)).not.toBeNull();

    await runScheduledStorageMaintenance(
      maintenanceEnv(),
      () => NOW + 38 * DAY_MS,
    );
    expect(await testPlatform().env.DESIGN_ARTWORK.head(key)).toBeNull();
  });
});

async function seedConfiguredProduct(designId: string, sha256: string) {
  const base = await testPlatform().env.DB.prepare(`
    SELECT id FROM products WHERE design_id IS NULL ORDER BY created_at LIMIT 1
  `).first<{ readonly id: string }>();
  if (!base) throw new Error("Base Product fixture is unavailable.");
  const revisionId = crypto.randomUUID();
  const productId = crypto.randomUUID();
  const artworkKey = `designs/${designId}/artwork.jpg`;
  await testPlatform().env.DB.batch([
    testPlatform().env.DB.prepare(`
      INSERT INTO designs (
        id, owner_id, artwork_key, content_type, byte_size, artwork_width,
        artwork_height, sha256, crop_x, crop_y, crop_zoom, placement_x,
        placement_y, placement_width, depth, status, version, finalized_at,
        created_at, updated_at
      ) VALUES (?, 'qualification', ?, 'image/jpeg', 3, 10, 10, ?, 0.5,
        0.5, 1, 0.5, 0.5, 0.25, 5, 'ready', 1, ?, ?, ?)
    `).bind(designId, artworkKey, sha256, NOW, NOW, NOW),
    testPlatform().env.DB.prepare(`
      INSERT INTO design_revisions (
        id, design_id, fingerprint, artwork_key, content_type, byte_size,
        artwork_width, artwork_height, sha256, crop_x, crop_y, crop_zoom,
        placement_x, placement_y, placement_width, depth, created_at
      ) VALUES (?, ?, ?, ?, 'image/jpeg', 3, 10, 10, ?, 0.5, 0.5, 1,
        0.5, 0.5, 0.25, 5, ?)
    `).bind(revisionId, designId, `fixture:${designId}`, artworkKey, sha256, NOW),
    testPlatform().env.DB.prepare(`
      INSERT INTO products (
        id, base_product_id, design_id, design_revision_id, placement_x,
        placement_y, placement_width, placement_depth, projection_version,
        shopify_handle, status, created_at
      ) VALUES (?, ?, ?, ?, 0.5, 0.5, 0.25, 5, 'safe-margin-v1', ?,
        'active', ?)
    `).bind(productId, base.id, designId, revisionId, `fixture-${designId}`, NOW),
  ]);
  return { artworkKey, baseProductId: base.id, designId, productId, revisionId };
}

function storyJobStatement(
  productId: string,
  revisionId: string,
  renderer: string,
  storyKey: string,
  updatedAt: number,
) {
  return testPlatform().env.DB.prepare(`
    INSERT INTO story_video_jobs (
      id, product_id, design_revision_id, colour, renderer_version,
      story_key, status, attempt_count, output_byte_size, created_at,
      updated_at, rendered_at
    ) VALUES (?, ?, ?, 'Black', ?, ?, 'ready', 1, 1, ?, ?, ?)
  `).bind(
    crypto.randomUUID(),
    productId,
    revisionId,
    renderer,
    storyKey,
    updatedAt,
    updatedAt,
    updatedAt,
  );
}

function readyPrintAssetStatement(
  fixture: Awaited<ReturnType<typeof seedConfiguredProduct>>,
  sha256: string,
  storageKey: string,
) {
  return testPlatform().env.DB.prepare(`
    INSERT INTO print_assets (
      id, configured_product_id, design_revision_id, base_product_id,
      projection_version, geometry_key, storage_key, content_type, byte_size,
      width_px, height_px, sha256, object_sha256, status, created_at,
      updated_at, ready_at
    ) VALUES (?, ?, ?, ?, 'safe-margin-v1', 'dtg:10x10', ?, 'image/png',
      3, 10, 10, ?, ?, 'ready', ?, ?, ?)
  `).bind(
    crypto.randomUUID(),
    fixture.productId,
    fixture.revisionId,
    fixture.baseProductId,
    storageKey,
    sha256,
    sha256,
    NOW - DAY_MS,
    NOW - DAY_MS,
    NOW - DAY_MS,
  );
}

async function putFixtureObjects(artwork: string[], videos: string[]) {
  for (const key of artwork) {
    await testPlatform().env.DESIGN_ARTWORK.put(key, new Uint8Array([1, 2, 3]));
  }
  for (const key of videos) {
    await maintenanceEnv().STORY_VIDEOS.put(key, new Uint8Array([1, 2, 3]));
  }
}

async function count(table: string, column: string, value: string) {
  const allowed = new Set([
    "designs:id",
    "print_asset_objects:sha256",
    "story_video_jobs:renderer_version",
  ]);
  if (!allowed.has(`${table}:${column}`)) throw new Error("Unsafe count query.");
  const row = await testPlatform().env.DB.prepare(`
    SELECT count(*) AS count FROM ${table} WHERE ${column} = ?
  `).bind(value).first<{ readonly count: number }>();
  return row?.count ?? 0;
}
