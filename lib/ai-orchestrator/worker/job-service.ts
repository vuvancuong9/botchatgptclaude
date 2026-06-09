import { recordAudit } from "../audit";
import { getRepository } from "../db/factory";
import type { AiOrchestratorRepository } from "../db/repository.interface";
import { redactSecrets } from "../security/redact";
import {
  WorkerJobLogRecord,
  WorkerJobRecord,
} from "../types";
import { applyPatchSet, resolvePatchHashStrict } from "./patch-applier";
import {
  Heartbeat,
  HeartbeatController,
  HeartbeatDeps,
  HeartbeatStats,
  resolveHeartbeatIntervalMs,
  resolveLeaseSeconds,
} from "./heartbeat";
import { runSandboxJob, SandboxRunnerDeps, RunSandboxResult } from "./sandbox-runner";
import {
  JobQueue,
  parseJobPayload,
  RepoRef,
  TestPatchPayload,
} from "./types";

function nowIso(): string {
  return new Date().toISOString();
}

export interface CreateTestJobArgs {
  sessionId: string;
  patchSetId?: string | null;
  pullRequestId?: string | null;
  userId?: string | null;
  jobType: "test_patch" | "test_branch";
  repo: RepoRef;
  commands: string[];
  priority?: number;
  ip?: string | null;
  userAgent?: string | null;
}

/** Validate the payload + enqueue a test job. Audits worker_job_created. */
export async function createTestJob(
  queue: JobQueue,
  args: CreateTestJobArgs,
): Promise<WorkerJobRecord> {
  const payload =
    args.jobType === "test_patch"
      ? {
          repo: args.repo,
          patch_set_id: args.patchSetId ?? undefined,
          apply_patch: true, // Phase 7.1: always apply the patch before tests.
          commands: args.commands,
        }
      : { repo: args.repo, commands: args.commands };

  // Throws on any allowlist / shape violation — the model can't smuggle commands.
  parseJobPayload(args.jobType, payload);

  const job = await queue.enqueue({
    sessionId: args.sessionId,
    patchSetId: args.patchSetId ?? null,
    pullRequestId: args.pullRequestId ?? null,
    userId: args.userId ?? null,
    jobType: args.jobType,
    payload: payload as unknown as Record<string, unknown>,
    priority: args.priority,
  });

  await recordAudit({
    eventType: "worker_job_created",
    status: "ok",
    sessionId: args.sessionId,
    userId: args.userId ?? null,
    ip: args.ip ?? null,
    userAgent: args.userAgent ?? null,
    metadata: {
      jobId: job.id,
      jobType: args.jobType,
      patchSetId: args.patchSetId ?? null,
      commands: args.commands.length,
    },
  });

  return job;
}

export interface JobView {
  job: WorkerJobRecord;
  logs: WorkerJobLogRecord[];
}

/** Job + a tail of (already-redacted) logs. */
export async function getJobView(
  queue: JobQueue,
  jobId: string,
  logLimit = 200,
): Promise<JobView | null> {
  const job = await queue.get(jobId);
  if (!job) return null;
  const logs = await queue.getLogs(jobId, logLimit);
  return { job, logs };
}

/** Cancel a job (queued/running only). Audits worker_job_cancelled when applied. */
export async function cancelJob(
  queue: JobQueue,
  jobId: string,
  meta: { userId?: string | null; sessionId?: string | null; ip?: string | null; userAgent?: string | null } = {},
): Promise<boolean> {
  const ok = await queue.cancel(jobId);
  if (ok) {
    await recordAudit({
      eventType: "worker_job_cancelled",
      status: "ok",
      sessionId: meta.sessionId ?? null,
      userId: meta.userId ?? null,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
      metadata: { jobId },
    });
  }
  return ok;
}

/**
 * Latest PR-flow test job for a session. Only `test_patch` jobs gate a PR (they
 * apply the patch); orchestrator TEST_RUNNER jobs (`test_branch` with
 * source=orchestrator_test_runner) must NOT shadow the PR's patch test.
 */
export async function findLatestRequiredWorkerJob(
  repo: AiOrchestratorRepository,
  sessionId: string,
): Promise<WorkerJobRecord | null> {
  const jobs = await repo.listWorkerJobsForSession(sessionId, 50);
  return jobs.find((j) => j.job_type === "test_patch") ?? null;
}

