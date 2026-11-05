ALTER TABLE `designs` ADD COLUMN `default_product_color_status` text NOT NULL DEFAULT 'fallback'
  CHECK (`default_product_color_status` IN ('pending', 'complete', 'fallback'));
--> statement-breakpoint
UPDATE `designs` SET
  `default_product_color` = 'Black',
  `default_product_color_model` = 'featured-product-backfill-v1'
WHERE `id` = 'c2bf0318-784a-4dda-b82b-9534aed42903';
--> statement-breakpoint
UPDATE `products` SET `default_color` = 'Black'
WHERE `design_id` = 'c2bf0318-784a-4dda-b82b-9534aed42903';
--> statement-breakpoint
UPDATE `designs` SET `default_product_color_status` = 'complete'
WHERE `default_product_color_model` IS NOT NULL;
