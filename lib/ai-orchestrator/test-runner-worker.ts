import { WorkerJobRecord } from "./types";
import type { AuditEventType } from "./types";
import {
  CommandResult,
  TestExecutor,
  TestReport,
  TestStepResult,
} from "./test-runner";
import { inlineCommandsAllowed, isProductionEnv } from "./worker/job-queue";
import { JobQueue } from "./worker/types";

export type TestRunnerMode = "inline" | "worker_wait" | "worker_async";

/**
 * Resolve the TEST_RUNNER mode. Default: worker_async in production, inline in
 * dev/test. `worker` is a legacy alias for `worker_wait` (Phase 7.2).
 */
export function resolveTestRunnerMode(
  env: Record<string, string | undefined> = process.env,
): TestRunnerMode {
  const raw = (env.AI_ORCHESTRATOR_TEST_RUNNER_MODE ?? "").trim().toLowerCase();
  if (raw === "inline") return "inline";
  if (raw === "worker_wait" || raw === "worker") return "worker_wait";
  if (raw === "worker_async") return "worker_async";
  return isProductionEnv(env) ? "worker_async" : "inline";
}

export function resolveTestJobTimeoutMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const v = parseInt(env.AI_ORCHESTRATOR_TEST_JOB_TIMEOUT_MS || "900000", 10);
  return Number.isFinite(v) && v >= 1 ? v : 900000;
}

export function resolveTestJobPollMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const v = parseInt(env.AI_ORCHESTRATOR_TEST_JOB_POLL_MS || "3000", 10);
  return Number.isFinite(v) && v >= 1 ? v : 3000;
}

export class TestRunnerModeBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TestRunnerModeBlockedError";
  }
}

/**
 * Refuse inline TEST_RUNNER in production unless explicitly (and riskily)
 * allowed. Production must route tests through the sandbox worker.
 */
export function assertTestRunnerModeAllowed(
  env: Record<string, string | undefined> = process.env,
): void {
  if (
    resolveTestRunnerMode(env) === "inline" &&
    isProductionEnv(env) &&
    !inlineCommandsAllowed(env)
  ) {
    throw new TestRunnerModeBlockedError(
      "Inline TEST_RUNNER is blocked in production. Set " +
        "AI_ORCHESTRATOR_TEST_RUNNER_MODE=worker and run the sandbox worker " +
        "(or AI_ORCHESTRATOR_ALLOW_INLINE_COMMANDS=1 for an explicit, risky override).",
    );
  }
}

/** The default suite the orchestrator runs in the sandbox. */
export const ORCHESTRATOR_TEST_COMMANDS = [
  "npm ci",
  "npm run typecheck",
  "npm test",
  "npm run build",
] as const;

const TERMINAL = new Set(["passed", "failed", "timed_out", "cancelled"]);

