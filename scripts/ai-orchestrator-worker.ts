/**
 * Sandbox worker (execution plane).
 *
 *   npm run ai:worker             # continuous polling loop
 *   npm run ai:worker -- --once   # drain currently-queued jobs, then exit (cron)
 *
 * Polls the job queue, claims jobs with a lease, runs allowlisted commands in an
 * isolated workspace, and writes redacted logs + results back to the DB. It
 * NEVER prints secrets and never opens a shell. Refuses unsafe production config
 * (local provider / inline commands) at startup.
 */
import { redactSecrets } from "../lib/ai-orchestrator/security/redact";
import {
  assertWorkerConfig,
  getJobQueue,
} from "../lib/ai-orchestrator/worker/job-queue";
import type { JobQueue } from "../lib/ai-orchestrator/worker/types";
import { pollAndRunOnce } from "../lib/ai-orchestrator/worker/job-service";

const WORKER_ID = process.env.AI_ORCHESTRATOR_WORKER_ID || "worker-1";
const CONCURRENCY = Math.max(
  1,
  parseInt(process.env.AI_ORCHESTRATOR_WORKER_CONCURRENCY || "1", 10) || 1,
);
const POLL_MS = Math.max(
  250,
  parseInt(process.env.AI_ORCHESTRATOR_WORKER_POLL_INTERVAL_MS || "3000", 10) ||
    3000,
);

let stopping = false;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Optional (off by default): resume async orchestrations whose job finished.
 * Skipped without model keys — resume calls the code reviewer + QA judge, so a
 * keyless worker would produce mock verdicts. The control-plane API is primary.
 */
async function maybeAutoResume(): Promise<void> {
  if (process.env.AI_ORCHESTRATOR_WORKER_AUTO_RESUME !== "1") return;
  if (!process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY) {
    console.warn(
      "[worker] AUTO_RESUME=1 but no model keys — skipping (control-plane resume is primary).",
    );
    return;
  }
  try {
    const { autoResumeReadyOrchestrations } = await import(
      "../lib/ai-orchestrator/service"
    );
    const n = await autoResumeReadyOrchestrations();
    if (n > 0) console.log(`[worker] auto-resumed ${n} orchestration(s).`);
  } catch (err) {
    console.error(
      `[worker] auto-resume error: ${redactSecrets((err as Error).message)}`,
    );
  }
}

/** Claim + run up to CONCURRENCY jobs per pass; repeat until none claimable. */
async function drain(queue: JobQueue): Promise<number> {
  let processed = 0;
  for (;;) {
    if (stopping) break;
    const batch = Array.from({ length: CONCURRENCY }, () =>
      pollAndRunOnce(queue, WORKER_ID),
    );
    const results = await Promise.all(batch);
    const ran = results.filter(Boolean).length;
    processed += ran;
    if (ran === 0) break;
  }
  return processed;
}

async function main(): Promise<void> {
  const once = process.argv.includes("--once");
  assertWorkerConfig(); // refuse local provider / inline commands in production
  const queue = getJobQueue();
  console.log(
    `[worker] ${WORKER_ID} starting (concurrency=${CONCURRENCY}, poll=${POLL_MS}ms, once=${once})`,
  );

  if (once) {
    const n = await drain(queue);
    await maybeAutoResume();
    console.log(`[worker] drained ${n} job(s); exiting.`);
    process.exit(0);
  }

  process.on("SIGINT", () => {
    stopping = true;
  });
  process.on("SIGTERM", () => {
    stopping = true;
  });

  while (!stopping) {
    try {
      const ran = await drain(queue);
      await maybeAutoResume();
      if (ran === 0) await sleep(POLL_MS);
    } catch (err) {
      console.error(`[worker] loop error: ${redactSecrets((err as Error).message)}`);
      await sleep(POLL_MS);
    }
  }
  console.log("[worker] stopped.");
  process.exit(0);
}

main().catch((err) => {
  console.error("[worker] FATAL:", redactSecrets((err as Error).message));
  process.exit(1);
});
