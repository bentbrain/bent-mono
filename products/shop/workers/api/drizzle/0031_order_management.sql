CREATE TABLE order_management_commands (
  id TEXT PRIMARY KEY NOT NULL,
  paid_order_id TEXT NOT NULL REFERENCES paid_orders(id),
  operation TEXT NOT NULL CHECK(operation IN ('address','cancel')),
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256) = 64),
  status TEXT NOT NULL CHECK(status IN ('pending','processing','succeeded','rejected','ambiguous')),
  shopify_job_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);
--> statement-breakpoint
CREATE INDEX order_management_pending_idx ON order_management_commands(status, updated_at);
--> statement-breakpoint
CREATE TABLE order_management_access_log (
  id TEXT PRIMARY KEY NOT NULL,
  subject_hash TEXT NOT NULL CHECK(length(subject_hash) = 64),
  actor TEXT NOT NULL CHECK(actor IN ('customer:capability','system:order-management')),
  action TEXT NOT NULL CHECK(action IN ('read','address','cancel','refund-read')),
  occurred_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX order_management_access_time_idx ON order_management_access_log(occurred_at);
--> statement-breakpoint
CREATE TRIGGER order_management_access_no_update BEFORE UPDATE ON order_management_access_log
BEGIN SELECT RAISE(ABORT, 'Order management access log is append-only'); END;
