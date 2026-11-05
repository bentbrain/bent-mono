ALTER TABLE `designs` ADD COLUMN `default_product_color` text NOT NULL DEFAULT 'White'
  CHECK (`default_product_color` IN ('Black', 'White'));
--> statement-breakpoint
ALTER TABLE `designs` ADD COLUMN `default_product_color_model` text;
--> statement-breakpoint
ALTER TABLE `products` ADD COLUMN `default_color` text NOT NULL DEFAULT 'White'
  CHECK (`default_color` IN ('Black', 'White'));
