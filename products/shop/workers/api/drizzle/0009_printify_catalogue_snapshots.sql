CREATE TABLE `printify_catalogue_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`shop_id` text NOT NULL,
	`blueprint_id` integer NOT NULL,
	`print_provider_id` integer NOT NULL,
	`retrieved_at` integer NOT NULL,
	`source_urls_json` text NOT NULL CHECK (json_valid(`source_urls_json`)),
	`variant_count` integer NOT NULL CHECK (`variant_count` > 0)
);
--> statement-breakpoint
CREATE INDEX `printify_catalogue_snapshots_retrieved_at_idx`
	ON `printify_catalogue_snapshots` (`retrieved_at` DESC);
--> statement-breakpoint
CREATE TABLE `printify_catalogue_variants` (
	`snapshot_id` text NOT NULL,
	`printify_variant_id` integer NOT NULL,
	`colour` text NOT NULL CHECK (`colour` IN ('Black', 'White')),
	`size` text NOT NULL,
	`available` integer NOT NULL CHECK (`available` IN (0, 1)),
	`decoration_method` text NOT NULL,
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
CREATE TRIGGER `printify_catalogue_snapshots_no_update`
	BEFORE UPDATE ON `printify_catalogue_snapshots`
	BEGIN SELECT RAISE(ABORT, 'catalogue snapshots are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `printify_catalogue_variants_no_update`
	BEFORE UPDATE ON `printify_catalogue_variants`
	BEGIN SELECT RAISE(ABORT, 'catalogue variants are immutable'); END;
