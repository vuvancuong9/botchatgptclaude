import { randomUUID } from "node:crypto";
import {
  AgentOutput,
  ApiKeyRecord,
  ArtifactRecord,
  ArtifactType,
  AuditLogRecord,
  deriveRunStatus,
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
  RunStatus,
  SessionCollaboratorRecord,
  SessionDetail,
  SessionRecord,
  StepName,
  UserRecord,
  UserRole,
  WorkerJobLogRecord,
  WorkerJobRecord,
  WorkerJobStatus,
  WorkerJobStream,
  WorkerJobType,
} from "../types";
import type {
  ClaimOptions,
  CreateWorkerJobInput,
  UpdateWorkerJobStatusInput,
} from "../worker/types";
import { redactSecrets } from "../security/redact";
import type {
  AiOrchestratorRepository,
  AuditLogInput,
  SessionAttribution,
} from "./repository.interface";
import type { TableGateway } from "./supabase-server";

const T_SESSIONS = "ai_sessions";
const T_MESSAGES = "ai_messages";
const T_ARTIFACTS = "ai_artifacts";
const T_RUNS = "ai_runs";
const T_AUDIT = "ai_audit_logs";
const T_USERS = "ai_users";
const T_API_KEYS = "ai_api_keys";
const T_COLLAB = "ai_session_collaborators";
const T_OVERRIDES = "ai_user_permissions_override";
const T_PATCH_SETS = "ai_patch_sets";
const T_PATCH_FILES = "ai_patch_files";
const T_PULL_REQUESTS = "ai_pull_requests";
const T_WORKER_JOBS = "ai_worker_jobs";
const T_WORKER_JOB_LOGS = "ai_worker_job_logs";
const T_ORCH_RUNS = "ai_orchestration_runs";
const T_ORCH_EVENTS = "ai_orchestration_events";

function now(): string {
  return new Date().toISOString();
}

/**
 * Postgres/Supabase-backed implementation of the storage abstraction.
 *
 * IDs and timestamps are generated app-side (like the SQLite backend) so the
 * returned records are exact without an extra round-trip. `output` is stored as
 * a JSONB object. Secrets in run output are redacted before persisting.
 */
export class PostgresRepository implements AiOrchestratorRepository {
  constructor(private readonly db: TableGateway) {}

  async createSession(
    userRequest: string,
    attribution: SessionAttribution = {},
  ): Promise<SessionRecord> {
    const record: SessionRecord = {
      id: randomUUID(),
      user_request: userRequest,
      status: "running",
      approval: "pending",
      rounds: 0,
      user_id: attribution.userId ?? null,
      admin_key_fingerprint: attribution.adminKeyFingerprint ?? null,
      created_at: now(),
      updated_at: now(),
    };
    await this.db.insert(T_SESSIONS, record as unknown as Record<string, unknown>);
    return record;
  }

  async updateSession(
    id: string,
    patch: Partial<Pick<SessionRecord, "status" | "approval" | "rounds">>,
  ): Promise<void> {
    const current = await this.getSession(id);
    if (!current) throw new Error(`Session ${id} not found`);
    await this.db.update(
      T_SESSIONS,
      { id },
      {
        status: patch.status ?? current.status,
        approval: patch.approval ?? current.approval,
        rounds: patch.rounds ?? current.rounds,
        updated_at: now(),
      },
    );
  }

  async getSession(id: string): Promise<SessionRecord | null> {
    const row = await this.db.selectOne<Record<string, unknown>>(T_SESSIONS, {
      id,
    });
    return row ? mapSession(row) : null;
  }

  async listSessions(limit = 50): Promise<SessionRecord[]> {
    const rows = await this.db.selectMany<Record<string, unknown>>(
      T_SESSIONS,
      {},
      { orderBy: { column: "created_at", ascending: false }, limit },
    );
    return rows.map(mapSession);
  }

  async addMessage(args: {
    sessionId: string;
    step: StepName;
    provider: Provider;
    round: number;
    output: AgentOutput;
  }): Promise<MessageRecord> {
    const id = randomUUID();
    const ts = now();
    await this.db.insert(T_MESSAGES, {
      id,
      session_id: args.sessionId,
      step: args.step,
      provider: args.provider,
      round: args.round,
      status: args.output.status,
      output: args.output,
      created_at: ts,
    });

    for (const artifact of args.output.artifacts) {
      await this.addArtifact({
        sessionId: args.sessionId,
        messageId: id,
        type: artifact.type,
        content: artifact.content,
      });
    }

    return {
      id,
      session_id: args.sessionId,
      step: args.step,
      provider: args.provider,
      round: args.round,
      output: args.output,
      created_at: ts,
    };
  }

  async addArtifact(args: {
    sessionId: string;
    messageId: string;
    type: ArtifactType;
    content: string;
  }): Promise<ArtifactRecord> {
    const id = randomUUID();
    const ts = now();
    await this.db.insert(T_ARTIFACTS, {
      id,
      session_id: args.sessionId,
      message_id: args.messageId,
      type: args.type,
      content: args.content,
      created_at: ts,
    });
    return {
      id,
      session_id: args.sessionId,
      message_id: args.messageId,
      type: args.type,
      content: args.content,
      created_at: ts,
    };
  }

