import { getRepository } from "./db/factory";
import { Orchestrator, OrchestratorOptions } from "./orchestrator";
import {
  PatchFileRecord,
  PatchSetRecord,
  PullRequestRecord,
  SessionDetail,
  SessionRecord,
} from "./types";
import { AuthContext } from "./auth/context";
import { PERMISSIONS } from "./auth/permissions";
import { RbacSubject } from "./auth/rbac";
import { recordAudit } from "./audit";
import { createGithubClient, resolveGithubConfig } from "./github/github-client";
import { buildBranchName } from "./github/branch-service";
import { validateAndStorePatch } from "./github/patch-service";
import { driftHash } from "./patch/hash";
import {
  getJobQueue,
  inlineCommandsAllowed,
  isProductionEnv,
  resolveWorkerProvider,
} from "./worker/job-queue";
import {
  cancelJob,
  createTestJob,
  getJobView,
  JobView,
} from "./worker/job-service";
import {
  assertTestRunnerModeAllowed,
  makeWorkerTestExecutor,
  resolveTestJobPollMs,
  resolveTestJobTimeoutMs,
  resolveTestRunnerMode,
  TestRunnerModeBlockedError,
} from "./test-runner-worker";
import { AsyncOrchestrator, AsyncResult } from "./async-orchestrator";
import { resumeDueOrchestrations } from "./orchestration-resume-scheduler";
import { resolveModelKeys } from "./settings";
import { OpenAIAdapter } from "./adapters/openai.adapter";
import { AnthropicAdapter } from "./adapters/anthropic.adapter";
import { AIAdapter } from "./adapters/types";
import {
  OrchestrationEventRecord,
  OrchestrationRunRecord,
  WorkerJobRecord,
} from "./types";

// Re-export the factory so existing import sites keep working.
export { getRepository } from "./db/factory";

/** Map an AuthContext to the minimal RBAC subject the Phase 6 flow needs. */
export function subjectFromContext(ctx: AuthContext): RbacSubject {
  return { userId: ctx.userId, role: ctx.role, permissions: ctx.permissions };
}

/** Sessions visible to a context: all (read_all) or own + collaborator. */
export async function listSessionsForContext(
  ctx: AuthContext,
  limit = 100,
): Promise<SessionRecord[]> {
  const repo = getRepository();
  const all = await repo.listSessions(Math.max(limit, 200));
  if (ctx.permissions.includes(PERMISSIONS.SESSION_READ_ALL)) {
    return all.slice(0, limit);
  }
  const collabIds = ctx.userId
    ? new Set(await repo.getCollaboratorSessionIds(ctx.userId))
    : new Set<string>();
  return all
    .filter(
      (s) =>
        (ctx.userId && s.user_id === ctx.userId) || collabIds.has(s.id),
    )
    .slice(0, limit);
}

/** Fetch a session plus whether the context is a collaborator on it. */
export async function getSessionWithAccessFlags(
  ctx: AuthContext,
  id: string,
): Promise<{ session: SessionRecord; isCollaborator: boolean } | null> {
  const repo = getRepository();
  const session = await repo.getSession(id);
  if (!session) return null;
  let isCollaborator = false;
  if (ctx.userId) {
    const ids = await repo.getCollaboratorSessionIds(ctx.userId);
    isCollaborator = ids.includes(id);
  }
  return { session, isCollaborator };
}

