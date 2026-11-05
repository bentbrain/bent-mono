CREATE TABLE `designs` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text,
	`artwork_key` text NOT NULL,
	`content_type` text NOT NULL,
	`byte_size` integer NOT NULL,
	`sha256` text NOT NULL,
	`crop_x` real NOT NULL,
	`crop_y` real NOT NULL,
	`crop_zoom` real NOT NULL,
	`placement_x` real NOT NULL,
	`placement_y` real NOT NULL,
	`placement_width` real NOT NULL,
	`depth` integer NOT NULL,
	`status` text DEFAULT 'ready' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `designs_artwork_key_unique` ON `designs` (`artwork_key`);--> statement-breakpoint
CREATE INDEX `designs_owner_updated_idx` ON `designs` (`owner_id`,`updated_at`);