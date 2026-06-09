-- =============================================================================
-- AI Orchestrator — Phase 7.1.3 worker lease renewal (Postgres / Supabase).
-- Additive + manual. A running worker renews its lease via heartbeat so a
-- long job (npm ci + typecheck + test + build can exceed 5 min) is not
-- re-claimed by another worker. Nothing destructive (function only).
-- =============================================================================

create or replace function public.renew_ai_worker_job_lease(
  p_job_id uuid,
  p_worker_id text,
  p_lease_seconds integer default 300
)
returns setof public.ai_worker_jobs
language plpgsql
as $$
begin
  -- Only the OWNER of a still-running job may renew. The UPDATE ... RETURNING is
  -- a single atomic statement; a non-match (cancelled / finished / owner change)
  -- returns no rows -> the worker learns it lost the lease and must stop.
  return query
  update public.ai_worker_jobs
     set lease_expires_at = now() + make_interval(secs => p_lease_seconds),
         updated_at = now()
   where id = p_job_id
     and status = 'running'
     and lease_owner = p_worker_id
  returning *;
end;
$$;

revoke all on function public.renew_ai_worker_job_lease(uuid, text, integer) from public;
grant execute on function public.renew_ai_worker_job_lease(uuid, text, integer) to service_role;
