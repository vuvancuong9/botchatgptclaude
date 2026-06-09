-- =============================================================================
-- AI Orchestrator — Phase 7.1.2 atomic worker-job claim (Postgres / Supabase).
-- Additive + manual. Provides an atomic claim so multiple workers never claim
-- the same job. Nothing destructive here (CREATE OR REPLACE FUNCTION only).
--
-- Convention: priority ASC = higher priority (lower number first), then
-- created_at ASC (FIFO). Mirrors the SQLite/in-memory queue exactly.
-- =============================================================================

create or replace function public.claim_ai_worker_job(
  p_worker_id text,
  p_lease_seconds integer default 300
)
returns setof public.ai_worker_jobs
language plpgsql
as $$
declare
  v_id uuid;
begin
  -- 1) Fail any claimable job that has exhausted its attempts (consistent with
  --    the SQLite/in-memory queue: such a job is never claimed again).
  update public.ai_worker_jobs
     set status = 'failed',
         error_message = 'max attempts exceeded',
         finished_at = now(),
         updated_at = now()
   where (
           status = 'queued'
           or (status = 'running'
               and (lease_expires_at is null or lease_expires_at < now()))
         )
     and attempts >= max_attempts;

  -- 2) Atomically lock the next eligible job. FOR UPDATE SKIP LOCKED guarantees
  --    two concurrent callers grab different rows (or one gets nothing) — no
  --    two workers ever claim the same job.
  select id
    into v_id
    from public.ai_worker_jobs
   where (
           status = 'queued'
           or (status = 'running'
               and (lease_expires_at is null or lease_expires_at < now()))
         )
     and attempts < max_attempts
   order by priority asc, created_at asc
   for update skip locked
   limit 1;

  if v_id is null then
    return; -- nothing claimable
  end if;

  -- 3) Claim it (still inside the row lock held by this transaction).
  update public.ai_worker_jobs
     set status = 'running',
         lease_owner = p_worker_id,
         lease_expires_at = now() + make_interval(secs => p_lease_seconds),
         attempts = attempts + 1,
         started_at = coalesce(started_at, now()),
         updated_at = now()
   where id = v_id;

  return query select * from public.ai_worker_jobs where id = v_id;
end;
$$;

-- Allow the service role (server-side only) to call it. The anon/public roles
-- must NOT be able to claim jobs.
revoke all on function public.claim_ai_worker_job(text, integer) from public;
grant execute on function public.claim_ai_worker_job(text, integer) to service_role;
