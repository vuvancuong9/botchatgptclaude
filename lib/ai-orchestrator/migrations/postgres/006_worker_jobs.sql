-- =============================================================================
-- AI Orchestrator — Phase 7 sandbox worker jobs (Postgres / Supabase).
-- Additive + manual: run in the Supabase SQL editor or via `supabase db push`.
-- Nothing destructive here.
-- =============================================================================

create extension if not exists "pgcrypto";

create table if not exists public.ai_worker_jobs (
  id                uuid primary key default gen_random_uuid(),
  session_id        uuid references public.ai_sessions (id) on delete cascade,
  patch_set_id      uuid references public.ai_patch_sets (id) on delete cascade,
  pull_request_id   uuid references public.ai_pull_requests (id) on delete set null,
  user_id           uuid,
  job_type          text not null
                      check (job_type in ('test_patch','test_branch','build','lint')),
  status            text not null default 'queued'
                      check (status in ('queued','running','passed','failed','cancelled','timed_out')),
  priority          integer not null default 5,
  payload           jsonb not null,
  result            jsonb,
  error_message     text,
  lease_owner       text,
  lease_expires_at  timestamptz,
  attempts          integer not null default 0,
  max_attempts      integer not null default 2,
  created_at        timestamptz not null default now(),
  started_at        timestamptz,
  finished_at       timestamptz,
  updated_at        timestamptz not null default now()
);

create index if not exists idx_ai_worker_jobs_status     on public.ai_worker_jobs (status);
create index if not exists idx_ai_worker_jobs_created_at on public.ai_worker_jobs (created_at);
create index if not exists idx_ai_worker_jobs_lease      on public.ai_worker_jobs (lease_expires_at);
create index if not exists idx_ai_worker_jobs_session    on public.ai_worker_jobs (session_id);
create index if not exists idx_ai_worker_jobs_patch_set  on public.ai_worker_jobs (patch_set_id);
create index if not exists idx_ai_worker_jobs_user       on public.ai_worker_jobs (user_id);

create table if not exists public.ai_worker_job_logs (
  id          uuid primary key default gen_random_uuid(),
  job_id      uuid not null references public.ai_worker_jobs (id) on delete cascade,
  stream      text not null check (stream in ('stdout','stderr','system')),
  content     text not null,
  created_at  timestamptz not null default now()
);

create index if not exists idx_ai_worker_job_logs_job on public.ai_worker_job_logs (job_id);
