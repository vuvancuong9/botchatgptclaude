# AI Orchestrator

A **controlled** pipeline that makes ChatGPT (GPT) and Claude collaborate to
build software. There is **no infinite chat** — a deterministic orchestrator
drives a fixed workflow with a hard cap of **3 revision rounds**, every agent
output is validated against a strict JSON contract, and a safety guard blocks
dangerous operations.

## Workflow

```
GPT_PRODUCT_SPEC        (OpenAI)     -> spec
CLAUDE_CRITICAL_REVIEW  (Anthropic)  -> critique / edge cases
GPT_IMPLEMENTATION_PLAN (OpenAI)     -> plan
┌───────────── up to 3 rounds ─────────────┐
│ CLAUDE_CODE_IMPLEMENTER (Anthropic) -> patch (safety-scanned)
│ TEST_RUNNER            (system)     -> typecheck / test / build (allowlist)
│ GPT_CODE_REVIEWER      (OpenAI)     -> review
│ QA_JUDGE               (OpenAI)     -> pass | needs_revision | fail
└──────────────────────────────────────────┘
```

`QA_JUDGE` is fail-safe: it can never return `pass` while tests are red.

## Agent output contract

Every agent must return exactly:

```json
{
  "status": "pass" | "needs_revision" | "fail",
  "summary": "string",
  "issues": ["string"],
  "next_action": "string",
  "artifacts": [{ "type": "spec|plan|patch|test_report|review", "content": "string" }]
}
```

Validated by `lib/ai-orchestrator/schema.ts` (zod). Invalid output is rejected.

## Adapters

- `lib/ai-orchestrator/adapters/openai.adapter.ts` — OpenAI Chat Completions.
- `lib/ai-orchestrator/adapters/anthropic.adapter.ts` — **native Anthropic
  Messages API** (`POST /v1/messages`, `x-api-key` + `anthropic-version`).
  The OpenAI compatibility layer is deliberately **not** used on the production
  path.

Both run in deterministic **mock mode** when no API key is set, so
typecheck / test / build all pass offline without secrets.

## Safety guard (`lib/ai-orchestrator/safety.ts`)

- ❌ Reading/printing env secrets (`.env`, API keys, tokens).
- ❌ `rm -rf` / recursive force deletes.
- ❌ Automated production deploys (`vercel deploy`, `kubectl apply`, …).
- ❌ Destructive migrations (`DROP`/`TRUNCATE`/`DELETE` without `WHERE`)
  unless a human has approved.
- ✅ Command allowlist for TEST_RUNNER: `npm run typecheck`, `npm test`,
  `npm run build`, `git diff` only (no chaining / injection).

## Persistence

SQLite via Node's built-in `node:sqlite` (no native build). Migrations in
`lib/ai-orchestrator/migrations/`:

- `001_ai_sessions.sql`
- `002_ai_messages.sql`
- `003_ai_artifacts.sql`
- `004_ai_runs.sql`

## API

- `POST /api/ai-orchestrator/run` — `{ request, humanApproved? }`
- `GET  /api/ai-orchestrator/sessions`
- `GET  /api/ai-orchestrator/sessions/[id]`
- `POST /api/ai-orchestrator/sessions/[id]` — `{ action: "approve" | "reject" }`

## UI

`/ai-orchestrator` — request box, per-step display (spec, critique, plan, diff,
test report, final review), session history, Approve / Reject buttons.

## Security (Phase 2)

- **Admin auth** — every `/api/ai-orchestrator/*` route requires
  `x-ai-admin-key: <AI_ORCHESTRATOR_ADMIN_KEY>`. Missing/wrong key → `401`
  before any model call, session creation, or DB write. If the env key is unset
  the API is closed by default (`401`). See
  `lib/ai-orchestrator/security/auth.ts` (`requireAiAdminAuth`).
- **Rate limit** — `POST /run` is limited to **10 requests / 10 minutes** per
  admin-key fingerprint (falling back to client IP). Over the limit → `429`
  with a `Retry-After` header, and no model is called. In-memory MVP store in
  `lib/ai-orchestrator/security/rate-limit.ts`, swappable for Redis/Upstash via
  the `RateLimitStore` interface.
- **Secret redaction** — command stdout/stderr is scrubbed both at capture
  (test-runner) and on persist (repository). Redacts the values of
  `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `AI_ORCHESTRATOR_ADMIN_KEY`,
  `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL`, plus any `sk-…` token. See
  `lib/ai-orchestrator/security/redact.ts`.
- **Command execution** — TEST_RUNNER stays dry-run unless
  `AI_ORCHESTRATOR_EXECUTE_TESTS=1`. When live it only runs the allowlist,
  rejects shell control chars (`; && || | \` $() > <`), and caps each command
  at **120s**.

The UI stores the admin key in **sessionStorage** (not localStorage) and sends
it as the `x-ai-admin-key` header; `401`/`429` responses are surfaced clearly.

## Database backends

The persistence backend is selected by `AI_ORCHESTRATOR_DB_PROVIDER`:

| Provider   | Backend                         | Use            |
| ---------- | ------------------------------- | -------------- |
| `sqlite`   | `node:sqlite` file (default)    | local dev / MVP |
| `postgres` | Supabase / Postgres (service role) | production  |

Both implement the same async `AiOrchestratorRepository` interface
(`lib/ai-orchestrator/db/repository.interface.ts`); the factory in
`lib/ai-orchestrator/db/factory.ts` picks one. Selecting `postgres` without the
required env **throws** — it never silently falls back to SQLite.

### Local dev

```bash
AI_ORCHESTRATOR_DB_PROVIDER=sqlite        # (or leave unset)
AI_ORCHESTRATOR_DB=./.data/ai-orchestrator.db
```

### Production (Vercel + Supabase)

```bash
AI_ORCHESTRATOR_DB_PROVIDER=postgres
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service-role-key>   # server-side ONLY
```

1. In Supabase, run `lib/ai-orchestrator/migrations/postgres/001_init.sql`
   (SQL editor or `supabase db push`). The app does **not** auto-apply
   migrations to production.
2. Set the env vars above in Vercel (server-side env, not `NEXT_PUBLIC_*`).

