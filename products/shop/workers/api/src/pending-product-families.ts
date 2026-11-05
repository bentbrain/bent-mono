import { baseProductSlugForId } from "@forever-tee/contracts";
import { designRevisionFingerprint } from "./design-revision-repository";
import { productPrintResolution } from "./print-assets";

// A finalized progressive draft reserves its own UUID for the future immutable
// revision. Products and cart intents keep that identity across preparation.
export async function pendingProductPreparation(db: D1Database, designId: string) {
  const row = await db.prepare(`SELECT id FROM designs WHERE id = ?
    AND artwork_job_id IS NOT NULL AND finalized_at IS NOT NULL AND deleted_at IS NULL
    AND status IN ('processing', 'ready')`).bind(designId).first<{ id: string }>();
  return row?.id;
}

interface PendingDesign {
  id: string; artwork_key: string; content_type: string; byte_size: number;
  artwork_width: number; artwork_height: number; sha256: string;
  crop_x: number; crop_y: number; crop_zoom: number; updated_at: number; version: number;
}

// The finalized design and null product revisions are the durable outbox. Cron
// recovers a crash after source completion, revision insertion, or queue handoff.
export async function completePendingProductFamilies(
  db: D1Database,
  publish: (ids: string[]) => Promise<unknown>,
) {
  const rows = await db.prepare(`SELECT DISTINCT d.id, d.artwork_key, d.content_type, d.byte_size,
    d.artwork_width, d.artwork_height, d.sha256, d.crop_x, d.crop_y, d.crop_zoom, d.updated_at, d.version
    FROM designs d JOIN products p ON p.design_id = d.id AND p.status = 'active'
    WHERE d.artwork_job_id IS NOT NULL AND d.finalized_at IS NOT NULL AND d.status = 'ready'
      AND d.deleted_at IS NULL AND (p.design_revision_id IS NULL OR (
        p.design_revision_id = d.id AND (
          NOT EXISTS (SELECT 1 FROM print_asset_jobs WHERE configured_product_id = p.id)
          OR NOT EXISTS (SELECT 1 FROM product_image_jobs WHERE product_id = p.id)
          OR (p.print_mode <> 'base-image-only' AND NOT EXISTS (SELECT 1 FROM story_video_jobs WHERE product_id = p.id))
        ))) LIMIT 20`).all<PendingDesign>();
  for (const design of rows.results) {
    const products = await db.prepare(`SELECT id, base_product_id FROM products WHERE design_id = ?
      AND status = 'active' AND (design_revision_id IS NULL OR design_revision_id = ?)`)
      .bind(design.id, design.id).all<{ id: string; base_product_id: string }>();
    // Revalidate the actual full-resolution source before creating any immutable
    // revision or print job. An early display preview can never pass this gate.
    const quality = await Promise.all(products.results.map(product => productPrintResolution(db,
      product.base_product_id, design.artwork_width, design.artwork_height,
      { cropX: design.crop_x, cropY: design.crop_y, cropZoom: design.crop_zoom })));
    if (!products.results.length || !quality.every(result => result?.safe)) continue;
    if (!products.results.every(product => baseProductSlugForId(product.base_product_id))) continue;
    const fingerprint = await designRevisionFingerprint(db, {
      id: design.id, artworkKey: design.artwork_key, contentType: design.content_type,
      byteSize: design.byte_size, artworkWidth: design.artwork_width, artworkHeight: design.artwork_height,
      sha256: design.sha256, cropX: design.crop_x, cropY: design.crop_y, cropZoom: design.crop_zoom,
      updatedAt: new Date(design.updated_at),
    });
    await db.batch([
      db.prepare(`INSERT INTO design_revisions (id, design_id, fingerprint, artwork_key, content_type,
        byte_size, artwork_width, artwork_height, sha256, crop_x, crop_y, crop_zoom,
        placement_x, placement_y, placement_width, depth, created_at)
        SELECT id, id, ?, artwork_key, content_type, byte_size, artwork_width, artwork_height,
          sha256, crop_x, crop_y, crop_zoom, 0, 0, 0.08, 1, updated_at FROM designs
        WHERE id = ? AND version = ? AND status = 'ready' AND finalized_at IS NOT NULL AND deleted_at IS NULL
        ON CONFLICT DO NOTHING`).bind(fingerprint, design.id, design.version),
      db.prepare(`UPDATE products SET design_revision_id = ? WHERE design_id = ?
        AND design_revision_id IS NULL AND status = 'active'
        AND EXISTS (SELECT 1 FROM design_revisions r JOIN designs d ON d.id = r.design_id
          WHERE r.id = ? AND r.fingerprint = ? AND d.status = 'ready' AND d.deleted_at IS NULL)`)
        .bind(design.id, design.id, design.id, fingerprint),
    ]);
    await publish(products.results.map(product => product.id));
  }
}
