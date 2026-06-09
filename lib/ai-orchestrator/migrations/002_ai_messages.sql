-- One row per agent step output (validated AgentOutput JSON).
CREATE TABLE IF NOT EXISTS ai_messages (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES ai_sessions(id) ON DELETE CASCADE,
  step       TEXT NOT NULL,
  provider   TEXT NOT NULL CHECK (provider IN ('openai','anthropic','system')),
  round      INTEGER NOT NULL DEFAULT 0,
  status     TEXT NOT NULL,
  output     TEXT NOT NULL, -- JSON-encoded AgentOutput
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_messages_session ON ai_messages(session_id);