  async addRun(args: {
    sessionId: string;
    command: string;
    allowed: boolean;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    step?: StepName | null;
    adminKeyFingerprint?: string | null;
    userId?: string | null;
  }): Promise<RunRecord> {
    const id = randomUUID();
    const ts = now();
    // Redact secrets BEFORE the value ever leaves the process.
    const stdout = redactSecrets(args.stdout);
    const stderr = redactSecrets(args.stderr);
    const status: RunStatus = deriveRunStatus(args.allowed, args.exitCode);
    const step = args.step ?? null;
    const fingerprint = args.adminKeyFingerprint ?? null;
    const userId = args.userId ?? null;
    await this.db.insert(T_RUNS, {
      id,
      session_id: args.sessionId,
      command: args.command,
      allowed: args.allowed,
      exit_code: args.exitCode,
      stdout,
      stderr,
      step_name: step,
      status,
      admin_key_fingerprint: fingerprint,
      user_id: userId,
      created_at: ts,
    });
    return {
      id,
      session_id: args.sessionId,
      command: args.command,
      allowed: args.allowed,
      exit_code: args.exitCode,
      stdout,
      stderr,
      step_name: step,
      status,
      admin_key_fingerprint: fingerprint,
      user_id: userId,
      created_at: ts,
    };
  }

  async getMessages(sessionId: string): Promise<MessageRecord[]> {
    const rows = await this.db.selectMany<Record<string, unknown>>(
      T_MESSAGES,
      { session_id: sessionId },
      { orderBy: { column: "created_at", ascending: true } },
    );
    return rows.map(mapMessage);
  }

  async getArtifacts(sessionId: string): Promise<ArtifactRecord[]> {
    const rows = await this.db.selectMany<Record<string, unknown>>(
      T_ARTIFACTS,
      { session_id: sessionId },
      { orderBy: { column: "created_at", ascending: true } },
    );
    return rows.map((r) => ({
      id: r.id as string,
      session_id: r.session_id as string,
      message_id: r.message_id as string,
      type: r.type as ArtifactType,
      content: r.content as string,
      created_at: r.created_at as string,
    }));
  }

  async getRuns(sessionId: string): Promise<RunRecord[]> {
    const rows = await this.db.selectMany<Record<string, unknown>>(
      T_RUNS,
      { session_id: sessionId },
      { orderBy: { column: "created_at", ascending: true } },
    );
    return rows.map(mapRun);
  }

  async getSessionDetail(id: string): Promise<SessionDetail | null> {
    const session = await this.getSession(id);
    if (!session) return null;
    return {
      session,
      messages: await this.getMessages(id),
      artifacts: await this.getArtifacts(id),
      runs: await this.getRuns(id),
    };
  }

  async addAuditLog(input: AuditLogInput): Promise<AuditLogRecord> {
    const id = randomUUID();
    const ts = now();
    const metadata = input.metadata ?? {};
    await this.db.insert(T_AUDIT, {
      id,
      event_type: input.eventType,
      session_id: input.sessionId ?? null,
      admin_key_fingerprint: input.adminKeyFingerprint ?? null,
      user_id: input.userId ?? null,
      ip_hash: input.ipHash ?? null,
      user_agent_hash: input.userAgentHash ?? null,
      status: input.status,
      metadata,
      created_at: ts,
    });
    return {
      id,
      event_type: input.eventType,
      session_id: input.sessionId ?? null,
      admin_key_fingerprint: input.adminKeyFingerprint ?? null,
      user_id: input.userId ?? null,
      ip_hash: input.ipHash ?? null,
      user_agent_hash: input.userAgentHash ?? null,
      status: input.status,
      metadata,
      created_at: ts,
    };
  }

  async getAuditLogs(limit = 100): Promise<AuditLogRecord[]> {
    const rows = await this.db.selectMany<Record<string, unknown>>(
      T_AUDIT,
      {},
      { orderBy: { column: "created_at", ascending: false }, limit },
    );
    return rows.map((r) => ({
      id: r.id as string,
      event_type: r.event_type as string,
      session_id: (r.session_id as string | null) ?? null,
      admin_key_fingerprint: (r.admin_key_fingerprint as string | null) ?? null,
      user_id: (r.user_id as string | null) ?? null,
      ip_hash: (r.ip_hash as string | null) ?? null,
      user_agent_hash: (r.user_agent_hash as string | null) ?? null,
      status: r.status as string,
      metadata:
        typeof r.metadata === "string"
          ? JSON.parse(r.metadata)
          : ((r.metadata as Record<string, unknown>) ?? {}),
      created_at: String(r.created_at),
    }));
  }

  // --- Users / API keys / RBAC ---

  async createUser(args: {
    email?: string | null;
    displayName?: string | null;
    role: UserRole;
  }): Promise<UserRecord> {
    const record: UserRecord = {
      id: randomUUID(),
      email: args.email ?? null,
      display_name: args.displayName ?? null,
      role: args.role,
      status: "active",
      created_at: now(),
      updated_at: now(),
      last_seen_at: null,
    };
    await this.db.insert(T_USERS, record as unknown as Record<string, unknown>);
    return record;
  }

  async getUserById(id: string): Promise<UserRecord | null> {
    const row = await this.db.selectOne<Record<string, unknown>>(T_USERS, { id });
    return row ? mapUser(row) : null;
  }

  async getUserByEmail(email: string): Promise<UserRecord | null> {
    const row = await this.db.selectOne<Record<string, unknown>>(T_USERS, {
      email,
    });
    return row ? mapUser(row) : null;
  }

  async listUsers(limit = 100): Promise<UserRecord[]> {
    const rows = await this.db.selectMany<Record<string, unknown>>(
      T_USERS,
      {},
      { orderBy: { column: "created_at", ascending: true }, limit },
    );
    return rows.map(mapUser);
  }

