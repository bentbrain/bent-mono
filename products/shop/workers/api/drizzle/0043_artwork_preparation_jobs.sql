ALTER TABLE designs ADD COLUMN artwork_job_id TEXT;
--> statement-breakpoint
ALTER TABLE designs ADD COLUMN remove_background INTEGER;
--> statement-breakpoint
ALTER TABLE design_upload_grants ADD COLUMN progressive INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE TABLE artwork_preparation_jobs (
  id TEXT PRIMARY KEY,
  design_id TEXT NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
  source_key TEXT NOT NULL,
  source_bytes INTEGER NOT NULL,
  source_sha256 TEXT NOT NULL CHECK (length(source_sha256) = 64),
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'complete', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  lease_token TEXT,
  source_deleted_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX artwork_preparation_jobs_due_idx ON artwork_preparation_jobs(status, next_attempt_at);
