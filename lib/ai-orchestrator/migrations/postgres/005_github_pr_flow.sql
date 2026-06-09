-- =============================================================================
-- AI Orchestrator — Phase 6 GitHub PR flow (Postgres / Supabase).
-- Additive + manual: run in the Supabase SQL editor or via `supabase db push`.
-- The app NEVER auto-applies this to production. Nothing destructive here.
-- =============================================================================

create extension if not exists "pgcrypto";

create table if not exists public.ai_patch_sets (
  id                uuid primary key default gen_random_uuid(),
  session_id        uuid not null references public.ai_sessions (id) on delete cascade,
  user_id           uuid,
  status            text not null default 'draft'
                      check (status in ('draft','validated','applied','failed','superseded')),
  base_branch       text not null,
  target_branch     text not null,
  base_sha          text,
  patch_summary     text,
  patch_text        text,
  validation_errors jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists idx_ai_patch_sets_session on public.ai_patch_sets (session_id);
create index if not exists idx_ai_patch_sets_user    on public.ai_patch_sets (user_id);
create index if not exists idx_ai_patch_sets_status  on public.ai_patch_sets (status);

create table if not exists public.ai_patch_files (
  id                uuid primary key default gen_random_uuid(),
  patch_set_id      uuid not null references public.ai_patch_sets (id) on delete cascade,
  file_path         text not null,
  change_type       text not null
                      check (change_type in ('create','modify','delete','rename')),
  old_content_hash  text,
  new_content_hash  text,
  patch_hunk        text,
  reason            text,
  created_at        timestamptz not null default now()
);

create index if not exists idx_ai_patch_files_patch_set on public.ai_patch_files (patch_set_id);

create table if not exists public.ai_pull_requests (
  id                uuid primary key default gen_random_uuid(),
  session_id        uuid not null references public.ai_sessions (id) on delete cascade,
  patch_set_id      uuid not null references public.ai_patch_sets (id) on delete cascade,
  user_id           uuid,
  github_pr_number  bigint,
  github_pr_url     text,
  branch_name       text not null,
  base_branch       text not null,
  status            text not null default 'dry_run'
                      check (status in ('dry_run','created','closed','merged','failed')),
  error_message     text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists idx_ai_pull_requests_session   on public.ai_pull_requests (session_id);
create index if not exists idx_ai_pull_requests_patch_set on public.ai_pull_requests (patch_set_id);
create index if not exists idx_ai_pull_requests_pr_number on public.ai_pull_requests (github_pr_number);
create index if not exists idx_ai_pull_requests_status    on public.ai_pull_requests (status);