  async updateUserStatus(
    id: string,
    status: "active" | "disabled",
  ): Promise<void> {
    await this.db.update(T_USERS, { id }, { status, updated_at: now() });
  }

  async updateUserLastSeen(id: string): Promise<void> {
    await this.db.update(T_USERS, { id }, { last_seen_at: now() });
  }

  async createApiKey(args: {
    userId: string;
    keyPrefix: string;
    keyHash: string;
    name?: string | null;
    expiresAt?: string | null;
  }): Promise<ApiKeyRecord> {
    const record: ApiKeyRecord = {
      id: randomUUID(),
      user_id: args.userId,
      key_prefix: args.keyPrefix,
      key_hash: args.keyHash,
      name: args.name ?? null,
      status: "active",
      last_used_at: null,
      expires_at: args.expiresAt ?? null,
      created_at: now(),
      revoked_at: null,
    };
    await this.db.insert(
      T_API_KEYS,
      record as unknown as Record<string, unknown>,
    );
    return record;
  }

  async getApiKeyByPrefix(prefix: string): Promise<ApiKeyRecord | null> {
    // Return regardless of status so the caller can distinguish revoked (403)
    // from invalid (401).
    const row = await this.db.selectOne<Record<string, unknown>>(T_API_KEYS, {
      key_prefix: prefix,
    });
    return row ? mapApiKey(row) : null;
  }

  async getApiKeyById(id: string): Promise<ApiKeyRecord | null> {
    const row = await this.db.selectOne<Record<string, unknown>>(T_API_KEYS, {
      id,
    });
    return row ? mapApiKey(row) : null;
  }

  async listApiKeysForUser(userId: string): Promise<ApiKeyRecord[]> {
    const rows = await this.db.selectMany<Record<string, unknown>>(
      T_API_KEYS,
      { user_id: userId },
      { orderBy: { column: "created_at", ascending: false } },
    );
    return rows.map(mapApiKey);
  }

  async updateApiKeyLastUsed(id: string): Promise<void> {
    await this.db.update(T_API_KEYS, { id }, { last_used_at: now() });
  }

  async revokeApiKey(id: string): Promise<void> {
    await this.db.update(
      T_API_KEYS,
      { id },
      { status: "revoked", revoked_at: now() },
    );
  }

  async addSessionCollaborator(args: {
    sessionId: string;
    userId: string;
    permission: SessionCollaboratorRecord["permission"];
  }): Promise<SessionCollaboratorRecord> {
    const record: SessionCollaboratorRecord = {
      id: randomUUID(),
      session_id: args.sessionId,
      user_id: args.userId,
      permission: args.permission,
      created_at: now(),
    };
    await this.db.insert(T_COLLAB, record as unknown as Record<string, unknown>);
    return record;
  }

  async listSessionCollaborators(
    sessionId: string,
  ): Promise<SessionCollaboratorRecord[]> {
    const rows = await this.db.selectMany<Record<string, unknown>>(T_COLLAB, {
      session_id: sessionId,
    });
    return rows.map(mapCollaborator);
  }

  async getCollaboratorSessionIds(userId: string): Promise<string[]> {
    const rows = await this.db.selectMany<Record<string, unknown>>(T_COLLAB, {
      user_id: userId,
    });
    return rows.map((r) => r.session_id as string);
  }

  async addUserPermissionOverride(args: {
    userId: string;
    permission: string;
    effect: "allow" | "deny";
  }): Promise<PermissionOverrideRecord> {
    const record: PermissionOverrideRecord = {
      id: randomUUID(),
      user_id: args.userId,
      permission: args.permission,
      effect: args.effect,
      created_at: now(),
    };
    await this.db.insert(
      T_OVERRIDES,
      record as unknown as Record<string, unknown>,
    );
    return record;
  }

  async getUserPermissionOverrides(
    userId: string,
  ): Promise<PermissionOverrideRecord[]> {
    const rows = await this.db.selectMany<Record<string, unknown>>(T_OVERRIDES, {
      user_id: userId,
    });
    return rows.map((r) => ({
      id: r.id as string,
      user_id: r.user_id as string,
      permission: r.permission as string,
      effect: r.effect as "allow" | "deny",
      created_at: String(r.created_at),
    }));
  }

  // --- Patch sets / patch files / pull requests (Phase 6) ---

  async createPatchSet(args: {
    sessionId: string;
    userId: string | null;
    status: PatchSetStatus;
    baseBranch: string;
    targetBranch: string;
    baseSha: string | null;
    patchSummary: string | null;
    patchText: string | null;
    validationErrors: string[] | null;
  }): Promise<PatchSetRecord> {
    const record: PatchSetRecord = {
      id: randomUUID(),
      session_id: args.sessionId,
      user_id: args.userId ?? null,
      status: args.status,
      base_branch: args.baseBranch,
      target_branch: args.targetBranch,
      base_sha: args.baseSha ?? null,
      patch_summary: args.patchSummary ?? null,
      patch_text: args.patchText ?? null,
      validation_errors: args.validationErrors ?? null,
      created_at: now(),
      updated_at: now(),
    };
    await this.db.insert(
      T_PATCH_SETS,
      record as unknown as Record<string, unknown>,
    );
    return record;
  }

  async getPatchSet(id: string): Promise<PatchSetRecord | null> {
    const row = await this.db.selectOne<Record<string, unknown>>(
      T_PATCH_SETS,
      { id },
    );
    return row ? mapPatchSet(row) : null;
  }

  async getPatchSetsForSession(
    sessionId: string,
    limit = 50,
  ): Promise<PatchSetRecord[]> {
    const rows = await this.db.selectMany<Record<string, unknown>>(
      T_PATCH_SETS,
      { session_id: sessionId },
      { orderBy: { column: "created_at", ascending: false }, limit },
    );
    return rows.map(mapPatchSet);
  }

