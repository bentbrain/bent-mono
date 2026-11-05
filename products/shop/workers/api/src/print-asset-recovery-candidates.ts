// Resolve accepted history once per Base Product, rather than repeating its
// snapshot lookup for every variant of every completed Configured Product.
// Both legacy recovery paths share this bounded set for their entire pass.
export const requiredPrintGeometryCtesSql = `accepted_print_catalogues AS MATERIALIZED (
        SELECT base_product.id AS base_product_id, (
          SELECT catalogue_snapshot_id FROM shopify_variant_mapping_snapshots
          WHERE base_product_id = base_product.id
            AND shopify_product_handle = base_product.shopify_handle
          ORDER BY retrieved_at DESC, id DESC LIMIT 1
        ) AS catalogue_snapshot_id
        FROM products AS base_product
        WHERE base_product.status = 'active' AND base_product.design_id IS NULL
      ), required_print_geometries AS MATERIALIZED (
        SELECT DISTINCT accepted.base_product_id,
          lower(variants.decoration_method) || ':' ||
            variants.print_width || 'x' || variants.print_height AS geometry_key
        FROM accepted_print_catalogues AS accepted
        CROSS JOIN printify_catalogue_snapshots AS snapshots
          ON snapshots.id = accepted.catalogue_snapshot_id
          AND snapshots.base_product_id = accepted.base_product_id
        CROSS JOIN printify_catalogue_variants AS variants
          ON variants.snapshot_id = snapshots.id
      )`;

// This predicate expects the products alias and the materialized CTEs above.
export const missingRequiredPrintGeometrySql = `EXISTS (
        SELECT 1
        FROM required_print_geometries AS geometry
        WHERE geometry.base_product_id = products.base_product_id
          AND NOT EXISTS (
            SELECT 1 FROM print_assets AS assets
            WHERE assets.configured_product_id = products.id
              AND assets.design_revision_id = products.design_revision_id
              AND assets.base_product_id = products.base_product_id
              AND assets.projection_version = products.projection_version
              AND assets.geometry_key = geometry.geometry_key
              AND assets.status = 'ready'
          )
      )`;
