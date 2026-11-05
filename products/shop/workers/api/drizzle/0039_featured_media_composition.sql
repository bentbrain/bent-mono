-- Existing products keep their original print and single-source video semantics.
ALTER TABLE products ADD print_mode TEXT NOT NULL DEFAULT 'recursive'
  CHECK (print_mode IN ('recursive', 'base-image-only'));
--> statement-breakpoint
ALTER TABLE products ADD video_recursive_revision_id TEXT REFERENCES design_revisions(id);
--> statement-breakpoint
CREATE TRIGGER products_media_composition_insert BEFORE INSERT ON products
WHEN (NEW.print_mode = 'base-image-only' AND (
  NEW.design_revision_id IS NULL OR NEW.video_recursive_revision_id IS NULL
  OR NEW.video_recursive_revision_id = NEW.design_revision_id
  OR NOT EXISTS (SELECT 1 FROM design_revisions source
    WHERE source.id = NEW.design_revision_id AND source.design_id = NEW.design_id)
  OR NOT EXISTS (SELECT 1 FROM design_revisions source
    WHERE source.id = NEW.video_recursive_revision_id AND source.design_id = NEW.design_id)
  OR EXISTS (SELECT 1 FROM products sibling WHERE sibling.design_revision_id = NEW.design_revision_id
    AND (sibling.print_mode <> NEW.print_mode OR sibling.video_recursive_revision_id IS NOT NEW.video_recursive_revision_id))
)) OR (NEW.print_mode = 'recursive' AND NEW.video_recursive_revision_id IS NOT NULL)
OR EXISTS (SELECT 1 FROM products sibling WHERE sibling.design_revision_id = NEW.design_revision_id
  AND sibling.video_recursive_revision_id IS NOT NEW.video_recursive_revision_id)
BEGIN SELECT RAISE(ABORT, 'Invalid immutable media composition'); END;
--> statement-breakpoint
CREATE TRIGGER products_media_composition_no_update
BEFORE UPDATE OF print_mode, video_recursive_revision_id ON products
WHEN (NEW.print_mode <> OLD.print_mode OR NEW.video_recursive_revision_id IS NOT OLD.video_recursive_revision_id)
AND NOT (OLD.status IN ('deleted', 'suspended', 'unpublished', 'retired') AND NEW.status = OLD.status
  AND EXISTS (SELECT 1 FROM designs WHERE id = OLD.design_id AND status = 'deleted') AND NEW.print_mode = OLD.print_mode
  AND NEW.design_revision_id IS NULL AND NEW.video_recursive_revision_id IS NULL)
BEGIN SELECT RAISE(ABORT, 'Product media composition is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER products_composed_source_no_update
BEFORE UPDATE OF design_id, design_revision_id, placement_x, placement_y, placement_width, placement_depth, projection_version ON products
WHEN OLD.print_mode = 'base-image-only'
AND NOT (OLD.status IN ('deleted', 'suspended', 'unpublished', 'retired') AND NEW.status = OLD.status
  AND EXISTS (SELECT 1 FROM designs WHERE id = OLD.design_id AND status = 'deleted') AND NEW.design_revision_id IS NULL
  AND NEW.video_recursive_revision_id IS NULL AND NEW.design_id IS OLD.design_id
  AND NEW.placement_x IS OLD.placement_x AND NEW.placement_y IS OLD.placement_y
  AND NEW.placement_width IS OLD.placement_width AND NEW.placement_depth IS OLD.placement_depth
  AND NEW.projection_version IS OLD.projection_version) AND (
  NEW.design_id IS NOT OLD.design_id OR NEW.design_revision_id IS NOT OLD.design_revision_id
  OR NEW.placement_x IS NOT OLD.placement_x OR NEW.placement_y IS NOT OLD.placement_y
  OR NEW.placement_width IS NOT OLD.placement_width OR NEW.placement_depth IS NOT OLD.placement_depth
  OR NEW.projection_version IS NOT OLD.projection_version)
BEGIN SELECT RAISE(ABORT, 'Composed product source is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER composed_revision_no_update BEFORE UPDATE ON design_revisions
WHEN EXISTS (SELECT 1 FROM products WHERE print_mode = 'base-image-only'
  AND (design_revision_id = OLD.id OR video_recursive_revision_id = OLD.id))
BEGIN SELECT RAISE(ABORT, 'Composed artwork revision is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER products_composed_no_replace BEFORE INSERT ON products
WHEN EXISTS (SELECT 1 FROM products existing WHERE existing.id = NEW.id
  AND (existing.print_mode = 'base-image-only' OR NEW.print_mode = 'base-image-only'))
BEGIN SELECT RAISE(ABORT, 'Composed product identity cannot be replaced'); END;
--> statement-breakpoint
CREATE TRIGGER composed_revision_no_replace BEFORE INSERT ON design_revisions
WHEN EXISTS (SELECT 1 FROM products WHERE print_mode = 'base-image-only'
  AND (design_revision_id = NEW.id OR video_recursive_revision_id = NEW.id))
BEGIN SELECT RAISE(ABORT, 'Composed artwork revision cannot be replaced'); END;