  async updatePatchSet(
    id: string,
    patch: Partial<
      Pick<
        PatchSetRecord,
        "status" | "base_sha" | "validation_errors" | "patch_summary"
      >
    >,
  ): Promise<void> {
    const current = await this.getPatchSet(id);
    if (!current) throw new Error(`Patch set ${id} not found`);
    await this.db.update(
      T_PATCH_SETS,
      { id },
      {
        status: patch.status ?? current.status,
        base_sha:
          patch.base_sha !== undefined ? patch.base_sha : current.base_sha,
        validation_errors:
          patch.validation_errors !== undefined
            ? patch.validation_errors
            : current.validation_errors,
        patch_summary:
          patch.patch_summary !== undefined
            ? patch.patch_summary
            : current.patch_summary,
        updated_at: now(),
      },
    );
  }

  async addPatchFile(args: {
    patchSetId: string;
    filePath: string;
    changeType: PatchFileChangeType;
    oldContentHash: string | null;
    newContentHash: string | null;
    patchHunk: string | null;
    reason: string | null;
    newContentRedacted?: string | null;
  }): Promise<PatchFileRecord> {
    const record: PatchFileRecord = {
      id: randomUUID(),
      patch_set_id: args.patchSetId,
      file_path: args.filePath,
      change_type: args.changeType,
      old_content_hash: args.oldContentHash ?? null,
      new_content_hash: args.newContentHash ?? null,
      patch_hunk: args.patchHunk ?? null,
      reason: args.reason ?? null,
      new_content_redacted: args.newContentRedacted ?? null,
      created_at: now(),
    };
    await this.db.insert(
      T_PATCH_FILES,
      record as unknown as Record<string, unknown>,
    );
    return record;
  }

  async getPatchFiles(patchSetId: string): Promise<PatchFileRecord[]> {
    const rows = await this.db.selectMany<Record<string, unknown>>(
      T_PATCH_FILES,
      { patch_set_id: patchSetId },
      { orderBy: { column: "created_at", ascending: true } },
    );
    return rows.map(mapPatchFile);
  }

  async createPullRequest(args: {
    sessionId: string;
    patchSetId: string;
    userId: string | null;
    branchName: string;
    baseBranch: string;
    status: PullRequestStatus;
    githubPrNumber?: number | null;
    githubPrUrl?: string | null;
    errorMessage?: string | null;
  }): Promise<PullRequestRecord> {
    const record: PullRequestRecord = {
      id: randomUUID(),
      session_id: args.sessionId,
      patch_set_id: args.patchSetId,
      user_id: args.userId ?? null,
      github_pr_number: args.githubPrNumber ?? null,
      github_pr_url: args.githubPrUrl ?? null,
      branch_name: args.branchName,
      base_branch: args.baseBranch,
      status: args.status,
      error_message: args.errorMessage ?? null,
      created_at: now(),
      updated_at: now(),
    };
    await this.db.insert(
      T_PULL_REQUESTS,
      record as unknown as Record<string, unknown>,
    );
    return record;
  }

  async getPullRequestsForSession(
    sessionId: string,
    limit = 50,
  ): Promise<PullRequestRecord[]> {
    const rows = await this.db.selectMany<Record<string, unknown>>(
      T_PULL_REQUESTS,
      { session_id: sessionId },
      { orderBy: { column: "created_at", ascending: false }, limit },
    );
    return rows.map(mapPullRequest);
  }

  async updatePullRequest(
    id: string,
    patch: Partial<
      Pick<
        PullRequestRecord,
        "status" | "github_pr_number" | "github_pr_url" | "error_message"
      >
    >,
  ): Promise<void> {
    const current = await this.db.selectOne<Record<string, unknown>>(
      T_PULL_REQUESTS,
      { id },
    );
    if (!current) throw new Error(`Pull request ${id} not found`);
    const cur = mapPullRequest(current);
    await this.db.update(
      T_PULL_REQUESTS,
      { id },
      {
        status: patch.status ?? cur.status,
        github_pr_number:
          patch.github_pr_number !== undefined
            ? patch.github_pr_number
            : cur.github_pr_number,
        github_pr_url:
          patch.github_pr_url !== undefined
            ? patch.github_pr_url
            : cur.github_pr_url,
        error_message:
          patch.error_message !== undefined
            ? patch.error_message
            : cur.error_message,
        updated_at: now(),
      },
    );
  }

  // --- Worker jobs / job logs (Phase 7) ---

  async createWorkerJob(input: CreateWorkerJobInput): Promise<WorkerJobRecord> {
    const record: WorkerJobRecord = {
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
      created_at: now(),
      started_at: null,
      finished_at: null,
      updated_at: now(),
    };
    await this.db.insert(
      T_WORKER_JOBS,
      record as unknown as Record<string, unknown>,
    );
    return record;
  }

  async getWorkerJob(id: string): Promise<WorkerJobRecord | null> {
    const row = await this.db.selectOne<Record<string, unknown>>(
      T_WORKER_JOBS,
      { id },
    );
    return row ? mapWorkerJob(row) : null;
  }

  async listWorkerJobsForSession(
    sessionId: string,
    limit = 50,
  ): Promise<WorkerJobRecord[]> {
    const rows = await this.db.selectMany<Record<string, unknown>>(
      T_WORKER_JOBS,
      { session_id: sessionId },
      { orderBy: { column: "created_at", ascending: false }, limit },
    );
    return rows.map(mapWorkerJob);
  }

