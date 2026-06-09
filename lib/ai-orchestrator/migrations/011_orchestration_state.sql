-- Phase 7.3: resumable (async) orchestration state (additive, non-destructive).
-- The control plane persists every orchestration run so /run can return
-- immediately (waiting_for_worker) and a resume endpoint continues after the
-- sandbox worker job finishes.

CREATE TABLE IF NOT EXISTS ai_orchestration_runs (
  id                     TEXT PRIMARY KEY,
  session_id             TEXT NOT NULL REFERENCES ai_sessions(id) ON DELETE CASCADE,
  user_id                TEXT,
  status                 TEXT NOT NULL DEFAULT 'queued'
                           CHECK (status IN ('queued','running','waiting_for_worker','needs_revision','passed','failed','cancelled')),
  current_round          INTEGER NOT NULL DEFAULT 1,
  max_rounds             INTEGER NOT NULL DEFAULT 3,
  current_step           TEXT,
  pending_worker_job_id  TEXT REFERENCES ai_worker_jobs(id) ON DELETE SET NULL,
  last_error             TEXT,
  state                  TEXT NOT NULL DEFAULT '{}',   -- JSON (redacted)
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  finished_at            TEXT
);

CREATE INDEX IF NOT EXISTS idx_ai_orch_runs_session    ON ai_orchestration_runs(session_id);
CREATE INDEX IF NOT EXISTS idx_ai_orch_runs_status     ON ai_orchestration_runs(status);
CREATE INDEX IF NOT EXISTS idx_ai_orch_runs_pending    ON ai_orchestration_runs(pending_worker_job_id);
CREATE INDEX IF NOT EXISTS idx_ai_orch_runs_created_at ON ai_orchestration_runs(created_at);

CREATE TABLE IF NOT EXISTS ai_orchestration_events (
  id                    TEXT PRIMARY KEY,
  orchestration_run_id  TEXT NOT NULL REFERENCES ai_orchestration_runs(id) ON DELETE CASCADE,
  session_id            TEXT NOT NULL,
  event_type            TEXT NOT NULL,
  metadata              TEXT NOT NULL DEFAULT '{}',    -- JSON (redacted)
  created_at            TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_orch_events_run     ON ai_orchestration_events(orchestration_run_id);
CREATE INDEX IF NOT EXISTS idx_ai_orch_events_session ON ai_orchestration_events(session_id);
CREATE INDEX IF NOT EXISTS idx_ai_orch_events_type    ON ai_orchestration_events(event_type);
