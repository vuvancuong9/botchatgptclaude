import { getRepository, resolveDbProvider } from "./db/factory";
import type { AiOrchestratorRepository } from "./db/repository.interface";
import {
  inlineCommandsAllowed,
  isProductionEnv,
  resolveWorkerProvider,
} from "./worker/job-queue";
import {
  resolveHeartbeatIntervalMs,
  resolveLeaseSeconds,
} from "./worker/heartbeat";
import { resolveTestRunnerMode } from "./test-runner-worker";
import { resolveCronKey, cronQueryKeyAllowed } from "./security/cron-auth";
import { resolveRateLimitProvider } from "./security/redis-rate-limit";
import { resolveGithubConfig, resolveGithubFlags } from "./github/github-client";

export type ReadinessStatus = "pass" | "warn" | "fail" | "skip";
export type ReadinessSeverity = "critical" | "high" | "medium" | "low";

export interface ReadinessCheck {
  id: string;
  name: string;
  status: ReadinessStatus;
  severity: ReadinessSeverity;
  message: string;
  remediation?: string;
}

export interface ReadinessReport {
  ok: boolean;
  environment: "development" | "test" | "production";
  checks: ReadinessCheck[];
  summary: { pass: number; warn: number; fail: number; skip: number };
  timestamp: string;
}

type Env = Record<string, string | undefined>;

/** The schema the production app depends on (table existence). */
const REQUIRED_TABLES = [
  "ai_sessions",
  "ai_messages",
  "ai_artifacts",
  "ai_runs",
  "ai_audit_logs",
  "ai_users",
  "ai_api_keys",
  "ai_patch_sets",
  "ai_patch_files",
  "ai_pull_requests",
  "ai_worker_jobs",
  "ai_worker_job_logs",
  "ai_orchestration_runs",
  "ai_orchestration_events",
] as const;

/** Columns added by later migrations that must be present. */
const REQUIRED_COLUMNS: Array<{
  table: string;
  column: string;
  migration: string;
}> = [
  {
    table: "ai_patch_files",
    column: "new_content_redacted",
    migration: "007_patch_file_content.sql",
  },
  {
    table: "ai_orchestration_runs",
    column: "resume_lock_owner",
    migration: "011_orchestration_resume_lock.sql",
  },
];

/** NEXT_PUBLIC_* names that must NEVER be set (they ship to the browser). */
const UNSAFE_PUBLIC_KEYS = [
  "NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY",
  "NEXT_PUBLIC_OPENAI_API_KEY",
  "NEXT_PUBLIC_ANTHROPIC_API_KEY",
  "NEXT_PUBLIC_GITHUB_TOKEN",
  "NEXT_PUBLIC_AI_ORCHESTRATOR_ADMIN_KEY",
  "NEXT_PUBLIC_AI_ORCHESTRATOR_CRON_KEY",
] as const;