  /**
   * Phase 7.1.2: claim atomically via the Postgres RPC `claim_ai_worker_job`
   * (FOR UPDATE SKIP LOCKED) so concurrent workers never grab the same job.
   * There is NO non-atomic read-then-write fallback — a missing RPC throws a
   * clear "apply migration 008" error (no silent fallback in production).
   * `opts.now` is ignored here: Postgres uses transactional `now()`.
   */
  async claimNextWorkerJob(
    workerId: string,
    opts: ClaimOptions = {},
  ): Promise<WorkerJobRecord | null> {
    const leaseSeconds = Math.max(
      1,
      Math.round((opts.leaseMs ?? 5 * 60_000) / 1000),
    );
    let rows: unknown;
    try {
      rows = await this.db.rpc<Record<string, unknown>[]>(
        "claim_ai_worker_job",
        { p_worker_id: workerId, p_lease_seconds: leaseSeconds },
      );
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      if (isMissingRpcFunction(msg, "claim_ai_worker_job")) {
        throw new Error(
          "Atomic worker claim RPC 'claim_ai_worker_job' is missing. Apply " +
            "lib/ai-orchestrator/migrations/postgres/008_atomic_worker_claim.sql " +
            "before running workers (no silent non-atomic fallback in production).",
        );
      }
      throw err;
    }
    const row = Array.isArray(rows)
      ? ((rows[0] as Record<string, unknown> | undefined) ?? null)
      : ((rows as Record<string, unknown> | null) ?? null);
    return row ? mapWorkerJob(row) : null;
  }

  /**
   * Phase 7.1.3: renew the lease atomically via the RPC. Returns null when the
   * caller no longer owns a running job. A missing RPC throws a clear "apply
   * migration 009" error — no silent fallback.
   */
  async renewWorkerJobLease(
    jobId: string,
    workerId: string,
    leaseSeconds: number,
  ): Promise<WorkerJobRecord | null> {
    let rows: unknown;
    try {
      rows = await this.db.rpc<Record<string, unknown>[]>(
        "renew_ai_worker_job_lease",
        {
          p_job_id: jobId,
          p_worker_id: workerId,
          p_lease_seconds: Math.max(1, Math.round(leaseSeconds)),
        },
      );
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      if (isMissingRpcFunction(msg, "renew_ai_worker_job_lease")) {
        throw new Error(
          "Lease-renewal RPC 'renew_ai_worker_job_lease' is missing. Apply " +
            "lib/ai-orchestrator/migrations/postgres/009_worker_lease_renewal.sql " +
            "before running workers (no silent fallback in production).",
        );
      }
      throw err;
    }
    const row = Array.isArray(rows)
      ? ((rows[0] as Record<string, unknown> | undefined) ?? null)
      : ((rows as Record<string, unknown> | null) ?? null);
    return row ? mapWorkerJob(row) : null;
  }

  async updateWorkerJobStatus(
    id: string,
    patch: UpdateWorkerJobStatusInput,
  ): Promise<void> {
    const current = await this.getWorkerJob(id);
    if (!current) throw new Error(`Worker job ${id} not found`);
    await this.db.update(
      T_WORKER_JOBS,
      { id },
      {
        status: patch.status ?? current.status,
        result: patch.result !== undefined ? patch.result : current.result,
        error_message:
          patch.errorMessage !== undefined
            ? patch.errorMessage
            : current.error_message,
        lease_owner:
          patch.leaseOwner !== undefined ? patch.leaseOwner : current.lease_owner,
        lease_expires_at:
          patch.leaseExpiresAt !== undefined
            ? patch.leaseExpiresAt
            : current.lease_expires_at,
        attempts: patch.attempts !== undefined ? patch.attempts : current.attempts,
        started_at:
          patch.startedAt !== undefined ? patch.startedAt : current.started_at,
        finished_at:
          patch.finishedAt !== undefined ? patch.finishedAt : current.finished_at,
        updated_at: now(),
      },
    );
  }

  async appendWorkerJobLog(
    jobId: string,
    stream: WorkerJobStream,
    content: string,
  ): Promise<void> {
    await this.db.insert(T_WORKER_JOB_LOGS, {
      id: randomUUID(),
      job_id: jobId,
      stream,
      content: redactSecrets(content),
      created_at: now(),
    });
  }

  async getWorkerJobLogs(
    jobId: string,
    limit = 500,
  ): Promise<WorkerJobLogRecord[]> {
    const rows = await this.db.selectMany<Record<string, unknown>>(
      T_WORKER_JOB_LOGS,
      { job_id: jobId },
      { orderBy: { column: "created_at", ascending: true }, limit },
    );
    return rows.map((r) => ({
      id: r.id as string,
      job_id: r.job_id as string,
      stream: r.stream as WorkerJobStream,
      content: (r.content as string) ?? "",
      created_at: String(r.created_at),
    }));
  }

  async cancelWorkerJob(id: string): Promise<boolean> {
    const job = await this.getWorkerJob(id);
    if (!job) return false;
    if (job.status !== "queued" && job.status !== "running") return false;
    const ts = now();
    await this.db.update(
      T_WORKER_JOBS,
      { id },
      { status: "cancelled", finished_at: ts, updated_at: ts },
    );
    return true;
  }

  // --- Async orchestration runs / events (Phase 7.3) ---