> ⚠️ **SQLite (`node:sqlite`) is NOT for production serverless.**
> On Vercel the filesystem is **ephemeral and per-instance** — the `.data/*.db`
> file is not durable, not shared across instances, and wiped on every cold
> start. Use `postgres` in production.

> 🔐 **Service role key is server-side only.** It bypasses Row Level Security
> and must **never** be exposed to the client or embedded in the UI. Never put
> any Supabase key in `NEXT_PUBLIC_*`. The Supabase client is created only in
> `lib/ai-orchestrator/db/supabase-server.ts`, used exclusively from Node route
> handlers.

> **RLS** is intentionally left disabled in `001_init.sql` because access is via
> the service role. Enable RLS + per-user policies when adding multi-user client
> access (Phase 4). The schema already ships nullable `user_id` /
> `admin_key_fingerprint` columns to prepare for that.

Also move the rate-limit store to Redis/Upstash for multi-instance correctness,
and add per-tenant scoping for real multi-user isolation.

## Rate limiting (memory vs Upstash)

Selected by `AI_ORCHESTRATOR_RATE_LIMIT_PROVIDER`:

| Provider  | Store                              | Use            |
| --------- | ---------------------------------- | -------------- |
| `memory`  | in-process (default)               | local dev only |
| `upstash` | Upstash Redis REST (sliding window) | production     |

Rule is fixed: **10 requests / 10 minutes** per admin-key fingerprint (falling
back to IP). Upstash requires `UPSTASH_REDIS_REST_URL` +
`UPSTASH_REDIS_REST_TOKEN` — missing env **throws** (no silent fallback to
memory). The Redis key uses only the fingerprint/IP — never a raw admin key.

> In-memory rate limiting is **local only** — on serverless it is per-instance
> and resets on cold start. Use Upstash in production.

## Audit log

Every security/operational event is written to `ai_audit_logs`
(`auth_failed`, `auth_passed`, `rate_limited`, `ai_run_started`,
`ai_run_completed`, `ai_run_failed`, `session_approved`, `session_rejected`).
Only **hashes** of IP / user-agent are stored — never raw IP, raw admin key, or
secrets; metadata strings are redacted. Audit failures **never** crash the main
request.

## Health endpoint

`GET /api/ai-orchestrator/health` (requires `x-ai-admin-key`) returns:
`db_provider`, `rate_limit_provider`, `db_status`, `rate_limit_status`,
`has_openai_key`, `has_anthropic_key`, `execute_tests_enabled`, `timestamp`. It
returns **500** when the DB is unreachable. No secret values are ever returned.
The UI has a **Check Health** button.

## Multi-user + RBAC (Phase 5)

Auth is now **per-user API keys** (`x-ai-api-key: aiorch_…`). Raw keys are never
stored — only a `key_prefix` (lookup) + `key_hash` (SHA-256, or HMAC-SHA256 when
`AI_ORCHESTRATOR_API_KEY_PEPPER` is set). Keys are shown **once** at creation.

### Bootstrap the first owner

```bash
AI_OWNER_EMAIL=you@example.com AI_OWNER_NAME="You" npm run ai:create-owner
# prints the owner API key ONCE — store it securely
```

Then send it as a header on every request: `x-ai-api-key: aiorch_…`.

### Roles & permissions matrix

| Permission \ Role      | owner | admin | developer | reviewer | viewer |
| ---------------------- | :---: | :---: | :-------: | :------: | :----: |
| ai:run                 |  ✅   |  ✅   |    ✅     |    –     |   –    |
| ai:session:create      |  ✅   |  ✅   |    ✅     |    –     |   –    |
| ai:session:read (own)  |  ✅   |  ✅   |    ✅     |    ✅    |   ✅   |
| ai:session:read_all    |  ✅   |  ✅   |     –     |    –     |   –    |
| ai:session:approve     |  ✅   |  ✅   |     –     |    –†    |   –    |
| ai:session:reject      |  ✅   |  ✅   |     –     |    –†    |   –    |
| ai:artifact:create     |  ✅   |  ✅   |    ✅     |    –     |   –    |
| ai:audit:read          |  ✅   |  ✅   |     –     |    –     |   –    |
| ai:users:manage        |  ✅   |  ✅‡  |     –     |    –     |   –    |
| ai:apikey:manage       |  ✅   |  ✅   |     –     |    –     |   –    |
| ai:config:manage       |  ✅   |   –   |     –     |    –     |   –    |
| ai:patch:create        |  ✅   |  ✅   |    ✅     |    –     |   –    |
| ai:pr:create           |  ✅   |  ✅   |     –     |    –     |   –    |
| ai:run_tests           |  ✅   |  ✅   |    ✅     |    –     |   –    |

† reviewers can be granted approve/reject via a per-user permission override.
‡ admins can manage developers/reviewers/viewers but **not** owners.

### Route → permission

| Route                                            | Permission / check                |
| ------------------------------------------------ | --------------------------------- |
| `POST /run`                                      | `ai:run`                          |
| `GET  /sessions`                                 | `ai:session:read` (filtered)      |
| `GET  /sessions/[id]`                            | `ai:session:read` + access        |
| `POST /sessions/[id]` (approve/reject)           | `ai:session:read` + can-approve   |
| `GET  /me`                                        | any authenticated                 |
| `GET  /health`                                    | any authenticated                 |
| `GET/POST /users`, `/users/[id]/actions`         | `ai:users:manage` (+ apikey:manage) |
| `POST /sessions/[id]/patch/validate`             | `ai:patch:create` + access        |
| `POST /sessions/[id]/pull-request`               | `ai:pr:create` + access + approved |
| `GET  /sessions/[id]/pull-request`               | `ai:session:read` + access        |
| `POST /sessions/[id]/test-job`                   | `ai:run_tests` + access           |
| `GET  /jobs/[id]`                                 | `ai:session:read` + job access    |
| `POST /jobs/[id]/cancel`                          | `ai:run_tests` + job access       |
| `GET  /orchestrations/[id]`                       | `ai:session:read` + access        |
| `POST /orchestrations/[id]/resume`               | `ai:run` + access                 |
| `POST /orchestrations/[id]/cancel`               | `ai:run` + access                 |
| `POST /cron/resume`                              | `x-ai-cron-key` (NOT a user key)  |
| `GET  /readiness`                                | owner/admin or `ai:config:manage` |
| `GET  /production-dry-run`                       | owner/admin or `ai:config:manage` |

