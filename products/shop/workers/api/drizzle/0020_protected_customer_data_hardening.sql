UPDATE `shopify_webhook_inbox`
SET `payload_json` = '{"schema":"orders-paid-audit-v1"}';
--> statement-breakpoint
ALTER TABLE `paid_orders` ADD COLUMN `personal_data_purged_at` integer;
--> statement-breakpoint
CREATE TABLE `personal_data_access_log` (
	`id` text PRIMARY KEY NOT NULL,
	`subject_hash` text NOT NULL CHECK (length(`subject_hash`) = 64),
	`actor` text NOT NULL CHECK (`actor` IN (
		'system:shopify-webhook',
		'system:paid-order-reconciliation'
	)),
	`action` text NOT NULL CHECK (`action` IN ('receive', 'read')),
	`purpose` text NOT NULL CHECK (`purpose` IN (
		'paid-order-ingestion',
		'fraud-address-line-validation'
	)),
	`occurred_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `personal_data_access_log_subject_idx`
	ON `personal_data_access_log` (`subject_hash`, `occurred_at`);
--> statement-breakpoint
CREATE INDEX `personal_data_access_log_occurred_idx`
	ON `personal_data_access_log` (`occurred_at`);
--> statement-breakpoint
CREATE TRIGGER `personal_data_access_log_no_update`
BEFORE UPDATE ON `personal_data_access_log`
BEGIN
	SELECT RAISE(ABORT, 'personal-data access logs are immutable');
END;
--> statement-breakpoint
CREATE TABLE `privacy_object_deletions` (
	`id` text PRIMARY KEY NOT NULL,
	`bucket` text NOT NULL CHECK (`bucket` = 'design-artwork'),
	`storage_key` text NOT NULL,
	`reason` text NOT NULL CHECK (`reason` = 'abandoned-draft'),
	`source_record_id` text NOT NULL,
	`attempt_count` integer NOT NULL DEFAULT 0 CHECK (`attempt_count` >= 0),
	`enqueued_at` integer NOT NULL,
	`deleted_at` integer,
	`last_error` text,
	UNIQUE (`bucket`, `storage_key`)
);
--> statement-breakpoint
CREATE INDEX `privacy_object_deletions_pending_idx`
	ON `privacy_object_deletions` (`deleted_at`, `enqueued_at`);