  async createOrchestrationRun(args: {
    sessionId: string;
    userId: string | null;
    status?: OrchestrationRunStatus;
    currentRound?: number;
    maxRounds?: number;
    currentStep?: string | null;
    state?: Record<string, unknown>;
  }): Promise<OrchestrationRunRecord> {
    const record: OrchestrationRunRecord = {
      id: randomUUID(),
      session_id: args.sessionId,
      user_id: args.userId ?? null,
      status: args.status ?? "queued",
      current_round: args.currentRound ?? 1,
      max_rounds: args.maxRounds ?? 3,
      current_step: args.currentStep ?? null,
      pending_worker_job_id: null,
      last_error: null,
      state: args.state ?? {},
      created_at: now(),
      updated_at: now(),
      finished_at: null,
      resume_lock_owner: null,
      resume_lock_expires_at: null,
      resume_attempts: 0,
      last_resume_attempt_at: null,
    };
    // Insert only the base columns so this keeps working before the Phase 7.4
    // resume-lock migration (postgres/011) is applied — the lock columns default
    // in the DB. Only the cron resume path needs migration 011.
    await this.db.insert(T_ORCH_RUNS, {
      id: record.id,
      session_id: record.session_id,
      user_id: record.user_id,
      status: record.status,
      current_round: record.current_round,
      max_rounds: record.max_rounds,
      current_step: record.current_step,
      pending_worker_job_id: record.pending_worker_job_id,
      last_error: record.last_error,
      state: record.state,
      created_at: record.created_at,
      updated_at: record.updated_at,
      finished_at: record.finished_at,
    });
    return record;
  }

  async getOrchestrationRun(id: string): Promise<OrchestrationRunRecord | null> {
    const row = await this.db.selectOne<Record<string, unknown>>(T_ORCH_RUNS, {
      id,
    });
    return row ? mapOrchestrationRun(row) : null;
  }

  async getOrchestrationRunBySession(
    sessionId: string,
  ): Promise<OrchestrationRunRecord | null> {
    const rows = await this.db.selectMany<Record<string, unknown>>(
      T_ORCH_RUNS,
      { session_id: sessionId },
      { orderBy: { column: "created_at", ascending: false }, limit: 1 },
    );
    return rows.length ? mapOrchestrationRun(rows[0]) : null;
  }

  async listOrchestrationRuns(limit = 50): Promise<OrchestrationRunRecord[]> {
    const rows = await this.db.selectMany<Record<string, unknown>>(
      T_ORCH_RUNS,
      {},
      { orderBy: { column: "created_at", ascending: false }, limit },
    );
    return rows.map(mapOrchestrationRun);
  }

  async updateOrchestrationRun(
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
  ): Promise<void> {
    const current = await this.getOrchestrationRun(id);
    if (!current) throw new Error(`Orchestration run ${id} not found`);
    await this.db.update(
      T_ORCH_RUNS,
      { id },
      {
        status: patch.status ?? current.status,
        current_round:
          patch.current_round !== undefined
            ? patch.current_round
            : current.current_round,
        current_step:
          patch.current_step !== undefined
            ? patch.current_step
            : current.current_step,
        pending_worker_job_id:
          patch.pending_worker_job_id !== undefined
            ? patch.pending_worker_job_id
            : current.pending_worker_job_id,
        last_error:
          patch.last_error !== undefined
            ? patch.last_error
              ? redactSecrets(patch.last_error)
              : null
            : current.last_error,
        state: patch.state !== undefined ? patch.state : current.state,
        finished_at:
          patch.finished_at !== undefined
            ? patch.finished_at
            : current.finished_at,
        updated_at: now(),
      },
    );
  }

  async appendOrchestrationEvent(args: {
    orchestrationRunId: string;
    sessionId: string;
    eventType: string;
    metadata?: Record<string, unknown>;
  }): Promise<OrchestrationEventRecord> {
    const metadata = sanitizePgEventMetadata(args.metadata);
    const record: OrchestrationEventRecord = {
      id: randomUUID(),
      orchestration_run_id: args.orchestrationRunId,
      session_id: args.sessionId,
      event_type: args.eventType,
      metadata,
      created_at: now(),
    };
    await this.db.insert(
      T_ORCH_EVENTS,
      record as unknown as Record<string, unknown>,
    );
    return record;
  }

  async getOrchestrationEvents(
    orchestrationRunId: string,
    limit = 100,
  ): Promise<OrchestrationEventRecord[]> {
    const rows = await this.db.selectMany<Record<string, unknown>>(
      T_ORCH_EVENTS,
      { orchestration_run_id: orchestrationRunId },
      { orderBy: { column: "created_at", ascending: true }, limit },
    );
    return rows.map(mapOrchestrationEvent);
  }

  async findOrchestrationRunByWorkerJobId(
    jobId: string,
  ): Promise<OrchestrationRunRecord | null> {
    const rows = await this.db.selectMany<Record<string, unknown>>(
      T_ORCH_RUNS,
      { pending_worker_job_id: jobId },
      { orderBy: { column: "created_at", ascending: false }, limit: 1 },
    );
    return rows.length ? mapOrchestrationRun(rows[0]) : null;
  }

  async cancelOrchestrationRun(id: string): Promise<boolean> {
    const run = await this.getOrchestrationRun(id);
    if (!run) return false;
    if (PG_TERMINAL_ORCH.has(run.status)) return false;
    const ts = now();
    await this.db.update(
      T_ORCH_RUNS,
      { id },
      {
        status: "cancelled",
        pending_worker_job_id: null,
        finished_at: ts,
        updated_at: ts,
      },
    );
    return true;
  }

  // --- Scheduled / cron resume (Phase 7.4) ---

