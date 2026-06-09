import { getRepository } from "./db/factory";
import type { AiOrchestratorRepository } from "./db/repository.interface";
import {
  getProductionReadinessReport,
  ReadinessReport,
} from "./production-readiness";
import { getHealthReport } from "./health";
import {
  inlineCommandsAllowed,
  isProductionEnv,
  resolveWorkerProvider,
} from "./worker/job-queue";
import { resolveTestRunnerMode } from "./test-runner-worker";
import { resolveCronKey } from "./security/cron-auth";
import { resolveGithubFlags } from "./github/github-client";

type Env = Record<string, string | undefined>;

export interface DryRunHealthSummary {
  ok: boolean;
  db_status: string;
  rate_limit_status: string;
  worker_provider: string;
  test_runner_mode: string;
  cron_key_configured: boolean;
  has_openai_key: boolean;
  has_anthropic_key: boolean;
  repo_clone_configured: boolean;
  github_pr_enabled: boolean;
  github_pr_dry_run: boolean;
}

export interface ProductionDryRunStatus {
  /** True when there are no blockers — safe to run the dry-run go-live steps. */
  dry_run_safe: boolean;
  environment: ReadinessReport["environment"];
  blockers: string[];
  warnings: string[];
  next_actions: string[];
  readiness: {
    ok: boolean;
    environment: ReadinessReport["environment"];
    summary: ReadinessReport["summary"];
  };
  health: DryRunHealthSummary;
  timestamp: string;
}

// Readiness checks the dry-run evaluates directly (env-aware, not isProd-gated),
// so we skip them when folding the readiness report into blockers/warnings.
const READINESS_OVERRIDDEN = new Set([
  "worker_config",
  "test_runner_mode",
  "github_pr",
  "cron_resume",
  "cron_query_key",
]);

/**
 * Aggregate readiness + health + dry-run-specific safety gates into a single
 * go/no-go view. PURE INSPECTION: never creates a session, calls a model, runs
 * a command, applies a migration, or returns a secret VALUE.
 */
export async function getProductionDryRunStatus(
  opts: { env?: Env; repo?: AiOrchestratorRepository } = {},
): Promise<ProductionDryRunStatus> {
  const env = opts.env ?? process.env;
  const repo = opts.repo ?? getRepository();
  const isProd = isProductionEnv(env);

  const readiness = await getProductionReadinessReport({ env, repo });
  const health = await getHealthReport();

  const blockers: string[] = [];
  const warnings: string[] = [];

  // 1) Fold in readiness (minus the items the dry-run evaluates itself).
  for (const c of readiness.checks) {
    if (READINESS_OVERRIDDEN.has(c.id)) continue;
    if (c.status === "fail" && (c.severity === "critical" || c.severity === "high")) {
      blockers.push(`${c.name}: ${c.message}`);
    } else if (c.status === "warn") {
      warnings.push(`${c.name}: ${c.message}`);
    }
  }

  // 2) Dry-run-specific gates (evaluated in any environment).
  const mode = resolveTestRunnerMode(env);
  if (mode !== "worker_async") {
    blockers.push(
      `Test runner must be worker_async for a dry-run go-live (got "${mode}").`,
    );
  }

  let workerProvider = "database";
  try {
    workerProvider = resolveWorkerProvider(env.AI_ORCHESTRATOR_WORKER_PROVIDER);
  } catch {
    workerProvider = "invalid";
  }
  if (workerProvider !== "database") {
    blockers.push(
      `Worker provider must be 'database' (got "${workerProvider}").`,
    );
  }

  if (inlineCommandsAllowed(env)) {
    blockers.push(
      "AI_ORCHESTRATOR_ALLOW_INLINE_COMMANDS=1 — inline command execution must be OFF for a safe dry-run.",
    );
  }

  // 3) PR flow must be in DRY-RUN (no live PR / merge / push).
  const ghFlags = resolveGithubFlags(env);
  if (env.AI_ORCHESTRATOR_PR_DRY_RUN === "0") {
    blockers.push(
      "AI_ORCHESTRATOR_PR_DRY_RUN=0 — live PR mode is ON. A dry-run requires PR_DRY_RUN=1 (never a live PR/merge/push).",
    );
  } else if (!ghFlags.enableGithubPr) {
    warnings.push(
      "GitHub PR flow disabled (AI_ORCHESTRATOR_ENABLE_GITHUB_PR != 1) — the dry-run PR step (validate → sandbox tests → dry-run PR) will be skipped.",
    );
  }

  // 4) Cron resume for worker_async.
  if (mode === "worker_async" && !resolveCronKey(env)) {
    const msg =
      "worker_async without AI_ORCHESTRATOR_CRON_KEY — finished runs do not auto-resume.";
    if (isProd) blockers.push(msg);
    else warnings.push(msg + " (manual resume only outside production)");
  }

  const dry_run_safe = blockers.length === 0;

  return {
    dry_run_safe,
    environment: readiness.environment,
    blockers,
    warnings,
    next_actions: buildNextActions(dry_run_safe, warnings.length > 0),
    readiness: {
      ok: readiness.ok,
      environment: readiness.environment,
      summary: readiness.summary,
    },
    health: {
      ok: health.ok,
      db_status: health.db_status,
      rate_limit_status: health.rate_limit_status,
      worker_provider: health.worker_provider,
      test_runner_mode: health.test_runner_mode,
      cron_key_configured: health.cron_key_configured,
      has_openai_key: health.has_openai_key,
      has_anthropic_key: health.has_anthropic_key,
      repo_clone_configured: health.repo_clone_configured,
      github_pr_enabled: health.github_pr_enabled,
      github_pr_dry_run: health.github_pr_dry_run,
    },
    timestamp: new Date().toISOString(),
  };
}

function buildNextActions(safe: boolean, hasWarnings: boolean): string[] {
  if (!safe) {
    return [
      "Resolve the blockers above, then re-run `npm run prod:dry-run`.",
      "Follow docs/production-dry-run-runbook.md step by step.",
    ];
  }
  const actions = [
    "Start the sandbox worker (`npm run ai:worker`) if it is not already running.",
    "Run a dry-run orchestration: POST /api/ai-orchestrator/run (expect 202), let the worker + cron drive it to a terminal status.",
    "Run the dry-run PR flow: Validate Patch → Run Patch Tests in sandbox → Create PR with AI_ORCHESTRATOR_PR_DRY_RUN=1.",
    "Confirm the audit log has `ai_pr_dry_run_completed` and that NO real branch/PR was created.",
  ];
  if (hasWarnings) {
    actions.unshift("Review the warnings above — accept with a reason, or fix.");
  }
  return actions;
}
