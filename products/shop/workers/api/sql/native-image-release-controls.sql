CREATE TRIGGER IF NOT EXISTS product_image_pause_insert BEFORE INSERT ON product_image_jobs
WHEN NEW.status = 'rendering' AND COALESCE((SELECT paused FROM native_video_release_control WHERE singleton = 1), 1) = 1
BEGIN SELECT RAISE(IGNORE); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS product_image_pause_update BEFORE UPDATE OF status, attempt_count ON product_image_jobs
WHEN NEW.status = 'rendering' AND (OLD.status <> 'rendering' OR NEW.attempt_count <> OLD.attempt_count) AND COALESCE((SELECT paused FROM native_video_release_control WHERE singleton = 1), 1) = 1
BEGIN SELECT RAISE(IGNORE); END;
