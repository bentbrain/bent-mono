CREATE TABLE `print_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`configured_product_id` text NOT NULL,
	`design_revision_id` text NOT NULL,
	`base_product_id` text NOT NULL,
	`projection_version` text NOT NULL,
	`geometry_key` text NOT NULL,
	`storage_key` text UNIQUE,
	`content_type` text,
	`byte_size` integer,
	`width_px` integer,
	`height_px` integer,
	`sha256` text,
	`status` text NOT NULL DEFAULT 'pending' CHECK (`status` IN ('pending', 'ready', 'failed', 'deleted')),
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`ready_at` integer,
	`deleted_at` integer,
	FOREIGN KEY (`configured_product_id`) REFERENCES `products` (`id`) ON DELETE RESTRICT,
	FOREIGN KEY (`design_revision_id`) REFERENCES `design_revisions` (`id`) ON DELETE RESTRICT,
	FOREIGN KEY (`base_product_id`) REFERENCES `products` (`id`) ON DELETE RESTRICT,
	UNIQUE (`configured_product_id`, `geometry_key`),
	CHECK (`sha256` IS NULL OR length(`sha256`) = 64),
	CHECK (`byte_size` IS NULL OR `byte_size` > 0),
	CHECK (`width_px` IS NULL OR `width_px` > 0),
	CHECK (`height_px` IS NULL OR `height_px` > 0),
	CHECK (`status` != 'ready' OR (
		`storage_key` IS NOT NULL AND `content_type` = 'image/png' AND
		`byte_size` IS NOT NULL AND `width_px` IS NOT NULL AND
		`height_px` IS NOT NULL AND `sha256` IS NOT NULL AND
		`ready_at` IS NOT NULL
	))
);
--> statement-breakpoint
CREATE INDEX `print_assets_revision_base_idx`
	ON `print_assets` (`design_revision_id`, `base_product_id`, `status`);
--> statement-breakpoint
CREATE UNIQUE INDEX `print_assets_order_identity_unique_idx`
	ON `print_assets` (`id`, `configured_product_id`, `design_revision_id`, `base_product_id`, `projection_version`, `geometry_key`, `sha256`);
--> statement-breakpoint
CREATE TABLE `order_management_capabilities` (
	`token_hash` text PRIMARY KEY NOT NULL CHECK (length(`token_hash`) = 64),
	`shopify_cart_id` text NOT NULL UNIQUE,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`bound_at` integer,
	`revoked_at` integer,
	CHECK (`expires_at` > `created_at`),
	CHECK (`bound_at` IS NULL OR `bound_at` >= `created_at`),
	CHECK (`revoked_at` IS NULL OR `revoked_at` >= `created_at`)
);
--> statement-breakpoint
CREATE INDEX `order_management_capabilities_expires_idx`
	ON `order_management_capabilities` (`expires_at`);
--> statement-breakpoint
CREATE TABLE `shopify_webhook_inbox` (
	`webhook_id` text PRIMARY KEY NOT NULL,
	`topic` text NOT NULL,
	`shop_domain` text NOT NULL,
	`api_version` text NOT NULL,
	`triggered_at` text,
	`payload_sha256` text NOT NULL CHECK (length(`payload_sha256`) = 64),
	`payload_json` text NOT NULL,
	`status` text NOT NULL DEFAULT 'pending' CHECK (`status` IN ('pending', 'processing', 'processed', 'failed')),
	`attempt_count` integer NOT NULL DEFAULT 0 CHECK (`attempt_count` >= 0),
	`received_at` integer NOT NULL,
	`processing_started_at` integer,
	`processed_at` integer,
	`last_error` text
);
--> statement-breakpoint
CREATE INDEX `shopify_webhook_inbox_pending_idx`
	ON `shopify_webhook_inbox` (`status`, `received_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `shopify_variant_mapping_snapshots_order_base_unique_idx`
	ON `shopify_variant_mapping_snapshots` (`id`, `base_product_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `shopify_variant_mappings_order_identity_unique_idx`
	ON `shopify_variant_mappings` (`snapshot_id`, `shopify_variant_id`, `printify_variant_id`, `colour`, `size`);
--> statement-breakpoint
CREATE TABLE `paid_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`shopify_order_id` text NOT NULL UNIQUE,
	`shopify_order_name` text NOT NULL,
	`source_payload_sha256` text NOT NULL CHECK (length(`source_payload_sha256`) = 64),
	`order_management_capability_hash` text UNIQUE,
	`currency_code` text NOT NULL,
	`total_minor_units` integer NOT NULL CHECK (`total_minor_units` >= 0),
	`status` text NOT NULL CHECK (`status` IN ('production_hold', 'exception_review', 'fulfilment_locked', 'cancelled', 'refunded', 'fulfilled')),
	`fraud_result` text NOT NULL DEFAULT 'pending' CHECK (`fraud_result` IN ('pending', 'accept', 'none', 'cancel', 'investigate')),
	`address_validation_result` text NOT NULL DEFAULT 'pending' CHECK (`address_validation_result` IN ('pending', 'no_issues', 'warning', 'error')),
	`production_hold_expires_at` integer NOT NULL,
	`production_lease_id` text,
	`production_lease_expires_at` integer,
	`shopify_order_updated_at` text,
	`delivery_address_sha256` text,
	`delivery_address_json` text,
	`validation_checked_at` integer,
	`fulfilment_locked_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`order_management_capability_hash`) REFERENCES `order_management_capabilities` (`token_hash`) ON DELETE RESTRICT,
	CHECK ((`production_lease_id` IS NULL) = (`production_lease_expires_at` IS NULL)),
	CHECK ((`delivery_address_sha256` IS NULL) = (`delivery_address_json` IS NULL)),
	CHECK (`delivery_address_sha256` IS NULL OR length(`delivery_address_sha256`) = 64),
	CHECK (`production_hold_expires_at` >= `created_at`),
	CHECK (`fulfilment_locked_at` IS NULL OR `fulfilment_locked_at` >= `created_at`),
	CHECK (`status` != 'fulfilment_locked' OR (
		`production_lease_id` IS NULL AND `shopify_order_updated_at` IS NOT NULL AND
		`delivery_address_sha256` IS NOT NULL AND `delivery_address_json` IS NOT NULL AND
		`validation_checked_at` IS NOT NULL AND `fulfilment_locked_at` IS NOT NULL
	))
);
--> statement-breakpoint
CREATE INDEX `paid_orders_hold_idx`
	ON `paid_orders` (`status`, `production_hold_expires_at`);
--> statement-breakpoint
CREATE TABLE `paid_order_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`paid_order_id` text NOT NULL,
	`shopify_line_item_id` text NOT NULL,
	`line_position` integer NOT NULL CHECK (`line_position` > 0),
	`quantity` integer NOT NULL CHECK (`quantity` BETWEEN 1 AND 10),
	`base_product_id` text NOT NULL,
	`configured_product_id` text NOT NULL,
	`design_revision_id` text NOT NULL,
	`projection_version` text NOT NULL,
	`print_geometry_key` text NOT NULL CHECK (length(`print_geometry_key`) BETWEEN 1 AND 128),
	`print_asset_id` text NOT NULL,
	`print_asset_sha256` text NOT NULL CHECK (length(`print_asset_sha256`) = 64),
	`shopify_variant_id` text NOT NULL,
	`printify_variant_id` integer NOT NULL CHECK (`printify_variant_id` > 0),
	`variant_mapping_snapshot_id` text NOT NULL,
	`colour` text NOT NULL CHECK (`colour` IN ('Black', 'Cream', 'White')),
	`size` text NOT NULL,
	`line_capability_sha256` text NOT NULL CHECK (length(`line_capability_sha256`) = 64),
	`created_at` integer NOT NULL,
	FOREIGN KEY (`paid_order_id`) REFERENCES `paid_orders` (`id`) ON DELETE RESTRICT,
	FOREIGN KEY (`base_product_id`) REFERENCES `products` (`id`) ON DELETE RESTRICT,
	FOREIGN KEY (`configured_product_id`) REFERENCES `products` (`id`) ON DELETE RESTRICT,
	FOREIGN KEY (`design_revision_id`) REFERENCES `design_revisions` (`id`) ON DELETE RESTRICT,
	FOREIGN KEY (`print_asset_id`, `configured_product_id`, `design_revision_id`, `base_product_id`, `projection_version`, `print_geometry_key`, `print_asset_sha256`)
		REFERENCES `print_assets` (`id`, `configured_product_id`, `design_revision_id`, `base_product_id`, `projection_version`, `geometry_key`, `sha256`) ON DELETE RESTRICT,
	FOREIGN KEY (`variant_mapping_snapshot_id`, `base_product_id`)
		REFERENCES `shopify_variant_mapping_snapshots` (`id`, `base_product_id`) ON DELETE RESTRICT,
	FOREIGN KEY (`variant_mapping_snapshot_id`, `shopify_variant_id`, `printify_variant_id`, `colour`, `size`)
		REFERENCES `shopify_variant_mappings` (`snapshot_id`, `shopify_variant_id`, `printify_variant_id`, `colour`, `size`) ON DELETE RESTRICT,
	UNIQUE (`paid_order_id`, `shopify_line_item_id`),
	UNIQUE (`paid_order_id`, `line_position`),
	CHECK (`projection_version` IN ('legacy-shirt-v1', 'safe-margin-v1'))
);
--> statement-breakpoint
CREATE INDEX `paid_order_lines_identity_idx`
	ON `paid_order_lines` (`configured_product_id`, `design_revision_id`, `print_asset_id`);
--> statement-breakpoint
CREATE TABLE `fulfilment_exceptions` (
	`id` text PRIMARY KEY NOT NULL,
	`paid_order_id` text NOT NULL,
	`code` text NOT NULL,
	`summary` text NOT NULL,
	`status` text NOT NULL DEFAULT 'open' CHECK (`status` IN ('open', 'resolved')),
	`created_at` integer NOT NULL,
	`resolved_at` integer,
	FOREIGN KEY (`paid_order_id`) REFERENCES `paid_orders` (`id`) ON DELETE RESTRICT,
	CHECK ((`status` = 'resolved') = (`resolved_at` IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `fulfilment_exceptions_open_idx`
	ON `fulfilment_exceptions` (`status`, `created_at`);
