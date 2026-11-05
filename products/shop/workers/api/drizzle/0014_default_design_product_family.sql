-- Keep the storefront's configured sample design as one cross-product family.
-- Existing sample shirt URLs remain the family anchor; this adds only the
-- missing tote projection and is safe to retry or skip when already present.
INSERT INTO `products` (
  `id`, `base_product_id`, `design_id`, `design_revision_id`,
  `placement_x`, `placement_y`, `placement_width`, `placement_depth`,
  `projection_version`, `shopify_handle`, `status`, `created_at`, `deleted_at`
)
SELECT
  '55b53491-a09d-4f50-b9f6-73fbd3fabff9',
  '97b629d7-1d3b-4d2a-a586-537168141e97',
  source.`design_id`,
  source.`design_revision_id`,
  ROUND((118.0 / 2835.0) + source.`placement_x` * (2599.0 / 2835.0), 6),
  ROUND((118.0 / 2835.0) + source.`placement_y` * (2599.0 / 2835.0), 6),
  ROUND(source.`placement_width` * (2599.0 / 2835.0), 6),
  source.`placement_depth`,
  'safe-margin-v1',
  'cotton-tote',
  'active',
  1787875200001,
  NULL
FROM `products` AS source
WHERE source.`id` = 'd2dd07c1-dbbf-4d1a-8df7-9c43b4a7dfc4'
  AND source.`status` = 'active'
  AND source.`design_id` IS NOT NULL
  AND source.`design_revision_id` IS NOT NULL
  AND source.`placement_x` IS NOT NULL
  AND source.`placement_y` IS NOT NULL
  AND source.`placement_width` IS NOT NULL
  AND source.`placement_depth` IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM `products` AS existing
    WHERE existing.`design_revision_id` = source.`design_revision_id`
      AND existing.`base_product_id` = '97b629d7-1d3b-4d2a-a586-537168141e97'
      AND existing.`status` = 'active'
  )
ON CONFLICT (`id`) DO NOTHING;