export async function runOrchestration(
  userRequest: string,
  opts: OrchestratorOptions = {},
): Promise<SessionDetail> {
  const repo = getRepository();
  const mode = resolveTestRunnerMode();

  // Production must NOT spawn commands inline in the request.
  if (mode === "inline" && isProductionEnv() && !inlineCommandsAllowed()) {
    await recordAudit({
      eventType: "orchestrator_test_runner_inline_blocked",
      status: "denied",
      metadata: { mode },
    });
    assertTestRunnerModeAllowed(); // throws TestRunnerModeBlockedError
  }

  // Worker mode (worker_wait): enqueue an orchestrator_test job per round and
  // wait (bounded) for it. No command runs inside this Next.js request.
  // (worker_async is handled by the /run route before this point.)
  const workerExecutor =
    mode !== "inline"
      ? makeWorkerTestExecutor({
          queue: getJobQueue(),
          repoCloneUrl: resolveRepoCloneUrl(),
          branch: resolveBaseBranch(),
          timeoutMs: resolveTestJobTimeoutMs(),
          pollMs: resolveTestJobPollMs(),
          userId: opts.userId ?? null,
          audit: (eventType, sessionId, metadata) =>
            recordAudit({
              eventType,
              status: eventType.includes("failed") || eventType.includes("timeout")
                ? "fail"
                : "ok",
              sessionId,
              userId: opts.userId ?? null,
              metadata,
            }),
        })
      : undefined;

  const adapters = await buildModelAdapters();
  const orchestrator = new Orchestrator(repo, {
    executeTests: process.env.AI_ORCHESTRATOR_EXECUTE_TESTS === "1",
    openai: adapters.openai,
    anthropic: adapters.anthropic,
    ...opts,
    testExecutor: opts.testExecutor ?? workerExecutor,
  });
  const { sessionId } = await orchestrator.run(userRequest);
  const detail = await repo.getSessionDetail(sessionId);
  if (!detail) throw new Error("Session disappeared after run");
  return detail;
}

export { TestRunnerModeBlockedError };

export async function listSessions(limit = 50): Promise<SessionRecord[]> {
  return getRepository().listSessions(limit);
}

export async function getSessionDetail(
  id: string,
): Promise<SessionDetail | null> {
  return getRepository().getSessionDetail(id);
}

export async function setApproval(
  id: string,
  approval: "approved" | "rejected",
): Promise<SessionDetail | null> {
  const repo = getRepository();
  const session = await repo.getSession(id);
  if (!session) return null;
  await repo.updateSession(id, {
    approval,
    status: approval === "rejected" ? "rejected" : session.status,
  });
  return repo.getSessionDetail(id);
}

// =============================================================================
// Phase 6 — patch validation + GitHub PR state helpers.
// =============================================================================

function resolveBaseBranch(): string {
  const { config } = resolveGithubConfig();
  return config?.defaultBranch ?? process.env.GITHUB_DEFAULT_BRANCH?.trim() ?? "main";
}

/** Latest `patch` artifact content for a session (the implementer's output). */
export async function getLatestPatchArtifactText(
  sessionId: string,
): Promise<string | null> {
  const repo = getRepository();
  const artifacts = await repo.getArtifacts(sessionId);
  const patches = artifacts.filter((a) => a.type === "patch");
  return patches.length ? patches[patches.length - 1].content : null;
}

/** Most recent validated patch set, if any. */
export async function getLatestValidatedPatchSet(
  sessionId: string,
): Promise<PatchSetRecord | null> {
  const repo = getRepository();
  const sets = await repo.getPatchSetsForSession(sessionId);
  return sets.find((s) => s.status === "validated") ?? null;
}

export interface ValidatePatchOutcome {
  ok: boolean;
  patchSet: PatchSetRecord | null;
  errors: string[];
  message: string;
}

