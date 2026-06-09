-- =============================================================================
-- AI Orchestrator — Postgres / Supabase multi-user + RBAC (additive, manual).
-- RLS left disabled here (service-role access); see 004_rls_policies.sql.
-- =============================================================================

create extension if not exists "pgcrypto";

create table if not exists public.ai_users (
  id           uuid primary key default gen_random_uuid(),
  email        text,
  display_name text,
  role         text not null default 'viewer'
                 check (role in ('owner','admin','developer','reviewer','viewer')),
  status       text not null default 'active' check (status in ('active','disabled')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  last_seen_at timestamptz
);

create unique index if not exists idx_ai_users_email on public.ai_users (email);
create index if not exists idx_ai_users_role   on public.ai_users (role);
create index if not exists idx_ai_users_status on public.ai_users (status);

create table if not exists public.ai_api_keys (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.ai_users (id) on delete cascade,
  key_prefix   text not null,
  key_hash     text not null,
  name         text,
  status       text not null default 'active' check (status in ('active','revoked')),
  last_used_at timestamptz,
  expires_at   timestamptz,
  created_at   timestamptz not null default now(),
  revoked_at   timestamptz
);

create index if not exists idx_ai_api_keys_user   on public.ai_api_keys (user_id);
create unique index if not exists idx_ai_api_keys_hash on public.ai_api_keys (key_hash);
create index if not exists idx_ai_api_keys_prefix on public.ai_api_keys (key_prefix);
create index if not exists idx_ai_api_keys_status on public.ai_api_keys (status);

create table if not exists public.ai_session_collaborators (
  id         uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.ai_sessions (id) on delete cascade,
  user_id    uuid not null references public.ai_users (id) on delete cascade,
  permission text not null default 'viewer'
               check (permission in ('owner','editor','reviewer','viewer')),
  created_at timestamptz not null default now()
);

create index if not exists idx_ai_collab_session on public.ai_session_collaborators (session_id);
create index if not exists idx_ai_collab_user    on public.ai_session_collaborators (user_id);

create table if not exists public.ai_user_permissions_override (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.ai_users (id) on delete cascade,
  permission text not null,
  effect     text not null default 'allow' check (effect in ('allow','deny')),
  created_at timestamptz not null default now()
);

create index if not exists idx_ai_perm_override_user on public.ai_user_permissions_override (user_id);

-- Link foreign keys for previously-nullable columns (optional; safe if users exist).
-- ai_sessions.user_id and ai_runs.user_id remain plain uuid (nullable) for
-- backward compatibility; add FKs manually once all rows are backfilled.
