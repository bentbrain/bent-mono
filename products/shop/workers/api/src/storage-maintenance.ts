import { artworkPreviewKey } from "./design-repository";
import { STORY_VIDEO_RETAINED_RENDERER_VERSIONS } from "./story-video-jobs";

const DAY_MS = 24 * 60 * 60 * 1_000;
const FIXTURE_LIMIT = 10;
const OBJECT_GRACE_MS = 2 * DAY_MS;
const OBJECT_SCAN_LIMIT = 100;
const ORPHAN_SWEEP_INTERVAL_MS = 7 * DAY_MS;
const PRINT_OBJECT_LIMIT = 100;
const RENDERER_RETENTION_MS = 30 * DAY_MS;
const RENDERER_RETENTION_LIMIT = 100;
const BENCHMARK_RETENTION_MS = 7 * DAY_MS;

interface StorageMaintenanceEnv {
  readonly DB: D1Database;
  readonly DESIGN_ARTWORK: R2Bucket;
  readonly STORY_VIDEOS: R2Bucket;
}

interface FixtureRow {
  readonly design_id: string;
}

interface FixtureKeys {
  readonly artwork: string[];
  readonly printAssets: string[];
  readonly printObjects: readonly {
    readonly sha256: string;
    readonly storage_key: string;
  }[];
  readonly videos: string[];
}

interface RendererJobRow {
  readonly id: string;
  readonly story_key: string;
}

interface PrintObjectRow {
  readonly sha256: string;
  readonly storage_key: string;
}

interface CursorRow {
  readonly cursor: string | null;
  readonly updated_at: number;
}

interface ReferenceRow {
  readonly referenced: number;
}

export interface StorageMaintenanceReport {
  readonly fixturesDeleted: number;
  readonly orphanArtworkDeleted: number;
  readonly orphanVideosDeleted: number;
  readonly printObjectsDeleted: number;
  readonly rendererJobsDeleted: number;
}

export async function runScheduledStorageMaintenance(
  env: StorageMaintenanceEnv,
  now = () => Date.now(),
): Promise<StorageMaintenanceReport> {
  const timestamp = now();
  const fixturesDeleted = await purgeExpiredFixtures(env, timestamp);
  const printObjectsDeleted = await purgeUnreferencedPrintObjects(env);
  const rendererJobsDeleted = await purgeOldRendererJobs(env, timestamp);
  const orphanArtworkDeleted = await scanArtworkOrphans(env, timestamp);
  const orphanVideosDeleted = await scanVideoOrphans(env, timestamp);
  return {
    fixturesDeleted,
    orphanArtworkDeleted,
    orphanVideosDeleted,
    printObjectsDeleted,
    rendererJobsDeleted,
  };
}

async function purgeExpiredFixtures(env: StorageMaintenanceEnv, now: number) {
  const fixtures = await env.DB.prepare(`
    SELECT design_id FROM storage_test_fixtures
    WHERE purpose = 'native-qualification' AND expires_at <= ?
    ORDER BY expires_at, design_id LIMIT ?
  `).bind(now, FIXTURE_LIMIT).all<FixtureRow>();
  let deleted = 0;
  for (const fixture of fixtures.results) {
    if (await fixtureHasProtectedReferences(env.DB, fixture.design_id)) continue;
    const keys = await readFixtureKeys(env.DB, fixture.design_id);
    const results = await env.DB.batch([
      env.DB.prepare(`
        DELETE FROM native_video_qualification_observations
        WHERE design_id = ?
      `).bind(fixture.design_id),
      env.DB.prepare(`
        DELETE FROM native_video_qualification_faults WHERE design_id = ?
      `).bind(fixture.design_id),
      env.DB.prepare(`
        DELETE FROM story_video_jobs
        WHERE product_id IN (SELECT id FROM products WHERE design_id = ?)
      `).bind(fixture.design_id),
      env.DB.prepare(`
        DELETE FROM print_assets
        WHERE configured_product_id IN (
          SELECT id FROM products WHERE design_id = ?
        )
      `).bind(fixture.design_id),
      env.DB.prepare(`
        DELETE FROM products WHERE design_id = ?
      `).bind(fixture.design_id),
      env.DB.prepare(`
        DELETE FROM design_upload_grants WHERE design_id = ?
      `).bind(fixture.design_id),
      env.DB.prepare(`
        DELETE FROM design_revisions WHERE design_id = ?
      `).bind(fixture.design_id),
      env.DB.prepare(`
        DELETE FROM storage_test_fixtures WHERE design_id = ?
      `).bind(fixture.design_id),
      env.DB.prepare(`
        DELETE FROM designs WHERE id = ?
      `).bind(fixture.design_id),
    ]);
    if ((results[8]?.meta.changes ?? 0) !== 1) continue;
    deleted += 1;
    await removeUnreferencedPrintObjects(env, keys.printObjects);
    const legacyPrintAssets = await filterUnreferencedLegacyPrintAssets(
      env.DB,
      keys.printAssets,
    );
    await deleteObjects(env.DESIGN_ARTWORK, [
      ...keys.artwork,
      ...legacyPrintAssets,
    ]);
    await deleteObjects(env.STORY_VIDEOS, keys.videos);
  }
  return deleted;
}

