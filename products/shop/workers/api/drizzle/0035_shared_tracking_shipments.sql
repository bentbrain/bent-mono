-- Preserve immutable fulfilment batches while allowing successive SKU events
-- for one physical package. A provider SKU reserves its full remaining quantity
-- once; repeated or overlapping events must reuse that reservation.
CREATE TABLE `printify_shipments_next` (
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
	UNIQUE (`fulfilment_order_id`, `tracking_number`, `request_sha256`),
	CHECK ((`lease_id` IS NULL) = (`lease_expires_at` IS NULL)),
	CHECK (`status` NOT IN ('ready', 'delivered') OR `shopify_fulfilment_id` IS NOT NULL),
	CHECK (`status` != 'delivered' OR `delivered_at` IS NOT NULL)
);

--> statement-breakpoint
CREATE TABLE `printify_shipment_lines_next` (
	`shipment_id` text NOT NULL,
	`fulfilment_order_line_id` text NOT NULL UNIQUE,
	`quantity` integer NOT NULL CHECK (`quantity` > 0),
	FOREIGN KEY (`shipment_id`) REFERENCES `printify_shipments_next` (`id`) ON DELETE RESTRICT,
	FOREIGN KEY (`fulfilment_order_line_id`) REFERENCES `printify_fulfilment_order_lines` (`id`) ON DELETE RESTRICT,
	PRIMARY KEY (`shipment_id`, `fulfilment_order_line_id`)
);

--> statement-breakpoint
INSERT INTO printify_shipments_next SELECT * FROM printify_shipments;
--> statement-breakpoint
INSERT INTO printify_shipment_lines_next SELECT * FROM printify_shipment_lines;
--> statement-breakpoint
DROP TABLE printify_shipment_lines;
--> statement-breakpoint
DROP TABLE printify_shipments;
--> statement-breakpoint
ALTER TABLE printify_shipments_next RENAME TO printify_shipments;
--> statement-breakpoint
ALTER TABLE printify_shipment_lines_next RENAME TO printify_shipment_lines;
--> statement-breakpoint
CREATE INDEX printify_shipments_status_idx ON printify_shipments (status, lease_expires_at, created_at);
