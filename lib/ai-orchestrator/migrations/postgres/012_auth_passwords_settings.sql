-- =============================================================================
-- AI Orchestrator — Phase 10 web login passwords + encrypted settings.
-- Additive + manual (Postgres / Supabase). Nothing destructive.
-- =============================================================================

alter table public.ai_users
  add column if not exists password_hash text;

create table if not exists public.ai_settings (
  key        text primary key,
  value      text not null,   -- encrypted (AES-256-GCM) for secret values
  updated_at timestamptz not null default now()
);
