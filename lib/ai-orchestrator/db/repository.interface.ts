import {
  AgentOutput,
  ApiKeyRecord,
  ArtifactRecord,
  ArtifactType,
  AuditLogRecord,
  MessageRecord,
  OrchestrationEventRecord,
  OrchestrationRunRecord,
  OrchestrationRunStatus,
  PatchFileChangeType,
  PatchFileRecord,
  PatchSetRecord,
  PatchSetStatus,
  PermissionOverrideRecord,
  Provider,
  PullRequestRecord,
  PullRequestStatus,
  RunRecord,
  SessionCollaboratorRecord,
  SessionDetail,
  SessionRecord,
  StepName,
  UserRecord,
  UserRole,
  WorkerJobLogRecord,
  WorkerJobRecord,
  WorkerJobStream,
} from "../types";
import type {
  ClaimOptions,
  CreateWorkerJobInput,
  UpdateWorkerJobStatusInput,
} from "../worker/types";

export interface AuditLogInput {
  eventType: string;
  status: string;
  sessionId?: string | null;
  adminKeyFingerprint?: string | null;
  userId?: string | null;
  ipHash?: string | null;
  userAgentHash?: string | null;
  metadata?: Record<string, unknown>;
}

/** Optional caller attribution (prepared for multi-user; nullable today). */
export interface SessionAttribution {
  userId?: string | null;
  adminKeyFingerprint?: string | null;
}

/**
 * Storage abstraction for the orchestrator. The service + orchestrator depend
 * ONLY on this interface, so the SQLite implementation can be swapped for a
 * Postgres/Supabase one in production without touching business logic.
 *
 * All methods are async: SQLite (node:sqlite) resolves immediately, while the
 * Postgres/Supabase backend performs real network I/O.
 */
export interface AiOrchestratorRepository {
  createSession(
    userRequest: string,
    attribution?: SessionAttribution,
  ): Promise<SessionRecord>;
  updateSession(
    id: string,
    patch: Partial<Pick<SessionRecord, "status" | "approval" | "rounds">>,
  ): Promise<void>;
  getSession(id: string): Promise<SessionRecord | null>;
  listSessions(limit?: number): Promise<SessionRecord[]>;

  addMessage(args: {
    sessionId: string;
    step: StepName;
    provider: Provider;
    round: number;
    output: AgentOutput;
  }): Promise<MessageRecord>;

  addArtifact(args: {
    sessionId: string;
    messageId: string;
    type: ArtifactType;
    content: string;
  }): Promise<ArtifactRecord>;

  addRun(args: {
    sessionId: string;
    command: string;
    allowed: boolean;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    step?: StepName | null;
    adminKeyFingerprint?: string | null;
    userId?: string | null;
  }): Promise<RunRecord>;

  getMessages(sessionId: string): Promise<MessageRecord[]>;
  getArtifacts(sessionId: string): Promise<ArtifactRecord[]>;
  getRuns(sessionId: string): Promise<RunRecord[]>;
  getSessionDetail(id: string): Promise<SessionDetail | null>;

  /** Append an audit-log row. */
  addAuditLog(input: AuditLogInput): Promise<AuditLogRecord>;
  /** Read recent audit-log rows (most recent first). */
  getAuditLogs(limit?: number): Promise<AuditLogRecord[]>;

  // --- Users / API keys / RBAC (Phase 5) ---
  createUser(args: {
    email?: string | null;
    displayName?: string | null;
    role: UserRole;
  }): Promise<UserRecord>;
  getUserById(id: string): Promise<UserRecord | null>;
  getUserByEmail(email: string): Promise<UserRecord | null>;
  listUsers(limit?: number): Promise<UserRecord[]>;
  updateUserStatus(id: string, status: "active" | "disabled"): Promise<void>;
  updateUserLastSeen(id: string): Promise<void>;

