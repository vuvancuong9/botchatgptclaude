-- Artifacts emitted by steps: spec / plan / patch / test_report / review.
CREATE TABLE IF NOT EXISTS ai_artifacts (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES ai_sessions(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES ai_messages(id) ON DELETE CASCADE,
  type       TEXT NOT NULL
               CHECK (type IN ('spec','plan','patch','test_report','review')),
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_artifacts_session ON ai_artifacts(session_id);
CREATE INDEX IF NOT EXISTS idx_ai_artifacts_type ON ai_artifacts(type);
