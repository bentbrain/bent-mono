CREATE TABLE IF NOT EXISTS fitness_accounts (
  owner_id text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS fitness_records (
  owner_id text NOT NULL REFERENCES fitness_accounts(owner_id),
  id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  data jsonb,
  deleted boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id,id),
  CHECK ((deleted AND data IS NULL) OR (NOT deleted AND data IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS fitness_operations (
  owner_id text NOT NULL REFERENCES fitness_accounts(owner_id),
  id uuid NOT NULL,
  fingerprint text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id,id)
);
CREATE TABLE IF NOT EXISTS fitness_photos (
  owner_id text NOT NULL REFERENCES fitness_accounts(owner_id),
  id uuid NOT NULL,
  name text NOT NULL,
  content_type text NOT NULL CHECK (content_type IN ('image/jpeg','image/png','image/webp')),
  bytes bytea NOT NULL CHECK (octet_length(bytes) <= 5242880),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS fitness_weight_date ON fitness_records(owner_id, (data->>'date')) WHERE deleted=false AND data->>'kind'='weight';
CREATE UNIQUE INDEX IF NOT EXISTS fitness_active_workout ON fitness_records(owner_id) WHERE deleted=false AND data->>'kind'='workout' AND data->>'finishedAt' IS NULL;
