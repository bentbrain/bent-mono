-- Installed only by the paired native release pipeline, before migration 0018.
-- This works with the already deployed claim SQL: ignored UPDATEs report zero
-- changes, so the old Worker cannot dispatch while the durable pause is held.
-- Products and queued jobs remain writable. No attempts or ready media are lost.
CREATE TABLE IF NOT EXISTS native_video_release_control (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  paused INTEGER NOT NULL CHECK (paused IN (0, 1)),
  release_id TEXT,
  paused_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  current_release_id TEXT
);
--> statement-breakpoint
INSERT INTO native_video_release_control (singleton, paused, release_id, paused_at, updated_at)
VALUES (1, 1, NULL, 0, 0) ON CONFLICT (singleton) DO NOTHING;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS native_video_pause_attempt_update
BEFORE UPDATE OF status, attempt_count ON story_video_jobs
WHEN NEW.status = 'rendering'
  AND (OLD.status != 'rendering' OR NEW.attempt_count != OLD.attempt_count)
  AND COALESCE((SELECT paused FROM native_video_release_control WHERE singleton = 1), 1) = 1
BEGIN
  SELECT RAISE(IGNORE);
END;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS native_video_release_events (
  release_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (release_id, stage)
);
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS native_video_release_events_no_update
BEFORE UPDATE ON native_video_release_events
BEGIN
  SELECT RAISE(ABORT, 'Release evidence is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS native_video_release_events_no_delete
BEFORE DELETE ON native_video_release_events
BEGIN
  SELECT RAISE(ABORT, 'Release evidence is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS native_video_pause_attempt_insert
BEFORE INSERT ON story_video_jobs
WHEN NEW.status = 'rendering'
  AND COALESCE((SELECT paused FROM native_video_release_control WHERE singleton = 1), 1) = 1
BEGIN
  SELECT RAISE(IGNORE);
END;
