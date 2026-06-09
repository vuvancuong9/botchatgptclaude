-- Phase 7: sandbox worker jobs (additive, non-destructive).
-- The execution plane (a separate worker) claims jobs with a lease, runs
-- allowlisted commands in an isolated workspace, and writes redacted logs back.

CREATE TABLE IF NOT EXISTS ai_worker_jobs (
  id                TEXT PRIMARY KEY,
  session_id        TEXT REFERENCES ai_sessions(id) ON DELETE CASCADE,
  patch_set_id      TEXT REFERENCES ai_patch_sets(id) ON DELETE CASCADE,
  pull_request_id   TEXT REFERENCES ai_pull_requests(id) ON DELETE SET NULL,
  user_id           TEXT,
  job_type          TEXT NOT NULL
                      CHECK (job_type IN ('test_patch','test_branch','build','lint')),
  status            TEXT NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('queued','running','passed','failed','cancelled','timed_out')),
  priority          INTEGER NOT NULL DEFAULT 5,
  payload           TEXT NOT NULL,            -- JSON
  result            TEXT,                     -- JSON (nullable)
  error_message     TEXT,
  lease_owner       TEXT,
  lease_expires_at  TEXT,
  attempts          INTEGER NOT NULL DEFAULT 0,
  max_attempts      INTEGER NOT NULL DEFAULT 2,
  created_at        TEXT NOT NULL,
  started_at        TEXT,
  finished_at       TEXT,
  updated_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_worker_jobs_status     ON ai_worker_jobs(status);
CREATE INDEX IF NOT EXISTS idx_ai_worker_jobs_created_at ON ai_worker_jobs(created_at);
CREATE INDEX IF NOT EXISTS idx_ai_worker_jobs_lease      ON ai_worker_jobs(lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_ai_worker_jobs_session    ON ai_worker_jobs(session_id);
CREATE INDEX IF NOT EXISTS idx_ai_worker_jobs_patch_set  ON ai_worker_jobs(patch_set_id);
CREATE INDEX IF NOT EXISTS idx_ai_worker_jobs_user       ON ai_worker_jobs(user_id);

CREATE TABLE IF NOT EXISTS ai_worker_job_logs (
  id          TEXT PRIMARY KEY,
  job_id      TEXT NOT NULL REFERENCES ai_worker_jobs(id) ON DELETE CASCADE,
  stream      TEXT NOT NULL CHECK (stream IN ('stdout','stderr','system')),
  content     TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_worker_job_logs_job ON ai_worker_job_logs(job_id);
