CREATE TABLE product_image_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  product_id TEXT NOT NULL,
  design_revision_id TEXT NOT NULL,
  colour TEXT NOT NULL,
  view TEXT NOT NULL CHECK (view IN ('flat', 'lifestyle')),
  renderer_version TEXT NOT NULL,
  storage_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'rendering', 'ready', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  execution_id TEXT,
  sha256 TEXT,
  byte_size INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(product_id, colour, view, renderer_version)
);
--> statement-breakpoint
CREATE INDEX product_image_jobs_pending ON product_image_jobs(status, updated_at);
