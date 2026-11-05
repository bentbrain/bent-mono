CREATE TABLE print_asset_jobs (
  configured_product_id TEXT PRIMARY KEY NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'dispatched', 'running', 'ready')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  lease_id TEXT,
  next_attempt_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX print_asset_jobs_due_idx ON print_asset_jobs(next_attempt_at, configured_product_id)
  WHERE status <> 'ready';
--> statement-breakpoint
CREATE TABLE provider_admission (
  provider TEXT PRIMARY KEY NOT NULL CHECK (provider IN ('printify', 'portrait')),
  tokens REAL NOT NULL,
  updated_at INTEGER NOT NULL,
  blocked_until INTEGER NOT NULL
);
