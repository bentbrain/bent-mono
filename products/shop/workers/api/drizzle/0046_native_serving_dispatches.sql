CREATE TABLE native_serving_dispatches (
  kind TEXT NOT NULL CHECK (kind IN ('video','image-v4')),
  job_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt BETWEEN 1 AND 3),
  target_json TEXT NOT NULL,
  target_digest TEXT NOT NULL CHECK (length(target_digest)=64),
  accepted_at INTEGER NOT NULL,
  PRIMARY KEY(kind,job_id,attempt)
);
--> statement-breakpoint
CREATE TRIGGER native_serving_video_cleanup AFTER DELETE ON story_video_jobs
BEGIN DELETE FROM native_serving_dispatches WHERE kind='video' AND job_id=OLD.id; END;
--> statement-breakpoint
CREATE TRIGGER native_serving_image_cleanup AFTER DELETE ON product_image_jobs
BEGIN DELETE FROM native_serving_dispatches WHERE kind='image-v4' AND job_id=OLD.id; END;
