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
-- Each Apple Health sample Fitness has synced, the record it became or matched,
-- that record's date and revision, and a run sample's distance and duration.
CREATE TABLE IF NOT EXISTS fitness_health_samples (
  owner_id text NOT NULL REFERENCES fitness_accounts(owner_id),
  sample text NOT NULL,
  record_id uuid NOT NULL,
  record_date date NOT NULL,
  matched boolean NOT NULL,
  record_revision integer,
  distance_km double precision,
  minutes double precision,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id,sample)
);
CREATE INDEX IF NOT EXISTS fitness_health_sample_record ON fitness_health_samples(owner_id, record_id);
CREATE UNIQUE INDEX IF NOT EXISTS fitness_weight_date ON fitness_records(owner_id, (data->>'date')) WHERE deleted=false AND data->>'kind'='weight';
CREATE UNIQUE INDEX IF NOT EXISTS fitness_active_workout ON fitness_records(owner_id) WHERE deleted=false AND data->>'kind'='workout' AND data->>'finishedAt' IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS fitness_workout_correction ON fitness_records(owner_id, (data->>'workoutId')) WHERE deleted=false AND data->>'kind'='workoutCorrection';
-- Each enrollment attempt for an iPhone sync device, keyed by the ID Clerk
-- verified for its one-time OAuth token and by the SHA-256 digest of the
-- token, so a token issues at most one device key. The attempt ID is also a claim on the key it creates. key_state is
-- pending while its request runs, then issued (Clerk returned the key,
-- recorded in key_id), ambiguous (the creation had no confirmed result) or
-- failed (no creation was attempted). charged_at is when the key Clerk
-- created for the attempt counts toward the hourly limit from. A device key
-- can import only while
-- its attempt is issued and active with the same key_id; each installation
-- has at most one active attempt. Enrollment removes inactive rows older
-- than two days.
--
-- The table started with fewer columns. The statements below add the later
-- ones and their constraints in place, keeping the token digests already
-- recorded, so applying this file again is safe.
CREATE TABLE IF NOT EXISTS fitness_device_enrollments (
  owner_id text NOT NULL REFERENCES fitness_accounts(owner_id),
  token_digest text PRIMARY KEY CHECK (token_digest ~ '^[0-9a-f]{64}$'),
  installation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- The ID Clerk verified for the token, which identifies it however it is
-- encoded. Rows recorded before it existed keep only the digest.
ALTER TABLE fitness_device_enrollments ADD COLUMN IF NOT EXISTS token_id text;
ALTER TABLE fitness_device_enrollments ADD COLUMN IF NOT EXISTS attempt_id uuid;
UPDATE fitness_device_enrollments SET attempt_id = gen_random_uuid() WHERE attempt_id IS NULL;
ALTER TABLE fitness_device_enrollments ALTER COLUMN attempt_id SET NOT NULL;
ALTER TABLE fitness_device_enrollments ADD COLUMN IF NOT EXISTS key_state text NOT NULL DEFAULT 'pending';
ALTER TABLE fitness_device_enrollments ADD COLUMN IF NOT EXISTS key_id text;
ALTER TABLE fitness_device_enrollments ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT false;
ALTER TABLE fitness_device_enrollments ADD COLUMN IF NOT EXISTS charged_at timestamptz;
-- The keys an attempt's swap replaced, so a read after a lost commit reply
-- knows which to revoke.
ALTER TABLE fitness_device_enrollments ADD COLUMN IF NOT EXISTS replaced_key_ids text[];
-- The app's own count of enrollment attempts for the installation, so an
-- earlier attempt never replaces a later one's key. Rows recorded before
-- it existed have none and count lowest.
ALTER TABLE fitness_device_enrollments ADD COLUMN IF NOT EXISTS enrollment_sequence bigint;
-- Keys issued before charged_at existed count from when they were recorded.
UPDATE fitness_device_enrollments SET charged_at = created_at WHERE key_state = 'issued' AND charged_at IS NULL;
-- Earlier versions checked key_state without ambiguous, and the active key
-- under a generated name.
ALTER TABLE fitness_device_enrollments DROP CONSTRAINT IF EXISTS fitness_device_enrollments_key_state_check;
ALTER TABLE fitness_device_enrollments DROP CONSTRAINT IF EXISTS fitness_device_enrollments_check;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'fitness_device_enrollments'::regclass AND conname = 'fitness_device_enrollments_token_id_key') THEN
    ALTER TABLE fitness_device_enrollments ADD CONSTRAINT fitness_device_enrollments_token_id_key UNIQUE (token_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'fitness_device_enrollments'::regclass AND conname = 'fitness_device_enrollments_attempt_id_key') THEN
    ALTER TABLE fitness_device_enrollments ADD CONSTRAINT fitness_device_enrollments_attempt_id_key UNIQUE (attempt_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'fitness_device_enrollments'::regclass AND conname = 'fitness_device_enrollment_key_state') THEN
    ALTER TABLE fitness_device_enrollments ADD CONSTRAINT fitness_device_enrollment_key_state CHECK (key_state IN ('pending','issued','ambiguous','failed'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'fitness_device_enrollments'::regclass AND conname = 'fitness_device_enrollment_active_key') THEN
    ALTER TABLE fitness_device_enrollments ADD CONSTRAINT fitness_device_enrollment_active_key CHECK (NOT active OR (key_state = 'issued' AND key_id IS NOT NULL));
  END IF;
END $$;
DROP INDEX IF EXISTS fitness_device_enrollment_pending;
CREATE INDEX IF NOT EXISTS fitness_device_enrollment_created ON fitness_device_enrollments(created_at);
CREATE INDEX IF NOT EXISTS fitness_device_enrollment_owner ON fitness_device_enrollments(owner_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS fitness_device_enrollment_active ON fitness_device_enrollments(owner_id, installation_id) WHERE active;
-- Unused. Earlier versions issued device keys one at a time per owner under
-- a lease row here. Enrollment now serializes on the account row, and the
-- table is kept so existing databases need no destructive change.
CREATE TABLE IF NOT EXISTS fitness_device_issuance_leases (
  owner_id text PRIMARY KEY,
  holder uuid NOT NULL,
  expires_at timestamptz NOT NULL
);
-- Enrollment attempts across all servers, per one-minute window, counted
-- before any Clerk call. Enrollment removes windows older than an hour.
CREATE TABLE IF NOT EXISTS fitness_device_attempt_windows (
  window_start timestamptz PRIMARY KEY,
  attempts integer NOT NULL
);
-- The highest enrollment sequence each installation's app has sent, kept
-- whatever became of that attempt, so an earlier attempt never takes over
-- from a later one, even a later one that failed.
CREATE TABLE IF NOT EXISTS fitness_device_sequences (
  owner_id text NOT NULL REFERENCES fitness_accounts(owner_id),
  installation_id uuid NOT NULL,
  max_seen bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, installation_id)
);
-- Training plans assistants propose for the owner to accept in the app.
-- status is pending until the owner accepts or dismisses it, or a newer
-- proposal replaces it; an account has at most one pending proposal. plan
-- holds the proposal as storedPlanSchema in @bent/fitness-contracts/proposal
-- describes it.
CREATE TABLE IF NOT EXISTS fitness_plan_proposals (
  owner_id text NOT NULL REFERENCES fitness_accounts(owner_id),
  id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','dismissed','replaced')),
  plan jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  PRIMARY KEY (owner_id,id),
  CHECK ((status = 'pending') = (decided_at IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS fitness_plan_proposal_pending ON fitness_plan_proposals(owner_id) WHERE status = 'pending';
