CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id TEXT PRIMARY KEY,
  redirect_uris JSONB NOT NULL,
  client_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS app_users (
  id TEXT PRIMARY KEY,
  clerk_user_id TEXT NOT NULL UNIQUE,
  github_username TEXT,
  github_user_id TEXT,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  github_username TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revoked')),
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_by_user_id TEXT REFERENCES app_users(id),
  accepted_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE app_users ADD COLUMN IF NOT EXISTS github_username TEXT;
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS github_user_id TEXT;
ALTER TABLE invites ADD COLUMN IF NOT EXISTS github_username TEXT;
ALTER TABLE app_users DROP COLUMN IF EXISTS email;
ALTER TABLE invites DROP COLUMN IF EXISTS email;

CREATE UNIQUE INDEX IF NOT EXISTS app_users_github_username_idx
  ON app_users(LOWER(github_username)) WHERE github_username IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS app_users_github_user_id_idx
  ON app_users(github_user_id) WHERE github_user_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS invites_github_username_idx
  ON invites(LOWER(github_username)) WHERE github_username IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS invites_github_username_key
  ON invites(github_username) WHERE github_username IS NOT NULL;

CREATE INDEX IF NOT EXISTS invites_status_expires_idx
  ON invites(status, expires_at);

CREATE TABLE IF NOT EXISTS tesla_connections (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES app_users(id),
  access_token_encrypted TEXT NOT NULL,
  refresh_token_encrypted TEXT NOT NULL,
  token_version INTEGER NOT NULL DEFAULT 1,
  scopes TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE tesla_connections
  ADD COLUMN IF NOT EXISTS user_id TEXT REFERENCES app_users(id);

CREATE INDEX IF NOT EXISTS tesla_connections_user_idx
  ON tesla_connections(user_id);

CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_clients(client_id),
  connection_id TEXT NOT NULL REFERENCES tesla_connections(id),
  redirect_uri TEXT NOT NULL,
  resource TEXT NOT NULL,
  scopes TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS oauth_access_tokens (
  token_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_clients(client_id),
  connection_id TEXT NOT NULL REFERENCES tesla_connections(id),
  resource TEXT NOT NULL,
  scopes TEXT NOT NULL,
  family_id TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS oauth_access_tokens_connection_idx
  ON oauth_access_tokens(connection_id);

CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
  token_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_clients(client_id),
  connection_id TEXT NOT NULL REFERENCES tesla_connections(id),
  resource TEXT NOT NULL,
  scopes TEXT NOT NULL,
  family_id TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  successor_token_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS oauth_refresh_tokens_connection_idx
  ON oauth_refresh_tokens(connection_id);

ALTER TABLE oauth_access_tokens ADD COLUMN IF NOT EXISTS family_id TEXT;
ALTER TABLE oauth_access_tokens ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;
UPDATE oauth_access_tokens SET family_id = token_hash WHERE family_id IS NULL;
ALTER TABLE oauth_access_tokens ALTER COLUMN family_id SET NOT NULL;

ALTER TABLE oauth_refresh_tokens ADD COLUMN IF NOT EXISTS family_id TEXT;
ALTER TABLE oauth_refresh_tokens ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;
ALTER TABLE oauth_refresh_tokens ADD COLUMN IF NOT EXISTS successor_token_hash TEXT;
UPDATE oauth_refresh_tokens SET family_id = token_hash WHERE family_id IS NULL;
ALTER TABLE oauth_refresh_tokens ALTER COLUMN family_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS oauth_refresh_tokens_family_idx
  ON oauth_refresh_tokens(family_id);

CREATE INDEX IF NOT EXISTS oauth_access_tokens_family_idx
  ON oauth_access_tokens(family_id);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  connection_id TEXT REFERENCES tesla_connections(id),
  event_type TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS audit_events_connection_created_idx
  ON audit_events(connection_id, created_at DESC);
