CREATE TABLE `design_asset_deletions` (
  `bucket` text NOT NULL CHECK (`bucket` IN ('design-artwork', 'story-videos')),
  `storage_key` text NOT NULL,
  `design_id` text NOT NULL,
  `created_at` integer NOT NULL,
  PRIMARY KEY (`bucket`, `storage_key`)
);
--> statement-breakpoint
CREATE INDEX `design_asset_deletions_pending_idx`
  ON `design_asset_deletions` (`created_at`);