### Legacy admin key (migration window)

The Phase 2 `x-ai-admin-key` still works **only** when
`AI_ORCHESTRATOR_ALLOW_LEGACY_ADMIN_KEY=1`. It maps to an owner-level context,
is audited as `legacy_admin_used`, and should be **disabled in production**
once every caller has a user API key.

> 🔐 API keys are stored only as hashes; the raw key is shown once. Do **not**
> put API keys in `localStorage` — the UI uses `sessionStorage`.

## GitHub PR flow (Phase 6)

Turn a validated patch into a **branch + files + Pull Request** on GitHub. The
flow is deliberately constrained: it **never merges, never pushes/forces the
base branch, never deletes branches, and never deploys**. A human reviews and
merges in GitHub.

```
patch artifact (implementer)
  → validate (strict patch schema + safety validator)   POST .../patch/validate
  → [human] approve session                              POST .../sessions/[id] {approve}
  → create PR (dry-run by default)                       POST .../pull-request
       dry-run : validate + persist patch_set/files, NO GitHub write
       live    : real tests → branch off base → write files → open PR
  → [human] review + merge in GitHub
```

### Env

| Var | Meaning |
| --- | --- |
| `GITHUB_TOKEN` | PAT/app token, **server-side only**, never exposed to the UI or logged |
| `GITHUB_OWNER` / `GITHUB_REPO` | target repository |
| `GITHUB_DEFAULT_BRANCH` | protected base branch (default `main`) — never written to directly |
| `AI_ORCHESTRATOR_ENABLE_GITHUB_PR` | master switch; when `!= 1` the create-PR route returns **403** |
| `AI_ORCHESTRATOR_PR_DRY_RUN` | **dry-run is the default** (any value but `0`); set `0` for live PRs |
| `AI_ORCHESTRATOR_EXECUTE_TESTS` | live mode requires `1` (real tests must run) |
| `AI_ORCHESTRATOR_REQUIRE_SMOKE_PASS` | optional; when `1`, a recorded smoke pass is required |
| `AI_ORCHESTRATOR_SUPABASE_SMOKE_PASSED_AT` | ISO timestamp set after `npm run smoke:supabase` passes |

### Minimum GitHub token scopes

- `contents: write` — create the branch and write files.
- `pull_requests: write` — open the PR.

Nothing more. The token is read only in `lib/ai-orchestrator/github/github-client.ts`,
added to `SENSITIVE_ENV_NAMES` for redaction, and GitHub token shapes
(`ghp_`/`gho_`/`ghs_`/`ghu_`/`ghr_`/`github_pat_`) are structurally masked in any
persisted/logged text.

### Dry-run vs live

- **Dry-run (default).** Validates the patch, persists `ai_patch_sets` +
  `ai_patch_files`, records a `dry_run` row in `ai_pull_requests`, and audits
  `ai_pr_dry_run_completed`. **No GitHub API write happens.** This is the safe
  default and what you get the moment you enable the feature.
- **Live** (`AI_ORCHESTRATOR_PR_DRY_RUN=0` **and**
  `AI_ORCHESTRATOR_ENABLE_GITHUB_PR=1`). Adds, in order: session must be
  approved, caller must hold `ai:pr:create`, GitHub must be configured, optional
  smoke-pass gate, health must be green, **real tests must be enabled and must
  pass**, then branch → files → PR. Per-file pre-checks: `create` must not
  exist, `modify`/`delete` must exist, and writes pass the current blob SHA so a
  stale SHA fails rather than blind-overwrites.

### Patch safety validator (`lib/ai-orchestrator/patch/patch-validator.ts`)

Blocks: absolute paths, `..`, `~`, `.git/`, `node_modules/`, `.env*`,
`package-lock.json` (without explicit approval), destructive migrations, CI
workflows that deploy to production, secrets/tokens in content, `delete` by a
non-owner/admin, and any command outside the allowlist
(`npm run typecheck` · `npm test` · `npm run build` · `git diff`).

### Live mode checklist

1. Apply the Phase 6 migrations (manual):
   `lib/ai-orchestrator/migrations/postgres/005_github_pr_flow.sql` in Supabase
   (SQLite applies `008_github_pr_flow.sql` automatically).
2. Set `GITHUB_TOKEN` / `GITHUB_OWNER` / `GITHUB_REPO` (+ `GITHUB_DEFAULT_BRANCH`)
   server-side.
3. `AI_ORCHESTRATOR_ENABLE_GITHUB_PR=1`, `AI_ORCHESTRATOR_EXECUTE_TESTS=1`.
4. Verify dry-run first; confirm the patch file list + branch name look right.
5. Only then set `AI_ORCHESTRATOR_PR_DRY_RUN=0` for a live PR.
6. Review the PR in GitHub and **merge manually**.

### Why no auto-merge

The pipeline opens a PR and stops. A human must read the diff, run CI, and click
merge. Auto-merging would let an automated agent land code on a protected branch
with no human in the loop — exactly the failure mode this design rejects. The PR
body explicitly says “do not auto-merge”.

### Why no production deploy

Phase 6 ends at an open PR. Deploys are owned by your existing CI/CD on merge to
the base branch. The safety guard and patch validator both block deploy
commands / CI-workflow production deploys, and the flow never runs them.

### Audit events

`patch_validation_started/passed/failed`, `github_branch_created`,
`github_file_written`, `github_pr_created`, `github_pr_failed`,
`ai_pr_blocked_tests_failed`, `ai_pr_blocked_permission`,
`ai_pr_blocked_not_approved`, `ai_pr_dry_run_completed`. Patch content is
redacted before it is stored or audited; the GitHub token is never logged.

## Sandbox worker — execution plane (Phase 7)

Real commands (`npm ci` / `typecheck` / `test` / `build`) no longer run inside a
Next.js request in production. They run in a **separate worker process** that
checks out the repo into an isolated workspace, runs only allowlisted commands
(no shell), captures redacted output, and writes the result back to the DB.

### Control plane vs execution plane

