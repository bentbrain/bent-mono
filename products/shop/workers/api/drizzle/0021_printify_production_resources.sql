CREATE UNIQUE INDEX `print_assets_provider_identity_unique_idx`
	ON `print_assets` (`id`, `sha256`);
--> statement-breakpoint
CREATE TABLE `printify_media_copies` (
	`id` text PRIMARY KEY NOT NULL,
	`print_asset_id` text NOT NULL,
	`print_asset_sha256` text NOT NULL CHECK (length(`print_asset_sha256`) = 64),
	`provider_image_id` text UNIQUE,
	`file_name` text NOT NULL UNIQUE,
	`status` text NOT NULL DEFAULT 'pending' CHECK (`status` IN ('pending', 'creating', 'verifying', 'ready', 'ambiguous', 'failed', 'archived')),
	`lease_id` text,
	`lease_expires_at` integer,
	`attempt_count` integer NOT NULL DEFAULT 0 CHECK (`attempt_count` >= 0),
	`provider_mime_type` text,
	`provider_byte_size` integer,
	`provider_width_px` integer,
	`provider_height_px` integer,
	`provider_preview_url` text,
	`last_error_code` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`verified_at` integer,
	`archived_at` integer,
	FOREIGN KEY (`print_asset_id`, `print_asset_sha256`)
		REFERENCES `print_assets` (`id`, `sha256`) ON DELETE RESTRICT,
	UNIQUE (`print_asset_id`, `print_asset_sha256`),
	CHECK ((`lease_id` IS NULL) = (`lease_expires_at` IS NULL)),
	CHECK (`provider_byte_size` IS NULL OR `provider_byte_size` > 0),
	CHECK (`provider_width_px` IS NULL OR `provider_width_px` > 0),
	CHECK (`provider_height_px` IS NULL OR `provider_height_px` > 0),
	CHECK (`status` NOT IN ('verifying', 'ready', 'archived') OR `provider_image_id` IS NOT NULL),
	CHECK (`status` != 'ready' OR (
		`provider_mime_type` = 'image/png' AND `provider_byte_size` IS NOT NULL AND
		`provider_width_px` IS NOT NULL AND `provider_height_px` IS NOT NULL AND
		`provider_preview_url` IS NOT NULL AND `verified_at` IS NOT NULL
	)),
	CHECK (`status` != 'archived' OR `archived_at` IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX `printify_media_copies_status_idx`
	ON `printify_media_copies` (`status`, `lease_expires_at`, `created_at`);
--> statement-breakpoint
CREATE TABLE `printify_production_products` (
	`id` text PRIMARY KEY NOT NULL,
	`configured_product_id` text NOT NULL,
	`design_revision_id` text NOT NULL,
	`base_product_id` text NOT NULL,
	`projection_version` text NOT NULL CHECK (`projection_version` IN ('legacy-shirt-v1', 'safe-margin-v1')),
	`print_geometry_key` text NOT NULL,
	`print_asset_id` text NOT NULL,
	`print_asset_sha256` text NOT NULL CHECK (length(`print_asset_sha256`) = 64),
	`media_copy_id` text NOT NULL,
	`printify_variant_id` integer NOT NULL CHECK (`printify_variant_id` > 0),
	`blueprint_id` integer NOT NULL CHECK (`blueprint_id` > 0),
	`print_provider_id` integer NOT NULL CHECK (`print_provider_id` > 0),
	`retail_price_minor_units` integer NOT NULL CHECK (`retail_price_minor_units` > 0),
	`provider_product_id` text UNIQUE,
	`title` text NOT NULL UNIQUE,
	`request_sha256` text NOT NULL CHECK (length(`request_sha256`) = 64),
	`readback_sha256` text,
	`status` text NOT NULL DEFAULT 'pending' CHECK (`status` IN ('pending', 'creating', 'verifying', 'ready', 'ambiguous', 'failed', 'archived')),
	`lease_id` text,
	`lease_expires_at` integer,
	`attempt_count` integer NOT NULL DEFAULT 0 CHECK (`attempt_count` >= 0),
	`last_error_code` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`verified_at` integer,
	`archived_at` integer,
	FOREIGN KEY (`configured_product_id`) REFERENCES `products` (`id`) ON DELETE RESTRICT,
	FOREIGN KEY (`design_revision_id`) REFERENCES `design_revisions` (`id`) ON DELETE RESTRICT,
	FOREIGN KEY (`base_product_id`) REFERENCES `products` (`id`) ON DELETE RESTRICT,
	FOREIGN KEY (`print_asset_id`, `print_asset_sha256`)
		REFERENCES `print_assets` (`id`, `sha256`) ON DELETE RESTRICT,
	FOREIGN KEY (`media_copy_id`) REFERENCES `printify_media_copies` (`id`) ON DELETE RESTRICT,
	UNIQUE (`configured_product_id`, `design_revision_id`, `base_product_id`, `projection_version`, `print_geometry_key`, `print_asset_id`, `print_asset_sha256`, `printify_variant_id`, `retail_price_minor_units`),
	CHECK ((`lease_id` IS NULL) = (`lease_expires_at` IS NULL)),
	CHECK (`readback_sha256` IS NULL OR length(`readback_sha256`) = 64),
	CHECK (`status` NOT IN ('verifying', 'ready', 'archived') OR `provider_product_id` IS NOT NULL),
	CHECK (`status` != 'ready' OR (`readback_sha256` IS NOT NULL AND `verified_at` IS NOT NULL)),
	CHECK (`status` != 'archived' OR `archived_at` IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX `printify_production_products_status_idx`
	ON `printify_production_products` (`status`, `lease_expires_at`, `created_at`);
--> statement-breakpoint
ALTER TABLE `paid_order_lines` ADD `retail_price_minor_units` integer CHECK (`retail_price_minor_units` IS NULL OR `retail_price_minor_units` > 0);