function present(v: string | undefined): boolean {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * Build a production go-live readiness report. PURE INSPECTION: reads env +
 * bounded DB probes only. Never runs a command, never calls a model, never
 * applies a migration, never logs or returns a secret VALUE.
 */
export async function getProductionReadinessReport(
  opts: { env?: Env; repo?: AiOrchestratorRepository } = {},
): Promise<ReadinessReport> {
  const env = opts.env ?? process.env;
  const repo = opts.repo ?? getRepository();
  const isProd = isProductionEnv(env);
  const environment: ReadinessReport["environment"] = isProd
    ? "production"
    : env.NODE_ENV === "test"
      ? "test"
      : "development";

  const checks: ReadinessCheck[] = [];
  const add = (c: ReadinessCheck) => checks.push(c);

  let dbProvider = "unknown";
  try {
    dbProvider = resolveDbProvider();
  } catch {
    dbProvider = "invalid";
  }

  // 1) Production DB provider ------------------------------------------------
  if (!isProd) {
    add({
      id: "db_provider",
      name: "Database provider",
      status: "skip",
      severity: "critical",
      message: `Non-production (${environment}); provider=${dbProvider}.`,
    });
  } else if (dbProvider === "postgres") {
    add({
      id: "db_provider",
      name: "Database provider",
      status: "pass",
      severity: "critical",
      message: "Production uses Postgres.",
    });
  } else {
    add({
      id: "db_provider",
      name: "Database provider",
      status: "fail",
      severity: "critical",
      message: `Production must use Postgres, not "${dbProvider}" (SQLite is ephemeral on serverless).`,
      remediation: "Set AI_ORCHESTRATOR_DB_PROVIDER=postgres.",
    });
  }

  // 2) Supabase env ----------------------------------------------------------
  const needsSupabase = isProd || dbProvider === "postgres";
  if (!needsSupabase) {
    add({
      id: "supabase_env",
      name: "Supabase env",
      status: "skip",
      severity: "critical",
      message: "SQLite backend — Supabase env not required.",
    });
  } else {
    const missing: string[] = [];
    if (!present(env.SUPABASE_URL)) missing.push("SUPABASE_URL");
    if (!present(env.SUPABASE_SERVICE_ROLE_KEY))
      missing.push("SUPABASE_SERVICE_ROLE_KEY");
    if (missing.length) {
      add({
        id: "supabase_env",
        name: "Supabase env",
        status: "fail",
        severity: "critical",
        message: `Missing Supabase env: ${missing.join(", ")}.`,
        remediation:
          "Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (server-side only).",
      });
    } else {
      add({
        id: "supabase_env",
        name: "Supabase env",
        status: "pass",
        severity: "critical",
        message: "Supabase URL + service-role key are configured.",
      });
    }
  }

  // 3) DB ping ---------------------------------------------------------------
  let dbReachable = false;
  try {
    await repo.ping();
    dbReachable = true;
    add({
      id: "db_ping",
      name: "Database connectivity",
      status: "pass",
      severity: "critical",
      message: "Repository ping succeeded.",
    });
  } catch (err) {
    add({
      id: "db_ping",
      name: "Database connectivity",
      status: "fail",
      severity: "critical",
      message: `Repository ping failed: ${(err as Error)?.message ?? "unknown"}`,
      remediation: "Verify DB credentials + network reachability.",
    });
  }

  // 4) Schema: tables + columns ---------------------------------------------
  if (!dbReachable) {
    add({
      id: "schema_tables",
      name: "Required tables",
      status: "skip",
      severity: "critical",
      message: "Skipped — database unreachable.",
    });
    add({
      id: "schema_columns",
      name: "Required columns",
      status: "skip",
      severity: "critical",
      message: "Skipped — database unreachable.",
    });
  } else {
    const missingTables: string[] = [];
    for (const t of REQUIRED_TABLES) {
      if (!(await repo.probeTableColumn(t, "*"))) missingTables.push(t);
    }
    add(
      missingTables.length
        ? {
            id: "schema_tables",
            name: "Required tables",
            status: "fail",
            severity: "critical",
            message: `Missing tables: ${missingTables.join(", ")}.`,
            remediation:
              "Apply the Postgres migrations in order (001_init … 011_orchestration_resume_lock).",
          }
        : {
            id: "schema_tables",
            name: "Required tables",
            status: "pass",
            severity: "critical",
            message: `All ${REQUIRED_TABLES.length} core tables present.`,
          },
    );

    const missingCols: string[] = [];
    const colRemediation: string[] = [];
    for (const c of REQUIRED_COLUMNS) {
      if (!(await repo.probeTableColumn(c.table, c.column))) {
        missingCols.push(`${c.table}.${c.column}`);
        colRemediation.push(c.migration);
      }
    }
    add(
      missingCols.length
        ? {
            id: "schema_columns",
            name: "Required columns",
            status: "fail",
            severity: "critical",
            message: `Missing columns: ${missingCols.join(", ")}.`,
            remediation: `Apply migration(s): ${[...new Set(colRemediation)].join(", ")}.`,
          }
        : {
            id: "schema_columns",
            name: "Required columns",
            status: "pass",
            severity: "critical",
            message: "Migration columns (patch content, resume lock) present.",
          },
    );
  }

  // 5) Worker claim / lease verification ------------------------------------
  const claimVerified = env.AI_ORCHESTRATOR_WORKER_CLAIM_VERIFIED === "1";
  const leaseVerified = env.AI_ORCHESTRATOR_WORKER_LEASE_VERIFIED === "1";
  const concurrency = Math.max(
    1,
    parseInt(env.AI_ORCHESTRATOR_WORKER_CONCURRENCY || "1", 10) || 1,
  );
  const verifyRemediation =
    "Run `npm run smoke:worker-claim` + `npm run smoke:worker-lease`, then set " +
    "AI_ORCHESTRATOR_WORKER_CLAIM_VERIFIED=1 and AI_ORCHESTRATOR_WORKER_LEASE_VERIFIED=1.";
  if (!isProd) {
    add({
      id: "worker_verification",
      name: "Worker claim/lease verified",
      status: "skip",
      severity: "high",
      message: "Non-production — verification not required.",
    });
  } else if (claimVerified && leaseVerified) {
    add({
      id: "worker_verification",
      name: "Worker claim/lease verified",
      status: "pass",
      severity: "high",
      message: "Atomic claim + lease renewal verified.",
    });
  } else if (concurrency > 1) {
    add({
      id: "worker_verification",
      name: "Worker claim/lease verified",
      status: "fail",
      severity: "high",
      message: `Concurrency ${concurrency} but claim/lease not verified (race + stuck-lease risk).`,
      remediation: verifyRemediation,
    });
  } else {
    add({
      id: "worker_verification",
      name: "Worker claim/lease verified",
      status: "warn",
      severity: "high",
      message: "Single worker, but atomic claim/lease are not verified yet.",
      remediation: verifyRemediation,
    });
  }

  // 6) Worker config ---------------------------------------------------------
  let workerProvider = "database";
  try {
    workerProvider = resolveWorkerProvider(env.AI_ORCHESTRATOR_WORKER_PROVIDER);
  } catch {
    workerProvider = "invalid";
  }
  const repoCloneConfigured =
    present(env.AI_ORCHESTRATOR_REPO_CLONE_URL) ||
    resolveGithubConfig(env).config !== null;
  const leaseSeconds = resolveLeaseSeconds();
  const heartbeatMs = resolveHeartbeatIntervalMs();
  if (!isProd) {
    add({
      id: "worker_config",
      name: "Worker configuration",
      status: "skip",
      severity: "high",
      message: "Non-production — worker config not enforced.",
    });
  } else {
    const issues: string[] = [];
    if (workerProvider !== "database")
      issues.push("AI_ORCHESTRATOR_WORKER_PROVIDER must be 'database'");
    if (!repoCloneConfigured)
      issues.push("AI_ORCHESTRATOR_REPO_CLONE_URL must be set");
    if (heartbeatMs >= leaseSeconds * 1000)
      issues.push(
        `heartbeat ${heartbeatMs}ms must be < lease ${leaseSeconds}s (×1000)`,
      );
    add(
      issues.length
        ? {
            id: "worker_config",
            name: "Worker configuration",
            status: "fail",
            severity: "high",
            message: issues.join("; ") + ".",
            remediation:
              "Set worker provider=database, a repo clone URL, and heartbeat < lease.",
          }
        : {
            id: "worker_config",
            name: "Worker configuration",
            status: "pass",
            severity: "high",
            message: `provider=database, repo clone set, heartbeat ${heartbeatMs}ms < lease ${leaseSeconds}s.`,
          },
    );
  }

  // 7) Test runner mode ------------------------------------------------------
  const testRunnerMode = resolveTestRunnerMode(env);
  if (!isProd) {
    add({
      id: "test_runner_mode",
      name: "Test runner mode",
      status: "skip",
      severity: "high",
      message: `Non-production (mode=${testRunnerMode}).`,
    });
  } else if (testRunnerMode === "worker_async") {
    add({
      id: "test_runner_mode",
      name: "Test runner mode",
      status: "pass",
      severity: "high",
      message: "worker_async (request never holds a long build).",
    });
  } else if (testRunnerMode === "worker_wait") {
    add({
      id: "test_runner_mode",
      name: "Test runner mode",
      status: "warn",
      severity: "high",
      message: "worker_wait holds the request — may exceed the platform timeout.",
      remediation: "Set AI_ORCHESTRATOR_TEST_RUNNER_MODE=worker_async.",
    });
  } else if (inlineCommandsAllowed(env)) {
    add({
      id: "test_runner_mode",
      name: "Test runner mode",
      status: "warn",
      severity: "high",
      message:
        "inline commands explicitly allowed in production (risky, but intentional).",
      remediation: "Prefer worker_async; unset AI_ORCHESTRATOR_ALLOW_INLINE_COMMANDS.",
    });
  } else {
    add({
      id: "test_runner_mode",
      name: "Test runner mode",
      status: "fail",
      severity: "critical",
      message: "inline TEST_RUNNER would spawn commands in a production request.",
      remediation: "Set AI_ORCHESTRATOR_TEST_RUNNER_MODE=worker_async + run the worker.",
    });
  }

  // 8) Cron resume -----------------------------------------------------------
  const cronKey = resolveCronKey(env);
  if (!isProd || testRunnerMode !== "worker_async") {
    add({
      id: "cron_resume",
      name: "Cron resume",
      status: "skip",
      severity: "high",
      message: "Only relevant for production worker_async.",
    });
  } else if (!present(cronKey)) {
    add({
      id: "cron_resume",
      name: "Cron resume",
      status: "fail",
      severity: "high",
      message:
        "worker_async without AI_ORCHESTRATOR_CRON_KEY — finished runs never auto-resume.",
      remediation:
        "Set AI_ORCHESTRATOR_CRON_KEY and schedule POST /api/ai-orchestrator/cron/resume.",
    });
  } else if (present(env.CRON_SECRET) && env.CRON_SECRET !== cronKey) {
    add({
      id: "cron_resume",
      name: "Cron resume",
      status: "warn",
      severity: "medium",
      message: "CRON_SECRET is set but differs from AI_ORCHESTRATOR_CRON_KEY.",
      remediation:
        "For Vercel Cron set CRON_SECRET = AI_ORCHESTRATOR_CRON_KEY (Bearer auth).",
    });
  } else {
    add({
      id: "cron_resume",
      name: "Cron resume",
      status: "pass",
      severity: "high",
      message: "Cron key configured for scheduled resume.",
    });
  }

  // 8b) Cron query-key fallback ---------------------------------------------
  add(
    cronQueryKeyAllowed(env)
      ? {
          id: "cron_query_key",
          name: "Cron query-token fallback",
          status: "warn",
          severity: "medium",
          message:
            "AI_ORCHESTRATOR_ALLOW_CRON_QUERY_KEY=1 — query tokens can leak via logs/referrers.",
          remediation: "Prefer a header; unset AI_ORCHESTRATOR_ALLOW_CRON_QUERY_KEY.",
        }
      : {
          id: "cron_query_key",
          name: "Cron query-token fallback",
          status: "pass",
          severity: "low",
          message: "Query-token fallback disabled (header-only).",
        },
  );

  // 9) Model keys ------------------------------------------------------------
  const hasOpenAI = present(env.OPENAI_API_KEY);
  const hasAnthropic = present(env.ANTHROPIC_API_KEY);
  if (!isProd) {
    add({
      id: "model_keys",
      name: "Model API keys",
      status: "skip",
      severity: "high",
      message: "Non-production — mock mode is fine.",
    });
  } else if (hasOpenAI && hasAnthropic) {
    add({
      id: "model_keys",
      name: "Model API keys",
      status: "pass",
      severity: "high",
      message: "OpenAI + Anthropic keys present.",
    });
  } else {
    const missing = [
      !hasOpenAI ? "OPENAI_API_KEY" : null,
      !hasAnthropic ? "ANTHROPIC_API_KEY" : null,
    ].filter(Boolean);
    add({
      id: "model_keys",
      name: "Model API keys",
      status: "fail",
      severity: "high",
      message: `Missing ${missing.join(" + ")} — production would run mock/incorrect output.`,
      remediation: "Set OPENAI_API_KEY and ANTHROPIC_API_KEY on the control plane.",
    });
  }

  // 10) GitHub PR flow -------------------------------------------------------
  const ghFlags = resolveGithubFlags(env);
  if (!ghFlags.enableGithubPr) {
    add({
      id: "github_pr",
      name: "GitHub PR flow",
      status: "skip",
      severity: "medium",
      message: "GitHub PR flow disabled (AI_ORCHESTRATOR_ENABLE_GITHUB_PR != 1).",
    });
  } else {
    const missing: string[] = [];
    if (!present(env.GITHUB_TOKEN)) missing.push("GITHUB_TOKEN");
    if (!present(env.GITHUB_OWNER)) missing.push("GITHUB_OWNER");
    if (!present(env.GITHUB_REPO)) missing.push("GITHUB_REPO");
    if (ghFlags.dryRun) {
      add({
        id: "github_pr",
        name: "GitHub PR flow",
        status: "warn",
        severity: "medium",
        message:
          "GitHub PR enabled in DRY-RUN — no live PRs are created" +
          (missing.length ? ` (also missing ${missing.join(", ")})` : "") +
          ".",
        remediation:
          "For live PRs set AI_ORCHESTRATOR_PR_DRY_RUN=0 + AI_ORCHESTRATOR_EXECUTE_TESTS=1.",
      });
    } else if (missing.length) {
      add({
        id: "github_pr",
        name: "GitHub PR flow",
        status: "fail",
        severity: "high",
        message: `Live PR mode but missing ${missing.join(", ")}.`,
        remediation: "Set GITHUB_TOKEN / GITHUB_OWNER / GITHUB_REPO (server-side).",
      });
    } else {
      add({
        id: "github_pr",
        name: "GitHub PR flow",
        status: "pass",
        severity: "high",
        message: "Live PR mode configured (token + owner + repo present).",
      });
    }
  }

  // 11) RBAC: owner + active API key ----------------------------------------
  if (!isProd) {
    add({
      id: "rbac_owner",
      name: "Active owner",
      status: "skip",
      severity: "high",
      message: "Non-production — owner bootstrap not enforced.",
    });
    add({
      id: "rbac_api_key",
      name: "Active API key",
      status: "skip",
      severity: "high",
      message: "Non-production — API key not enforced.",
    });
  } else if (!dbReachable) {
    add({
      id: "rbac_owner",
      name: "Active owner",
      status: "skip",
      severity: "high",
      message: "Skipped — database unreachable.",
    });
    add({
      id: "rbac_api_key",
      name: "Active API key",
      status: "skip",
      severity: "high",
      message: "Skipped — database unreachable.",
    });
  } else {
    try {
      const users = await repo.listUsers(200);
      const hasOwner = users.some(
        (u) => u.role === "owner" && u.status === "active",
      );
      add({
        id: "rbac_owner",
        name: "Active owner",
        status: hasOwner ? "pass" : "fail",
        severity: "high",
        message: hasOwner
          ? "At least one active owner exists."
          : "No active owner account.",
        remediation: hasOwner ? undefined : "Run `npm run ai:create-owner`.",
      });

      let hasActiveKey = false;
      for (const u of users) {
        if (u.status !== "active") continue;
        const keys = await repo.listApiKeysForUser(u.id);
        if (keys.some((k) => k.status === "active")) {
          hasActiveKey = true;
          break;
        }
      }
      add({
        id: "rbac_api_key",
        name: "Active API key",
        status: hasActiveKey ? "pass" : "fail",
        severity: "high",
        message: hasActiveKey
          ? "At least one active API key exists."
          : "No active API key — no one can authenticate.",
        remediation: hasActiveKey
          ? undefined
          : "Create an API key (`npm run ai:create-owner` mints one for the owner).",
      });
    } catch (err) {
      add({
        id: "rbac_owner",
        name: "Active owner",
        status: "fail",
        severity: "high",
        message: `RBAC check failed: ${(err as Error)?.message ?? "unknown"}`,
      });
    }
  }

  // 11b) Legacy admin key ----------------------------------------------------
  const legacyAdminOn = env.AI_ORCHESTRATOR_ALLOW_LEGACY_ADMIN_KEY === "1";
  if (isProd && legacyAdminOn) {
    add({
      id: "legacy_admin_key",
      name: "Legacy admin key",
      status: "warn",
      severity: "high",
      message:
        "Legacy x-ai-admin-key is enabled in production (broad owner-level access).",
      remediation: "Unset AI_ORCHESTRATOR_ALLOW_LEGACY_ADMIN_KEY once every caller uses an API key.",
    });
  } else {
    add({
      id: "legacy_admin_key",
      name: "Legacy admin key",
      status: "pass",
      severity: "low",
      message: "Legacy admin key not enabled.",
    });
  }

  // 12) Rate limit -----------------------------------------------------------
  let rlProvider = "memory";
  try {
    rlProvider = resolveRateLimitProvider();
  } catch {
    rlProvider = "invalid";
  }
  if (!isProd) {
    add({
      id: "rate_limit",
      name: "Rate limiter",
      status: "skip",
      severity: "high",
      message: `Non-production (provider=${rlProvider}).`,
    });
  } else if (rlProvider === "upstash") {
    const missing: string[] = [];
    if (!present(env.UPSTASH_REDIS_REST_URL))
      missing.push("UPSTASH_REDIS_REST_URL");
    if (!present(env.UPSTASH_REDIS_REST_TOKEN))
      missing.push("UPSTASH_REDIS_REST_TOKEN");
    add(
      missing.length
        ? {
            id: "rate_limit",
            name: "Rate limiter",
            status: "fail",
            severity: "high",
            message: `Upstash selected but missing ${missing.join(", ")}.`,
            remediation: "Set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN.",
          }
        : {
            id: "rate_limit",
            name: "Rate limiter",
            status: "pass",
            severity: "high",
            message: "Upstash distributed rate limiting configured.",
          },
    );
  } else {
    add({
      id: "rate_limit",
      name: "Rate limiter",
      status: "warn",
      severity: "high",
      message: `In-memory rate limiting in production (not correct across instances).`,
      remediation:
        "Set AI_ORCHESTRATOR_RATE_LIMIT_PROVIDER=upstash + Upstash credentials.",
    });
  }

  // 13) Audit log ------------------------------------------------------------
  if (!dbReachable) {
    add({
      id: "audit_log",
      name: "Audit log",
      status: "skip",
      severity: "high",
      message: "Skipped — database unreachable.",
    });
  } else {
    try {
      const auditTable = await repo.probeTableColumn("ai_audit_logs", "id");
      await repo.getAuditLogs(1); // read-only; never writes a secret
      add({
        id: "audit_log",
        name: "Audit log",
        status: auditTable ? "pass" : "fail",
        severity: "high",
        message: auditTable
          ? "ai_audit_logs present and readable."
          : "ai_audit_logs missing.",
        remediation: auditTable
          ? undefined
          : "Apply migration 002_ai_audit_logs.sql.",
      });
    } catch (err) {
      add({
        id: "audit_log",
        name: "Audit log",
        status: "fail",
        severity: "high",
        message: `Audit log check failed: ${(err as Error)?.message ?? "unknown"}`,
      });
    }
  }

  // 14) Smoke flags ----------------------------------------------------------
  if (!isProd) {
    add({
      id: "smoke_flags",
      name: "Smoke verification flags",
      status: "skip",
      severity: "high",
      message: "Non-production — smoke evidence not required.",
    });
  } else {
    const missing: string[] = [];
    if (!present(env.AI_ORCHESTRATOR_SUPABASE_SMOKE_PASSED_AT))
      missing.push("AI_ORCHESTRATOR_SUPABASE_SMOKE_PASSED_AT");
    if (!claimVerified) missing.push("AI_ORCHESTRATOR_WORKER_CLAIM_VERIFIED");
    if (!leaseVerified) missing.push("AI_ORCHESTRATOR_WORKER_LEASE_VERIFIED");
    add(
      missing.length
        ? {
            id: "smoke_flags",
            name: "Smoke verification flags",
            status: "warn",
            severity: "high",
            message: `Missing smoke evidence: ${missing.join(", ")}.`,
            remediation:
              "Run `npm run smoke:supabase`, `npm run smoke:worker-claim`, `npm run smoke:worker-lease`, then set the flags.",
          }
        : {
            id: "smoke_flags",
            name: "Smoke verification flags",
            status: "pass",
            severity: "high",
            message: "Supabase + claim + lease smoke flags recorded.",
          },
    );
  }

  // 15) Unsafe NEXT_PUBLIC secrets ------------------------------------------
  const leaked = UNSAFE_PUBLIC_KEYS.filter((k) => present(env[k]));
  add(
    leaked.length
      ? {
          id: "unsafe_public_secrets",
          name: "Unsafe NEXT_PUBLIC secrets",
          status: "fail",
          severity: "critical",
          message: `Secret(s) exposed to the browser via: ${leaked.join(", ")}.`,
          remediation:
            "Remove every NEXT_PUBLIC_* secret — these ship to the client bundle.",
        }
      : {
          id: "unsafe_public_secrets",
          name: "Unsafe NEXT_PUBLIC secrets",
          status: "pass",
          severity: "critical",
          message: "No secrets exposed via NEXT_PUBLIC_*.",
        },
  );

  const summary = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const c of checks) summary[c.status]++;

  return {
    ok: summary.fail === 0,
    environment,
    checks,
    summary,
    timestamp: new Date().toISOString(),
  };
}

/** True when any FAILED check is critical/high — the route returns 503. */
export function hasBlockingFailure(report: ReadinessReport): boolean {
  return report.checks.some(
    (c) =>
      c.status === "fail" &&
      (c.severity === "critical" || c.severity === "high"),
  );
}