| Plane | What it does | Secrets |
| ----- | ------------ | ------- |
| **Control plane** (this Next.js app) | stores sessions/patches/PRs/audit, **enqueues** jobs, **reads** status/logs/results. Never spawns a command in production. | full app env |
| **Execution plane** (`npm run ai:worker`) | claims jobs (lease), checks out repo/branch, runs allowlisted commands in a sandbox, writes redacted logs + result. | only what it needs — **no** OpenAI/Anthropic/Supabase-service-role/GitHub-write keys in the child process |

```
control plane                         execution plane (worker)
  POST /sessions/[id]/test-job  ──▶  ai_worker_jobs (queued)
                                        │  claimNextWorkerJob (lease 5m, attempts++)
                                        ▼
                                     workspace = clone repo@branch (isolated)
                                     run: npm ci / typecheck / test / build
                                        │  redacted logs -> ai_worker_job_logs
                                        ▼
  GET /jobs/[id]  ◀──  status: passed | failed | timed_out | cancelled + result
```

### Job queue providers

`AI_ORCHESTRATOR_WORKER_PROVIDER`:

| Provider   | Backend                     | Use            |
| ---------- | --------------------------- | -------------- |
| `database` | `ai_worker_jobs` (PG/SQLite) | production / MVP (default) |
| `local`    | in-memory                   | test / local only (**forbidden in production**) |

`claimNextWorkerJob` is **lease-based**: it picks a `queued` job (or a `running`
job whose lease expired), sets `running` + `lease_owner` + `lease_expires_at`
(now+5m), and increments `attempts`. A job that reaches `max_attempts` (default
2) is marked `failed` and never re-claimed. Logs are redacted before storage.

### Atomic worker claim (Phase 7.1.2)

With **multiple** workers, a naive read-then-write claim can race: two workers
read the same `queued` job and both update it. Postgres solves this with a
single atomic statement using **`FOR UPDATE SKIP LOCKED`** — the row is locked by
the first transaction; concurrent claimers *skip* the locked row and grab a
different one (or get nothing). No two workers ever claim the same job.

- **SQLite** (`sqlite-local`): single-writer, so the in-process claim is already
  effectively atomic. No change needed.
- **Postgres** (`postgres-rpc`): the repository claims via the RPC
  `claim_ai_worker_job(p_worker_id, p_lease_seconds)`
  (`migrations/postgres/008_atomic_worker_claim.sql`). It fails attempt-exhausted
  jobs, then `SELECT … FOR UPDATE SKIP LOCKED LIMIT 1`, then claims atomically.
  If the RPC is missing, the repository **throws a clear "apply migration 008"
  error** — there is **no silent non-atomic fallback** in production.

Ordering convention: **`priority ASC`** (lower number = higher priority), then
`created_at ASC` (FIFO) — identical across SQLite, in-memory, and the RPC.

Verify it against your real database before scaling out:

```bash
AI_ORCHESTRATOR_DB_PROVIDER=postgres SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
  npm run smoke:worker-claim     # fires 5 concurrent claims; exactly 1 must win
```

Then set `AI_ORCHESTRATOR_WORKER_CLAIM_VERIFIED=1` to clear the health warning.

> ⚠️ **Do NOT run more than one worker in production until migration 008 is
> applied** and `npm run smoke:worker-claim` passes. The health endpoint reports
> `worker_claim_mode`, `worker_atomic_claim`, and a `worker_claim_warning` — if
> the warning is present, **keep workers at 1** (a single worker can't race
> itself).

### Worker heartbeat / lease renewal (Phase 7.1.3)

Atomic claim stops two workers grabbing a job *at claim time*, but a long job
(`npm ci` 180s + `typecheck` 120s + `test` 180s + `build` 180s ≈ **660s**) can
outlive the default **5-minute lease**. Once `lease_expires_at` passes, another
worker could re-claim the still-running job → duplicate execution. The fix is a
**heartbeat**: the running worker periodically renews its lease.

- While a job runs, the worker renews every
  `AI_ORCHESTRATOR_WORKER_HEARTBEAT_INTERVAL_MS` (default 60s) via
  `renewWorkerJobLease` → Postgres RPC `renew_ai_worker_job_lease`
  (`migrations/postgres/009_worker_lease_renewal.sql`). **Only the owner of a
  still-running job can renew** (atomic `UPDATE … WHERE id=? AND status='running'
  AND lease_owner=?`); a non-match returns nothing → the worker learns it lost
  the lease.
- The heartbeat **fails closed**: after **3 consecutive renewal failures**
  (network) it aborts the job (`lease_renewal_failed`) rather than risk a second
  worker running the same patch.
- **Cancellation is immediate**: cancelling a job makes the next renewal return
  null → the worker fires an `AbortSignal` that **kills the command's process
  tree** (Linux/Docker: the child is spawned in its own group, killed with
  `process.kill(-pid)`; never `shell:true`). The job ends `cancelled`.
- **No clobbering**: before writing the final status the worker re-checks it
  still owns the lease — if another worker reclaimed it, the original abandons
  without overwriting.

Per-renewal events go to `worker_job_logs` (not audited individually, to avoid
pumping the DB); only `worker_heartbeat_started`/`stopped`, the final
`worker_lease_renew_failed`, and `worker_cancel_signal_sent` are audited.

Verify lease ownership against your real database before scaling out:

```bash
AI_ORCHESTRATOR_DB_PROVIDER=postgres SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
  npm run smoke:worker-lease     # owner renews; non-owner + cancelled are rejected
```

> ⚠️ The heartbeat interval **must be smaller than the lease**
> (`AI_ORCHESTRATOR_WORKER_HEARTBEAT_INTERVAL_MS` < `AI_ORCHESTRATOR_WORKER_LEASE_SECONDS`×1000),
> or the lease expires between renewals. Health reports `worker_lease_seconds`,
> `worker_heartbeat_interval_ms`, `worker_lease_renewal_supported`, and
> `worker_lease_warning`. Run the production worker on **Linux/Docker** for
> reliable process-tree kills.

### Orchestrator TEST_RUNNER via worker (Phase 7.2)

The orchestrator's 7-step workflow has a TEST_RUNNER step
(`CLAUDE_CODE_IMPLEMENTER → TEST_RUNNER → GPT_CODE_REVIEWER → QA_JUDGE`). In
production it must **not** spawn commands inside the Next.js request — instead it
enqueues a sandbox job and reads the result.