async function fixtureHasProtectedReferences(db: D1Database, designId: string) {
  const row = await db.prepare(`
    SELECT EXISTS (
      SELECT 1 FROM paid_order_lines AS lines
      JOIN products ON products.id = lines.configured_product_id
      WHERE products.design_id = ?
    ) OR EXISTS (
      SELECT 1 FROM printify_production_products AS production
      JOIN products ON products.id = production.configured_product_id
      WHERE products.design_id = ?
    ) OR EXISTS (
      SELECT 1 FROM product_lifecycle_transitions transitions
      JOIN products ON products.id = transitions.product_id
      WHERE products.design_id = ?
    ) AS referenced
  `).bind(designId, designId, designId).first<ReferenceRow>();
  return row?.referenced === 1;
}

async function readFixtureKeys(
  db: D1Database,
  designId: string,
): Promise<FixtureKeys> {
  const designs = await db.prepare(`
    SELECT artwork_key, sha256 FROM designs WHERE id = ?
    UNION SELECT artwork_key, sha256 FROM design_artwork_sources WHERE design_id = ?
    UNION SELECT artwork_key, sha256 FROM design_revisions WHERE design_id = ?
  `).bind(designId, designId, designId).all<{ readonly artwork_key: string; readonly sha256: string }>();
  const assets = await db.prepare(`
    SELECT assets.storage_key,
      objects.sha256 AS object_sha256,
      objects.storage_key AS object_storage_key
    FROM print_assets AS assets
    LEFT JOIN print_asset_objects AS objects
      ON objects.sha256 = assets.object_sha256
    WHERE assets.configured_product_id IN (
      SELECT id FROM products WHERE design_id = ?
    )
  `).bind(designId).all<{
    readonly object_sha256: string | null;
    readonly object_storage_key: string | null;
    readonly storage_key: string | null;
  }>();
  const videos = await db.prepare(`
    SELECT story_key FROM story_video_jobs
    WHERE product_id IN (SELECT id FROM products WHERE design_id = ?)
  `).bind(designId).all<{ readonly story_key: string }>();
  return {
    artwork: designs.results.flatMap((design) => [
      design.artwork_key,
      artworkPreviewKey(designId, design.sha256),
    ]),
    printAssets: assets.results.flatMap((asset) =>
      asset.storage_key ? [asset.storage_key] : []
    ),
    printObjects: assets.results.flatMap((asset) =>
      asset.object_sha256 && asset.object_storage_key
        ? [{ sha256: asset.object_sha256, storage_key: asset.object_storage_key }]
        : []
    ),
    videos: videos.results.map((video) => video.story_key),
  };
}