  async listWaitingOrchestrationRuns(
    limit = 50,
  ): Promise<OrchestrationRunRecord[]> {
    const rows = await this.db.selectMany<Record<string, unknown>>(
      T_ORCH_RUNS,
      { status: "waiting_for_worker" },
      { orderBy: { column: "created_at", ascending: true }, limit },
    );
    return rows.map(mapOrchestrationRun);
  }

  async claimOrchestrationResumeLock(
    runId: string,
    owner: string,
    ttlSeconds: number,
  ): Promise<OrchestrationRunRecord | null> {
    const current = await this.getOrchestrationRun(runId);
    if (!current || current.status !== "waiting_for_worker") return null;
    const nowIso = now();
    const nowMs = Date.parse(nowIso);
    const expired =
      !current.resume_lock_expires_at ||
      Date.parse(current.resume_lock_expires_at) < nowMs;
    // A fresh lock held by someone else blocks the claim.
    if (current.resume_lock_owner && !expired) return null;
    const ttl = Math.max(1, Math.floor(ttlSeconds));
    const expires = new Date(nowMs + ttl * 1000).toISOString();
    // Optimistic claim: write our owner (matching on status so a just-terminal
    // run isn't locked), then re-read. If a concurrent claim won the race, the
    // re-read shows a different owner and we back off — exactly one cron wins.
    await this.db.update(
      T_ORCH_RUNS,
      { id: runId, status: "waiting_for_worker" },
      {
        resume_lock_owner: owner,
        resume_lock_expires_at: expires,
        last_resume_attempt_at: nowIso,
        updated_at: nowIso,
      },
    );
    const after = await this.getOrchestrationRun(runId);
    return after && after.resume_lock_owner === owner ? after : null;
  }

  async releaseOrchestrationResumeLock(
    runId: string,
    owner: string,
  ): Promise<void> {
    await this.db.update(
      T_ORCH_RUNS,
      { id: runId, resume_lock_owner: owner },
      { resume_lock_owner: null, resume_lock_expires_at: null, updated_at: now() },
    );
  }

  async incrementOrchestrationResumeAttempt(runId: string): Promise<void> {
    const current = await this.getOrchestrationRun(runId);
    if (!current) return;
    await this.db.update(
      T_ORCH_RUNS,
      { id: runId },
      { resume_attempts: current.resume_attempts + 1, updated_at: now() },
    );
  }

  async ping(): Promise<void> {
    // A trivial bounded read verifies connectivity + that the table exists.
    await this.db.selectMany(T_SESSIONS, {}, { limit: 1 });
  }

  async probeTableColumn(table: string, column: string): Promise<boolean> {
    try {
      await this.db.probe(table, column);
      return true;
    } catch {
      return false;
    }
  }
}

const PG_TERMINAL_ORCH = new Set<OrchestrationRunStatus>([
  "passed",
  "failed",
  "needs_revision",
  "cancelled",
]);

function sanitizePgEventMetadata(
  meta?: Record<string, unknown>,
): Record<string, unknown> {
  if (!meta) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    out[k] = typeof v === "string" ? redactSecrets(v) : v;
  }
  return out;
}

function mapOrchestrationRun(
  r: Record<string, unknown>,
): OrchestrationRunRecord {
  return {
    id: r.id as string,
    session_id: r.session_id as string,
    user_id: (r.user_id as string | null) ?? null,
    status: r.status as OrchestrationRunStatus,
    current_round: Number(r.current_round),
    max_rounds: Number(r.max_rounds),
    current_step: (r.current_step as string | null) ?? null,
    pending_worker_job_id: (r.pending_worker_job_id as string | null) ?? null,
    last_error: (r.last_error as string | null) ?? null,
    state: parseJsonField(r.state) ?? {},
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
    finished_at: r.finished_at ? String(r.finished_at) : null,
    resume_lock_owner: r.resume_lock_owner ? String(r.resume_lock_owner) : null,
    resume_lock_expires_at: r.resume_lock_expires_at
      ? String(r.resume_lock_expires_at)
      : null,
    resume_attempts: r.resume_attempts != null ? Number(r.resume_attempts) : 0,
    last_resume_attempt_at: r.last_resume_attempt_at
      ? String(r.last_resume_attempt_at)
      : null,
  };
}

function mapOrchestrationEvent(
  r: Record<string, unknown>,
): OrchestrationEventRecord {
  return {
    id: r.id as string,
    orchestration_run_id: r.orchestration_run_id as string,
    session_id: r.session_id as string,
    event_type: r.event_type as string,
    metadata: parseJsonField(r.metadata) ?? {},
    created_at: String(r.created_at),
  };
}

/** True when an RPC error means the named function isn't installed yet. */
function isMissingRpcFunction(msg: string, fnName: string): boolean {
  if (/PGRST202/i.test(msg)) return true;
  return (
    new RegExp(fnName, "i").test(msg) &&
    /(does not exist|could not find|not find the function|schema cache|undefined function|unknown function)/i.test(
      msg,
    )
  );
}

function parseJsonField(v: unknown): Record<string, unknown> | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") {
    try {
      return JSON.parse(v) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return v as Record<string, unknown>;
}

