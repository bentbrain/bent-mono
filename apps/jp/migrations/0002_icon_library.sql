-- Keep every generated icon, including versions replaced by regeneration.
CREATE TABLE IF NOT EXISTS jp_icon_assets (
  storage_key TEXT PRIMARY KEY,
  category_id TEXT NOT NULL,
  normalized TEXT NOT NULL,
  label TEXT NOT NULL,
  version TEXT NOT NULL
);
--> statement-breakpoint
INSERT OR IGNORE INTO jp_icon_assets(storage_key,category_id,normalized,label,version)
SELECT ready_key,id,normalized,label,ready_version FROM jp_categories
WHERE ready_key IS NOT NULL AND ready_version IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS jp_icon_asset_ready AFTER UPDATE OF ready_key ON jp_categories
WHEN NEW.ready_key IS NOT NULL AND NEW.ready_version IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO jp_icon_assets(storage_key,category_id,normalized,label,version)
  VALUES(NEW.ready_key,NEW.id,NEW.normalized,NEW.label,NEW.ready_version);
END;
--> statement-breakpoint
-- Ordinary uploads keep their existing behavior. Generated icons have one
-- durable media identity even when owner requests register them concurrently.
CREATE UNIQUE INDEX IF NOT EXISTS jp_icon_media_storage_key
ON media(storage_key) WHERE storage_key LIKE 'category-icons/%';
