-- Multi-user + RBAC (additive).

CREATE TABLE IF NOT EXISTS ai_users (
  id           TEXT PRIMARY KEY,
  email        TEXT,
  display_name TEXT,
  role         TEXT NOT NULL DEFAULT 'viewer'
                 CHECK (role IN ('owner','admin','developer','reviewer','viewer')),
  status       TEXT NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active','disabled')),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  last_seen_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_users_email ON ai_users(email);
CREATE INDEX IF NOT EXISTS idx_ai_users_role   ON ai_users(role);
CREATE INDEX IF NOT EXISTS idx_ai_users_status ON ai_users(status);

CREATE TABLE IF NOT EXISTS ai_api_keys (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES ai_users(id) ON DELETE CASCADE,
  key_prefix   TEXT NOT NULL,
  key_hash     TEXT NOT NULL,
  name         TEXT,
  status       TEXT NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active','revoked')),
  last_used_at TEXT,
  expires_at   TEXT,
  created_at   TEXT NOT NULL,
  revoked_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_ai_api_keys_user   ON ai_api_keys(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_api_keys_hash ON ai_api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_ai_api_keys_prefix ON ai_api_keys(key_prefix);
CREATE INDEX IF NOT EXISTS idx_ai_api_keys_status ON ai_api_keys(status);

CREATE TABLE IF NOT EXISTS ai_session_collaborators (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES ai_sessions(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES ai_users(id) ON DELETE CASCADE,
  permission TEXT NOT NULL DEFAULT 'viewer'
               CHECK (permission IN ('owner','editor','reviewer','viewer')),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_collab_session ON ai_session_collaborators(session_id);
CREATE INDEX IF NOT EXISTS idx_ai_collab_user    ON ai_session_collaborators(user_id);

CREATE TABLE IF NOT EXISTS ai_user_permissions_override (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES ai_users(id) ON DELETE CASCADE,
  permission TEXT NOT NULL,
  effect     TEXT NOT NULL DEFAULT 'allow' CHECK (effect IN ('allow','deny')),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_perm_override_user ON ai_user_permissions_override(user_id);
