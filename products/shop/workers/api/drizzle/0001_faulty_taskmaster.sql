CREATE TABLE `products` (
	`id` text PRIMARY KEY NOT NULL,
	`base_product_id` text NOT NULL,
	`design_id` text,
	`shopify_handle` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`design_id`) REFERENCES `designs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `products_base_created_idx` ON `products` (`base_product_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `products_design_idx` ON `products` (`design_id`);--> statement-breakpoint
INSERT INTO `products` (
	`id`,
	`base_product_id`,
	`design_id`,
	`shopify_handle`,
	`status`,
	`created_at`,
	`deleted_at`
) VALUES (
	'8f48ee90-08d8-4c6c-b369-0444a20ddd25',
	'8f48ee90-08d8-4c6c-b369-0444a20ddd25',
	NULL,
	'bent-shirt',
	'active',
	1786574017526,
	NULL
);
