ALTER TABLE `printify_production_products` ADD `provider_sku` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `printify_production_products_provider_sku_unique_idx`
	ON `printify_production_products` (`provider_sku`);
--> statement-breakpoint
CREATE TABLE `printify_fulfilment_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`paid_order_id` text NOT NULL UNIQUE,
	`external_id` text NOT NULL UNIQUE,
	`label` text NOT NULL,
	`provider_order_id` text UNIQUE,
	`request_sha256` text NOT NULL CHECK (length(`request_sha256`) = 64),
	`readback_sha256` text CHECK (`readback_sha256` IS NULL OR length(`readback_sha256`) = 64),
	`status` text NOT NULL DEFAULT 'pending' CHECK (`status` IN (
		'pending', 'creating', 'verifying', 'on_hold', 'submitting',
		'in_production', 'ambiguous', 'failed', 'fulfilled'
	)),
	`lease_id` text,
	`lease_expires_at` integer,
	`attempt_count` integer NOT NULL DEFAULT 0 CHECK (`attempt_count` >= 0),
	`last_error_code` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`verified_at` integer,
	`submitted_at` integer,
	`fulfilled_at` integer,
	FOREIGN KEY (`paid_order_id`) REFERENCES `paid_orders` (`id`) ON DELETE RESTRICT,
	CHECK ((`lease_id` IS NULL) = (`lease_expires_at` IS NULL)),
	CHECK (`status` NOT IN ('verifying', 'on_hold', 'submitting', 'in_production', 'fulfilled') OR `provider_order_id` IS NOT NULL),
	CHECK (`status` NOT IN ('on_hold', 'submitting', 'in_production', 'fulfilled') OR (`readback_sha256` IS NOT NULL AND `verified_at` IS NOT NULL)),
	CHECK (`status` NOT IN ('in_production', 'fulfilled') OR `submitted_at` IS NOT NULL),
	CHECK (`status` != 'fulfilled' OR `fulfilled_at` IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX `printify_fulfilment_orders_status_idx`
	ON `printify_fulfilment_orders` (`status`, `lease_expires_at`, `created_at`);
--> statement-breakpoint
CREATE TABLE `printify_fulfilment_order_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`fulfilment_order_id` text NOT NULL,
	`paid_order_line_id` text NOT NULL UNIQUE,
	`external_id` text NOT NULL UNIQUE,
	`production_product_id` text NOT NULL,
	`provider_product_id` text NOT NULL,
	`printify_variant_id` integer NOT NULL CHECK (`printify_variant_id` > 0),
	`provider_sku` text NOT NULL UNIQUE,
	`quantity` integer NOT NULL CHECK (`quantity` BETWEEN 1 AND 10),
	`shipped_quantity` integer NOT NULL DEFAULT 0 CHECK (`shipped_quantity` >= 0 AND `shipped_quantity` <= `quantity`),
	`created_at` integer NOT NULL,
	FOREIGN KEY (`fulfilment_order_id`) REFERENCES `printify_fulfilment_orders` (`id`) ON DELETE RESTRICT,
	FOREIGN KEY (`paid_order_line_id`) REFERENCES `paid_order_lines` (`id`) ON DELETE RESTRICT,
	FOREIGN KEY (`production_product_id`) REFERENCES `printify_production_products` (`id`) ON DELETE RESTRICT,
	UNIQUE (`fulfilment_order_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `printify_fulfilment_order_lines_order_idx`
	ON `printify_fulfilment_order_lines` (`fulfilment_order_id`, `created_at`);
--> statement-breakpoint
CREATE TABLE `printify_webhook_inbox` (
	`event_id` text PRIMARY KEY NOT NULL,
	`topic` text NOT NULL,
	`provider_order_id` text NOT NULL,
	`payload_sha256` text NOT NULL CHECK (length(`payload_sha256`) = 64),
	`status` text NOT NULL DEFAULT 'pending' CHECK (`status` IN ('pending', 'processing', 'processed', 'failed', 'ambiguous')),
	`attempt_count` integer NOT NULL DEFAULT 0 CHECK (`attempt_count` >= 0),
	`received_at` integer NOT NULL,
	`processing_started_at` integer,
	`processed_at` integer,
	`last_error_code` text
);
--> statement-breakpoint
CREATE INDEX `printify_webhook_inbox_pending_idx`
	ON `printify_webhook_inbox` (`status`, `received_at`);
--> statement-breakpoint
CREATE TABLE `printify_shipments` (
	`id` text PRIMARY KEY NOT NULL,
	`fulfilment_order_id` text NOT NULL,
	`carrier` text NOT NULL,
	`tracking_number` text NOT NULL,
	`tracking_url` text NOT NULL,
	`shipped_at` integer NOT NULL,
	`delivered_at` integer,
	`shopify_fulfilment_id` text UNIQUE,
	`request_sha256` text NOT NULL CHECK (length(`request_sha256`) = 64),
	`status` text NOT NULL DEFAULT 'pending' CHECK (`status` IN ('pending', 'creating', 'ready', 'ambiguous', 'failed', 'delivered')),
	`lease_id` text,
	`lease_expires_at` integer,
	`attempt_count` integer NOT NULL DEFAULT 0 CHECK (`attempt_count` >= 0),
	`last_error_code` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`fulfilment_order_id`) REFERENCES `printify_fulfilment_orders` (`id`) ON DELETE RESTRICT,
	UNIQUE (`fulfilment_order_id`, `tracking_number`),
	CHECK ((`lease_id` IS NULL) = (`lease_expires_at` IS NULL)),
	CHECK (`status` NOT IN ('ready', 'delivered') OR `shopify_fulfilment_id` IS NOT NULL),
	CHECK (`status` != 'delivered' OR `delivered_at` IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX `printify_shipments_status_idx`
	ON `printify_shipments` (`status`, `lease_expires_at`, `created_at`);
--> statement-breakpoint
CREATE TABLE `printify_shipment_lines` (
	`shipment_id` text NOT NULL,
	`fulfilment_order_line_id` text NOT NULL,
	`quantity` integer NOT NULL CHECK (`quantity` > 0),
	FOREIGN KEY (`shipment_id`) REFERENCES `printify_shipments` (`id`) ON DELETE RESTRICT,
	FOREIGN KEY (`fulfilment_order_line_id`) REFERENCES `printify_fulfilment_order_lines` (`id`) ON DELETE RESTRICT,
	PRIMARY KEY (`shipment_id`, `fulfilment_order_line_id`)
);
