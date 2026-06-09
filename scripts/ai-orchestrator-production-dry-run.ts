/**
 * Production dry-run go-live verification (CLI).
 *
 *   npm run prod:dry-run                       # read-only go/no-go report
 *   npm run prod:dry-run -- --json             # machine-readable JSON
 *   npm run prod:dry-run -- --create-test-session
 *
 * READ-ONLY by default: aggregates readiness + health + dry-run safety gates.
 * It never deploys, applies a migration, edits env, creates a live PR, merges,
 * pushes, calls a model, or prints a secret VALUE. Exit 0 when dry_run_safe,
 * else exit 1.
 *
 * --create-test-session runs one real (model-calling) orchestration, and ONLY
 * when AI_ORCHESTRATOR_PROD_DRY_RUN_ALLOW_MODEL_CALLS=1 — otherwise it is
 * skipped. It never creates a live PR.
 */
import { redactSecrets } from "../lib/ai-orchestrator/security/redact";
import {
  getProductionDryRunStatus,
  ProductionDryRunStatus,
} from "../lib/ai-orchestrator/production-dry-run";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TERMINAL = new Set(["passed", "failed", "needs_revision", "cancelled"]);

function printHuman(status: ProductionDryRunStatus): void {
  console.log(
    `\nProduction dry-run check (${status.environment}) — ` +
      `dry_run_safe=${status.dry_run_safe}`,
  );
  console.log("─".repeat(72));
  console.log(
    `  readiness: ${status.readiness.ok ? "ok" : "NOT ok"} ` +
      `(PASS ${status.readiness.summary.pass} WARN ${status.readiness.summary.warn} ` +
      `FAIL ${status.readiness.summary.fail} SKIP ${status.readiness.summary.skip})`,
  );
  console.log(
    `  health: db=${status.health.db_status} rate_limit=${status.health.rate_limit_status} ` +
      `worker=${status.health.worker_provider} mode=${status.health.test_runner_mode} ` +
      `cron=${status.health.cron_key_configured ? "set" : "off"} ` +
      `pr_dry_run=${status.health.github_pr_dry_run}`,
  );
  console.log("─".repeat(72));
  if (status.blockers.length) {
    console.log("  BLOCKERS:");
    for (const b of status.blockers) console.log(`    ✗ ${b}`);
  } else {
    console.log("  BLOCKERS: none");
  }
  if (status.warnings.length) {
    console.log("  WARNINGS:");
    for (const w of status.warnings) console.log(`    ! ${w}`);
  }
  console.log("  NEXT ACTIONS:");
  for (const a of status.next_actions) console.log(`    → ${a}`);
  console.log("─".repeat(72));
  console.log(
    status.dry_run_safe
      ? "  RESULT: SAFE FOR DRY-RUN."
      : "  RESULT: NOT SAFE — resolve blockers first.",
  );
  console.log("");
}

async function maybeCreateTestSession(safe: boolean): Promise<void> {
  if (!safe) {
    console.log("[dry-run] --create-test-session skipped: environment not safe.");
    return;
  }
  if (process.env.AI_ORCHESTRATOR_PROD_DRY_RUN_ALLOW_MODEL_CALLS !== "1") {
    console.log(
      "[dry-run] --create-test-session skipped: set " +
        "AI_ORCHESTRATOR_PROD_DRY_RUN_ALLOW_MODEL_CALLS=1 to run a real " +
        "(model-calling) test orchestration. No model was called.",
    );
    return;
  }

  const { startOrchestrationSystem, resumeOrchestrationSystem, getRepository } =
    await import("../lib/ai-orchestrator/service");
  const repo = getRepository();
  const started = await startOrchestrationSystem(
    "Dry-run smoke: add a harmless code comment; do not change behavior.",
    false,
  );
  console.log(
    `[dry-run] started orchestration ${started.orchestrationRunId} ` +
      `(worker job ${started.workerJobId ?? "none"}); polling…`,
  );

  const timeoutMs = parseInt(
    process.env.AI_ORCHESTRATOR_PROD_DRY_RUN_TIMEOUT_MS || "300000",
    10,
  );
  const startedAt = Date.now();
  let run = await repo.getOrchestrationRun(started.orchestrationRunId);
  while (run && !TERMINAL.has(run.status) && Date.now() - startedAt < timeoutMs) {
    await sleep(5000);
    // Resume drives review→QA once the worker job is terminal (no-op while queued).
    await resumeOrchestrationSystem(started.orchestrationRunId).catch(() => {});
    run = await repo.getOrchestrationRun(started.orchestrationRunId);
  }
  console.log(
    `[dry-run] orchestration ${started.orchestrationRunId} final status=` +
      `${run?.status ?? "unknown"} (round ${run?.current_round ?? "?"}). ` +
      "No live PR was created.",
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const createSession = args.includes("--create-test-session");

  const status = await getProductionDryRunStatus();

  if (asJson) console.log(JSON.stringify(status, null, 2));
  else printHuman(status);

  if (createSession) await maybeCreateTestSession(status.dry_run_safe);

  process.exit(status.dry_run_safe ? 0 : 1);
}

main().catch((err) => {
  console.error(
    "[prod:dry-run] FATAL:",
    redactSecrets(String((err as Error)?.message ?? err)),
  );
  process.exit(1);
});
