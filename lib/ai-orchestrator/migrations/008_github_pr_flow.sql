-- Phase 6: GitHub PR flow (additive, non-destructive).
-- Patch sets, per-file changes, and pull-request attempts. No table is
-- dropped or altered destructively; everything is CREATE ... IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS ai_patch_sets (
  id                TEXT PRIMARY KEY,
  session_id        TEXT NOT NULL REFERENCES ai_sessions(id) ON DELETE CASCADE,
  user_id           TEXT,
  status            TEXT NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft','validated','applied','failed','superseded')),
  base_branch       TEXT NOT NULL,
  target_branch     TEXT NOT NULL,
  base_sha          TEXT,
  patch_summary     TEXT,
  patch_text        TEXT,
  validation_errors TEXT,          -- JSON array of strings (nullable)
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_patch_sets_session ON ai_patch_sets(session_id);
CREATE INDEX IF NOT EXISTS idx_ai_patch_sets_user    ON ai_patch_sets(user_id);
CREATE INDEX IF NOT EXISTS idx_ai_patch_sets_status  ON ai_patch_sets(status);

CREATE TABLE IF NOT EXISTS ai_patch_files (
  id                TEXT PRIMARY KEY,
  patch_set_id      TEXT NOT NULL REFERENCES ai_patch_sets(id) ON DELETE CASCADE,
  file_path         TEXT NOT NULL,
  change_type       TEXT NOT NULL
                      CHECK (change_type IN ('create','modify','delete','rename')),
  old_content_hash  TEXT,
  new_content_hash  TEXT,
  patch_hunk        TEXT,
  reason            TEXT,
  created_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_patch_files_patch_set ON ai_patch_files(patch_set_id);

CREATE TABLE IF NOT EXISTS ai_pull_requests (
  id                TEXT PRIMARY KEY,
  session_id        TEXT NOT NULL REFERENCES ai_sessions(id) ON DELETE CASCADE,
  patch_set_id      TEXT NOT NULL REFERENCES ai_patch_sets(id) ON DELETE CASCADE,
  user_id           TEXT,
  github_pr_number  INTEGER,
  github_pr_url     TEXT,
  branch_name       TEXT NOT NULL,
  base_branch       TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'dry_run'
                      CHECK (status IN ('dry_run','created','closed','merged','failed')),
  error_message     TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_pull_requests_session   ON ai_pull_requests(session_id);
CREATE INDEX IF NOT EXISTS idx_ai_pull_requests_patch_set ON ai_pull_requests(patch_set_id);
CREATE INDEX IF NOT EXISTS idx_ai_pull_requests_pr_number ON ai_pull_requests(github_pr_number);
CREATE INDEX IF NOT EXISTS idx_ai_pull_requests_status    ON ai_pull_requests(status);
