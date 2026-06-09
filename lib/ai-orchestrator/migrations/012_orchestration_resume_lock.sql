-- Phase 7.4: resume lock for scheduled/cron resume (additive, non-destructive).
-- A lightweight lock on ai_orchestration_runs prevents two cron ticks from
-- resuming the same orchestration at once. The loader tolerates the
-- "duplicate column name" error, so re-applying these ALTERs is safe.

ALTER TABLE ai_orchestration_runs ADD COLUMN resume_lock_owner TEXT;
ALTER TABLE ai_orchestration_runs ADD COLUMN resume_lock_expires_at TEXT;
ALTER TABLE ai_orchestration_runs ADD COLUMN resume_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ai_orchestration_runs ADD COLUMN last_resume_attempt_at TEXT;

CREATE INDEX IF NOT EXISTS idx_ai_orch_runs_resume_lock
  ON ai_orchestration_runs(resume_lock_expires_at);
CREATE INDEX IF NOT EXISTS idx_ai_orch_runs_status_pending
  ON ai_orchestration_runs(status, pending_worker_job_id);
