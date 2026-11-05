-- Display videos can use a frozen screened preview while the separate print
-- revision remains absent until full-resolution preparation and validation.
ALTER TABLE products ADD COLUMN video_design_revision_id TEXT REFERENCES design_revisions(id);
