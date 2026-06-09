-- Command-execution audit log for the TEST_RUNNER (allowlist enforced).
CREATE TABLE IF NOT EXISTS ai_runs (
  id                    TEXT PRIMARY KEY,
  session_id            TEXT NOT NULL REFERENCES ai_sessions(id) ON DELETE CASCADE,
  command               TEXT NOT NULL,
  allowed               INTEGER NOT NULL DEFAULT 0, -- 0/1 boolean
  exit_code             INTEGER,
  stdout                TEXT NOT NULL DEFAULT '',
  stderr                TEXT NOT NULL DEFAULT '',
  step_name             TEXT,
  status                TEXT NOT NULL DEFAULT 'skipped'
                          CHECK (status IN ('passed','failed','blocked','skipped')),
  admin_key_fingerprint TEXT,
  user_id               TEXT,
  created_at            TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_runs_session ON ai_runs(session_id);
CREATE INDEX IF NOT EXISTS idx_ai_runs_step_name ON ai_runs(step_name);
CREATE INDEX IF NOT EXISTS idx_ai_runs_status ON ai_runs(status);
CREATE INDEX IF NOT EXISTS idx_ai_runs_user_id ON ai_runs(user_id);
