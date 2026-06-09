-- =============================================================================
-- AI Orchestrator — Postgres / Supabase schema (production backend).
--
-- Apply via the Supabase SQL editor or `supabase db push` (NOT auto-applied by
-- the app). Additive only — no destructive statements. Business fields are kept
-- compatible with the local SQLite schema in ../001..004_*.sql.
--
-- RLS: intentionally LEFT DISABLED because the app accesses these tables with
-- the SERVICE ROLE key server-side only (the service role bypasses RLS anyway).
-- The service role key must NEVER reach the browser. Enable RLS + policies when
-- moving to per-user client access (see README "Production deployment").
-- =============================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- ai_sessions
-- ---------------------------------------------------------------------------
create table if not exists public.ai_sessions (
  id                    uuid primary key default gen_random_uuid(),
  user_request          text not null,
  status                text not null default 'running'
                          check (status in ('running','passed','needs_revision','failed','rejected')),
  approval              text not null default 'pending'
                          check (approval in ('pending','approved','rejected')),
  rounds                integer not null default 0,
  -- Nullable, reserved for multi-user (Phase 4).
  user_id               uuid,
  admin_key_fingerprint text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists idx_ai_sessions_created_at on public.ai_sessions (created_at);
create index if not exists idx_ai_sessions_status     on public.ai_sessions (status);

-- ---------------------------------------------------------------------------
-- ai_messages
-- ---------------------------------------------------------------------------
create table if not exists public.ai_messages (
  id         uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.ai_sessions (id) on delete cascade,
  step       text not null,
  provider   text not null check (provider in ('openai','anthropic','system')),
  round      integer not null default 0,
  status     text not null,
  output     jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_ai_messages_session on public.ai_messages (session_id);

-- ---------------------------------------------------------------------------
-- ai_artifacts
-- ---------------------------------------------------------------------------
create table if not exists public.ai_artifacts (
  id         uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.ai_sessions (id) on delete cascade,
  message_id uuid not null references public.ai_messages (id) on delete cascade,
  type       text not null check (type in ('spec','plan','patch','test_report','review')),
  content    text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_ai_artifacts_session on public.ai_artifacts (session_id);
create index if not exists idx_ai_artifacts_type    on public.ai_artifacts (type);

-- ---------------------------------------------------------------------------
-- ai_runs  (command-execution audit log; stdout/stderr are redacted by the app)
-- ---------------------------------------------------------------------------
create table if not exists public.ai_runs (
  id                    uuid primary key default gen_random_uuid(),
  session_id            uuid not null references public.ai_sessions (id) on delete cascade,
  command               text not null,
  allowed               boolean not null default false,
  exit_code             integer,
  stdout                text not null default '',
  stderr                text not null default '',
  step_name             text,
  status                text not null default 'skipped'
                          check (status in ('passed','failed','blocked','skipped')),
  admin_key_fingerprint text,
  user_id               uuid,
  created_at            timestamptz not null default now()
);

create index if not exists idx_ai_runs_session   on public.ai_runs (session_id);
create index if not exists idx_ai_runs_step_name on public.ai_runs (step_name);
create index if not exists idx_ai_runs_status    on public.ai_runs (status);
create index if not exists idx_ai_runs_user_id   on public.ai_runs (user_id);
