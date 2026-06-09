# Production Dry-run Go-live Runbook (Phase 9)

A safe, **dry-run** verification of a real production deployment. It exercises
the full path — migrations → env → owner → smoke → readiness → worker → cron →
a real orchestration → the PR flow **in dry-run** — **without ever** creating a
live PR, merging, pushing `main`, deploying, or auto-applying a migration.

> ⚠️ This runbook is a checklist for a human operator. The app never performs
> any of these steps automatically. The helper script `npm run prod:dry-run`
> and the endpoint `GET /api/ai-orchestrator/production-dry-run` are **read-only**.

---

## 1. Prerequisites

- **Supabase** project provisioned (Postgres + service-role key).
- **Vercel** project connected to the repo (control plane).
- **Upstash Redis** database (REST URL + token) for multi-instance rate limiting.
- **GitHub** repo the orchestrator will open PRs against (a least-privilege token).
- **OpenAI** + **Anthropic** API keys (the control plane needs both — GPT spec +
  Claude review).
- A **worker host** to run `npm run ai:worker` — prefer Linux/Docker (the
  process-group kill on cancel + sandbox isolation assume POSIX).

## 2. Apply Postgres migrations (manual)

Run **in order** in the Supabase SQL editor (or `supabase db push`). Nothing is
auto-applied in production.

```
001_init.sql
002_ai_audit_logs.sql
003_users_rbac.sql
004_rls_policies.sql          # optional — only with client-side Supabase Auth
005_github_pr_flow.sql
006_worker_jobs.sql
007_patch_file_content.sql
008_atomic_worker_claim.sql   # required before scaling workers > 1
009_worker_lease_renewal.sql  # required for long jobs + multiple workers
010_orchestration_state.sql
011_orchestration_resume_lock.sql
```

The Phase 8 readiness gate verifies every table + the migration columns
(`ai_patch_files.new_content_redacted`, `ai_orchestration_runs.resume_lock_owner`).

## 3. Required Vercel env (server-side only — never `NEXT_PUBLIC_*`)

| Group | Variables |
| --- | --- |
| **Supabase** | `AI_ORCHESTRATOR_DB_PROVIDER=postgres`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` |
| **Model** | `OPENAI_API_KEY`, `OPENAI_MODEL`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` |
| **Upstash** | `AI_ORCHESTRATOR_RATE_LIMIT_PROVIDER=upstash`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` |
| **Auth / RBAC** | `AI_ORCHESTRATOR_API_KEY_PEPPER`, `AI_ORCHESTRATOR_ALLOW_LEGACY_ADMIN_KEY=0` |
| **GitHub** | `GITHUB_TOKEN`, `GITHUB_OWNER`, `GITHUB_REPO`, `GITHUB_DEFAULT_BRANCH` |
| **Worker** | `AI_ORCHESTRATOR_WORKER_PROVIDER=database`, `AI_ORCHESTRATOR_REPO_CLONE_URL`, `AI_ORCHESTRATOR_WORKER_LEASE_SECONDS`, `AI_ORCHESTRATOR_WORKER_HEARTBEAT_INTERVAL_MS` |
| **Cron** | `AI_ORCHESTRATOR_CRON_KEY`, `CRON_SECRET` (= `AI_ORCHESTRATOR_CRON_KEY` for Vercel Cron) |
| **Test runner** | `AI_ORCHESTRATOR_TEST_RUNNER_MODE=worker_async` |
| **PR dry-run** | `AI_ORCHESTRATOR_ENABLE_GITHUB_PR=1`, `AI_ORCHESTRATOR_PR_DRY_RUN=1` |

## 4. Safe default env (MUST hold for the dry-run)

```
AI_ORCHESTRATOR_TEST_RUNNER_MODE=worker_async
AI_ORCHESTRATOR_WORKER_PROVIDER=database
AI_ORCHESTRATOR_ALLOW_INLINE_COMMANDS=0
AI_ORCHESTRATOR_PR_DRY_RUN=1
AI_ORCHESTRATOR_ENABLE_GITHUB_PR=1
AI_ORCHESTRATOR_REQUIRE_SMOKE_PASS=1
AI_ORCHESTRATOR_RATE_LIMIT_PROVIDER=upstash
AI_ORCHESTRATOR_ALLOW_LEGACY_ADMIN_KEY=0
AI_ORCHESTRATOR_ALLOW_CRON_QUERY_KEY=0
```

`npm run prod:dry-run` treats `PR_DRY_RUN=0`, a non-`worker_async` mode,
`ALLOW_INLINE_COMMANDS=1`, or a non-`database` worker provider as **blockers**.

## 5. Bootstrap the owner

```
npm run ai:create-owner      # creates an active owner + mints one API key
```

Store the printed API key in your password manager. Disable the legacy admin key
(`AI_ORCHESTRATOR_ALLOW_LEGACY_ADMIN_KEY` unset/0).

## 6. Run the smoke tests, then record the flags

```
npm run smoke:supabase        # add AI_ORCHESTRATOR_SMOKE_CLEANUP=1 to clean up
npm run smoke:worker-claim     # 5 concurrent claims; exactly 1 wins
npm run smoke:worker-lease     # owner renews; non-owner + cancelled rejected
```

After all three pass, set:

```
AI_ORCHESTRATOR_SUPABASE_SMOKE_PASSED_AT=<ISO_DATE>   # e.g. 2026-06-06T10:00:00Z
AI_ORCHESTRATOR_WORKER_CLAIM_VERIFIED=1
AI_ORCHESTRATOR_WORKER_LEASE_VERIFIED=1
```

## 7. Run the readiness gate

```
npm run readiness                      # exit 1 on any failure
npm run readiness -- --strict-warnings # exit 1 on warnings too
```

Resolve every **fail** (critical/high). Decide on each **warn** (fix or accept
with a reason). The endpoint `GET /api/ai-orchestrator/readiness` returns **503**
until all critical/high checks pass.

## 8. Start the worker

```
npm run ai:worker
```

or Docker:

```
docker build -f Dockerfile.ai-worker -t ai-orchestrator-worker .
docker run --env-file .env.worker ai-orchestrator-worker
```

> The worker runs allowlisted commands only (`spawn`, no shell). It does **not**
> need model keys. Keep `AI_ORCHESTRATOR_TEST_JOB_TIMEOUT_MS` under your Vercel
> function timeout for the control plane.

## 9. Verify cron resume

```
curl -s -X POST https://<app>/api/ai-orchestrator/cron/resume \
  -H "Authorization: Bearer $CRON_SECRET"
