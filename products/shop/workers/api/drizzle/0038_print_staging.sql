-- Deliberately no cascading foreign keys: removing a design must not erase the
-- inventory needed to abort/delete its temporary R2 uploads.
CREATE TABLE print_asset_staging (
  id TEXT PRIMARY KEY NOT NULL,
  attempt_id TEXT NOT NULL,
  configured_product_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  storage_key TEXT NOT NULL UNIQUE,
  upload_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('initializing', 'uploading', 'completed')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  CHECK (storage_key = 'print-assets/staging/v1/' || attempt_id || '/' || id || '.png')
);
--> statement-breakpoint
CREATE INDEX print_asset_staging_expiry ON print_asset_staging(expires_at);