/** Validate + persist the session's latest patch artifact (validate route). */
export async function validateSessionPatchArtifact(
  subject: RbacSubject,
  sessionId: string,
  meta: { ip?: string | null; userAgent?: string | null } = {},
): Promise<ValidatePatchOutcome> {
  const repo = getRepository();
  const session = await repo.getSession(sessionId);
  if (!session) {
    return {
      ok: false,
      patchSet: null,
      errors: ["session not found"],
      message: "Session not found",
    };
  }
  const artifactText = await getLatestPatchArtifactText(sessionId);
  if (!artifactText) {
    return {
      ok: false,
      patchSet: null,
      errors: ["no patch artifact"],
      message: "No patch artifact found for this session",
    };
  }

  await recordAudit({
    eventType: "patch_validation_started",
    status: "ok",
    sessionId,
    userId: subject.userId,
    ip: meta.ip ?? null,
    userAgent: meta.userAgent ?? null,
  });

  // Phase 7.1.1: capture base-file hashes from the GitHub base branch (when
  // configured) so the worker can detect base drift at apply time.
  const { config: ghConfig } = resolveGithubConfig();
  let baseFileHasher:
    | ((path: string) => Promise<string | null>)
    | undefined;
  if (ghConfig) {
    const client = createGithubClient(ghConfig);
    baseFileHasher = async (path: string) => {
      const f = await client.getFile(path, ghConfig.defaultBranch);
      return f ? driftHash(f.content) : null;
    };
  }

  const stored = await validateAndStorePatch({
    repo,
    session,
    userId: subject.userId,
    artifactText,
    baseBranch: resolveBaseBranch(),
    targetBranch: buildBranchName(sessionId, Date.now()),
    canDelete: subject.role === "owner" || subject.role === "admin",
    baseFileHasher,
  });

  await recordAudit({
    eventType: stored.ok ? "patch_validation_passed" : "patch_validation_failed",
    status: stored.ok ? "ok" : "fail",
    sessionId,
    userId: subject.userId,
    ip: meta.ip ?? null,
    userAgent: meta.userAgent ?? null,
    metadata: { files: stored.patch?.files.length ?? 0, errors: stored.errors.length },
  });

  return {
    ok: stored.ok,
    patchSet: stored.patchSet,
    errors: stored.errors,
    message: stored.ok ? "Patch validated." : "Patch validation failed.",
  };
}

export interface SessionGithubState {
  patchSets: PatchSetRecord[];
  latestPatchFiles: PatchFileRecord[];
  pullRequests: PullRequestRecord[];
  /** Phase 7.1: recent sandbox jobs + the current validated patch set id. */
  workerJobs: WorkerJobRecord[];
  latestValidatedPatchSetId: string | null;
}

/** Patch sets + latest files + PR attempts + worker jobs (GET pull-request). */
export async function getSessionGithubState(
  sessionId: string,
): Promise<SessionGithubState | null> {
  const repo = getRepository();
  const session = await repo.getSession(sessionId);
  if (!session) return null;
  const patchSets = await repo.getPatchSetsForSession(sessionId);
  const latestPatchFiles = patchSets.length
    ? await repo.getPatchFiles(patchSets[0].id)
    : [];
  const pullRequests = await repo.getPullRequestsForSession(sessionId);
  const workerJobs = await repo.listWorkerJobsForSession(sessionId, 20);
  const latestValidatedPatchSetId =
    patchSets.find((p) => p.status === "validated")?.id ?? null;
  return {
    patchSets,
    latestPatchFiles,
    pullRequests,
    workerJobs,
    latestValidatedPatchSetId,
  };
}

// =============================================================================
// Phase 7 — worker job bridge (control plane creates/reads/cancels jobs).
// =============================================================================

/** Resolve a clone URL: explicit env, else derive from GITHUB_OWNER/REPO. */
export function resolveRepoCloneUrl(
  env: Record<string, string | undefined> = process.env,
): string {
  const explicit = env.AI_ORCHESTRATOR_REPO_CLONE_URL?.trim();
  if (explicit) return explicit;
  const { config } = resolveGithubConfig(env);
  if (config) return `https://github.com/${config.owner}/${config.repo}.git`;
  return "local"; // local/dev fallback (worker copies the current repo)
}

export const DEFAULT_TEST_COMMANDS = [
  "npm ci",
  "npm run typecheck",
  "npm test",
  "npm run build",
] as const;

export interface CreateTestJobOptions {
  branch?: string;
  /** Owner/admin only: run a bare test_branch job (no patch) for debugging. */
  debug?: boolean;
  ip?: string | null;
  userAgent?: string | null;
}

export type CreateTestJobResult =
  | { ok: true; job: WorkerJobRecord }
  | { ok: false; status: number; error: string };

/**
 * Enqueue a sandbox test job for a session (control plane — no inline run).
 * The PR flow path needs a `test_patch` job, so a **validated patch set is
 * required**; without one we return 409 (run Validate Patch first). A bare
 * `test_branch` debug job is allowed only for owner/admin with debug=true.
 */