`AI_ORCHESTRATOR_TEST_RUNNER_MODE`:

| Mode | Behaviour | Use |
| ---- | --------- | --- |
| `inline` | run the suite in-process (`runTestSuite`) | dev/test (default off-prod); **blocked in production** unless `AI_ORCHESTRATOR_ALLOW_INLINE_COMMANDS=1` (audited `orchestrator_test_runner_inline_blocked`) |
| `worker` | enqueue a `test_branch` job (`source=orchestrator_test_runner`), then **wait, bounded**, for it | production (default) |

**Why not run commands in the request?** A Next.js request that spawns
`npm ci`/`test`/`build` ties a long, untrusted build to the web tier, can't be
sandboxed/lease-managed, and risks duplicate/uncontrolled execution. The worker
is the single execution plane — allowlisted commands, isolated workspace,
redacted logs, atomic claim, heartbeat.

**worker_wait** (this phase): the orchestrator enqueues per round and waits up to
`AI_ORCHESTRATOR_TEST_JOB_TIMEOUT_MS` (default 900 s), polling every
`AI_ORCHESTRATOR_TEST_JOB_POLL_MS` (default 3 s). It **never hangs forever** — on
a wait-timeout it produces a *failed* report, and the **QA fail-safe** keeps the
verdict from passing on a red/unknown test. The type surface
(`TestExecutor`/`TestStepResult` in `test-runner.ts`) is ready for a future
**worker_async** mode (enqueue + return `queued`, UI polls) without reworking the
workflow.

> ⚠️ **worker_wait can be long.** On Vercel the request must finish within the
> platform function timeout — if your test suite can exceed it, lower
> `AI_ORCHESTRATOR_TEST_JOB_TIMEOUT_MS` (you'll get a wait-timeout `needs_revision`
> rather than a hang) and plan a Phase 7.3 **worker_async** orchestration. Do
> **not** enable inline in production unless you fully understand the risk.

Health reports `test_runner_mode`, `test_job_timeout_ms`, `test_job_poll_ms`, and
`test_runner_warning` (red when production is inline; amber when worker mode lacks
`database` provider / `AI_ORCHESTRATOR_REPO_CLONE_URL` / verified RPCs). The
TEST_RUNNER artifact embeds the `worker_job_id` so you can open
`GET /api/ai-orchestrator/jobs/[id]` for its logs.

### Async (resumable) orchestration — worker_async (Phase 7.3)

`worker_wait` still holds the HTTP request until the build finishes — on Vercel
(function timeout 10–300 s) a clone + `npm ci` + suite easily exceeds it.
**`worker_async`** (production default) makes the orchestration *resumable*:

```
POST /run  ──▶  202 { session_id, orchestration_run_id, status:"waiting_for_worker", worker_job_id }
                  (pre-worker steps already ran inline: spec → critique → plan → implement)
   worker claims + runs the test job  ───────────────────────────────────────────────┐
UI polls GET /orchestrations/[id]  +  GET /jobs/[id]                                   │
   job terminal ──▶  POST /orchestrations/[id]/resume                                  │
                       (control plane runs review → QA judge)                          │
   needs_revision & round < max  ──▶  implement again + enqueue a new test job  ──▶ 202 (loop)
   pass / fail / max rounds      ──▶  terminal (session status updated)               │
```

- Every step is **persisted** in `ai_orchestration_runs` (status, round, step,
  `pending_worker_job_id`, redacted `state`) + a timeline in
  `ai_orchestration_events`. `/run` never holds a long request, and nothing
  promises background work that isn't in the DB.
- **QA fail-safe + MAX_ROUNDS are unchanged**: a red/unknown worker test can't
  let the judge pass, and revision rounds stop at `max_rounds`.
- Each `resume` advances **at most** to the next worker wait or a terminal state
  — never an unbounded loop in one request.
- **Resume runs the code reviewer + QA judge**, which call the models, so the
  **control plane needs `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`**. The sandbox
  worker does **not** need model keys (it only runs allowlisted commands).
- `AI_ORCHESTRATOR_WORKER_AUTO_RESUME=1` lets the worker resume finished runs,
  but it is **off by default** and **skipped without model keys** (a keyless
  worker would produce mock verdicts). The control-plane resume API is primary.

```
Routes:  GET  /api/ai-orchestrator/orchestrations/[id]            (ai:session:read + access)
         POST /api/ai-orchestrator/orchestrations/[id]/resume     (ai:run + access)
         POST /api/ai-orchestrator/orchestrations/[id]/cancel     (ai:run + access)
```

Health adds `async_orchestration_supported`, `worker_async_recommended`, and
`worker_async_warning` (provider≠database / missing repo clone / missing model
keys). The UI shows a live timeline, a **Resume** + **Cancel Orchestration**
button, and auto-resumes once when the worker job is terminal.

### Scheduled / cron resume (Phase 7.4)

The UI auto-resume only fires while a browser tab is open. **If no one is
watching, a finished run sits in `waiting_for_worker` forever.** A scheduled
cron closes that gap:

```
every minute ─▶ POST /api/ai-orchestrator/cron/resume   (x-ai-cron-key)
                  scan waiting_for_worker runs whose worker job is terminal
                  claim a short per-run lock ─▶ resume (review → QA judge)
                  bounded by AI_ORCHESTRATOR_RESUME_BATCH_SIZE per tick
```

Production flow: **(1)** `worker_async` mode → **(2)** the worker runs the test
job → **(3)** the cron scans `waiting_for_worker` → **(4)** it resumes the
orchestration → **(5)** the UI is a *viewer only* and never needs to stay open.

**Auth (the route is NOT a user endpoint, and is fail-closed).** With no
`AI_ORCHESTRATOR_CRON_KEY` the route returns 401 — it can never run unprotected.
Accepted credentials, in order:

1. `x-ai-cron-key: <key>` header — preferred (use with an external scheduler).
2. `Authorization: Bearer <key>` — **Vercel Cron** sends this automatically when
   the project's `CRON_SECRET` is set; point `CRON_SECRET` at the same value as
   `AI_ORCHESTRATOR_CRON_KEY`.