async function removeUnreferencedPrintObjects(
  env: StorageMaintenanceEnv,
  objects: FixtureKeys["printObjects"],
) {
  const unique = new Map(objects.map((object) => [object.sha256, object]));
  const keys: string[] = [];
  for (const object of unique.values()) {
    const result = await env.DB.prepare(`
      DELETE FROM print_asset_objects
      WHERE sha256 = ? AND NOT EXISTS (
        SELECT 1 FROM print_assets WHERE object_sha256 = ?
      )
    `).bind(object.sha256, object.sha256).run();
    if (result.meta.changes === 1) keys.push(object.storage_key);
  }
  await deleteObjects(env.DESIGN_ARTWORK, keys);
}

async function filterUnreferencedLegacyPrintAssets(
  db: D1Database,
  keys: readonly string[],
) {
  const deletable: string[] = [];
  for (const key of new Set(keys)) {
    const row = await db.prepare(`
      SELECT EXISTS (
        SELECT 1 FROM print_asset_objects WHERE storage_key = ?
      ) AS referenced
    `).bind(key).first<ReferenceRow>();
    if (row?.referenced !== 1) deletable.push(key);
  }
  return deletable;
}

async function purgeUnreferencedPrintObjects(env: StorageMaintenanceEnv) {
  const objects = await env.DB.prepare(`
    SELECT objects.sha256, objects.storage_key
    FROM print_asset_objects AS objects
    WHERE NOT EXISTS (
      SELECT 1 FROM print_assets WHERE object_sha256 = objects.sha256
    )
    ORDER BY objects.created_at, objects.sha256 LIMIT ?
  `).bind(PRINT_OBJECT_LIMIT).all<PrintObjectRow>();
  const keys: string[] = [];
  let deleted = 0;
  for (const object of objects.results) {
    const result = await env.DB.prepare(`
      DELETE FROM print_asset_objects
      WHERE sha256 = ? AND NOT EXISTS (
        SELECT 1 FROM print_assets WHERE object_sha256 = ?
      )
    `).bind(object.sha256, object.sha256).run();
    if (result.meta.changes === 1) {
      keys.push(object.storage_key);
      deleted += 1;
    }
  }
  await deleteObjects(env.DESIGN_ARTWORK, keys);
  return deleted;
}

async function purgeOldRendererJobs(env: StorageMaintenanceEnv, now: number) {
  const jobs = await env.DB.prepare(`
    SELECT id, story_key FROM story_video_jobs
    WHERE renderer_version NOT IN (?, ?)
      AND status != 'rendering' AND updated_at <= ?
    ORDER BY updated_at, id LIMIT ?
  `).bind(
    STORY_VIDEO_RETAINED_RENDERER_VERSIONS[0],
    STORY_VIDEO_RETAINED_RENDERER_VERSIONS[1],
    now - RENDERER_RETENTION_MS,
    RENDERER_RETENTION_LIMIT,
  ).all<RendererJobRow>();
  const keys: string[] = [];
  let deleted = 0;
  for (const job of jobs.results) {
    const result = await env.DB.prepare(`
      DELETE FROM story_video_jobs
      WHERE id = ? AND renderer_version NOT IN (?, ?)
        AND status != 'rendering' AND updated_at <= ?
    `).bind(
      job.id,
      STORY_VIDEO_RETAINED_RENDERER_VERSIONS[0],
      STORY_VIDEO_RETAINED_RENDERER_VERSIONS[1],
      now - RENDERER_RETENTION_MS,
    ).run();
    if (result.meta.changes === 1) {
      keys.push(job.story_key);
      deleted += 1;
    }
  }
  await deleteObjects(env.STORY_VIDEOS, keys);
  return deleted;
}

async function scanArtworkOrphans(env: StorageMaintenanceEnv, now: number) {
  return scanBucket(
    env.DB,
    env.DESIGN_ARTWORK,
    "design-artwork",
    now,
    (object) => artworkObjectIsUnreferenced(env.DB, object.key),
  );
}

async function scanVideoOrphans(env: StorageMaintenanceEnv, now: number) {
  return scanBucket(
    env.DB,
    env.STORY_VIDEOS,
    "story-videos",
    now,
    (object) => videoObjectIsUnreferenced(env.DB, object.key, object.uploaded, now),
  );
}

