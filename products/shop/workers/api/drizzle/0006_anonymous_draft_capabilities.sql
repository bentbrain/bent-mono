CREATE TABLE `design_upload_grants` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`design_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`expected_version` integer NOT NULL,
	`content_type` text NOT NULL,
	`max_bytes` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`design_id`) REFERENCES `designs`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
CREATE INDEX `design_upload_grants_design_created_idx` ON `design_upload_grants` (`design_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `design_upload_grants_expires_idx` ON `design_upload_grants` (`expires_at`);--> statement-breakpoint
UPDATE `designs`
SET `legacy_claim_expires_at` = unixepoch('now') * 1000 + 2592000000
WHERE `owner_id` IS NULL AND `legacy_claim_expires_at` IS NULL;
