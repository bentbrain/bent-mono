CREATE TABLE product_lifecycle_transitions (
  command_id TEXT PRIMARY KEY NOT NULL,
  product_id TEXT NOT NULL REFERENCES products(id),
  from_status TEXT NOT NULL CHECK (from_status IN ('active','suspended','unpublished')),
  to_status TEXT NOT NULL CHECK (to_status IN ('active','suspended','unpublished','retired')),
  actor TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  request_body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  applied_at INTEGER
);
--> statement-breakpoint
CREATE INDEX product_lifecycle_history_idx ON product_lifecycle_transitions(product_id, created_at);
--> statement-breakpoint
-- A new product UUID cannot bypass a takedown of the same immutable identity.
CREATE TRIGGER products_prevent_lifecycle_recreation BEFORE INSERT ON products
WHEN NEW.design_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM products existing
  WHERE existing.design_id = NEW.design_id
    AND existing.base_product_id = NEW.base_product_id
    AND existing.status IN ('suspended','unpublished','retired')
)
BEGIN
  SELECT RAISE(ABORT, 'Configured product is unavailable after lifecycle review');
END;
--> statement-breakpoint
CREATE TRIGGER products_prevent_irreversible_reactivation BEFORE UPDATE OF status ON products
WHEN (OLD.status IN ('unpublished','retired') AND NEW.status NOT IN ('unpublished','retired','deleted'))
  OR (OLD.status = 'retired' AND NEW.status = 'unpublished')
BEGIN
  SELECT RAISE(ABORT, 'Configured product cannot be republished');
END;