  createApiKey(args: {
    userId: string;
    keyPrefix: string;
    keyHash: string;
    name?: string | null;
    expiresAt?: string | null;
  }): Promise<ApiKeyRecord>;
  getApiKeyByPrefix(prefix: string): Promise<ApiKeyRecord | null>;
  getApiKeyById(id: string): Promise<ApiKeyRecord | null>;
  listApiKeysForUser(userId: string): Promise<ApiKeyRecord[]>;
  updateApiKeyLastUsed(id: string): Promise<void>;
  revokeApiKey(id: string): Promise<void>;

  addSessionCollaborator(args: {
    sessionId: string;
    userId: string;
    permission: SessionCollaboratorRecord["permission"];
  }): Promise<SessionCollaboratorRecord>;
  listSessionCollaborators(
    sessionId: string,
  ): Promise<SessionCollaboratorRecord[]>;
  getCollaboratorSessionIds(userId: string): Promise<string[]>;

  addUserPermissionOverride(args: {
    userId: string;
    permission: string;
    effect: "allow" | "deny";
  }): Promise<PermissionOverrideRecord>;
  getUserPermissionOverrides(
    userId: string,
  ): Promise<PermissionOverrideRecord[]>;

  // --- Patch sets / patch files / pull requests (Phase 6) ---
  createPatchSet(args: {
    sessionId: string;
    userId: string | null;
    status: PatchSetStatus;
    baseBranch: string;
    targetBranch: string;
    baseSha: string | null;
    patchSummary: string | null;
    patchText: string | null;
    validationErrors: string[] | null;
  }): Promise<PatchSetRecord>;
  getPatchSet(id: string): Promise<PatchSetRecord | null>;
  getPatchSetsForSession(
    sessionId: string,
    limit?: number,
  ): Promise<PatchSetRecord[]>;
  updatePatchSet(
    id: string,
    patch: Partial<
      Pick<
        PatchSetRecord,
        "status" | "base_sha" | "validation_errors" | "patch_summary"
      >
    >,
  ): Promise<void>;

  addPatchFile(args: {
    patchSetId: string;
    filePath: string;
    changeType: PatchFileChangeType;
    oldContentHash: string | null;
    newContentHash: string | null;
    patchHunk: string | null;
    reason: string | null;
    /** Full redacted new content (Phase 7.1) — null for delete. */
    newContentRedacted?: string | null;
  }): Promise<PatchFileRecord>;
  getPatchFiles(patchSetId: string): Promise<PatchFileRecord[]>;

  createPullRequest(args: {
    sessionId: string;
    patchSetId: string;
    userId: string | null;
    branchName: string;
    baseBranch: string;
    status: PullRequestStatus;
    githubPrNumber?: number | null;
    githubPrUrl?: string | null;
    errorMessage?: string | null;
  }): Promise<PullRequestRecord>;
  getPullRequestsForSession(
    sessionId: string,
    limit?: number,
  ): Promise<PullRequestRecord[]>;
  updatePullRequest(
    id: string,
    patch: Partial<
      Pick<
        PullRequestRecord,
        "status" | "github_pr_number" | "github_pr_url" | "error_message"
      >
    >,
  ): Promise<void>;

  // --- Worker jobs / job logs (Phase 7) ---
  createWorkerJob(input: CreateWorkerJobInput): Promise<WorkerJobRecord>;
  getWorkerJob(id: string): Promise<WorkerJobRecord | null>;
  listWorkerJobsForSession(
    sessionId: string,
    limit?: number,
  ): Promise<WorkerJobRecord[]>;
  /**
   * Atomically claim the next runnable job for `workerId` (queued, or running
   * with an expired lease). Sets status=running, lease_owner, lease_expires_at,
   * and increments attempts. Jobs that have exhausted max_attempts are marked
   * failed and skipped. Returns null when nothing is claimable.
   */
  claimNextWorkerJob(
    workerId: string,
    opts?: ClaimOptions,
  ): Promise<WorkerJobRecord | null>;
  /**
   * Phase 7.1.3: renew the lease of a running job the worker still owns. Returns
   * the updated job, or null if it is no longer running / owned by someone else
   * (the worker must then stop). On Postgres this is the atomic RPC
   * renew_ai_worker_job_lease.
   */
  renewWorkerJobLease(
    jobId: string,
    workerId: string,
    leaseSeconds: number,
  ): Promise<WorkerJobRecord | null>;
  updateWorkerJobStatus(
    id: string,
    patch: UpdateWorkerJobStatusInput,
  ): Promise<void>;
  /** Append a log line. Content is redacted before it is stored. */
  appendWorkerJobLog(
    jobId: string,
    stream: WorkerJobStream,
    content: string,
  ): Promise<void>;
  getWorkerJobLogs(
    jobId: string,
    limit?: number,
  ): Promise<WorkerJobLogRecord[]>;
  /** Cancel a queued/running job. Returns false if it was already terminal. */
  cancelWorkerJob(id: string): Promise<boolean>;

