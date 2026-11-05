-- Bound admission reads to in-flight work rather than all historical designs.
CREATE INDEX print_asset_jobs_running_idx
  ON print_asset_jobs(next_attempt_at, configured_product_id)
  WHERE status = 'running';

--> statement-breakpoint
-- FIFO considers only unfinished outbox rows, never historical ready designs.
CREATE INDEX print_asset_jobs_admission_idx
  ON print_asset_jobs(created_at, configured_product_id, status, next_attempt_at)
  WHERE status <> 'ready';
