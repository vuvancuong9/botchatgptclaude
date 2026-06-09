-- Production-grade audit log (additive). Stores hashes only — never raw IP,
-- raw admin key, or secrets.
CREATE TABLE IF NOT EXISTS ai_audit_logs (
  id                    TEXT PRIMARY KEY,
  event_type            TEXT NOT NULL,
  session_id            TEXT,
  admin_key_fingerprint TEXT,
  user_id               TEXT,
  ip_hash               TEXT,
  user_agent_hash       TEXT,
  status                TEXT NOT NULL DEFAULT 'ok',
  metadata              TEXT NOT NULL DEFAULT '{}', -- JSON-encoded
  created_at            TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_audit_created_at  ON ai_audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_ai_audit_event_type  ON ai_audit_logs(event_type);
CREATE INDEX IF NOT EXISTS idx_ai_audit_session     ON ai_audit_logs(session_id);
CREATE INDEX IF NOT EXISTS idx_ai_audit_fingerprint ON ai_audit_logs(admin_key_fingerprint);
CREATE INDEX IF NOT EXISTS idx_ai_audit_status      ON ai_audit_logs(status);