async function scanBucket(
  db: D1Database,
  bucket: R2Bucket,
  bucketName: "design-artwork" | "story-videos",
  now: number,
  isUnreferenced: (object: R2Object) => Promise<boolean>,
) {
  const state = await db.prepare(`
    SELECT cursor, updated_at FROM storage_gc_cursors WHERE bucket = ?
  `).bind(bucketName).first<CursorRow>();
  if (
    state?.cursor === null &&
    state.updated_at > now - ORPHAN_SWEEP_INTERVAL_MS
  ) return 0;
  const options: R2ListOptions = state?.cursor
    ? { cursor: state.cursor, limit: OBJECT_SCAN_LIMIT }
    : { limit: OBJECT_SCAN_LIMIT };
  const page = await bucket.list(options);
  const expired = page.objects.filter((object) =>
    object.uploaded.getTime() <= now - OBJECT_GRACE_MS
  );
  const deletions: string[] = [];
  for (const object of expired) {
    if (await isUnreferenced(object)) deletions.push(object.key);
  }
  await deleteObjects(bucket, deletions);
  await db.prepare(`
    INSERT INTO storage_gc_cursors (bucket, cursor, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT (bucket) DO UPDATE
    SET cursor = excluded.cursor, updated_at = excluded.updated_at
  `).bind(bucketName, page.truncated ? page.cursor : null, now).run();
  return deletions.length;
}

async function artworkObjectIsUnreferenced(db: D1Database, key: string) {
  if (!key.startsWith("designs/") && !key.startsWith("print-assets/")) {
    return false;
  }
  if (key.includes("/product-images/")) {
    const image = await db.prepare(`SELECT 1 FROM product_image_jobs jobs JOIN products ON products.id=jobs.product_id AND products.status='active'
      JOIN designs ON designs.id=products.design_id AND designs.status='ready' WHERE jobs.storage_key=?`).bind(key.replace(/-(192|384|768|960|1200|1500)\.(webp|png)$/, ".webp")).first();
    return !image;
  }
  const direct = await db.prepare(`
    SELECT EXISTS (SELECT 1 FROM designs WHERE artwork_key = ?)
      OR EXISTS (SELECT 1 FROM design_artwork_sources WHERE artwork_key = ?)
      OR EXISTS (SELECT 1 FROM artwork_preparation_jobs WHERE source_key = ? AND source_deleted_at IS NULL)
      OR EXISTS (SELECT 1 FROM design_revisions WHERE artwork_key = ?)
      OR EXISTS (SELECT 1 FROM print_asset_objects WHERE storage_key = ?)
      OR EXISTS (
        SELECT 1 FROM print_assets
        WHERE object_sha256 IS NULL AND storage_key = ?
      ) AS referenced
  `).bind(key, key, key, key, key, key).first<ReferenceRow>();
  if (direct?.referenced === 1) return false;
  const preview = /^designs\/([a-f0-9-]{36})\/artwork-preview-([a-f0-9]{64})-[a-z0-9-]+\.webp$/u.exec(key);
  if (!preview) return true;
  const designId = preview[1];
  const sha256 = preview[2];
  if (!designId || !sha256) return false;
  const owner = await db.prepare(`
    SELECT EXISTS (
      SELECT 1 FROM designs WHERE id = ? AND sha256 = ?
    ) AS referenced
  `).bind(designId, sha256).first<ReferenceRow>();
  return owner?.referenced !== 1;
}

async function videoObjectIsUnreferenced(
  db: D1Database,
  key: string,
  uploaded: Date,
  now: number,
) {
  if (key.startsWith("benchmarks/")) {
    return uploaded.getTime() <= now - BENCHMARK_RETENTION_MS;
  }
  if (!key.startsWith("story-videos/")) return false;
  const row = await db.prepare(`
    SELECT EXISTS (
      SELECT 1 FROM story_video_jobs WHERE story_key = ?
    ) AS referenced
  `).bind(key).first<ReferenceRow>();
  return row?.referenced !== 1;
}

async function deleteObjects(bucket: R2Bucket, keys: readonly string[]) {
  const unique = [...new Set(keys)];
  if (unique.length > 0) await bucket.delete(unique);
}
