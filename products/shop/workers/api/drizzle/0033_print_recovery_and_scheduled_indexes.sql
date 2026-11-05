CREATE TABLE print_asset_retries (
  configured_product_id TEXT PRIMARY KEY NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  attempt_count INTEGER NOT NULL CHECK (attempt_count BETWEEN 1 AND 16),
  claim_id TEXT,
  next_attempt_at INTEGER NOT NULL,
  last_attempt_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX story_video_jobs_status_updated_idx ON story_video_jobs(status, updated_at);
--> statement-breakpoint
CREATE INDEX story_video_jobs_recovery_idx ON story_video_jobs(renderer_version, updated_at)
  WHERE status IN ('queued', 'failed');
--> statement-breakpoint
CREATE INDEX designs_abandoned_updated_idx ON designs(updated_at, id)
  WHERE finalized_at IS NULL AND deleted_at IS NULL;