3. `?cron_key=<key>` query token — **only** when
   `AI_ORCHESTRATOR_ALLOW_CRON_QUERY_KEY=1` (off by default; a query token can
   leak via logs/referrers — prefer a header).

**Vercel Cron caveat.** Vercel Cron cannot send a *custom* header, so the bundled
`vercel.json` (`*/1 * * * *`) relies on the `Authorization: Bearer ${CRON_SECRET}`
path above. If you cannot set `CRON_SECRET`, drive the route from an external
scheduler that sends `x-ai-cron-key`, or enable the (less safe) query token.

**No-double-resume.** Each run is claimed with a TTL'd lock
(`AI_ORCHESTRATOR_RESUME_LOCK_TTL_SECONDS`, default 120s) before resuming, so two
overlapping ticks — or the cron and the optional worker auto-resume — never
process the same run twice. Each tick resumes at most
`AI_ORCHESTRATOR_RESUME_BATCH_SIZE` runs (default 5, clamped ≤ 50): no command
runs in the request, and the work is bounded.

> Cron resume **still calls the models** (review + QA judge), so the **control
> plane needs `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`**. The worker does not.
> **Never** put the cron key in `NEXT_PUBLIC_*` or any client bundle.

```
Route:   POST /api/ai-orchestrator/cron/resume                    (x-ai-cron-key / Bearer)
Migrate: lib/ai-orchestrator/migrations/postgres/011_orchestration_resume_lock.sql
Env:     AI_ORCHESTRATOR_CRON_KEY, AI_ORCHESTRATOR_RESUME_BATCH_SIZE=5,
         AI_ORCHESTRATOR_RESUME_LOCK_TTL_SECONDS=120, AI_ORCHESTRATOR_ALLOW_CRON_QUERY_KEY=0
```

Health adds `cron_resume_enabled`, `cron_key_configured`, `resume_batch_size`,
`resume_lock_ttl_seconds`, and `cron_resume_warning` (worker_async without a cron
key / batch too high / lock TTL too low). It never returns the key value.

### Production readiness gate (Phase 8)

A single gate aggregates every go-live precondition into one report — **pure
inspection only** (env + bounded DB probes): it never deploys, runs a command,
calls a model, applies a migration, or returns a secret VALUE.

```
GET /api/ai-orchestrator/readiness     (x-ai-api-key; owner/admin or ai:config:manage)
npm run readiness  [-- --json] [-- --strict-warnings]
```

Each check has a `status` (pass/warn/fail/skip) + `severity`
(critical/high/medium/low) + `message` + optional `remediation`. It verifies:
DB provider is Postgres in production; Supabase env present; DB ping; all 14
tables + the migration columns (`new_content_redacted`, `resume_lock_owner`);
worker claim/lease verified; worker provider/clone/heartbeat<lease; test runner =
worker_async; cron key (+ Vercel `CRON_SECRET` match); OpenAI + Anthropic keys;
GitHub PR config (live vs dry-run); an active owner + API key; Upstash rate
limiting; the audit log; the smoke-pass flags; and that **no `NEXT_PUBLIC_*`
secret is exposed**.

- The **endpoint returns 503** when any critical/high check fails (200 with only
  warnings). The **CLI exits 1** on any failure (or any warning with
  `--strict-warnings`), else 0 — wire it into CI / a pre-deploy step.
- Production-only checks `skip` in development, so `npm run readiness` is quiet
  locally and strict in production.

### Production dry-run go-live verification (Phase 9)

Before going live, verify a **real** production deployment in a **dry-run** —
without ever creating a live PR, merging, pushing `main`, deploying, or applying
a migration. The full checklist is in
**[`docs/production-dry-run-runbook.md`](docs/production-dry-run-runbook.md)**
(migrations → env → owner → smoke → readiness → worker → cron → a real
orchestration → the PR flow in dry-run, with explicit Go/No-go criteria).

A read-only aggregate gate folds readiness + health + dry-run safety into one
go/no-go view:

```
GET /api/ai-orchestrator/production-dry-run   (owner/admin or ai:config:manage)
npm run prod:dry-run  [-- --json] [-- --create-test-session]
```

It returns `dry_run_safe` + `blockers[]` + `warnings[]` + `next_actions[]`.
Blockers include: not `worker_async`, worker provider ≠ `database`, inline
commands on, `AI_ORCHESTRATOR_PR_DRY_RUN=0` (live PR), and any readiness
critical/high failure. **Pure inspection** — no session, no model, no command,
no migration, no secret in the output. `--create-test-session` runs one real
orchestration **only** when `AI_ORCHESTRATOR_PROD_DRY_RUN_ALLOW_MODEL_CALLS=1`,
and never opens a live PR.

### Local mode

```bash
# Terminal A — control plane
npm run dev
# Terminal B — worker (database provider, local SQLite)
AI_ORCHESTRATOR_WORKER_PROVIDER=database npm run ai:worker
# one-shot drain (cron/CI):
npm run ai:worker -- --once
```

For pure local dev you may keep the **inline** test-runner fallback by setting
`AI_ORCHESTRATOR_ALLOW_INLINE_COMMANDS=1` — but this is **refused in production**
(`NODE_ENV=production`), and the health endpoint flags it as
`worker_mode_warning`.

### Production mode

```bash
AI_ORCHESTRATOR_WORKER_PROVIDER=database
AI_ORCHESTRATOR_ALLOW_INLINE_COMMANDS=0
AI_ORCHESTRATOR_REPO_CLONE_URL=https://github.com/<owner>/<repo>.git
# private repo (optional): a READ-only token, used only in the clone URL, never logged
GITHUB_READ_TOKEN=...
```

The control plane runs on Vercel; the worker runs **elsewhere** (a container/VM)
because Vercel functions cannot spawn long-running builds. In production the
worker **requires** `AI_ORCHESTRATOR_REPO_CLONE_URL` (there is no local-copy
fallback).

### Docker worker

```bash
docker build -f Dockerfile.ai-worker -t ai-orchestrator-worker .
docker run --env-file .env.worker ai-orchestrator-worker
```

The image runs as the non-root `node` user, installs `git`, bakes **no**
secrets, and defaults to `npm run ai:worker`.

### `.env.worker`

