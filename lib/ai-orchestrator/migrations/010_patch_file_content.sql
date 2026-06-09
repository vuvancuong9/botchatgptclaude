-- Phase 7.1: store the FULL (redacted) new file content so the sandbox worker
-- can apply the patch into a workspace before running tests. Additive.
-- NOTE: SQLite has no "ADD COLUMN IF NOT EXISTS"; the migration loader ignores
-- the "duplicate column name" error so re-running this file is safe.
ALTER TABLE ai_patch_files ADD COLUMN new_content_redacted TEXT;
