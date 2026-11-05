CREATE TABLE `print_asset_objects` (
	`sha256` text PRIMARY KEY NOT NULL CHECK (length(`sha256`) = 64),
	`storage_key` text NOT NULL UNIQUE,
	`content_type` text NOT NULL CHECK (`content_type` = 'image/png'),
	`byte_size` integer NOT NULL CHECK (`byte_size` > 0),
	`width_px` integer NOT NULL CHECK (`width_px` > 0),
	`height_px` integer NOT NULL CHECK (`height_px` > 0),
	`created_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `print_asset_objects` (
	`sha256`, `storage_key`, `content_type`, `byte_size`, `width_px`,
	`height_px`, `created_at`
)
SELECT
	`sha256`, min(`storage_key`), 'image/png', max(`byte_size`),
	max(`width_px`), max(`height_px`), min(`created_at`)
FROM `print_assets`
WHERE `status` = 'ready'
	AND `sha256` IS NOT NULL
	AND `storage_key` IS NOT NULL
	AND `byte_size` IS NOT NULL
	AND `width_px` IS NOT NULL
	AND `height_px` IS NOT NULL
GROUP BY `sha256`;
--> statement-breakpoint
ALTER TABLE `print_assets` ADD COLUMN `object_sha256` text
	REFERENCES `print_asset_objects`(`sha256`);
--> statement-breakpoint
UPDATE `print_assets`
SET `object_sha256` = `sha256`
WHERE `status` = 'ready'
	AND `sha256` IN (SELECT `sha256` FROM `print_asset_objects`);
--> statement-breakpoint
CREATE INDEX `print_assets_object_sha256_idx`
	ON `print_assets` (`object_sha256`);
--> statement-breakpoint
CREATE TABLE `storage_test_fixtures` (
	`design_id` text PRIMARY KEY NOT NULL
		REFERENCES `designs`(`id`) ON DELETE CASCADE,
	`run_id` text NOT NULL,
	`purpose` text NOT NULL CHECK (`purpose` = 'native-qualification'),
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL CHECK (`expires_at` > `created_at`)
);
--> statement-breakpoint
CREATE INDEX `storage_test_fixtures_expiry_idx`
	ON `storage_test_fixtures` (`expires_at`, `design_id`);
--> statement-breakpoint
CREATE INDEX `storage_test_fixtures_run_idx`
	ON `storage_test_fixtures` (`run_id`, `design_id`);
--> statement-breakpoint
CREATE TABLE `storage_gc_cursors` (
	`bucket` text PRIMARY KEY NOT NULL CHECK (`bucket` IN (
		'design-artwork', 'story-videos'
	)),
	`cursor` text,
	`updated_at` integer NOT NULL
);
