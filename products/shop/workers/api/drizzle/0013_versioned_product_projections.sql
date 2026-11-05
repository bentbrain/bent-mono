-- Preserve historical shirt placement exactly while identifying every new
-- automatically generated projection by its immutable rule version.
ALTER TABLE `products` ADD `projection_version` text
  CHECK (`projection_version` IN ('legacy-shirt-v1', 'safe-margin-v1'));
--> statement-breakpoint
ALTER TABLE `designs` ADD `artwork_width` integer
  CHECK (`artwork_width` IS NULL OR `artwork_width` > 0);
--> statement-breakpoint
ALTER TABLE `designs` ADD `artwork_height` integer
  CHECK (`artwork_height` IS NULL OR `artwork_height` > 0);
--> statement-breakpoint
ALTER TABLE `design_revisions` ADD `artwork_width` integer
  CHECK (`artwork_width` IS NULL OR `artwork_width` > 0);
--> statement-breakpoint
ALTER TABLE `design_revisions` ADD `artwork_height` integer
  CHECK (`artwork_height` IS NULL OR `artwork_height` > 0);
--> statement-breakpoint
UPDATE `products`
SET `projection_version` = 'legacy-shirt-v1'
WHERE `design_id` IS NOT NULL
  AND `base_product_id` = 'a51b7acf-77e9-4762-83c4-62d96dd8942c'
  AND `placement_x` IS NOT NULL
  AND `placement_y` IS NOT NULL
  AND `placement_width` IS NOT NULL
  AND `placement_depth` IS NOT NULL;
