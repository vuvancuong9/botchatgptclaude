-- =============================================================================
-- AI Orchestrator — OPTIONAL Row Level Security policies (HUMAN-APPLIED).
--
-- ⚠️ DO NOT auto-apply. The app accesses Postgres with the SERVICE ROLE key,
-- which BYPASSES RLS — so these policies do NOT protect the current server-side
-- access path. They only matter if/when you expose the tables to client-side
-- Supabase Auth (anon/authenticated roles) in the future.
--
-- Apply manually in the Supabase SQL editor only when you adopt Supabase Auth.
-- The policies below assume auth.uid() maps to ai_users.id.
-- =============================================================================

-- Enable RLS (no effect on service-role connections).
alter table public.ai_sessions               enable row level security;
alter table public.ai_messages                enable row level security;
alter table public.ai_artifacts               enable row level security;
alter table public.ai_runs                    enable row level security;
alter table public.ai_session_collaborators   enable row level security;
alter table public.ai_audit_logs              enable row level security;

-- Helper: owner/admin see everything.
create or replace function public.ai_is_owner_or_admin() returns boolean
language sql stable as $$
  select exists (
    select 1 from public.ai_users u
    where u.id = auth.uid() and u.role in ('owner','admin')
  );
$$;

-- A user can read a session they own, collaborate on, or if owner/admin.
drop policy if exists ai_sessions_select on public.ai_sessions;
create policy ai_sessions_select on public.ai_sessions
  for select using (
    public.ai_is_owner_or_admin()
    or user_id = auth.uid()
    or exists (
      select 1 from public.ai_session_collaborators c
      where c.session_id = ai_sessions.id and c.user_id = auth.uid()
    )
  );

-- Messages/artifacts/runs follow their parent session's visibility.
drop policy if exists ai_messages_select on public.ai_messages;
create policy ai_messages_select on public.ai_messages
  for select using (
    public.ai_is_owner_or_admin()
    or exists (
      select 1 from public.ai_sessions s
      where s.id = ai_messages.session_id
        and (s.user_id = auth.uid()
             or exists (select 1 from public.ai_session_collaborators c
                        where c.session_id = s.id and c.user_id = auth.uid()))
    )
  );

drop policy if exists ai_artifacts_select on public.ai_artifacts;
create policy ai_artifacts_select on public.ai_artifacts
  for select using (
    public.ai_is_owner_or_admin()
    or exists (
      select 1 from public.ai_sessions s
      where s.id = ai_artifacts.session_id
        and (s.user_id = auth.uid()
             or exists (select 1 from public.ai_session_collaborators c
                        where c.session_id = s.id and c.user_id = auth.uid()))
    )
  );

drop policy if exists ai_runs_select on public.ai_runs;
create policy ai_runs_select on public.ai_runs
  for select using (
    public.ai_is_owner_or_admin()
    or exists (
      select 1 from public.ai_sessions s
      where s.id = ai_runs.session_id and s.user_id = auth.uid()
    )
  );

-- Audit logs: owner/admin only.
drop policy if exists ai_audit_select on public.ai_audit_logs;
create policy ai_audit_select on public.ai_audit_logs
  for select using (public.ai_is_owner_or_admin());
