CREATE TABLE `paid_operation_usage` (
	`quota_key` text NOT NULL,
	`usage_date` text NOT NULL,
	`operation_count` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY (`quota_key`, `usage_date`)
);--> statement-breakpoint
CREATE INDEX `paid_operation_usage_updated_idx` ON `paid_operation_usage` (`updated_at`);
