import { getRepository, resolveDbProvider } from "./db/factory";
import {
  getRateLimitStore,
  resolveRateLimitProvider,
} from "./security/redis-rate-limit";
import { resolveGithubConfig, resolveGithubFlags } from "./github/github-client";
import {
  inlineCommandsAllowed,
  isProductionEnv,
  resolveWorkerProvider,
} from "./worker/job-queue";
import { resolvePatchHashStrict } from "./worker/patch-applier";
import {
  resolveHeartbeatIntervalMs,
  resolveLeaseSeconds,
} from "./worker/heartbeat";
import {
  resolveTestJobPollMs,
  resolveTestJobTimeoutMs,
  resolveTestRunnerMode,
} from "./test-runner-worker";
import {
  resolveResumeBatchSize,
  resolveResumeLockTtlSeconds,
} from "./orchestration-resume-scheduler";
import { resolveCronKey } from "./security/cron-auth";

export interface HealthReport {
  db_provider: string;
  rate_limit_provider: string;
  db_status: "ok" | "fail";
  rate_limit_status: "ok" | "fail";
  has_openai_key: boolean;
  has_anthropic_key: boolean;
  execute_tests_enabled: boolean;
  // Phase 6 — GitHub PR readiness (booleans only; never the token value).
  github_pr_enabled: boolean;
  github_pr_dry_run: boolean;
  has_github_token: boolean;
  github_configured: boolean;
  // Phase 7 — execution plane.
  worker_provider: string;
  inline_commands_enabled: boolean;
  worker_queue_status: "ok" | "fail" | "local";
  repo_clone_configured: boolean;
  /** Phase 7.1.1: base-drift hash check is enforced. */
  patch_hash_strict: boolean;
  // Phase 7.1.2 — atomic worker-job claim.
  worker_atomic_claim: boolean | "unknown";
  worker_claim_mode: "sqlite-local" | "postgres-rpc" | "postgres-legacy";
  /** Non-null when the Postgres atomic-claim RPC hasn't been verified. */
  worker_claim_warning: string | null;
  // Phase 7.1.3 — heartbeat / lease renewal.
  worker_lease_seconds: number;
  worker_heartbeat_interval_ms: number;
  worker_lease_renewal_supported: boolean | "unknown";
  /** Non-null when lease/heartbeat config is unsafe or unverified. */
  worker_lease_warning: string | null;
  // Phase 7.2 / 7.3 — orchestrator TEST_RUNNER mode.
  test_runner_mode: "inline" | "worker_wait" | "worker_async";
  test_job_timeout_ms: number;
  test_job_poll_ms: number;
  /** Non-null when the TEST_RUNNER mode is unsafe / unready. */
  test_runner_warning: string | null;
  // Phase 7.3 — async (resumable) orchestration.
  async_orchestration_supported: boolean;
  worker_async_recommended: boolean;
  worker_async_warning: string | null;
  // Phase 7.4 — scheduled / cron resume.
  cron_resume_enabled: boolean;
  cron_key_configured: boolean;
  resume_batch_size: number;
  resume_lock_ttl_seconds: number;
  /** Non-null when cron resume is needed but unconfigured / misconfigured. */
  cron_resume_warning: string | null;
  /** Non-null when production is misconfigured to allow inline commands. */
  worker_mode_warning: string | null;
  timestamp: string;
  /** Overall health: true only when the DB is reachable. */
  ok: boolean;
}

/**
 * Build a production-readiness report. Never throws and never leaks secret
 * VALUES — only booleans for key presence + provider names + status.
 */
