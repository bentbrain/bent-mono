CREATE TABLE featured_products (
  slot INTEGER PRIMARY KEY CHECK (slot BETWEEN 1 AND 6),
  product_id TEXT NOT NULL UNIQUE REFERENCES products(id) ON DELETE CASCADE,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE featured_product_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL CHECK (revision >= 0)
);
--> statement-breakpoint
INSERT INTO featured_product_state (id, revision) VALUES (1, 0);
--> statement-breakpoint
CREATE TABLE featured_product_changes (
  command_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL UNIQUE,
  request_body TEXT NOT NULL,
  products_json TEXT NOT NULL CHECK (json_valid(products_json)),
  previous_products_json TEXT NOT NULL CHECK (json_valid(previous_products_json)),
  actor TEXT NOT NULL,
  run_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