export async function createTestJobForSession(
  subject: RbacSubject,
  sessionId: string,
  opts: CreateTestJobOptions = {},
): Promise<CreateTestJobResult> {
  const cloneUrl = resolveRepoCloneUrl();
  const branch = opts.branch?.trim() || resolveBaseBranch();
  const patchSet = await getLatestValidatedPatchSet(sessionId);

  if (!patchSet) {
    if (opts.debug && (subject.role === "owner" || subject.role === "admin")) {
      const job = await createTestJob(getJobQueue(), {
        sessionId,
        userId: subject.userId,
        jobType: "test_branch",
        repo: { clone_url: cloneUrl, branch },
        commands: [...DEFAULT_TEST_COMMANDS],
        ip: opts.ip,
        userAgent: opts.userAgent,
      });
      return { ok: true, job };
    }
    return {
      ok: false,
      status: 409,
      error: "No validated patch set for this session. Run Validate Patch first.",
    };
  }

  const job = await createTestJob(getJobQueue(), {
    sessionId,
    patchSetId: patchSet.id,
    userId: subject.userId,
    jobType: "test_patch",
    repo: { clone_url: cloneUrl, branch },
    commands: [...DEFAULT_TEST_COMMANDS],
    ip: opts.ip,
    userAgent: opts.userAgent,
  });
  return { ok: true, job };
}

/** A single worker job + its log tail (GET /jobs/[id]). */
export async function getWorkerJobView(jobId: string): Promise<JobView | null> {
  return getJobView(getJobQueue(), jobId);
}

/** Fetch a worker job alone (for access checks before returning the view). */
export async function getWorkerJob(
  jobId: string,
): Promise<WorkerJobRecord | null> {
  return getJobQueue().get(jobId);
}

/** Cancel a worker job (queued/running). Audits worker_job_cancelled. */
export async function cancelWorkerJobById(
  jobId: string,
  meta: {
    userId?: string | null;
    sessionId?: string | null;
    ip?: string | null;
    userAgent?: string | null;
  } = {},
): Promise<boolean> {
  return cancelJob(getJobQueue(), jobId, meta);
}

/** Current worker provider (for the health endpoint / UI). */
export function currentWorkerProvider(): "database" | "local" {
  return resolveWorkerProvider();
}

// =============================================================================
// Phase 7.3 — async (resumable) orchestration.
// =============================================================================

/** Build model adapters from the resolved keys (DB-stored first, else env). */
export async function buildModelAdapters(): Promise<{
  openai: AIAdapter;
  anthropic: AIAdapter;
}> {
  const keys = await resolveModelKeys();
  return {
    openai: new OpenAIAdapter({ apiKey: keys.openai, model: keys.openaiModel }),
    anthropic: new AnthropicAdapter({
      apiKey: keys.anthropic,
      model: keys.anthropicModel,
    }),
  };
}

async function buildAsyncOrchestrator(opts: {
  userId: string | null;
  adminKeyFingerprint: string | null;
  humanApproved?: boolean;
}): Promise<AsyncOrchestrator> {
  const adapters = await buildModelAdapters();
  return new AsyncOrchestrator({
    repo: getRepository(),
    queue: getJobQueue(),
    repoCloneUrl: resolveRepoCloneUrl(),
    branch: resolveBaseBranch(),
    humanApproved: opts.humanApproved ?? false,
    userId: opts.userId,
    adminKeyFingerprint: opts.adminKeyFingerprint,
    openai: adapters.openai,
    anthropic: adapters.anthropic,
  });
}

/** Start an async orchestration (returns at the first worker wait). */
export async function startAsyncOrchestrationForContext(
  ctx: AuthContext,
  request: string,
  humanApproved: boolean,
): Promise<AsyncResult> {
  return (
    await buildAsyncOrchestrator({
      userId: ctx.userId,
      adminKeyFingerprint: ctx.keyFingerprint,
      humanApproved,
    })
  ).start(request);
}

