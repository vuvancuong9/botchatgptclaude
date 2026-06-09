-- Orchestrator sessions: one row per user request / run.
CREATE TABLE IF NOT EXISTS ai_sessions (
  id                    TEXT PRIMARY KEY,
  user_request          TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'running'
                          CHECK (status IN ('running','passed','needs_revision','failed','rejected')),
  approval              TEXT NOT NULL DEFAULT 'pending'
                          CHECK (approval IN ('pending','approved','rejected')),
  rounds                INTEGER NOT NULL DEFAULT 0,
  -- Nullable, reserved for multi-user (Phase 4).
  user_id               TEXT,
  admin_key_fingerprint TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_sessions_created_at ON ai_sessions(created_at);
CREATE INDEX IF NOT EXISTS idx_ai_sessions_status ON ai_sessions(status);