A minimal, **worker-only** env file — give it just what the execution plane
needs, and none of the control-plane secrets:

```bash
AI_ORCHESTRATOR_DB_PROVIDER=postgres
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...            # worker reads/writes jobs
AI_ORCHESTRATOR_WORKER_PROVIDER=database
AI_ORCHESTRATOR_ALLOW_INLINE_COMMANDS=0
AI_ORCHESTRATOR_WORKER_ID=worker-1
AI_ORCHESTRATOR_WORKER_CONCURRENCY=1
AI_ORCHESTRATOR_REPO_CLONE_URL=https://github.com/<owner>/<repo>.git
GITHUB_READ_TOKEN=                        # only if the repo is private
```

> The worker needs the Supabase **service role** to read/write the job tables,
> but the **child process** that runs `npm test` gets NONE of these — see below.

### Security model

- **No secrets in the child process.** The command child env is built from
  scratch (`NODE_ENV=test`, `CI=1`, `NEXT_TELEMETRY_DISABLED=1`,
  `npm_config_loglevel=warn`, plus only `PATH`/system essentials). The service
  role key, `DATABASE_URL`, OpenAI/Anthropic keys, the GitHub write token, the
  admin key and the key pepper are **never** passed in.
- **Allowlist only**, validated again at run time: `npm ci`, `npm run typecheck`,
  `npm test`, `npm run build`, `git diff`. Anything else (or any
  `; && || | \` $() > <` / newline) is rejected.
- **No `shell: true`** — commands run via `spawn(file, args)`.
- **Timeouts** per command (`npm ci`/`test`/`build` 180s, `typecheck` 120s,
  `git diff` 30s) and a **200 KB/stream** output cap with a `[TRUNCATED]` marker.
- **No `.env` in the workspace** — the local-copy fallback excludes `.env*`,
  `node_modules`, `.git`, `.next`. A private-repo clone token lives only in the
  clone URL and is never logged.
- **No auto-merge, no auto-deploy** — Phase 7 only runs tests; merging/deploying
  stay manual (Phase 6 rules unchanged).

### PR integration

In the default worker mode (`database`, inline off), a **live** PR is blocked
until a sandbox job has **passed for the exact patch** (Phase 7.1):

- no sandbox job → `409 worker_required` (audit `pr_blocked_worker_required`),
- job failed/timed-out → `409 worker_failed` (audit `pr_blocked_worker_failed`),
- job passed but for a **different** `patch_set_id` → `409 worker_patch_mismatch`
  (audit `pr_blocked_worker_patch_mismatch`),
- job passed for this patch but `patch_applied=false` → `409 worker_required`,
- passed + matching `patch_set_id` + `patch_applied=true` → the PR is created and
  its body embeds the `patch_set_id`, `worker_job_id`, `patch_applied`,
  `changed_files`, and the sandbox test report.

Dry-run PRs don't require a worker job. The inline fallback (dev only,
`AI_ORCHESTRATOR_ALLOW_INLINE_COMMANDS=1`) still runs tests in-process.

### Patch testing in sandbox (Phase 7.1)

A `test_patch` job does **not** just test the branch — it **applies the patch
into the workspace first**, then runs the suite:

```
clone repo@branch (isolated)
  → apply patch_set files (full redacted content from ai_patch_files)
       create: must not exist · modify/delete: must exist · no .git/.env/.. escapes
  → npm ci → typecheck → test → build
  → result: { patch_applied, patch_set_id, changed_files, diff_summary, commands }
```

If the apply step fails, **no test command runs** and the job is `failed`.

**Why apply the patch before testing?** A green `test_branch` only proves the
*existing* branch builds — it says nothing about the AI's proposed change. Only
by applying the patch and re-running the suite do we prove *that patch* passes.
So the PR gate requires a passed job whose `patch_set_id` matches the patch being
opened **and** `patch_applied=true`.

- The full new file content is stored (redacted) in
  `ai_patch_files.new_content_redacted` at validate time. A validated patch never
  contains secrets (the validator rejects them), so redaction is a no-op on valid
  content; a secret-bearing patch fails validation and never reaches a worker.
- **A test-branch pass is not enough** — the PR flow requires `test_patch` with
  the patch applied.
- **Re-validating makes a new `patch_set`** with a new id, so any prior sandbox
  job no longer matches → you must **run Patch Tests again** before the PR.

### Base drift protection (Phase 7.1.1)

Even with the patch applied, the *base* the patch was built against can move
between validate-time and apply-time. The applier guards against this with
`old_content_hash`.

**What is `old_content_hash`?** At validate time, for every `modify`/`delete`
file, the validate step fetches the **base-branch file content** (via GitHub, when
configured) and stores its **drift hash** (SHA-256 of the UTF-8 content with line
endings normalized) in `ai_patch_files.old_content_hash`. It is a hash only —
never the file content.

**Why check the hash when applying, after validation passed?** Validation proves
the patch is *well-formed and safe*; it does not prove the *base hasn't changed*.
Before a `modify`/`delete`, the worker hashes the current workspace file and
compares it to `old_content_hash`:

- match → apply and set `base_hash_checked=true`,
- mismatch → fail `base_hash_mismatch`, **run no tests**, **create no PR**,
- missing hash under **strict mode** → fail `missing_old_content_hash`.

`AI_ORCHESTRATOR_PATCH_HASH_STRICT` controls strict mode (default: **on in
production**, off in dev/test; set `=1`/`=0` to force). In strict mode the PR is
blocked unless the worker job reports `base_hash_checked=true`
(`409 worker_hash_not_checked`, audit `pr_blocked_worker_hash_not_checked`).

**When you hit `base_hash_mismatch`:** the base moved — recover by:

1. **Validate Patch** again (recomputes `old_content_hash` against the new base),
2. **Run Patch Tests** again (worker re-applies + re-checks),
3. **Create PR** again.

> Errors carry a **code + file_path only** — never file content. Hashes are
> one-way and safe to store/audit.

### Runbook

