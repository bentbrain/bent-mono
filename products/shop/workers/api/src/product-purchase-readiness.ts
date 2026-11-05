import { MAX_PRINT_ASSET_BYTES } from "@forever-tee/contracts/limits";

// Polling checks the committed print ledger, including legacy products without
// jobs. Checkout still verifies the selected object's R2 checksum independently.
export async function productPurchaseReadiness(db: D1Database, productId: string) {
  const row = await db.prepare(`
    SELECT CASE WHEN
      (jobs.status IS NULL OR jobs.status = 'ready')
      AND count(variants.printify_variant_id) > 0
      AND min(CASE WHEN
        asset.id IS NOT NULL AND asset.status = 'ready'
        AND asset.content_type = 'image/png'
        AND asset.byte_size > 0 AND asset.byte_size <= ?
        AND asset.width_px = variants.print_width
        AND asset.height_px = variants.print_height
        AND variants.print_width BETWEEN 1 AND 12000
        AND variants.print_height BETWEEN 1 AND 12000
        AND length(asset.sha256) = 64
        AND asset.sha256 NOT GLOB '*[^0-9a-f]*'
        AND asset.storage_key = 'print-assets/' || product.id || '/' ||
          asset.geometry_key || '/' || asset.sha256 || '.png'
        AND asset.ready_at IS NOT NULL AND asset.deleted_at IS NULL
        AND (asset.object_sha256 IS NULL OR (
          object.sha256 = asset.sha256
          AND object.content_type = asset.content_type
          AND object.byte_size = asset.byte_size
          AND object.width_px = asset.width_px
          AND object.height_px = asset.height_px
          AND length(object.storage_key) > 0
        ))
      THEN 1 ELSE 0 END) = 1
    THEN 1 ELSE 0 END AS ready
    FROM products AS product
    JOIN products AS base ON base.id = product.base_product_id
      AND base.status = 'active' AND base.design_id IS NULL
    JOIN design_revisions AS revision ON revision.id = product.design_revision_id
      AND revision.design_id = product.design_id
    LEFT JOIN print_asset_jobs AS jobs ON jobs.configured_product_id = product.id
    LEFT JOIN shopify_variant_mapping_snapshots AS mapping
      ON mapping.id = (
        SELECT id FROM shopify_variant_mapping_snapshots
        WHERE base_product_id = product.base_product_id
          AND shopify_product_handle = base.shopify_handle
        ORDER BY retrieved_at DESC, id DESC LIMIT 1
      )
    LEFT JOIN printify_catalogue_snapshots AS catalogue
      ON catalogue.id = mapping.catalogue_snapshot_id
      AND catalogue.base_product_id = product.base_product_id
    LEFT JOIN printify_catalogue_variants AS variants
      ON variants.snapshot_id = catalogue.id
    LEFT JOIN print_assets AS asset ON asset.configured_product_id = product.id
      AND asset.design_revision_id = product.design_revision_id
      AND asset.base_product_id = product.base_product_id
      AND asset.projection_version = product.projection_version
      AND asset.geometry_key = lower(variants.decoration_method) || ':' ||
        variants.print_width || 'x' || variants.print_height
    LEFT JOIN print_asset_objects AS object ON object.sha256 = asset.object_sha256
    WHERE product.id = ? AND product.status = 'active'
      AND product.design_id IS NOT NULL AND product.design_revision_id IS NOT NULL
    GROUP BY product.id
  `).bind(MAX_PRINT_ASSET_BYTES, productId).first<{ ready: number }>();
  if (row) return { ready: row.ready === 1 };
  const pending = await db.prepare(`SELECT product.id, design.id AS design_id, design.artwork_job_id, job.status AS preparation_status
    FROM products product JOIN designs design ON design.id = product.design_id
    JOIN artwork_preparation_jobs job ON job.id = design.artwork_job_id
    JOIN products base ON base.id = product.base_product_id AND base.status = 'active' AND base.design_id IS NULL
    WHERE product.id = ? AND product.status = 'active' AND product.design_revision_id IS NULL
      AND design.artwork_job_id IS NOT NULL AND design.finalized_at IS NOT NULL
      AND design.deleted_at IS NULL AND design.status IN ('processing', 'ready')`).bind(productId).first<{ id: string; design_id: string; artwork_job_id: string; preparation_status: string }>();
  return pending ? { ready: false, ...(pending.preparation_status === "failed" ? {
    retryArtwork: { designId: pending.design_id, artworkJobId: pending.artwork_job_id },
  } : {}) } : undefined;
}
