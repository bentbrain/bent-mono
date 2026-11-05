CREATE TABLE `operational_controls` (
	`control_key` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT 0 NOT NULL,
	`reason` text NOT NULL,
	`updated_at` integer NOT NULL
);
