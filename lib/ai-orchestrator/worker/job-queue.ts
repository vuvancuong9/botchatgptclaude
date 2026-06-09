import { randomUUID } from "node:crypto";
import { getRepository } from "../db/factory";
import type { AiOrchestratorRepository } from "../db/repository.interface";
import { redactSecrets } from "../security/redact";
import {
  WorkerJobLogRecord,
  WorkerJobRecord,
  WorkerJobStream,
} from "../types";
import {
  ClaimOptions,
  CreateWorkerJobInput,
  JobQueue,
  UpdateWorkerJobStatusInput,
} from "./types";

export type WorkerProvider = "database" | "local";

export class WorkerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerConfigError";
  }
}

export function resolveWorkerProvider(
  raw: string | undefined = process.env.AI_ORCHESTRATOR_WORKER_PROVIDER,
): WorkerProvider {
  const v = (raw ?? "database").trim().toLowerCase();
  if (v === "" || v === "database") return "database";
  if (v === "local") return "local";
  throw new WorkerConfigError(
    `Unknown AI_ORCHESTRATOR_WORKER_PROVIDER="${raw}" (expected "database" or "local").`,
  );
}

export function inlineCommandsAllowed(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.AI_ORCHESTRATOR_ALLOW_INLINE_COMMANDS === "1";
}

export function isProductionEnv(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.NODE_ENV === "production";
}

/**
 * Validate worker config at startup. In production: the `local` provider is
 * forbidden, and inline command execution is forbidden — both must use the
 * database-backed queue + a separate worker. Throws a clear error otherwise.
 */
export function assertWorkerConfig(
  env: Record<string, string | undefined> = process.env,
): void {
  if (!isProductionEnv(env)) return;
  if (resolveWorkerProvider(env.AI_ORCHESTRATOR_WORKER_PROVIDER) === "local") {
    throw new WorkerConfigError(
      "AI_ORCHESTRATOR_WORKER_PROVIDER=local is not allowed in production; use 'database'.",
    );
  }
  if (inlineCommandsAllowed(env)) {
    throw new WorkerConfigError(
      "AI_ORCHESTRATOR_ALLOW_INLINE_COMMANDS=1 is forbidden in production; run the sandbox worker instead.",
    );
  }
}

/**
 * Guard placed right before any INLINE command execution. Refuses in production
 * and whenever the inline flag is off — there is no path to spawn a shell
 * command inside a production Next.js request.
 */
export function assertInlineExecutionAllowed(
  env: Record<string, string | undefined> = process.env,
): void {
  if (isProductionEnv(env)) {
    throw new WorkerConfigError(
      "Inline command execution is forbidden in production; use the sandbox worker.",
    );
  }
  if (!inlineCommandsAllowed(env)) {
    throw new WorkerConfigError(
      "Inline command execution is disabled (set AI_ORCHESTRATOR_ALLOW_INLINE_COMMANDS=1 for local dev).",
    );
  }
}

/** Database-backed queue (production / MVP). Delegates to the repository. */
export class RepositoryJobQueue implements JobQueue {
  constructor(private readonly repo: AiOrchestratorRepository) {}
  enqueue(input: CreateWorkerJobInput) {
    return this.repo.createWorkerJob(input);
  }
  get(id: string) {
    return this.repo.getWorkerJob(id);
  }
  listForSession(sessionId: string, limit?: number) {
    return this.repo.listWorkerJobsForSession(sessionId, limit);
  }
  claimNext(workerId: string, opts?: ClaimOptions) {
    return this.repo.claimNextWorkerJob(workerId, opts);
  }
  renewLease(jobId: string, workerId: string, leaseSeconds: number) {
    return this.repo.renewWorkerJobLease(jobId, workerId, leaseSeconds);
  }
  setStatus(id: string, patch: UpdateWorkerJobStatusInput) {
    return this.repo.updateWorkerJobStatus(id, patch);
  }
  appendLog(jobId: string, stream: WorkerJobStream, content: string) {
    return this.repo.appendWorkerJobLog(jobId, stream, content);
  }
  getLogs(jobId: string, limit?: number) {
    return this.repo.getWorkerJobLogs(jobId, limit);
  }
  cancel(id: string) {
    return this.repo.cancelWorkerJob(id);
  }
}

/** In-memory queue for tests / local mode only. Mirrors the lease semantics. */
export class InMemoryJobQueue implements JobQueue {
  private jobs = new Map<string, WorkerJobRecord>();
  private logs = new Map<string, WorkerJobLogRecord[]>();

  private nowIso(now?: string): string {
    // Tests pass an explicit `now`; otherwise use wall clock.
    return now ?? new Date().toISOString();
  }

