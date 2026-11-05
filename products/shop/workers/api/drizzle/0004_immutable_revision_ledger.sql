ALTER TABLE `designs` ADD `version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `designs` ADD `finalized_at` integer;--> statement-breakpoint
ALTER TABLE `designs` ADD `legacy_claim_expires_at` integer;--> statement-breakpoint
CREATE TABLE `design_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`design_id` text NOT NULL,
	`fingerprint` text NOT NULL,
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
	`created_at` integer NOT NULL,
	FOREIGN KEY (`design_id`) REFERENCES `designs`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
CREATE INDEX `design_revisions_design_created_idx` ON `design_revisions` (`design_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `design_revisions_design_fingerprint_unique_idx` ON `design_revisions` (`design_id`,`fingerprint`);--> statement-breakpoint
ALTER TABLE `products` ADD `design_revision_id` text REFERENCES design_revisions(id);--> statement-breakpoint
CREATE INDEX `products_design_revision_idx` ON `products` (`design_revision_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `products_active_design_revision_unique_idx` ON `products` (`design_revision_id`) WHERE `design_revision_id` IS NOT NULL AND `status` = 'active';--> statement-breakpoint
-- Backfill only configured drafts with stored artwork. Pending artwork and products
-- inserted after this one-time migration remain nullable for the staged catch-up.
INSERT INTO `design_revisions` (
	`id`, `design_id`, `fingerprint`, `artwork_key`, `content_type`, `byte_size`,
	`sha256`, `crop_x`, `crop_y`, `crop_zoom`, `placement_x`, `placement_y`,
	`placement_width`, `depth`, `created_at`
)
SELECT
	`designs`.`id`,
	`designs`.`id`,
	'legacy-v1:' || `designs`.`id` || ':' || `designs`.`sha256`,
	`designs`.`artwork_key`,
	`designs`.`content_type`,
	`designs`.`byte_size`,
	`designs`.`sha256`,
	`designs`.`crop_x`,
	`designs`.`crop_y`,
	`designs`.`crop_zoom`,
	`designs`.`placement_x`,
	`designs`.`placement_y`,
	`designs`.`placement_width`,
	`designs`.`depth`,
	`designs`.`updated_at`
FROM `designs`
WHERE
	`designs`.`sha256` <> ''
	AND `designs`.`artwork_key` <> 'designs/' || `designs`.`id` || '/pending'
	AND EXISTS (
		SELECT 1 FROM `products` WHERE `products`.`design_id` = `designs`.`id`
	)
ON CONFLICT (`id`) DO NOTHING;--> statement-breakpoint
UPDATE `products`
SET `design_revision_id` = `design_id`
WHERE
	`design_id` IS NOT NULL
	AND `design_revision_id` IS NULL
	AND EXISTS (
		SELECT 1 FROM `design_revisions`
		WHERE `design_revisions`.`id` = `products`.`design_id`
	);--> statement-breakpoint
UPDATE `designs`
SET `finalized_at` = COALESCE(`finalized_at`, `updated_at`)
WHERE EXISTS (
	SELECT 1 FROM `design_revisions`
	WHERE `design_revisions`.`design_id` = `designs`.`id`
);