export interface ProcessJobOptions {
  /** Override sandbox-runner deps (prepare/runCommand/cleanup) — used by tests. */
  runner?: SandboxRunnerDeps;
  /** Override lease/heartbeat timing (tests use tiny values). */
  heartbeat?: {
    leaseSeconds?: number;
    intervalMs?: number;
    failClosedThreshold?: number;
  };
  /** Inject a fake heartbeat controller (tests). Defaults to the real Heartbeat. */
  makeHeartbeat?: (deps: HeartbeatDeps) => HeartbeatController;
}

/**
 * Run a single already-CLAIMED job to completion: parse payload, run the sandbox,
 * write status + result, release the lease, and audit the lifecycle. Never
 * throws — failures become a failed job.
 */
export async function processClaimedJob(
  queue: JobQueue,
  job: WorkerJobRecord,
  opts: ProcessJobOptions = {},
): Promise<RunSandboxResult> {
  await recordAudit({
    eventType: "worker_job_started",
    status: "ok",
    sessionId: job.session_id,
    userId: job.user_id,
    metadata: { jobId: job.id, attempts: job.attempts },
  });

  let repo: RepoRef;
  let commands: string[];
  let patchSetId: string | null = null;
  let applyPatch = true;
  try {
    const payload = parseJobPayload(job.job_type, job.payload);
    repo = payload.repo;
    commands = payload.commands;
    if (job.job_type === "test_patch") {
      const p = payload as TestPatchPayload;
      patchSetId = p.patch_set_id;
      applyPatch = p.apply_patch;
    }
  } catch (err) {
    const msg = redactSecrets((err as Error).message);
    await queue.setStatus(job.id, {
      status: "failed",
      errorMessage: msg,
      finishedAt: nowIso(),
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    await recordAudit({
      eventType: "worker_job_failed",
      status: "fail",
      sessionId: job.session_id,
      userId: job.user_id,
      metadata: { jobId: job.id, reason: "invalid payload" },
    });
    return {
      status: "failed",
      result: { passed: false, commands: [], summary: "invalid payload" },
    };
  }

  if (job.job_type === "test_patch") {
    await recordAudit({
      eventType: "patch_apply_started",
      status: "ok",
      sessionId: job.session_id,
      userId: job.user_id,
      metadata: { jobId: job.id, patchSetId },
    });
  }

  // --- Phase 7.1.3: heartbeat renews the lease while the (long) job runs. ---
  const workerId = job.lease_owner ?? "worker";
  const leaseSeconds = opts.heartbeat?.leaseSeconds ?? resolveLeaseSeconds();
  const intervalMs = opts.heartbeat?.intervalMs ?? resolveHeartbeatIntervalMs();
  const abort = new AbortController();
  let cancelSignalAudited = false;
  const auditCancelSignal = async (reason: string) => {
    if (cancelSignalAudited) return;
    cancelSignalAudited = true;
    await recordAudit({
      eventType: "worker_cancel_signal_sent",
      status: "fail",
      sessionId: job.session_id,
      userId: job.user_id,
      metadata: { jobId: job.id, reason },
    });
  };

  await recordAudit({
    eventType: "worker_heartbeat_started",
    status: "ok",
    sessionId: job.session_id,
    userId: job.user_id,
    metadata: { jobId: job.id, leaseSeconds, intervalMs },
  });

  const makeHeartbeat =
    opts.makeHeartbeat ?? ((d: HeartbeatDeps) => new Heartbeat(d));
  const hb = makeHeartbeat({
    jobId: job.id,
    workerId,
    leaseSeconds,
    intervalMs,
    failClosedThreshold: opts.heartbeat?.failClosedThreshold,
    renew: (id, wid, secs) => queue.renewLease(id, wid, secs),
    getStatus: async (id) => (await queue.get(id))?.status ?? null,
    onAbort: (reason) => {
      abort.abort(reason);
      void auditCancelSignal(reason);
    },
    log: (m) => queue.appendLog(job.id, "system", m),
  });
  hb.start();

  let out: RunSandboxResult;
  let hbStats: HeartbeatStats = {
    renewals: 0,
    failures: 0,
    leaseRenewed: false,
    reason: null,
  };
  try {
    out = await runSandboxJob(
      {
        jobId: job.id,
        jobType: job.job_type,
        repo,
        commands,
        patchSetId,
        applyPatch,
      },
      {
        appendLog: (stream, content) =>
          queue.appendLog(job.id, stream, content),
        isCancelled: async () => {
          const j = await queue.get(job.id);
          return j?.status === "cancelled";
        },
        abortSignal: abort.signal,
        // Default applier reads patch_files from the DB and writes them into the
        // workspace (full redacted content) with the base-drift hash guard.
        applyPatch: (workspacePath, psid) =>
          applyPatchSet(workspacePath, getRepository(), psid, {
            strict: resolvePatchHashStrict(),
            appendLog: (stream, content) =>
              queue.appendLog(job.id, stream, content),
          }),
        ...opts.runner,
      },
    );
  } catch {
    out = {
      status: "failed",
      result: { passed: false, commands: [], summary: "runner crashed" },
    };
  } finally {
    hbStats = hb.stop(); // always stop — never leak the heartbeat timer
  }

  await recordAudit({
    eventType: "worker_heartbeat_stopped",
    status: "ok",
    sessionId: job.session_id,
    userId: job.user_id,
    metadata: {
      jobId: job.id,
      renewals: hbStats.renewals,
      failures: hbStats.failures,
      reason: hbStats.reason,
    },
  });

  // Phase 7.1.1: audit the patch-apply outcome (code/path only, no content).
  if (job.job_type === "test_patch") {
    if (out.result.patch_applied) {
      await recordAudit({
        eventType: "patch_apply_passed",
        status: "ok",
        sessionId: job.session_id,
        userId: job.user_id,
        metadata: {
          jobId: job.id,
          changed: out.result.changed_files?.length ?? 0,
          base_hash_checked: out.result.base_hash_checked ?? false,
        },
      });
    } else {
      const err = out.result.errors?.[0];
      await recordAudit({
        eventType: "patch_apply_failed",
        status: "fail",
        sessionId: job.session_id,
        userId: job.user_id,
        metadata: { jobId: job.id, reason: err?.code, file_path: err?.file_path },
      });
    }
  }

  // Attach heartbeat metrics; fail-closed on a lost/unrenewable lease.
  let finalStatus = out.status;
  const finalResult = out.result;
  finalResult.heartbeat_renewals = hbStats.renewals;
  finalResult.heartbeat_failures = hbStats.failures;
  finalResult.lease_renewed = hbStats.leaseRenewed;
  if (
    hbStats.reason === "lease_renewal_failed" ||
    hbStats.reason === "lease_lost"
  ) {
    finalStatus = "failed";
    finalResult.cancelled_by_signal = true;
    finalResult.errors = [
      ...(finalResult.errors ?? []),
      { code: "lease_renewal_failed" },
    ];
    await recordAudit({
      eventType: "worker_lease_renew_failed",
      status: "fail",
      sessionId: job.session_id,
      userId: job.user_id,
      metadata: {
        jobId: job.id,
        reason: hbStats.reason,
        failures: hbStats.failures,
      },
    });
  }

  // Owner-guarded finalize: NEVER overwrite a job another worker has reclaimed
  // (we lost the lease) — only write if we still own it.
  let stillOurs = false;
  try {
    const fresh = await queue.get(job.id);
    stillOurs = !!fresh && fresh.lease_owner === workerId;
  } catch {
    stillOurs = false;
  }
  if (stillOurs) {
    await queue.setStatus(job.id, {
      status: finalStatus,
      result: finalResult as unknown as Record<string, unknown>,
      finishedAt: nowIso(),
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    const evt =
      finalStatus === "passed"
        ? "worker_job_passed"
        : finalStatus === "timed_out"
          ? "worker_job_timed_out"
          : finalStatus === "cancelled"
            ? "worker_job_cancelled"
            : "worker_job_failed";
    await recordAudit({
      eventType: evt,
      status: finalStatus === "passed" ? "ok" : "fail",
      sessionId: job.session_id,
      userId: job.user_id,
      metadata: { jobId: job.id, summary: out.result.summary },
    });
  } else {
    await queue
      .appendLog(
        job.id,
        "system",
        "not finalizing: lease no longer owned (job reclaimed or DB unreachable)",
      )
      .catch(() => {});
  }

  return { status: finalStatus, result: finalResult };
}

/** Claim + run one job. Returns null when nothing was claimable. */
export async function pollAndRunOnce(
  queue: JobQueue,
  workerId: string,
  opts: ProcessJobOptions = {},
): Promise<RunSandboxResult | null> {
  // Initial lease matches the heartbeat lease so renewal keeps it alive.
  const leaseSeconds = opts.heartbeat?.leaseSeconds ?? resolveLeaseSeconds();
  const job = await queue.claimNext(workerId, { leaseMs: leaseSeconds * 1000 });
  if (!job) return null;
  return processClaimedJob(queue, job, opts);
}