```
1. start the app            npm run dev            (control plane)
2. start the worker         npm run ai:worker      (execution plane)
3. run the orchestrator     POST /run  (or the UI)
4. approve the session      POST /sessions/[id]   { "action": "approve" }
5. validate the patch       POST /sessions/[id]/patch/validate   (→ a validated patch_set)
6. run PATCH tests          POST /sessions/[id]/test-job   → poll GET /jobs/[id]
                            (worker applies the patch, then runs the suite)
7. create the PR (live)     POST /sessions/[id]/pull-request
                            (allowed only when the job passed for THIS patch_set
                             with patch_applied=true)
8. human review + merge     manually in GitHub

   ↻ if you re-validate the patch (step 5 again), the patch_set id changes —
     re-run step 6 before step 7.
```

## Production checklist

1. **Apply Postgres migrations manually** in Supabase (SQL editor /
   `supabase db push`):
   - `lib/ai-orchestrator/migrations/postgres/001_init.sql`
   - `lib/ai-orchestrator/migrations/postgres/002_ai_audit_logs.sql`
   - `lib/ai-orchestrator/migrations/postgres/003_users_rbac.sql`
   - `lib/ai-orchestrator/migrations/postgres/004_rls_policies.sql` (optional —
     only if/when you adopt client-side Supabase Auth; RLS does not affect the
     service-role server path)
   - `lib/ai-orchestrator/migrations/postgres/005_github_pr_flow.sql` (Phase 6 —
     patch sets, patch files, pull requests)
   - `lib/ai-orchestrator/migrations/postgres/006_worker_jobs.sql` (Phase 7 —
     worker jobs + job logs)
   - `lib/ai-orchestrator/migrations/postgres/007_patch_file_content.sql`
     (Phase 7.1 — full patch content the worker applies)
   - `lib/ai-orchestrator/migrations/postgres/008_atomic_worker_claim.sql`
     (Phase 7.1.2 — atomic `claim_ai_worker_job` RPC; **required before running
     more than one worker**)
   - `lib/ai-orchestrator/migrations/postgres/009_worker_lease_renewal.sql`
     (Phase 7.1.3 — `renew_ai_worker_job_lease` RPC; **required for long jobs +
     multiple workers**)
   - `lib/ai-orchestrator/migrations/postgres/010_orchestration_state.sql`
     (Phase 7.3 — `ai_orchestration_runs` + events for async/resumable runs)
   - `lib/ai-orchestrator/migrations/postgres/011_orchestration_resume_lock.sql`
     (Phase 7.4 — resume-lock columns; **required before the cron resume**)
   Then **create the owner**: `npm run ai:create-owner`, and **disable the
   legacy admin key** (`AI_ORCHESTRATOR_ALLOW_LEGACY_ADMIN_KEY` unset).
2. **Set Vercel env** (server-side, not `NEXT_PUBLIC_*`):
   ```
   AI_ORCHESTRATOR_DB_PROVIDER=postgres
   SUPABASE_URL=...
   SUPABASE_SERVICE_ROLE_KEY=...          # server-side ONLY
   AI_ORCHESTRATOR_ADMIN_KEY=...
   AI_ORCHESTRATOR_RATE_LIMIT_PROVIDER=upstash
   UPSTASH_REDIS_REST_URL=...
   UPSTASH_REDIS_REST_TOKEN=...
   AI_ORCHESTRATOR_CRON_KEY=...             # Phase 7.4 cron resume (server-side ONLY)
   CRON_SECRET=...                          # set equal to AI_ORCHESTRATOR_CRON_KEY for Vercel Cron
   ```
3. **Run the smoke test** against the real DB:
   ```
   npm run smoke:supabase          # add AI_ORCHESTRATOR_SMOKE_CLEANUP=1 to clean up
   ```
4. **Verify atomic worker claim + lease renewal** (required before running >1
   worker, or any long job):
   ```
   npm run smoke:worker-claim      # 5 concurrent claims; exactly 1 must win
   npm run smoke:worker-lease      # owner renews; non-owner + cancelled rejected
   ```
   Then set `AI_ORCHESTRATOR_WORKER_CLAIM_VERIFIED=1` +
   `AI_ORCHESTRATOR_WORKER_LEASE_VERIFIED=1` (clears both warnings).
   Ensure `AI_ORCHESTRATOR_WORKER_HEARTBEAT_INTERVAL_MS` < lease (×1000).
5. **Start the sandbox worker** (`npm run ai:worker`, or the Docker image) on a
   Linux host, and route the orchestrator's tests to it:
   ```
   AI_ORCHESTRATOR_TEST_RUNNER_MODE=worker_async
   AI_ORCHESTRATOR_REPO_CLONE_URL=https://github.com/<owner>/<repo>.git
   ```
   (Mind `AI_ORCHESTRATOR_TEST_JOB_TIMEOUT_MS` vs your Vercel function timeout.)
6. **Schedule the cron resume** (Phase 7.4) so finished runs continue without an
   open UI: keep the bundled `vercel.json` cron and set `CRON_SECRET` =
   `AI_ORCHESTRATOR_CRON_KEY` (Vercel sends `Authorization: Bearer`), or point an
   external scheduler at `POST /api/ai-orchestrator/cron/resume` with the
   `x-ai-cron-key` header. The control plane must have model keys for resume.
7. **Run the readiness gate** (Phase 8) and resolve every failure:
   ```
   npm run readiness                 # human-readable; exit 1 on any failure
   npm run readiness -- --json       # machine-readable (CI / pre-deploy step)
   ```
   Or hit `GET /api/ai-orchestrator/readiness` (owner/admin) — it returns **503**
   until all critical/high checks pass.
8. **Check the health endpoint** returns `200` with `db_status: ok`,
   `rate_limit_status: ok`, `worker_claim_warning: null`,
   `worker_lease_warning: null`, `test_runner_warning: null`, and
   `cron_resume_warning: null`.
9. **Enable Upstash rate limiting** (step 2) for multi-instance correctness.

> 🔐 The service role key bypasses RLS and is **server-side only** — never put
> any Supabase key in the UI / `NEXT_PUBLIC_*`.
>
> 🚦 **Do not enable auto-apply-patch / auto-PR** until the health endpoint and
> the Supabase smoke test both pass.

## Commands

```bash
npm run typecheck   # tsc --noEmit
npm test            # node:test + tsx
npm run build       # next build
npm run dev         # local dev server
```

Copy `.env.example` → `.env.local` and add keys to run live. Without keys the
pipeline runs in mock mode.
