-- Keep both screened sources so background removal is reversible while editing.
CREATE TABLE design_artwork_sources (
  design_id TEXT NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('original', 'cutout')),
  artwork_key TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  width INTEGER NOT NULL CHECK (width > 0),
  height INTEGER NOT NULL CHECK (height > 0),
  PRIMARY KEY (design_id, kind)
);
--> statement-breakpoint
CREATE INDEX design_artwork_sources_key_idx ON design_artwork_sources(artwork_key);
