import { getRepository } from "./db/factory";
import type { AiOrchestratorRepository } from "./db/repository.interface";
import { AsyncResult } from "./async-orchestrator";
import {
  OrchestrationRunRecord,
  OrchestrationRunStatus,
} from "./types";

/**
 * Phase 7.4 — scheduled / cron resume.
 *
 * A cron tick scans orchestration runs stuck in `waiting_for_worker`, and for
 * each whose pending worker job is terminal it acquires a short lock and calls
 * the control-plane resume. The lock makes concurrent cron ticks safe (no
 * duplicate resume), the batch size bounds each tick (no runaway), and every
 * candidate is processed at most once per tick (no infinite loop).
 *
 * This module never spawns a command and never imports a model adapter — the
 * actual resume (review + QA judge) is injected (default: the system resume in
 * service.ts, loaded lazily to avoid an import cycle).
 */

const TERMINAL_JOB_STATUSES = new Set([
  "passed",
  "failed",
  "timed_out",
  "cancelled",
]);

export const DEFAULT_RESUME_BATCH_SIZE = 5;
export const DEFAULT_RESUME_LOCK_TTL_SECONDS = 120;

export function resolveResumeBatchSize(
  env: Record<string, string | undefined> = process.env,
): number {
  const v = parseInt(env.AI_ORCHESTRATOR_RESUME_BATCH_SIZE || "", 10);
  if (!Number.isFinite(v) || v < 1) return DEFAULT_RESUME_BATCH_SIZE;
  return Math.min(v, 50); // hard ceiling — never resume more than 50 per tick
}

export function resolveResumeLockTtlSeconds(
  env: Record<string, string | undefined> = process.env,
): number {
  const v = parseInt(env.AI_ORCHESTRATOR_RESUME_LOCK_TTL_SECONDS || "", 10);
  if (!Number.isFinite(v) || v < 10) return DEFAULT_RESUME_LOCK_TTL_SECONDS;
  return Math.min(v, 900);
}

function defaultOwner(): string {
  // Unique-enough per process; the lock is advisory + TTL-bounded.
  return `cron-${process.pid}`;
}

/** Lazy default resume — avoids a static import cycle with service.ts. */
async function defaultResume(runId: string): Promise<AsyncResult> {
  const mod = await import("./service");
  return mod.resumeOrchestrationSystem(runId);
}

export interface ResumeSchedulerDeps {
  repo?: AiOrchestratorRepository;
  batchSize?: number;
  lockTtlSeconds?: number;
  owner?: string;
  /** Injectable resume (tests pass a fake; default = control-plane resume). */
  resume?: (runId: string) => Promise<AsyncResult>;
}

export type ResumeOutcome =
  | "resumed"
  | "still_waiting"
  | "lock_skipped"
  | "failed";

export interface ResumeRunResult {
  runId: string;
  sessionId: string;
  outcome: ResumeOutcome;
  status?: OrchestrationRunStatus;
}

export interface ResumeSummary {
  scanned: number;
  resumed: number;
  still_waiting: number;
  skipped: number;
  failed: number;
  results: ResumeRunResult[];
}

/**
 * Waiting runs whose pending worker job is terminal (passed/failed/timed_out/
 * cancelled) — i.e. ready to resume. Over-fetches then filters, capped at limit.
 */
export async function findResumableOrchestrations(deps: {
  repo?: AiOrchestratorRepository;
  limit?: number;
} = {}): Promise<OrchestrationRunRecord[]> {
  const repo = deps.repo ?? getRepository();
  const limit = Math.max(1, deps.limit ?? resolveResumeBatchSize());
  const waiting = await repo.listWaitingOrchestrationRuns(limit * 4);
  const out: OrchestrationRunRecord[] = [];
  for (const run of waiting) {
    if (!run.pending_worker_job_id) continue;
    const job = await repo.getWorkerJob(run.pending_worker_job_id);
    if (job && TERMINAL_JOB_STATUSES.has(job.status)) out.push(run);
    if (out.length >= limit) break;
  }
  return out;
}

async function safeEvent(
  repo: AiOrchestratorRepository,
  run: OrchestrationRunRecord,
  eventType: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await repo
    .appendOrchestrationEvent({
      orchestrationRunId: run.id,
      sessionId: run.session_id,
      eventType,
      metadata,
    })
    .catch(() => {});
}

/**
 * Resume every due orchestration in this tick. Each run is lock-claimed first,
 * so two crons never resume the same run; a run another cron already holds is
 * counted as `skipped`. Failures clear the lock and record last_error.
 */
export async function resumeDueOrchestrations(
  deps: ResumeSchedulerDeps = {},
): Promise<ResumeSummary> {
  const repo = deps.repo ?? getRepository();
  const batchSize = Math.max(1, deps.batchSize ?? resolveResumeBatchSize());
  const ttl = deps.lockTtlSeconds ?? resolveResumeLockTtlSeconds();
  const owner = deps.owner ?? defaultOwner();
  const resume = deps.resume ?? defaultResume;

  const candidates = await findResumableOrchestrations({ repo, limit: batchSize });
  const summary: ResumeSummary = {
    scanned: candidates.length,
    resumed: 0,
    still_waiting: 0,
    skipped: 0,
    failed: 0,
    results: [],
  };

  for (const run of candidates) {
    const locked = await repo.claimOrchestrationResumeLock(run.id, owner, ttl);
    if (!locked) {
      summary.skipped++;
      summary.results.push({
        runId: run.id,
        sessionId: run.session_id,
        outcome: "lock_skipped",
      });
      await safeEvent(repo, run, "orchestration_resume_lock_skipped", { owner });
      continue;
    }
    await safeEvent(repo, run, "orchestration_resume_lock_acquired", { owner });
    try {
      await repo.incrementOrchestrationResumeAttempt(run.id);
      const r = await resume(run.id);
      if (r.status === "waiting_for_worker") {
        summary.still_waiting++;
        summary.results.push({
          runId: run.id,
          sessionId: run.session_id,
          outcome: "still_waiting",
          status: r.status,
        });
      } else {
        summary.resumed++;
        summary.results.push({
          runId: run.id,
          sessionId: run.session_id,
          outcome: "resumed",
          status: r.status,
        });
      }
    } catch (err) {
      summary.failed++;
      summary.results.push({
        runId: run.id,
        sessionId: run.session_id,
        outcome: "failed",
      });
      // updateOrchestrationRun redacts last_error before persisting.
      await repo
        .updateOrchestrationRun(run.id, {
          last_error: (err as Error)?.message ?? "resume failed",
        })
        .catch(() => {});
    } finally {
      await repo.releaseOrchestrationResumeLock(run.id, owner).catch(() => {});
      await safeEvent(repo, run, "orchestration_resume_lock_released", { owner });
    }
  }

  return summary;
}
