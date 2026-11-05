CREATE TABLE `print_asset_render_slots` (
	`slot` integer PRIMARY KEY NOT NULL CHECK (`slot` BETWEEN 1 AND 3),
	`lease_id` text,
	`lease_expires_at` integer,
	CHECK ((`lease_id` IS NULL) = (`lease_expires_at` IS NULL))
);
--> statement-breakpoint
INSERT INTO `print_asset_render_slots` (`slot`) VALUES (1), (2), (3);