export interface WaitForTerminalOpts {
  timeoutMs: number;
  pollMs: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Bounded poll until the job reaches a terminal state, or the wait times out.
 * Returns null on wait-timeout (the request must NOT hang forever).
 */
export async function defaultWaitForTerminal(
  queue: JobQueue,
  jobId: string,
  opts: WaitForTerminalOpts,
): Promise<WorkerJobRecord | null> {
  const nowFn = opts.now ?? Date.now;
  const sleepFn =
    opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const start = nowFn();
  for (;;) {
    const job = await queue.get(jobId);
    if (job && TERMINAL.has(job.status)) return job;
    if (nowFn() - start >= opts.timeoutMs) return null;
    await sleepFn(opts.pollMs);
  }
}

export interface WorkerTestExecutorDeps {
  queue: JobQueue;
  repoCloneUrl: string;
  branch: string;
  commands?: readonly string[];
  timeoutMs?: number;
  pollMs?: number;
  userId?: string | null;
  /** Injectable wait (tests bypass real polling). */
  waitForTerminal?: (
    queue: JobQueue,
    jobId: string,
    opts: WaitForTerminalOpts,
  ) => Promise<WorkerJobRecord | null>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Redacted audit sink (eventType, sessionId, metadata). */
  audit?: (
    eventType: AuditEventType,
    sessionId: string,
    metadata: Record<string, unknown>,
  ) => Promise<void> | void;
}

export interface EnqueueOrchestratorTestArgs {
  sessionId: string;
  round: number;
  repoCloneUrl: string;
  branch: string;
  commands?: readonly string[];
  userId?: string | null;
}

/**
 * Enqueue an orchestrator TEST_RUNNER job. job_type "test_branch" = clone
 * repo@branch + run commands (no patch apply); `source` discriminates it from
 * PR-flow test jobs without a schema change.
 */
export function enqueueOrchestratorTestJob(
  queue: JobQueue,
  args: EnqueueOrchestratorTestArgs,
): Promise<WorkerJobRecord> {
  const commands = [...(args.commands ?? ORCHESTRATOR_TEST_COMMANDS)];
  return queue.enqueue({
    sessionId: args.sessionId,
    userId: args.userId ?? null,
    jobType: "test_branch",
    payload: {
      repo: { clone_url: args.repoCloneUrl, branch: args.branch },
      commands,
      session_id: args.sessionId,
      round: args.round,
      source: "orchestrator_test_runner",
    },
  });
}

export function buildReportFromJob(job: WorkerJobRecord): TestReport {
  const result = job.result as {
    commands?: { command: string; exitCode: number | null }[];
    summary?: string;
  } | null;
  const cmds = result?.commands ?? [];
  const results: CommandResult[] = cmds.map((c) => ({
    command: c.command,
    allowed: true,
    reason: "sandbox worker",
    exitCode: c.exitCode,
    stdout: "",
    stderr: "",
    executed: true,
  }));
  if (results.length === 0) {
    results.push({
      command: "(sandbox worker)",
      allowed: true,
      reason: "sandbox worker",
      exitCode: job.status === "passed" ? 0 : 1,
      stdout: "",
      stderr: (result?.summary ?? job.status).slice(0, 400),
      executed: true,
    });
  }
  return { results, passed: job.status === "passed" };
}

export function timeoutReport(jobId: string, timeoutMs: number): TestReport {
  return {
    results: [
      {
        command: "(sandbox worker wait)",
        allowed: true,
        reason: "sandbox worker",
        exitCode: null,
        stdout: "",
        stderr:
          `[WAIT TIMEOUT] worker job ${jobId} did not finish within ${timeoutMs}ms. ` +
          "Start the sandbox worker (npm run ai:worker) or raise AI_ORCHESTRATOR_TEST_JOB_TIMEOUT_MS.",
        executed: false,
      },
    ],
    passed: false,
  };
}

/**
 * Enqueue a sandbox test job for the orchestrator's TEST_RUNNER step and wait
 * (bounded) for it. Never hangs forever: a wait-timeout yields a failed report,
 * so the QA fail-safe keeps the verdict from passing on red/unknown tests.
 */
export async function runOrchestratorTestJob(
  ctx: { sessionId: string; round: number },
  deps: WorkerTestExecutorDeps,
): Promise<TestStepResult> {
  const commands = [...(deps.commands ?? ORCHESTRATOR_TEST_COMMANDS)];
  const timeoutMs = deps.timeoutMs ?? resolveTestJobTimeoutMs();
  const pollMs = deps.pollMs ?? resolveTestJobPollMs();

  const job = await enqueueOrchestratorTestJob(deps.queue, {
    sessionId: ctx.sessionId,
    round: ctx.round,
    repoCloneUrl: deps.repoCloneUrl,
    branch: deps.branch,
    commands,
    userId: deps.userId,
  });
  await deps.audit?.("orchestrator_test_job_created", ctx.sessionId, {
    jobId: job.id,
    round: ctx.round,
  });

  const waitFor = deps.waitForTerminal ?? defaultWaitForTerminal;
  const final = await waitFor(deps.queue, job.id, {
    timeoutMs,
    pollMs,
    sleep: deps.sleep,
    now: deps.now,
  });

  if (!final) {
    await deps.audit?.("orchestrator_test_job_timeout", ctx.sessionId, {
      jobId: job.id,
      timeoutMs,
    });
    return {
      report: timeoutReport(job.id, timeoutMs),
      mode: "worker",
      workerJobId: job.id,
    };
  }

  const passed = final.status === "passed";
  await deps.audit?.(
    passed ? "orchestrator_test_job_passed" : "orchestrator_test_job_failed",
    ctx.sessionId,
    { jobId: job.id, status: final.status },
  );
  return {
    report: buildReportFromJob(final),
    mode: "worker",
    workerJobId: job.id,
  };
}

/** Build a TestExecutor backed by the sandbox worker (worker_wait mode). */
export function makeWorkerTestExecutor(
  deps: WorkerTestExecutorDeps,
): TestExecutor {
  return { run: (ctx) => runOrchestratorTestJob(ctx, deps) };
}
