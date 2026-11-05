-- Development CI fixtures only. Deliberately not a production migration.
CREATE TABLE IF NOT EXISTS native_video_qualification_faults (
  design_id TEXT NOT NULL REFERENCES designs(id),
  release_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  point TEXT NOT NULL CHECK (point IN ('invoke-ack', 'invoke-duplicate', 'claim-ack', 'upload-ack', 'enqueue-send', 'direct-dispatch', 'terminate')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at AND expires_at <= created_at + 600000),
  consumed_at INTEGER,
  job_id TEXT REFERENCES story_video_jobs(id),
  PRIMARY KEY (design_id, point)
);
CREATE TABLE IF NOT EXISTS native_video_qualification_observations (
  id TEXT PRIMARY KEY,
  design_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  status INTEGER NOT NULL,
  execution_id TEXT,
  observed_at INTEGER NOT NULL
);