  async enqueue(input: CreateWorkerJobInput): Promise<WorkerJobRecord> {
    const ts = this.nowIso();
    const job: WorkerJobRecord = {
      id: randomUUID(),
      session_id: input.sessionId ?? null,
      patch_set_id: input.patchSetId ?? null,
      pull_request_id: input.pullRequestId ?? null,
      user_id: input.userId ?? null,
      job_type: input.jobType,
      status: "queued",
      priority: input.priority ?? 5,
      payload: input.payload ?? {},
      result: null,
      error_message: null,
      lease_owner: null,
      lease_expires_at: null,
      attempts: 0,
      max_attempts: input.maxAttempts ?? 2,
      created_at: ts,
      started_at: null,
      finished_at: null,
      updated_at: ts,
    };
    this.jobs.set(job.id, job);
    return { ...job };
  }

  async get(id: string): Promise<WorkerJobRecord | null> {
    const j = this.jobs.get(id);
    return j ? { ...j } : null;
  }

  async listForSession(sessionId: string, limit = 50): Promise<WorkerJobRecord[]> {
    return [...this.jobs.values()]
      .filter((j) => j.session_id === sessionId)
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
      .slice(0, limit)
      .map((j) => ({ ...j }));
  }

  async claimNext(
    workerId: string,
    opts: ClaimOptions = {},
  ): Promise<WorkerJobRecord | null> {
    const nowTs = this.nowIso(opts.now);
    const leaseMs = opts.leaseMs ?? 5 * 60_000;
    const candidates = [...this.jobs.values()]
      .filter(
        (j) =>
          j.status === "queued" ||
          (j.status === "running" &&
            (!j.lease_expires_at ||
              Date.parse(j.lease_expires_at) < Date.parse(nowTs))),
      )
      .sort(
        (a, b) =>
          a.priority - b.priority ||
          Date.parse(a.created_at) - Date.parse(b.created_at),
      );

    for (const job of candidates) {
      if (job.attempts >= job.max_attempts) {
        job.status = "failed";
        job.error_message = "max attempts exceeded";
        job.finished_at = nowTs;
        job.updated_at = nowTs;
        continue;
      }
      job.status = "running";
      job.lease_owner = workerId;
      job.lease_expires_at = new Date(
        Date.parse(nowTs) + leaseMs,
      ).toISOString();
      job.attempts += 1;
      job.started_at = job.started_at ?? nowTs;
      job.updated_at = nowTs;
      return { ...job };
    }
    return null;
  }

  async renewLease(
    jobId: string,
    workerId: string,
    leaseSeconds: number,
  ): Promise<WorkerJobRecord | null> {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== "running" || job.lease_owner !== workerId) {
      return null;
    }
    const ts = this.nowIso();
    job.lease_expires_at = new Date(
      Date.parse(ts) + leaseSeconds * 1000,
    ).toISOString();
    job.updated_at = ts;
    return { ...job };
  }

  async setStatus(id: string, patch: UpdateWorkerJobStatusInput): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Worker job ${id} not found`);
    if (patch.status !== undefined) job.status = patch.status;
    if (patch.result !== undefined) job.result = patch.result;
    if (patch.errorMessage !== undefined) job.error_message = patch.errorMessage;
    if (patch.leaseOwner !== undefined) job.lease_owner = patch.leaseOwner;
    if (patch.leaseExpiresAt !== undefined)
      job.lease_expires_at = patch.leaseExpiresAt;
    if (patch.attempts !== undefined) job.attempts = patch.attempts;
    if (patch.startedAt !== undefined) job.started_at = patch.startedAt;
    if (patch.finishedAt !== undefined) job.finished_at = patch.finishedAt;
    job.updated_at = this.nowIso();
  }

  async appendLog(
    jobId: string,
    stream: WorkerJobStream,
    content: string,
  ): Promise<void> {
    const arr = this.logs.get(jobId) ?? [];
    arr.push({
      id: randomUUID(),
      job_id: jobId,
      stream,
      content: redactSecrets(content),
      created_at: this.nowIso(),
    });
    this.logs.set(jobId, arr);
  }

  async getLogs(jobId: string, limit = 500): Promise<WorkerJobLogRecord[]> {
    return (this.logs.get(jobId) ?? []).slice(0, limit).map((l) => ({ ...l }));
  }

  async cancel(id: string): Promise<boolean> {
    const job = this.jobs.get(id);
    if (!job) return false;
    if (job.status !== "queued" && job.status !== "running") return false;
    job.status = "cancelled";
    job.finished_at = this.nowIso();
    job.updated_at = this.nowIso();
    return true;
  }
}

let localSingleton: InMemoryJobQueue | null = null;

/** Resolve the configured queue. Database by default; local for test/dev. */
export function getJobQueue(): JobQueue {
  const provider = resolveWorkerProvider();
  if (provider === "local") {
    if (isProductionEnv()) {
      throw new WorkerConfigError(
        "AI_ORCHESTRATOR_WORKER_PROVIDER=local is not allowed in production.",
      );
    }
    if (!localSingleton) localSingleton = new InMemoryJobQueue();
    return localSingleton;
  }
  return new RepositoryJobQueue(getRepository());
}

/** Test helper — drop the cached local queue. */
export function __resetJobQueue(): void {
  localSingleton = null;
}