```

- Expect a JSON summary (`scanned/resumed/still_waiting/skipped/failed`).
- Confirm the response **never** echoes the key.
- Confirm readiness no longer warns about cron (`cron_resume_warning: null`).

## 10. Dry-run orchestration

1. `POST /api/ai-orchestrator/run` with header `x-ai-api-key: <key>` and body
   `{ "request": "..." }`.
2. Expect **202** with an `orchestration_run_id` (+ `worker_job_id`).
3. The worker claims and runs the sandbox test job.
4. The cron (or a manual `POST /orchestrations/[id]/resume`) completes it.
5. The session reaches a clear terminal status: **passed** or **needs_revision**.

> `npm run prod:dry-run -- --create-test-session` automates steps 1–5, but ONLY
> when `AI_ORCHESTRATOR_PROD_DRY_RUN_ALLOW_MODEL_CALLS=1` (it calls the models).
> It never creates a live PR.

## 11. Dry-run PR flow

1. **Validate Patch** (`POST /sessions/[id]/patch/validate`).
2. **Run Patch Tests in sandbox** (`POST /sessions/[id]/test-job`) — wait for a
   passing `test_patch` job with `patch_applied=true` + `base_hash_checked=true`.
3. **Create PR** (`POST /sessions/[id]/pull-request`) with
   `AI_ORCHESTRATOR_PR_DRY_RUN=1`.
4. Confirm **no real branch / PR** was created on GitHub.
5. Confirm the audit log contains **`ai_pr_dry_run_completed`**.

## 12. Go / No-go criteria

**GO** when all hold:

- readiness has **no failures**;
- `--strict-warnings` passes, or each warning is accepted with a reason;
- all three smoke tests passed (flags recorded);
- the dry-run orchestration reached a terminal status via the worker;
- cron resume returned a summary and leaked nothing;
- the dry-run PR completed with `ai_pr_dry_run_completed` and **no** live PR;
- **no secret appears in any log**.

**NO-GO** when any holds:

- readiness fails any **critical/high** check;
- a model key is missing;
- the Supabase smoke flag is not recorded;
- worker claim/lease are not verified;
- cron resume does not run;
- the dry-run PR flow does not complete;
- live PR mode is on (`AI_ORCHESTRATOR_PR_DRY_RUN=0`).

---

### One-shot read-only check

```
npm run prod:dry-run            # human report; exit 1 if not safe
npm run prod:dry-run -- --json  # machine-readable; for CI / a pre-deploy gate
```

This never deploys, applies a migration, edits env, calls a model (without the
explicit flag), creates a live PR, or logs a secret.
