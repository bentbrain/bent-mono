-- Separate from the older video foundation because print_asset_jobs did not
-- exist when the foundation was introduced. Installed only when that table
-- exists, before the guarded release acquires its pause.
CREATE TRIGGER IF NOT EXISTS native_print_pause_attempt_update
BEFORE UPDATE OF status, attempt_count, lease_id ON print_asset_jobs
WHEN NEW.status = 'running'
  AND (OLD.status != 'running' OR NEW.attempt_count != OLD.attempt_count
    OR NEW.lease_id IS NOT OLD.lease_id)
  AND COALESCE((SELECT paused FROM native_video_release_control WHERE singleton = 1), 1) = 1
BEGIN
  SELECT RAISE(IGNORE);
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS native_print_pause_attempt_insert
BEFORE INSERT ON print_asset_jobs
WHEN NEW.status = 'running'
  AND COALESCE((SELECT paused FROM native_video_release_control WHERE singleton = 1), 1) = 1
BEGIN
  SELECT RAISE(IGNORE);
END;
