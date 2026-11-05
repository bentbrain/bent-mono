-- Deploy this additive migration before the Worker that writes revision-v2.
-- The Worker continues to read legacy revision rows, so rollback before that
-- Worker deploy leaves existing shirt URLs and historical order lookups intact.
ALTER TABLE `products` ADD `placement_x` real;
--> statement-breakpoint
ALTER TABLE `products` ADD `placement_y` real;
--> statement-breakpoint
ALTER TABLE `products` ADD `placement_width` real;
--> statement-breakpoint
ALTER TABLE `products` ADD `placement_depth` integer;
--> statement-breakpoint
UPDATE `products`
SET
  `placement_x` = (SELECT `placement_x` FROM `design_revisions` WHERE `design_revisions`.`id` = `products`.`design_revision_id`),
  `placement_y` = (SELECT `placement_y` FROM `design_revisions` WHERE `design_revisions`.`id` = `products`.`design_revision_id`),
  `placement_width` = (SELECT `placement_width` FROM `design_revisions` WHERE `design_revisions`.`id` = `products`.`design_revision_id`),
  `placement_depth` = (SELECT `depth` FROM `design_revisions` WHERE `design_revisions`.`id` = `products`.`design_revision_id`)
WHERE `design_id` IS NOT NULL AND `design_revision_id` IS NOT NULL;
--> statement-breakpoint
UPDATE `products`
SET
  `placement_x` = (SELECT `placement_x` FROM `designs` WHERE `designs`.`id` = `products`.`design_id`),
  `placement_y` = (SELECT `placement_y` FROM `designs` WHERE `designs`.`id` = `products`.`design_id`),
  `placement_width` = (SELECT `placement_width` FROM `designs` WHERE `designs`.`id` = `products`.`design_id`),
  `placement_depth` = (SELECT `depth` FROM `designs` WHERE `designs`.`id` = `products`.`design_id`)
WHERE `design_id` IS NOT NULL AND `design_revision_id` IS NULL;
--> statement-breakpoint
DROP INDEX `products_active_design_unique_idx`;
--> statement-breakpoint
DROP INDEX `products_active_design_revision_unique_idx`;
--> statement-breakpoint
CREATE UNIQUE INDEX `products_active_design_revision_base_product_unique_idx`
  ON `products` (`design_revision_id`, `base_product_id`)
  WHERE `design_revision_id` IS NOT NULL AND `status` = 'active';
--> statement-breakpoint
CREATE UNIQUE INDEX `products_active_pending_design_base_product_unique_idx`
  ON `products` (`design_id`, `base_product_id`)
  WHERE `design_id` IS NOT NULL AND `design_revision_id` IS NULL AND `status` = 'active';
--> statement-breakpoint
INSERT INTO `products` (
  `id`, `base_product_id`, `design_id`, `design_revision_id`, `shopify_handle`,
  `status`, `created_at`, `deleted_at`
) VALUES (
  '97b629d7-1d3b-4d2a-a586-537168141e97',
  '97b629d7-1d3b-4d2a-a586-537168141e97',
  NULL, NULL, 'cotton-tote', 'active', 1787702400000, NULL
)
ON CONFLICT (`id`) DO NOTHING;
