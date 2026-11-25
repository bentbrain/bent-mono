-- fitness_device_enrollments as the first attempt-tracking schema created it.
CREATE TABLE IF NOT EXISTS fitness_device_enrollments (
  owner_id text NOT NULL REFERENCES fitness_accounts(owner_id),
  token_digest text PRIMARY KEY CHECK (token_digest ~ '^[0-9a-f]{64}$'),
  attempt_id uuid NOT NULL UNIQUE,
  installation_id uuid NOT NULL,
  key_state text NOT NULL DEFAULT 'pending' CHECK (key_state IN ('pending','issued','failed')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fitness_device_enrollment_created ON fitness_device_enrollments(created_at);
CREATE INDEX IF NOT EXISTS fitness_device_enrollment_pending ON fitness_device_enrollments(owner_id) WHERE key_state='pending';