/** Resume an async orchestration after its worker job completes. */
export async function resumeOrchestration(
  ctx: AuthContext,
  runId: string,
): Promise<AsyncResult> {
  const run = await getRepository().getOrchestrationRun(runId);
  const humanApproved = Boolean(
    (run?.state as { humanApproved?: boolean } | undefined)?.humanApproved,
  );
  await recordAudit({
    eventType: "orchestration_resume_requested",
    status: "ok",
    sessionId: run?.session_id ?? null,
    userId: ctx.userId,
    adminKeyFingerprint: ctx.keyFingerprint,
    metadata: { orchestrationRunId: runId },
  });
  return (
    await buildAsyncOrchestrator({
      userId: ctx.userId,
      adminKeyFingerprint: ctx.keyFingerprint,
      humanApproved,
    })
  ).resume(runId);
}

/**
 * Start an async orchestration WITHOUT an AuthContext — used by the production
 * dry-run script (model calls are gated by an explicit flag in that script).
 */
export async function startOrchestrationSystem(
  request: string,
  humanApproved = false,
  userId: string | null = null,
): Promise<AsyncResult> {
  return (
    await buildAsyncOrchestrator({
      userId,
      adminKeyFingerprint: null,
      humanApproved,
    })
  ).start(request);
}

/**
 * Resume WITHOUT an AuthContext — used by the cron scheduler + worker
 * auto-resume. The run owner + humanApproved come from the persisted state, so
 * the destructive-migration safety gate carries across rounds.
 */
export async function resumeOrchestrationSystem(
  runId: string,
): Promise<AsyncResult> {
  const run = await getRepository().getOrchestrationRun(runId);
  const humanApproved = Boolean(
    (run?.state as { humanApproved?: boolean } | undefined)?.humanApproved,
  );
  return (
    await buildAsyncOrchestrator({
      userId: run?.user_id ?? null,
      adminKeyFingerprint: null,
      humanApproved,
    })
  ).resume(runId);
}

/** Cancel an async orchestration + its pending worker job. */
export async function cancelOrchestration(
  ctx: AuthContext,
  runId: string,
  meta: { ip?: string | null; userAgent?: string | null } = {},
): Promise<{ cancelled: boolean; status: string }> {
  const repo = getRepository();
  const run = await repo.getOrchestrationRun(runId);
  if (!run) return { cancelled: false, status: "not_found" };
  if (run.pending_worker_job_id) {
    await repo.cancelWorkerJob(run.pending_worker_job_id).catch(() => {});
  }
  const cancelled = await repo.cancelOrchestrationRun(runId);
  if (cancelled) {
    await recordAudit({
      eventType: "orchestration_cancelled",
      status: "ok",
      sessionId: run.session_id,
      userId: ctx.userId,
      adminKeyFingerprint: ctx.keyFingerprint,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
      metadata: { orchestrationRunId: runId },
    });
    await repo
      .appendOrchestrationEvent({
        orchestrationRunId: runId,
        sessionId: run.session_id,
        eventType: "orchestration_cancelled",
        metadata: {},
      })
      .catch(() => {});
  }
  return { cancelled, status: cancelled ? "cancelled" : run.status };
}

export interface OrchestrationView {
  run: OrchestrationRunRecord;
  events: OrchestrationEventRecord[];
  pendingJob: WorkerJobRecord | null;
}

/**
 * Phase 7.3/7.4 (optional worker auto-resume): resume any waiting orchestration
 * whose pending worker job is terminal. The PRIMARY path is the scheduled cron
 * resume — this is opt-in (AI_ORCHESTRATOR_WORKER_AUTO_RESUME=1) and only safe
 * when the resumer has model keys. It shares the Phase 7.4 resume lock with the
 * cron route, so the two paths never double-resume the same run. Returns the
 * number of runs resumed.
 */
export async function autoResumeReadyOrchestrations(
  limit = 50,
): Promise<number> {
  const summary = await resumeDueOrchestrations({
    batchSize: limit,
    resume: resumeOrchestrationSystem,
  });
  return summary.resumed;
}

/** Run + events + pending job for the GET orchestration route. */
export async function getOrchestrationView(
  runId: string,
): Promise<OrchestrationView | null> {
  const repo = getRepository();
  const run = await repo.getOrchestrationRun(runId);
  if (!run) return null;
  const events = await repo.getOrchestrationEvents(runId, 100);
  const pendingJob = run.pending_worker_job_id
    ? await repo.getWorkerJob(run.pending_worker_job_id)
    : null;
  return { run, events, pendingJob };
}
