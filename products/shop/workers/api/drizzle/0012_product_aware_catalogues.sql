-- Keep the MP-1 shirt history addressable while making every new snapshot
-- explicitly belong to one stable Base Product.
ALTER TABLE `printify_catalogue_snapshots` ADD `base_product_id` text NOT NULL DEFAULT 'a51b7acf-77e9-4762-83c4-62d96dd8942c';
--> statement-breakpoint
ALTER TABLE `printify_catalogue_snapshots` ADD `base_product_slug` text NOT NULL DEFAULT 'staple-tee' CHECK (`base_product_slug` IN ('staple-tee', 'cotton-tote'));
--> statement-breakpoint
CREATE INDEX `printify_catalogue_snapshots_base_product_retrieved_idx`
	ON `printify_catalogue_snapshots` (`base_product_slug`, `retrieved_at` DESC);
--> statement-breakpoint
DROP TRIGGER `printify_catalogue_variants_no_update`;
--> statement-breakpoint
CREATE TABLE `printify_catalogue_variants_product_aware` (
	`snapshot_id` text NOT NULL,
	`printify_variant_id` integer NOT NULL,
	`colour` text NOT NULL CHECK (`colour` IN ('Black', 'Cream', 'White')),
	`size` text NOT NULL,
	`available` integer NOT NULL CHECK (`available` IN (0, 1)),
	`decoration_method` text NOT NULL CHECK (lower(`decoration_method`) = 'dtg'),
	`print_width` integer NOT NULL CHECK (`print_width` > 0),
	`print_height` integer NOT NULL CHECK (`print_height` > 0),
	`shipping_first_item` integer NOT NULL CHECK (`shipping_first_item` >= 0),
	`shipping_additional_item` integer NOT NULL CHECK (`shipping_additional_item` >= 0),
	`shipping_currency` text NOT NULL,
	`handling_days_from` integer NOT NULL CHECK (`handling_days_from` >= 0),
	`handling_days_to` integer NOT NULL CHECK (`handling_days_to` >= `handling_days_from`),
	PRIMARY KEY (`snapshot_id`, `printify_variant_id`),
	UNIQUE (`snapshot_id`, `colour`, `size`),
	FOREIGN KEY (`snapshot_id`) REFERENCES `printify_catalogue_snapshots` (`id`) ON DELETE RESTRICT
);
--> statement-breakpoint
INSERT INTO `printify_catalogue_variants_product_aware`
SELECT * FROM `printify_catalogue_variants`;
--> statement-breakpoint
DROP TABLE `printify_catalogue_variants`;
--> statement-breakpoint
ALTER TABLE `printify_catalogue_variants_product_aware` RENAME TO `printify_catalogue_variants`;
--> statement-breakpoint
CREATE TRIGGER `printify_catalogue_variants_no_update`
	BEFORE UPDATE ON `printify_catalogue_variants`
	BEGIN SELECT RAISE(ABORT, 'catalogue variants are immutable'); END;
--> statement-breakpoint
ALTER TABLE `shopify_variant_mapping_snapshots` ADD `base_product_id` text NOT NULL DEFAULT 'a51b7acf-77e9-4762-83c4-62d96dd8942c';
--> statement-breakpoint
ALTER TABLE `shopify_variant_mapping_snapshots` ADD `base_product_slug` text NOT NULL DEFAULT 'staple-tee' CHECK (`base_product_slug` IN ('staple-tee', 'cotton-tote'));
--> statement-breakpoint
CREATE INDEX `shopify_variant_mapping_snapshots_base_product_retrieved_idx`
	ON `shopify_variant_mapping_snapshots` (`base_product_slug`, `retrieved_at` DESC);
--> statement-breakpoint
DROP TRIGGER `shopify_variant_mappings_no_update`;
--> statement-breakpoint
CREATE TABLE `shopify_variant_mappings_product_aware` (
	`snapshot_id` text NOT NULL,
	`shopify_variant_id` text NOT NULL,
	`printify_variant_id` integer NOT NULL,
	`colour` text NOT NULL CHECK (`colour` IN ('Black', 'Cream', 'White')),
	`size` text NOT NULL,
	`sku` text,
	`shopify_available` integer NOT NULL CHECK (`shopify_available` IN (0, 1)),
	PRIMARY KEY (`snapshot_id`, `shopify_variant_id`),
	UNIQUE (`snapshot_id`, `printify_variant_id`),
	UNIQUE (`snapshot_id`, `colour`, `size`),
	FOREIGN KEY (`snapshot_id`) REFERENCES `shopify_variant_mapping_snapshots` (`id`) ON DELETE RESTRICT
);
--> statement-breakpoint
INSERT INTO `shopify_variant_mappings_product_aware`
SELECT * FROM `shopify_variant_mappings`;
--> statement-breakpoint
DROP TABLE `shopify_variant_mappings`;
--> statement-breakpoint
ALTER TABLE `shopify_variant_mappings_product_aware` RENAME TO `shopify_variant_mappings`;
--> statement-breakpoint
CREATE TRIGGER `shopify_variant_mappings_no_update`
	BEFORE UPDATE ON `shopify_variant_mappings`
	BEGIN SELECT RAISE(ABORT, 'variant mappings are immutable'); END;
