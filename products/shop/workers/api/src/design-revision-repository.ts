interface DesignRevisionSource {
  readonly artworkHeight?: number | null;
  readonly artworkKey: string;
  readonly artworkWidth?: number | null;
  readonly byteSize: number;
  readonly contentType: string;
  readonly cropX: number;
  readonly cropY: number;
  readonly cropZoom: number;
  readonly id: string;
  readonly sha256: string;
  readonly updatedAt: Date;
}

export interface ConfiguredProductRecord {
  readonly baseProductId: string;
  readonly createdAt: Date;
  readonly defaultColor: "Black" | "White";
  readonly designId: string;
  readonly id: string;
  readonly placement: {
    readonly depth: number;
    readonly width: number;
    readonly x: number;
    readonly y: number;
  };
  readonly projectionVersion: "safe-margin-v1";
  readonly shopifyHandle: string;
}

const ARTWORK_FINGERPRINT_VERSION = "artwork-v1";
const REVISION_FINGERPRINT_VERSION = "revision-v2";

export async function canonicalArtworkFingerprint(
  db: D1Database,
  source: Pick<
    DesignRevisionSource,
    | "cropX"
    | "cropY"
    | "cropZoom"
  >,
) {
  const result = await db.prepare(`
    SELECT ? || ':' || printf(
      '%!.17g,%!.17g,%!.17g',
      ?, ?, ?
    ) AS fingerprint
  `).bind(
    ARTWORK_FINGERPRINT_VERSION,
    source.cropX,
    source.cropY,
    source.cropZoom,
  ).first<{ fingerprint: string }>();
  if (!result) throw new Error("Unable to canonicalize design settings.");
  return result.fingerprint;
}

export async function designRevisionFingerprint(
  db: D1Database,
  source: DesignRevisionSource,
) {
  const artwork = await canonicalArtworkFingerprint(db, source);
  return `${REVISION_FINGERPRINT_VERSION}:${source.sha256}:${artwork}`;
}

function hasStoredArtwork(source: DesignRevisionSource) {
  return (
    source.sha256.length > 0 &&
    source.artworkKey !== `designs/${source.id}/pending`
  );
}

export async function insertConfiguredProduct(
  db: D1Database,
  source: DesignRevisionSource,
  product: ConfiguredProductRecord,
) {
  if (!hasStoredArtwork(source)) {
    await db.prepare(`
      INSERT INTO products (
        id, base_product_id, design_id, design_revision_id,
        placement_x, placement_y, placement_width, placement_depth,
        projection_version, default_color, shopify_handle, status, created_at,
        deleted_at
      ) SELECT ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL
      WHERE EXISTS (
        SELECT 1 FROM designs WHERE id = ? AND owner_id IS NULL
      )
      ON CONFLICT DO NOTHING
    `).bind(
      product.id,
      product.baseProductId,
      product.designId,
      product.placement.x,
      product.placement.y,
      product.placement.width,
      product.placement.depth,
      product.projectionVersion,
      product.defaultColor,
      product.shopifyHandle,
      product.createdAt.getTime(),
      source.id,
    ).run();
    return;
  }

  const fingerprint = await designRevisionFingerprint(db, source);
  const revisionId = crypto.randomUUID();
  await db.batch([
    db.prepare(`
      INSERT INTO design_revisions (
        id, design_id, fingerprint, artwork_key, content_type, byte_size,
        artwork_width, artwork_height, sha256, crop_x, crop_y, crop_zoom,
        placement_x, placement_y,
        placement_width, depth, created_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
          SELECT 1 FROM designs WHERE id = ? AND owner_id IS NULL
        )
      ON CONFLICT (design_id, fingerprint) DO NOTHING
    `).bind(
      revisionId,
      source.id,
      fingerprint,
      source.artworkKey,
      source.contentType,
      source.byteSize,
      source.artworkWidth ?? null,
      source.artworkHeight ?? null,
      source.sha256,
      source.cropX,
      source.cropY,
      source.cropZoom,
      0,
      0,
      0.08,
      1,
      source.updatedAt.getTime(),
      source.id,
    ),
    db.prepare(`
      INSERT INTO products (
        id, base_product_id, design_id, design_revision_id,
        placement_x, placement_y, placement_width, placement_depth,
        projection_version, default_color, shopify_handle, status, created_at,
        deleted_at
      )
      SELECT ?, ?, ?, COALESCE(
        (SELECT design_revision_id FROM products
          WHERE design_id = ? AND design_revision_id IS NOT NULL
            AND status = 'active'
          ORDER BY created_at ASC, id ASC LIMIT 1),
        (SELECT id FROM design_revisions
          WHERE design_id = ? AND fingerprint = ?)
      ), ?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL
      WHERE EXISTS (
        SELECT 1 FROM design_revisions
        WHERE design_id = ? AND fingerprint = ?
      )
        AND EXISTS (
          SELECT 1 FROM designs
          WHERE designs.id = ? AND designs.owner_id IS NULL
        )
      ON CONFLICT DO NOTHING
    `).bind(
      product.id,
      product.baseProductId,
      product.designId,
      source.id,
      source.id,
      fingerprint,
      product.placement.x,
      product.placement.y,
      product.placement.width,
      product.placement.depth,
      product.projectionVersion,
      product.defaultColor,
      product.shopifyHandle,
      product.createdAt.getTime(),
      source.id,
      fingerprint,
      source.id,
    ),
  ]);
}

export async function attachRevisionToNullProducts(
  db: D1Database,
  source: DesignRevisionSource,
) {
  if (!hasStoredArtwork(source)) return;
  // Progressive product reservations own their future revision identity and
  // must pass full-source resolution checks before this link can be filled.
  if (await db.prepare("SELECT id FROM designs WHERE id = ? AND artwork_job_id IS NOT NULL AND finalized_at IS NOT NULL")
    .bind(source.id).first()) return;

  const fingerprint = await designRevisionFingerprint(db, source);
  const revisionId = crypto.randomUUID();
  await db.batch([
    db.prepare(`
      INSERT INTO design_revisions (
        id, design_id, fingerprint, artwork_key, content_type, byte_size,
        artwork_width, artwork_height, sha256, crop_x, crop_y, crop_zoom,
        placement_x, placement_y,
        placement_width, depth, created_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM products
        WHERE design_id = ? AND design_revision_id IS NULL
      )
      ON CONFLICT (design_id, fingerprint) DO NOTHING
    `).bind(
      revisionId,
      source.id,
      fingerprint,
      source.artworkKey,
      source.contentType,
      source.byteSize,
      source.artworkWidth ?? null,
      source.artworkHeight ?? null,
      source.sha256,
      source.cropX,
      source.cropY,
      source.cropZoom,
      0,
      0,
      0.08,
      1,
      source.updatedAt.getTime(),
      source.id,
    ),
    db.prepare(`
      UPDATE products
      SET design_revision_id = (
        SELECT id FROM design_revisions
        WHERE design_id = ? AND fingerprint = ?
      )
      WHERE design_id = ? AND design_revision_id IS NULL
    `).bind(source.id, fingerprint, source.id),
  ]);
}
