-- Queue-owned portrait preparation must stop accepting work during a release.
CREATE TRIGGER IF NOT EXISTS native_artwork_pause_update
BEFORE UPDATE ON artwork_preparation_jobs
WHEN NEW.status = 'processing'
  AND COALESCE((SELECT paused FROM native_video_release_control WHERE singleton = 1), 1) <> 0
BEGIN
  SELECT RAISE(IGNORE);
END;
