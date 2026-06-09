-- =============================================================================
-- AI Orchestrator — Phase 7.3 async (resumable) orchestration state.
-- Additive + manual (Postgres / Supabase). Nothing destructive.
-- =============================================================================

create extension if not exists "pgcrypto";

create table if not exists public.ai_orchestration_runs (
  id                     uuid primary key default gen_random_uuid(),
  session_id             uuid not null references public.ai_sessions (id) on delete cascade,
  user_id                uuid,
  status                 text not null default 'queued'
                           check (status in ('queued','running','waiting_for_worker','needs_revision','passed','failed','cancelled')),
  current_round          integer not null default 1,
  max_rounds             integer not null default 3,
  current_step           text,
  pending_worker_job_id  uuid references public.ai_worker_jobs (id) on delete set null,
  last_error             text,
  state                  jsonb not null default '{}'::jsonb,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  finished_at            timestamptz
);

create index if not exists idx_ai_orch_runs_session    on public.ai_orchestration_runs (session_id);
create index if not exists idx_ai_orch_runs_status     on public.ai_orchestration_runs (status);
create index if not exists idx_ai_orch_runs_pending    on public.ai_orchestration_runs (pending_worker_job_id);
create index if not exists idx_ai_orch_runs_created_at on public.ai_orchestration_runs (created_at);

create table if not exists public.ai_orchestration_events (
  id                    uuid primary key default gen_random_uuid(),
  orchestration_run_id  uuid not null references public.ai_orchestration_runs (id) on delete cascade,
  session_id            uuid not null,
  event_type            text not null,
  metadata              jsonb not null default '{}'::jsonb,
  created_at            timestamptz not null default now()
);

create index if not exists idx_ai_orch_events_run     on public.ai_orchestration_events (orchestration_run_id);
create index if not exists idx_ai_orch_events_session on public.ai_orchestration_events (session_id);
create index if not exists idx_ai_orch_events_type    on public.ai_orchestration_events (event_type);
