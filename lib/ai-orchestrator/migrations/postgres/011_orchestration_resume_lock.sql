-- =============================================================================
-- AI Orchestrator — Phase 7.4 scheduled/cron resume lock.
-- Additive + manual (Postgres / Supabase). Nothing destructive.
-- A lightweight lock on ai_orchestration_runs stops two cron ticks from
-- resuming the same orchestration concurrently.
-- =============================================================================

alter table public.ai_orchestration_runs
  add column if not exists resume_lock_owner      text;
alter table public.ai_orchestration_runs
  add column if not exists resume_lock_expires_at  timestamptz;
alter table public.ai_orchestration_runs
  add column if not exists resume_attempts         integer not null default 0;
alter table public.ai_orchestration_runs
  add column if not exists last_resume_attempt_at  timestamptz;

create index if not exists idx_ai_orch_runs_resume_lock
  on public.ai_orchestration_runs (resume_lock_expires_at);
create index if not exists idx_ai_orch_runs_status_pending
  on public.ai_orchestration_runs (status, pending_worker_job_id);