export async function getHealthReport(): Promise<HealthReport> {
  let dbProvider = "unknown";
  try {
    dbProvider = resolveDbProvider();
  } catch {
    dbProvider = "invalid";
  }

  let dbStatus: "ok" | "fail" = "fail";
  try {
    await getRepository().ping();
    dbStatus = "ok";
  } catch {
    dbStatus = "fail";
  }

  let rlProvider = "memory";
  let rlStatus: "ok" | "fail" = "fail";
  try {
    rlProvider = resolveRateLimitProvider();
    const store = getRateLimitStore();
    rlStatus = store.ping ? ((await store.ping()) ? "ok" : "fail") : "ok";
  } catch {
    rlStatus = "fail";
  }

  const githubFlags = resolveGithubFlags();
  const github = resolveGithubConfig();

  let workerProvider = "database";
  try {
    workerProvider = resolveWorkerProvider();
  } catch {
    workerProvider = "invalid";
  }
  const inlineEnabled = inlineCommandsAllowed();
  const repoCloneConfigured =
    Boolean(process.env.AI_ORCHESTRATOR_REPO_CLONE_URL?.trim()) ||
    github.config !== null;
  const workerQueueStatus: "ok" | "fail" | "local" =
    workerProvider === "local" ? "local" : dbStatus;
  const workerModeWarning =
    isProductionEnv() && inlineEnabled
      ? "Inline command execution is enabled in production — disable AI_ORCHESTRATOR_ALLOW_INLINE_COMMANDS and use the sandbox worker."
      : null;

  // Phase 7.1.2 — atomic claim. SQLite is single-writer (atomic enough);
  // Postgres uses the claim_ai_worker_job RPC. We can't probe the RPC from
  // health without a side effect, so it stays "unknown" until an operator
  // verifies it (npm run smoke:worker-claim) and sets the verified flag.
  const isPg = dbProvider === "postgres";
  const claimVerified = process.env.AI_ORCHESTRATOR_WORKER_CLAIM_VERIFIED === "1";
  const workerClaimMode: HealthReport["worker_claim_mode"] = isPg
    ? "postgres-rpc"
    : "sqlite-local";
  const workerAtomicClaim: HealthReport["worker_atomic_claim"] = isPg
    ? claimVerified
      ? true
      : "unknown"
    : true;
  const workerClaimWarning =
    isPg && !claimVerified
      ? "Postgres atomic claim uses RPC claim_ai_worker_job. Apply migration 008_atomic_worker_claim.sql, run `npm run smoke:worker-claim`, then set AI_ORCHESTRATOR_WORKER_CLAIM_VERIFIED=1. Do NOT scale workers > 1 until verified."
      : null;

  // Phase 7.1.3 — heartbeat / lease renewal.
  const leaseSeconds = resolveLeaseSeconds();
  const heartbeatIntervalMs = resolveHeartbeatIntervalMs();
  const concurrency = Math.max(
    1,
    parseInt(process.env.AI_ORCHESTRATOR_WORKER_CONCURRENCY || "1", 10) || 1,
  );
  const intervalTooBig = heartbeatIntervalMs >= leaseSeconds * 1000;
  const leaseRenewalSupported: HealthReport["worker_lease_renewal_supported"] =
    isPg ? (claimVerified ? true : "unknown") : true;
  const workerLeaseWarning = intervalTooBig
    ? `Heartbeat interval (${heartbeatIntervalMs}ms) must be smaller than the lease (${leaseSeconds}s) — the lease will expire between renewals.`
    : isPg && !claimVerified
      ? "Lease renewal RPC not verified — apply migration 009_worker_lease_renewal.sql, run `npm run smoke:worker-lease`, then set AI_ORCHESTRATOR_WORKER_CLAIM_VERIFIED=1. Keep workers at 1 until verified."
      : concurrency > 1 && !claimVerified
        ? "Multiple workers configured but lease renewal is not verified — keep workers at 1 until verified."
        : null;

  // Phase 7.2 — TEST_RUNNER mode.
  const testRunnerMode = resolveTestRunnerMode();
  const testJobTimeoutMs = resolveTestJobTimeoutMs();
  const testJobPollMs = resolveTestJobPollMs();
  const isWorkerTestMode =
    testRunnerMode === "worker_wait" || testRunnerMode === "worker_async";
  const hasModelKeys =
    Boolean(process.env.OPENAI_API_KEY) || Boolean(process.env.ANTHROPIC_API_KEY);
  const testRunnerWarning =
    testRunnerMode === "inline" && isProductionEnv()
      ? "TEST_RUNNER runs commands inline in a production request — set AI_ORCHESTRATOR_TEST_RUNNER_MODE=worker_async and run the sandbox worker."
      : testRunnerMode === "worker_wait" && isProductionEnv()
        ? "worker_wait holds the request until the build finishes — it may exceed the platform (Vercel) function timeout. Use worker_async in production."
        : isWorkerTestMode && workerProvider !== "database"
          ? "TEST_RUNNER worker mode requires AI_ORCHESTRATOR_WORKER_PROVIDER=database."
          : isWorkerTestMode && !repoCloneConfigured
            ? "TEST_RUNNER worker mode requires AI_ORCHESTRATOR_REPO_CLONE_URL."
            : isWorkerTestMode && isPg && !claimVerified
              ? "TEST_RUNNER worker mode: verify the claim/lease RPCs (smoke:worker-claim + smoke:worker-lease) before relying on it."
              : null;

  // Async orchestration needs DB-persisted state; resume needs model keys.
  const asyncOrchestrationSupported = workerProvider === "database";
  const workerAsyncRecommended = isProductionEnv();
  const workerAsyncWarning =
    testRunnerMode === "worker_async" && workerProvider !== "database"
      ? "worker_async requires AI_ORCHESTRATOR_WORKER_PROVIDER=database (orchestration state lives in the DB)."
      : testRunnerMode === "worker_async" && !repoCloneConfigured
        ? "worker_async requires AI_ORCHESTRATOR_REPO_CLONE_URL for the worker to check out."
        : testRunnerMode === "worker_async" && !hasModelKeys
          ? "worker_async resume (code review + QA judge) needs OPENAI_API_KEY / ANTHROPIC_API_KEY on the control plane."
          : null;

  // Phase 7.4 — scheduled / cron resume. The cron route is fail-closed: without
  // a cron key it is disabled, so a worker_async deployment that never resumes
  // is the danger we warn about (runs would sit in waiting_for_worker forever).
  const cronKeyConfigured = Boolean(resolveCronKey());
  const resumeBatchSize = resolveResumeBatchSize();
  const resumeLockTtlSeconds = resolveResumeLockTtlSeconds();
  const cronResumeEnabled = cronKeyConfigured;
  const cronResumeWarning =
    testRunnerMode === "worker_async" && !cronKeyConfigured
      ? "worker_async needs a scheduled resume: set AI_ORCHESTRATOR_CRON_KEY and schedule POST /api/ai-orchestrator/cron/resume (else finished runs stay waiting_for_worker until the UI resumes them)."
      : resumeBatchSize > 20
        ? `Resume batch size (${resumeBatchSize}) is high — a single cron tick may exceed the function timeout. Lower AI_ORCHESTRATOR_RESUME_BATCH_SIZE.`
        : resumeLockTtlSeconds < 30
          ? `Resume lock TTL (${resumeLockTtlSeconds}s) is low — a slow resume may lose its lock and be double-processed. Raise AI_ORCHESTRATOR_RESUME_LOCK_TTL_SECONDS.`
          : null;

  return {
    db_provider: dbProvider,
    rate_limit_provider: rlProvider,
    db_status: dbStatus,
    rate_limit_status: rlStatus,
    has_openai_key: Boolean(process.env.OPENAI_API_KEY),
    has_anthropic_key: Boolean(process.env.ANTHROPIC_API_KEY),
    execute_tests_enabled: process.env.AI_ORCHESTRATOR_EXECUTE_TESTS === "1",
    github_pr_enabled: githubFlags.enableGithubPr,
    github_pr_dry_run: githubFlags.dryRun,
    has_github_token: Boolean(process.env.GITHUB_TOKEN),
    github_configured: github.config !== null,
    worker_provider: workerProvider,
    inline_commands_enabled: inlineEnabled,
    worker_queue_status: workerQueueStatus,
    repo_clone_configured: repoCloneConfigured,
    patch_hash_strict: resolvePatchHashStrict(),
    worker_atomic_claim: workerAtomicClaim,
    worker_claim_mode: workerClaimMode,
    worker_claim_warning: workerClaimWarning,
    worker_lease_seconds: leaseSeconds,
    worker_heartbeat_interval_ms: heartbeatIntervalMs,
    worker_lease_renewal_supported: leaseRenewalSupported,
    worker_lease_warning: workerLeaseWarning,
    test_runner_mode: testRunnerMode,
    test_job_timeout_ms: testJobTimeoutMs,
    test_job_poll_ms: testJobPollMs,
    test_runner_warning: testRunnerWarning,
    async_orchestration_supported: asyncOrchestrationSupported,
    worker_async_recommended: workerAsyncRecommended,
    worker_async_warning: workerAsyncWarning,
    cron_resume_enabled: cronResumeEnabled,
    cron_key_configured: cronKeyConfigured,
    resume_batch_size: resumeBatchSize,
    resume_lock_ttl_seconds: resumeLockTtlSeconds,
    cron_resume_warning: cronResumeWarning,
    worker_mode_warning: workerModeWarning,
    timestamp: new Date().toISOString(),
    ok: dbStatus === "ok",
  };
}
