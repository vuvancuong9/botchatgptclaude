-- =============================================================================
-- AI Orchestrator — Postgres / Supabase audit log (additive, run manually).
-- Stores hashes only — never raw IP, raw admin key, or secrets.
-- RLS left disabled (service-role server-side access); see README.
-- =============================================================================

create table if not exists public.ai_audit_logs (
  id                    uuid primary key default gen_random_uuid(),
  event_type            text not null,
  session_id            uuid,
  admin_key_fingerprint text,
  user_id               uuid,
  ip_hash               text,
  user_agent_hash       text,
  status                text not null default 'ok',
  metadata              jsonb not null default '{}'::jsonb,
  created_at            timestamptz not null default now()
);

create index if not exists idx_ai_audit_created_at  on public.ai_audit_logs (created_at);
create index if not exists idx_ai_audit_event_type  on public.ai_audit_logs (event_type);
create index if not exists idx_ai_audit_session     on public.ai_audit_logs (session_id);
create index if not exists idx_ai_audit_fingerprint on public.ai_audit_logs (admin_key_fingerprint);
create index if not exists idx_ai_audit_status      on public.ai_audit_logs (status);
