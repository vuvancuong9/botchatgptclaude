-- Phase 10: web login passwords + encrypted app settings (model API keys).
-- Additive, non-destructive. The loader tolerates "duplicate column name".

ALTER TABLE ai_users ADD COLUMN password_hash TEXT;

CREATE TABLE IF NOT EXISTS ai_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,   -- encrypted (AES-256-GCM) for secrets
  updated_at TEXT NOT NULL
);
