ALTER TABLE product_image_jobs ADD COLUMN dispatch_provider TEXT CHECK (dispatch_provider IS NULL OR dispatch_provider = 'native-v5');
--> statement-breakpoint
CREATE TABLE native_v5_dispatches (
  job_id TEXT NOT NULL REFERENCES product_image_jobs(id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL CHECK (attempt BETWEEN 1 AND 3),
  target_json TEXT NOT NULL,
  target_digest TEXT NOT NULL CHECK (length(target_digest) = 64),
  input_json TEXT NOT NULL,
  input_digest TEXT NOT NULL CHECK (length(input_digest) = 64),
  grant_sha256 TEXT NOT NULL UNIQUE CHECK (length(grant_sha256) = 64),
  grant_expires_at INTEGER NOT NULL,
  request_sha256 TEXT NOT NULL CHECK (length(request_sha256) = 64),
  accepted_at INTEGER NOT NULL,
  dispatch_state TEXT NOT NULL CHECK (dispatch_state IN ('prepared','accepted','uncertain','rejected')),
  PRIMARY KEY (job_id, attempt)
);
--> statement-breakpoint
CREATE INDEX native_v5_dispatches_expiry ON native_v5_dispatches(grant_expires_at);