  // --- Async orchestration runs / events (Phase 7.3) ---
  createOrchestrationRun(args: {
    sessionId: string;
    userId: string | null;
    status?: OrchestrationRunStatus;
    currentRound?: number;
    maxRounds?: number;
    currentStep?: string | null;
    state?: Record<string, unknown>;
  }): Promise<OrchestrationRunRecord>;
  getOrchestrationRun(id: string): Promise<OrchestrationRunRecord | null>;
  getOrchestrationRunBySession(
    sessionId: string,
  ): Promise<OrchestrationRunRecord | null>;
  listOrchestrationRuns(limit?: number): Promise<OrchestrationRunRecord[]>;
  updateOrchestrationRun(
    id: string,
    patch: Partial<
      Pick<
        OrchestrationRunRecord,
        | "status"
        | "current_round"
        | "current_step"
        | "pending_worker_job_id"
        | "last_error"
        | "state"
        | "finished_at"
      >
    >,
  ): Promise<void>;
  appendOrchestrationEvent(args: {
    orchestrationRunId: string;
    sessionId: string;
    eventType: string;
    metadata?: Record<string, unknown>;
  }): Promise<OrchestrationEventRecord>;
  getOrchestrationEvents(
    orchestrationRunId: string,
    limit?: number,
  ): Promise<OrchestrationEventRecord[]>;
  findOrchestrationRunByWorkerJobId(
    jobId: string,
  ): Promise<OrchestrationRunRecord | null>;
  /** Cancel a non-terminal run. Returns false if it was already terminal. */
  cancelOrchestrationRun(id: string): Promise<boolean>;

  // --- Scheduled / cron resume (Phase 7.4) ---
  /** Runs in status=waiting_for_worker (most recent first) — cron resume scan. */
  listWaitingOrchestrationRuns(
    limit?: number,
  ): Promise<OrchestrationRunRecord[]>;
  /**
   * Atomically claim the resume lock for `owner`, but ONLY when the run is still
   * waiting_for_worker AND the lock is free or expired. Sets the owner + a TTL
   * and bumps last_resume_attempt_at. Returns the locked run, or null when it
   * could not be claimed (someone else holds a fresh lock / not waiting).
   */
  claimOrchestrationResumeLock(
    runId: string,
    owner: string,
    ttlSeconds: number,
  ): Promise<OrchestrationRunRecord | null>;
  /** Release the resume lock — only when `owner` still holds it (no-op otherwise). */
  releaseOrchestrationResumeLock(
    runId: string,
    owner: string,
  ): Promise<void>;
  /** Increment the resume-attempt counter (diagnostics / backoff). */
  incrementOrchestrationResumeAttempt(runId: string): Promise<void>;

  /** Lightweight connectivity probe for the health endpoint. Throws on failure. */
  ping(): Promise<void>;

  /**
   * Readiness gate (Phase 8): true when `column` is readable from `table` (pass
   * "*" to check only that the table exists). A bounded existence probe — reads
   * at most one row, writes nothing, never throws (returns false on any error).
   */
  probeTableColumn(table: string, column: string): Promise<boolean>;
}
