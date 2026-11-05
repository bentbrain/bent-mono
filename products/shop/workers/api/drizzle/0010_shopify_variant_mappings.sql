CREATE TABLE `shopify_variant_mapping_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`catalogue_snapshot_id` text NOT NULL,
	`shopify_product_id` text NOT NULL,
	`shopify_product_handle` text NOT NULL,
	`shopify_product_title` text NOT NULL,
	`retrieved_at` integer NOT NULL,
	`source_url` text NOT NULL,
	`variant_count` integer NOT NULL CHECK (`variant_count` > 0),
	FOREIGN KEY (`catalogue_snapshot_id`) REFERENCES `printify_catalogue_snapshots` (`id`) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE INDEX `shopify_variant_mapping_snapshots_retrieved_at_idx`
	ON `shopify_variant_mapping_snapshots` (`retrieved_at` DESC);
--> statement-breakpoint
CREATE TABLE `shopify_variant_mappings` (
	`snapshot_id` text NOT NULL,
	`shopify_variant_id` text NOT NULL,
	`printify_variant_id` integer NOT NULL,
	`colour` text NOT NULL CHECK (`colour` IN ('Black', 'White')),
	`size` text NOT NULL,
	`sku` text,
	`shopify_available` integer NOT NULL CHECK (`shopify_available` IN (0, 1)),
	PRIMARY KEY (`snapshot_id`, `shopify_variant_id`),
	UNIQUE (`snapshot_id`, `printify_variant_id`),
	UNIQUE (`snapshot_id`, `colour`, `size`),
	FOREIGN KEY (`snapshot_id`) REFERENCES `shopify_variant_mapping_snapshots` (`id`) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TRIGGER `shopify_variant_mapping_snapshots_no_update`
	BEFORE UPDATE ON `shopify_variant_mapping_snapshots`
	BEGIN SELECT RAISE(ABORT, 'variant mapping snapshots are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `shopify_variant_mappings_no_update`
	BEFORE UPDATE ON `shopify_variant_mappings`
	BEGIN SELECT RAISE(ABORT, 'variant mappings are immutable'); END;