function mapWorkerJob(r: Record<string, unknown>): WorkerJobRecord {
  return {
    id: r.id as string,
    session_id: (r.session_id as string | null) ?? null,
    patch_set_id: (r.patch_set_id as string | null) ?? null,
    pull_request_id: (r.pull_request_id as string | null) ?? null,
    user_id: (r.user_id as string | null) ?? null,
    job_type: r.job_type as WorkerJobType,
    status: r.status as WorkerJobStatus,
    priority: Number(r.priority),
    payload: parseJsonField(r.payload) ?? {},
    result: parseJsonField(r.result),
    error_message: (r.error_message as string | null) ?? null,
    lease_owner: (r.lease_owner as string | null) ?? null,
    lease_expires_at: r.lease_expires_at ? String(r.lease_expires_at) : null,
    attempts: Number(r.attempts),
    max_attempts: Number(r.max_attempts),
    created_at: String(r.created_at),
    started_at: r.started_at ? String(r.started_at) : null,
    finished_at: r.finished_at ? String(r.finished_at) : null,
    updated_at: String(r.updated_at),
  };
}

function parseErrorsField(v: unknown): string[] | null {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v as string[];
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? (parsed as string[]) : null;
    } catch {
      return null;
    }
  }
  return null;
}

function mapPatchSet(r: Record<string, unknown>): PatchSetRecord {
  return {
    id: r.id as string,
    session_id: r.session_id as string,
    user_id: (r.user_id as string | null) ?? null,
    status: r.status as PatchSetStatus,
    base_branch: r.base_branch as string,
    target_branch: r.target_branch as string,
    base_sha: (r.base_sha as string | null) ?? null,
    patch_summary: (r.patch_summary as string | null) ?? null,
    patch_text: (r.patch_text as string | null) ?? null,
    validation_errors: parseErrorsField(r.validation_errors),
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
  };
}

function mapPatchFile(r: Record<string, unknown>): PatchFileRecord {
  return {
    id: r.id as string,
    patch_set_id: r.patch_set_id as string,
    file_path: r.file_path as string,
    change_type: r.change_type as PatchFileChangeType,
    old_content_hash: (r.old_content_hash as string | null) ?? null,
    new_content_hash: (r.new_content_hash as string | null) ?? null,
    patch_hunk: (r.patch_hunk as string | null) ?? null,
    reason: (r.reason as string | null) ?? null,
    new_content_redacted: (r.new_content_redacted as string | null) ?? null,
    created_at: String(r.created_at),
  };
}

function mapPullRequest(r: Record<string, unknown>): PullRequestRecord {
  return {
    id: r.id as string,
    session_id: r.session_id as string,
    patch_set_id: r.patch_set_id as string,
    user_id: (r.user_id as string | null) ?? null,
    github_pr_number:
      r.github_pr_number === null || r.github_pr_number === undefined
        ? null
        : Number(r.github_pr_number),
    github_pr_url: (r.github_pr_url as string | null) ?? null,
    branch_name: r.branch_name as string,
    base_branch: r.base_branch as string,
    status: r.status as PullRequestStatus,
    error_message: (r.error_message as string | null) ?? null,
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
  };
}

function mapUser(r: Record<string, unknown>): UserRecord {
  return {
    id: r.id as string,
    email: (r.email as string | null) ?? null,
    display_name: (r.display_name as string | null) ?? null,
    role: r.role as UserRole,
    status: r.status as "active" | "disabled",
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
    last_seen_at: r.last_seen_at ? String(r.last_seen_at) : null,
  };
}

function mapApiKey(r: Record<string, unknown>): ApiKeyRecord {
  return {
    id: r.id as string,
    user_id: r.user_id as string,
    key_prefix: r.key_prefix as string,
    key_hash: r.key_hash as string,
    name: (r.name as string | null) ?? null,
    status: r.status as "active" | "revoked",
    last_used_at: r.last_used_at ? String(r.last_used_at) : null,
    expires_at: r.expires_at ? String(r.expires_at) : null,
    created_at: String(r.created_at),
    revoked_at: r.revoked_at ? String(r.revoked_at) : null,
  };
}

function mapCollaborator(
  r: Record<string, unknown>,
): SessionCollaboratorRecord {
  return {
    id: r.id as string,
    session_id: r.session_id as string,
    user_id: r.user_id as string,
    permission: r.permission as SessionCollaboratorRecord["permission"],
    created_at: String(r.created_at),
  };
}

function mapSession(r: Record<string, unknown>): SessionRecord {
  return {
    id: r.id as string,
    user_request: r.user_request as string,
    status: r.status as SessionRecord["status"],
    approval: r.approval as SessionRecord["approval"],
    rounds: Number(r.rounds),
    user_id: (r.user_id as string | null) ?? null,
    admin_key_fingerprint: (r.admin_key_fingerprint as string | null) ?? null,
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
  };
}

function mapMessage(r: Record<string, unknown>): MessageRecord {
  // `output` may arrive as a JSONB object or a JSON string depending on driver.
  const rawOutput = r.output;
  const output =
    typeof rawOutput === "string"
      ? (JSON.parse(rawOutput) as AgentOutput)
      : (rawOutput as AgentOutput);
  return {
    id: r.id as string,
    session_id: r.session_id as string,
    step: r.step as StepName,
    provider: r.provider as Provider,
    round: Number(r.round),
    output,
    created_at: String(r.created_at),
  };
}

function mapRun(r: Record<string, unknown>): RunRecord {
  return {
    id: r.id as string,
    session_id: r.session_id as string,
    command: r.command as string,
    allowed: Boolean(r.allowed),
    exit_code: r.exit_code === null ? null : Number(r.exit_code),
    stdout: (r.stdout as string) ?? "",
    stderr: (r.stderr as string) ?? "",
    step_name: (r.step_name as StepName | null) ?? null,
    status: (r.status as RunStatus) ?? "skipped",
    admin_key_fingerprint: (r.admin_key_fingerprint as string | null) ?? null,
    user_id: (r.user_id as string | null) ?? null,
    created_at: String(r.created_at),
  };
}
