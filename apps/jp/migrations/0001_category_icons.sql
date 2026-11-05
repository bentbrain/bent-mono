-- Category-only outbox. No journal, coordinates, filenames or media bytes.
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS jp_icon_baseline (label TEXT PRIMARY KEY);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS jp_icon_settings (id INTEGER PRIMARY KEY CHECK (id = 1), initialized INTEGER NOT NULL DEFAULT 0, provider_blocked INTEGER NOT NULL DEFAULT 0);
--> statement-breakpoint
INSERT OR IGNORE INTO jp_icon_settings(id) VALUES (1);
--> statement-breakpoint
INSERT OR IGNORE INTO jp_icon_baseline(label)
SELECT j.value FROM ec_media_items m, json_each(CASE WHEN json_valid(m.categories) THEN m.categories ELSE '[]' END) j
WHERE j.type = 'text' AND (SELECT initialized FROM jp_icon_settings WHERE id = 1) = 0;
--> statement-breakpoint
INSERT OR IGNORE INTO jp_icon_baseline(label)
SELECT j.value FROM ec_media_items m JOIN revisions r ON r.id = m.draft_revision_id,
json_each(CASE WHEN json_type(r.data, '$.categories') = 'array' THEN json_extract(r.data, '$.categories') ELSE '[]' END) j
WHERE j.type = 'text' AND (SELECT initialized FROM jp_icon_settings WHERE id = 1) = 0;
--> statement-breakpoint
UPDATE jp_icon_settings SET initialized = 1 WHERE id = 1;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS jp_icon_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, categories TEXT NOT NULL);
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS jp_icon_media_insert AFTER INSERT ON ec_media_items
BEGIN
  INSERT INTO jp_icon_outbox(categories) VALUES (COALESCE(NEW.categories, '[]'));
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS jp_icon_media_update AFTER UPDATE OF categories, draft_revision_id ON ec_media_items
WHEN NEW.categories IS NOT OLD.categories OR NEW.draft_revision_id IS NOT OLD.draft_revision_id
BEGIN
  INSERT INTO jp_icon_outbox(categories) VALUES (COALESCE((SELECT json_extract(data, '$.categories') FROM revisions WHERE id = NEW.draft_revision_id), NEW.categories, '[]'));
END;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS jp_categories (
  id TEXT PRIMARY KEY,
  normalized TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  ready_key TEXT,
  ready_version TEXT,
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation BETWEEN 0 AND 3)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS jp_icon_jobs (
  id TEXT PRIMARY KEY,
  category_id TEXT NOT NULL REFERENCES jp_categories(id),
  version TEXT NOT NULL,
  model TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation BETWEEN 1 AND 3),
  status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'ready', 'failed', 'uncertain', 'configuration')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
  available_at INTEGER NOT NULL,
  lease_until INTEGER,
  lease_token TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(category_id, version, generation)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS jp_icon_one_running ON jp_icon_jobs(status) WHERE status = 'running';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS jp_icon_queue ON jp_icon_jobs(status, available_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS jp_icon_attempts (token TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jp_icon_jobs(id), started_at INTEGER NOT NULL);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS jp_icon_spend_window ON jp_icon_attempts(started_at);
