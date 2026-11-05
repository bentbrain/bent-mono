import { artworkPreviewKey } from "./artwork-preview";

interface DeletionEnv {
  readonly DB: D1Database;
  readonly DESIGN_ARTWORK: Pick<R2Bucket, "list" | "delete">;
  readonly STORY_VIDEOS: Pick<R2Bucket, "delete">;
}

// Order and provider references are checked inside the same transaction that
// removes the public products. Their print assets and snapshots remain usable.
const unneededPrintAsset = `
  NOT EXISTS (SELECT 1 FROM paid_order_lines WHERE print_asset_id = print_assets.id)
  AND NOT EXISTS (SELECT 1 FROM printify_production_products WHERE print_asset_id = print_assets.id)
  AND NOT EXISTS (SELECT 1 FROM printify_media_copies WHERE print_asset_id = print_assets.id)
`;

export async function deleteOwnedDesign(env: DeletionEnv, ownerId: string, id: string) {
  const design = await env.DB.prepare(`
    SELECT id FROM designs WHERE id = ? AND owner_id = ? AND finalized_at IS NOT NULL
  `).bind(id, ownerId).first();
  if (!design) return undefined;

  const products = await env.DB.prepare("SELECT id FROM products WHERE design_id = ?")
    .bind(id).all<{ id: string }>();
  const artwork = await env.DB.prepare(`
    SELECT sha256 FROM designs WHERE id = ?
    UNION SELECT sha256 FROM design_revisions WHERE design_id = ?
  `).bind(id, id).all<{ sha256: string }>();
  const now = Date.now();
  const queue = (key: string) => env.DB.prepare(`
    INSERT OR IGNORE INTO design_asset_deletions (bucket, storage_key, design_id, created_at)
    VALUES ('design-artwork', ?, ?, ?)
  `).bind(key, id, now);

  await env.DB.batch([
    env.DB.prepare(`DELETE FROM product_image_jobs WHERE product_id IN (SELECT id FROM products WHERE design_id=?)`).bind(id),
    env.DB.prepare(`
      UPDATE designs SET status = 'deleted', deleted_at = coalesce(deleted_at, ?),
        updated_at = ? WHERE id = ? AND owner_id = ?
    `).bind(now, now, id, ownerId),
    env.DB.prepare(`
      UPDATE products SET status = CASE WHEN status IN ('suspended', 'unpublished', 'retired') THEN status ELSE 'deleted' END, deleted_at = coalesce(deleted_at, ?)
      WHERE design_id = ?
    `).bind(now, id),
    env.DB.prepare("DELETE FROM design_upload_grants WHERE design_id = ?").bind(id),
    env.DB.prepare(`
      INSERT OR IGNORE INTO design_asset_deletions (bucket, storage_key, design_id, created_at)
      SELECT 'story-videos', story_key, ?, ? FROM story_video_jobs
      WHERE design_revision_id IN (SELECT id FROM design_revisions WHERE design_id = ?)
    `).bind(id, now, id),
    env.DB.prepare(`DELETE FROM story_video_jobs
      WHERE design_revision_id IN (SELECT id FROM design_revisions WHERE design_id = ?)
    `).bind(id),
    env.DB.prepare(`
      INSERT OR IGNORE INTO design_asset_deletions (bucket, storage_key, design_id, created_at)
      SELECT 'design-artwork', coalesce(objects.storage_key, print_assets.storage_key), ?, ?
      FROM print_assets LEFT JOIN print_asset_objects AS objects ON objects.sha256 = print_assets.object_sha256
      WHERE configured_product_id IN (SELECT id FROM products WHERE design_id = ?)
        AND coalesce(objects.storage_key, print_assets.storage_key) IS NOT NULL
        AND ${unneededPrintAsset}
    `).bind(id, now, id),
    env.DB.prepare(`
      INSERT OR IGNORE INTO design_asset_deletions (bucket, storage_key, design_id, created_at)
      SELECT 'design-artwork', storage_key, ?, ? FROM print_assets
      WHERE configured_product_id IN (SELECT id FROM products WHERE design_id = ?)
        AND storage_key IS NOT NULL AND ${unneededPrintAsset}
    `).bind(id, now, id),
    env.DB.prepare(`DELETE FROM print_assets
      WHERE configured_product_id IN (SELECT id FROM products WHERE design_id = ?)
        AND ${unneededPrintAsset}
    `).bind(id),
    env.DB.prepare(`DELETE FROM print_asset_objects
      WHERE storage_key IN (SELECT storage_key FROM design_asset_deletions WHERE design_id = ?)
        AND NOT EXISTS (SELECT 1 FROM print_assets WHERE object_sha256 = print_asset_objects.sha256)
    `).bind(id),
    env.DB.prepare(`UPDATE products SET design_revision_id = NULL, video_recursive_revision_id = NULL, video_design_revision_id = NULL
      WHERE design_id = ?
        AND NOT EXISTS (SELECT 1 FROM print_assets WHERE configured_product_id = products.id)
        AND NOT EXISTS (SELECT 1 FROM paid_order_lines WHERE configured_product_id = products.id)
        AND NOT EXISTS (SELECT 1 FROM printify_production_products WHERE configured_product_id = products.id)
    `).bind(id),
    // Queue before dropping references so an interrupted R2 delete can retry.
    env.DB.prepare(`
      INSERT OR IGNORE INTO design_asset_deletions (bucket, storage_key, design_id, created_at)
      SELECT 'design-artwork', artwork_key, ?, ? FROM designs WHERE id = ?
      UNION SELECT 'design-artwork', artwork_key, ?, ? FROM design_revisions WHERE design_id = ?
      UNION SELECT 'design-artwork', artwork_key, ?, ? FROM design_artwork_sources WHERE design_id = ?
    `).bind(id, now, id, id, now, id, id, now, id),
    ...artwork.results.filter((row) => /^[a-f0-9]{64}$/.test(row.sha256))
      .map((row) => queue(artworkPreviewKey(id, row.sha256))),
    env.DB.prepare(`DELETE FROM design_revisions WHERE design_id = ?
      AND NOT EXISTS (SELECT 1 FROM products WHERE design_revision_id = design_revisions.id OR video_recursive_revision_id = design_revisions.id OR video_design_revision_id = design_revisions.id)
      AND NOT EXISTS (SELECT 1 FROM paid_order_lines WHERE design_revision_id = design_revisions.id)
      AND NOT EXISTS (SELECT 1 FROM print_assets WHERE design_revision_id = design_revisions.id)
      AND NOT EXISTS (SELECT 1 FROM printify_production_products WHERE design_revision_id = design_revisions.id)
    `).bind(id),
    env.DB.prepare("DELETE FROM design_artwork_sources WHERE design_id = ?").bind(id),
    env.DB.prepare(`UPDATE designs SET artwork_key = 'designs/' || id || '/deleted',
      sha256 = '', byte_size = 0, artwork_width = NULL, artwork_height = NULL,
      safety_screening_decision = NULL, safety_screening_model = NULL,
      default_product_color_model = NULL
      WHERE id = ?
    `).bind(id),
  ]);

  // Catch older previews and abandoned uploads as well as the current keys.
  // The regular orphan sweep also handles uploads that finish after deletion.
  try {
    let cursor: string | undefined;
    do {
      const page = await env.DESIGN_ARTWORK.list({ prefix: `designs/${id}/`, ...(cursor ? { cursor } : {}) });
      if (page.objects.length) await env.DB.batch(page.objects.map((object) => queue(object.key)));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    await drainDesignAssetDeletions(env, id);
  } catch {
    // Deletion has committed. Scheduled cleanup retries the durable outbox;
    // orphan maintenance catches any older objects missed by a failed list.
    console.warn("Design asset cleanup deferred", { designId: id });
  }
  return { id, productIds: products.results.map((product) => product.id) };
}

export async function drainDesignAssetDeletions(env: DeletionEnv, designId?: string) {
  const pending = await env.DB.prepare(`
    SELECT bucket, storage_key FROM design_asset_deletions
    ${designId ? "WHERE design_id = ?" : ""}
    ORDER BY created_at, storage_key LIMIT 100
  `).bind(...(designId ? [designId] : [])).all<{
    bucket: "design-artwork" | "story-videos"; storage_key: string;
  }>();
  for (const object of pending.results) {
    const key = object.storage_key;
    const reference = object.bucket === "design-artwork"
      ? await env.DB.prepare(`SELECT
          EXISTS (SELECT 1 FROM designs WHERE artwork_key = ?)
          OR EXISTS (SELECT 1 FROM design_revisions WHERE artwork_key = ?)
          OR EXISTS (SELECT 1 FROM print_assets WHERE storage_key = ?)
          OR EXISTS (SELECT 1 FROM print_asset_objects WHERE storage_key = ?) AS retained
        `).bind(key, key, key, key).first<{ retained: number }>()
      : await env.DB.prepare(`SELECT EXISTS (
          SELECT 1 FROM story_video_jobs WHERE story_key = ?
        ) AS retained`).bind(key).first<{ retained: number }>();
    if (reference?.retained !== 1) {
      try {
        await (object.bucket === "design-artwork" ? env.DESIGN_ARTWORK : env.STORY_VIDEOS).delete(key);
      } catch {
        // Leave the outbox row for the scheduled retry.
        continue;
      }
    }
    await env.DB.prepare("DELETE FROM design_asset_deletions WHERE bucket = ? AND storage_key = ?")
      .bind(object.bucket, key).run();
  }
}
