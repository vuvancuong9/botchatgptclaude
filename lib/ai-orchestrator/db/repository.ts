import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
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

function now(): string {
  return new Date().toISOString();
}

/** SQLite-backed implementation of the storage abstraction (local/MVP). */
export class OrchestratorRepository implements AiOrchestratorRepository {
  constructor(private readonly db: DatabaseSync) {}

  async createSession(
    userRequest: string,
    attribution: SessionAttribution = {},
  ): Promise<SessionRecord> {
    const id = randomUUID();
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO ai_sessions
           (id, user_request, status, approval, rounds, user_id, admin_key_fingerprint, created_at, updated_at)
         VALUES (?, ?, 'running', 'pending', 0, ?, ?, ?, ?)`,
      )
      .run(
        id,
        userRequest,
        attribution.userId ?? null,
        attribution.adminKeyFingerprint ?? null,
        ts,
        ts,
      );
    return (await this.getSession(id))!;
  }

  async updateSession(
    id: string,
    patch: Partial<Pick<SessionRecord, "status" | "approval" | "rounds">>,
  ): Promise<void> {
    const current = await this.getSession(id);
    if (!current) throw new Error(`Session ${id} not found`);
    const next = { ...current, ...patch };
    this.db
      .prepare(
        `UPDATE ai_sessions SET status = ?, approval = ?, rounds = ?, updated_at = ? WHERE id = ?`,
      )
      .run(next.status, next.approval, next.rounds, now(), id);
  }

  async getSession(id: string): Promise<SessionRecord | null> {
    const row = this.db
      .prepare(`SELECT * FROM ai_sessions WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? rowToSession(row) : null;
  }

  async listSessions(limit = 50): Promise<SessionRecord[]> {
    const rows = this.db
      .prepare(`SELECT * FROM ai_sessions ORDER BY created_at DESC LIMIT ?`)
      .all(limit) as Record<string, unknown>[];
    return rows.map(rowToSession);
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
    this.db
      .prepare(
        `INSERT INTO ai_messages (id, session_id, step, provider, round, status, output, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        args.sessionId,
        args.step,
        args.provider,
        args.round,
        args.output.status,
        JSON.stringify(args.output),
        ts,
      );

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
    this.db
      .prepare(
        `INSERT INTO ai_artifacts (id, session_id, message_id, type, content, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, args.sessionId, args.messageId, args.type, args.content, ts);
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
    // Defense in depth: redact secrets before persisting (the test-runner also
    // redacts at capture time).
    const stdout = redactSecrets(args.stdout);
    const stderr = redactSecrets(args.stderr);
    const status: RunStatus = deriveRunStatus(args.allowed, args.exitCode);
    const step = args.step ?? null;
    const fingerprint = args.adminKeyFingerprint ?? null;
    const userId = args.userId ?? null;
    this.db
      .prepare(
        `INSERT INTO ai_runs
           (id, session_id, command, allowed, exit_code, stdout, stderr, step_name, status, admin_key_fingerprint, user_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        args.sessionId,
        args.command,
        args.allowed ? 1 : 0,
        args.exitCode,
        stdout,
        stderr,
        step,
        status,
        fingerprint,
        userId,
        ts,
      );
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
    const rows = this.db
      .prepare(
        `SELECT * FROM ai_messages WHERE session_id = ? ORDER BY created_at ASC`,
      )
      .all(sessionId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as string,
      session_id: r.session_id as string,
      step: r.step as StepName,
      provider: r.provider as Provider,
      round: Number(r.round),
      output: JSON.parse(r.output as string) as AgentOutput,
      created_at: r.created_at as string,
    }));
  }

  async getArtifacts(sessionId: string): Promise<ArtifactRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM ai_artifacts WHERE session_id = ? ORDER BY created_at ASC`,
      )
      .all(sessionId) as Record<string, unknown>[];
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
    const rows = this.db
      .prepare(
        `SELECT * FROM ai_runs WHERE session_id = ? ORDER BY created_at ASC`,
      )
      .all(sessionId) as Record<string, unknown>[];
    return rows.map(rowToRun);
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
    this.db
      .prepare(
        `INSERT INTO ai_audit_logs
           (id, event_type, session_id, admin_key_fingerprint, user_id, ip_hash, user_agent_hash, status, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.eventType,
        input.sessionId ?? null,
        input.adminKeyFingerprint ?? null,
        input.userId ?? null,
        input.ipHash ?? null,
        input.userAgentHash ?? null,
        input.status,
        JSON.stringify(metadata),
        ts,
      );
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
    const rows = this.db
      .prepare(
        `SELECT * FROM ai_audit_logs ORDER BY created_at DESC LIMIT ?`,
      )
      .all(limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as string,
      event_type: r.event_type as string,
      session_id: (r.session_id as string | null) ?? null,
      admin_key_fingerprint: (r.admin_key_fingerprint as string | null) ?? null,
      user_id: (r.user_id as string | null) ?? null,
      ip_hash: (r.ip_hash as string | null) ?? null,
      user_agent_hash: (r.user_agent_hash as string | null) ?? null,
      status: r.status as string,
      metadata: JSON.parse((r.metadata as string) ?? "{}"),
      created_at: r.created_at as string,
    }));
  }

  // --- Users / API keys / RBAC ---

  async createUser(args: {
    email?: string | null;
    displayName?: string | null;
    role: UserRole;
  }): Promise<UserRecord> {
    const id = randomUUID();
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO ai_users (id, email, display_name, role, status, created_at, updated_at, last_seen_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?, NULL)`,
      )
      .run(id, args.email ?? null, args.displayName ?? null, args.role, ts, ts);
    return (await this.getUserById(id))!;
  }

  async getUserById(id: string): Promise<UserRecord | null> {
    const row = this.db
      .prepare(`SELECT * FROM ai_users WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? mapUser(row) : null;
  }

  async getUserByEmail(email: string): Promise<UserRecord | null> {
    const row = this.db
      .prepare(`SELECT * FROM ai_users WHERE email = ?`)
      .get(email) as Record<string, unknown> | undefined;
    return row ? mapUser(row) : null;
  }

  async listUsers(limit = 100): Promise<UserRecord[]> {
    const rows = this.db
      .prepare(`SELECT * FROM ai_users ORDER BY created_at ASC LIMIT ?`)
      .all(limit) as Record<string, unknown>[];
    return rows.map(mapUser);
  }

  async updateUserStatus(
    id: string,
    status: "active" | "disabled",
  ): Promise<void> {
    this.db
      .prepare(`UPDATE ai_users SET status = ?, updated_at = ? WHERE id = ?`)
      .run(status, now(), id);
  }

  async updateUserLastSeen(id: string): Promise<void> {
    this.db
      .prepare(`UPDATE ai_users SET last_seen_at = ? WHERE id = ?`)
      .run(now(), id);
  }

  async createApiKey(args: {
    userId: string;
    keyPrefix: string;
    keyHash: string;
    name?: string | null;
    expiresAt?: string | null;
  }): Promise<ApiKeyRecord> {
    const id = randomUUID();
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO ai_api_keys (id, user_id, key_prefix, key_hash, name, status, last_used_at, expires_at, created_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, 'active', NULL, ?, ?, NULL)`,
      )
      .run(
        id,
        args.userId,
        args.keyPrefix,
        args.keyHash,
        args.name ?? null,
        args.expiresAt ?? null,
        ts,
      );
    return (await this.getApiKeyById(id))!;
  }

  async getApiKeyByPrefix(prefix: string): Promise<ApiKeyRecord | null> {
    // Return regardless of status so the caller can distinguish revoked (403)
    // from invalid (401).
    const row = this.db
      .prepare(`SELECT * FROM ai_api_keys WHERE key_prefix = ?`)
      .get(prefix) as Record<string, unknown> | undefined;
    return row ? mapApiKey(row) : null;
  }

  async getApiKeyById(id: string): Promise<ApiKeyRecord | null> {
    const row = this.db
      .prepare(`SELECT * FROM ai_api_keys WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? mapApiKey(row) : null;
  }

  async listApiKeysForUser(userId: string): Promise<ApiKeyRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM ai_api_keys WHERE user_id = ? ORDER BY created_at DESC`,
      )
      .all(userId) as Record<string, unknown>[];
    return rows.map(mapApiKey);
  }

  async updateApiKeyLastUsed(id: string): Promise<void> {
    this.db
      .prepare(`UPDATE ai_api_keys SET last_used_at = ? WHERE id = ?`)
      .run(now(), id);
  }

  async revokeApiKey(id: string): Promise<void> {
    const ts = now();
    this.db
      .prepare(
        `UPDATE ai_api_keys SET status = 'revoked', revoked_at = ? WHERE id = ?`,
      )
      .run(ts, id);
  }

  async addSessionCollaborator(args: {
    sessionId: string;
    userId: string;
    permission: SessionCollaboratorRecord["permission"];
  }): Promise<SessionCollaboratorRecord> {
    const id = randomUUID();
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO ai_session_collaborators (id, session_id, user_id, permission, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, args.sessionId, args.userId, args.permission, ts);
    return {
      id,
      session_id: args.sessionId,
      user_id: args.userId,
      permission: args.permission,
      created_at: ts,
    };
  }

  async listSessionCollaborators(
    sessionId: string,
  ): Promise<SessionCollaboratorRecord[]> {
    const rows = this.db
      .prepare(`SELECT * FROM ai_session_collaborators WHERE session_id = ?`)
      .all(sessionId) as Record<string, unknown>[];
    return rows.map(mapCollaborator);
  }

  async getCollaboratorSessionIds(userId: string): Promise<string[]> {
    const rows = this.db
      .prepare(
        `SELECT session_id FROM ai_session_collaborators WHERE user_id = ?`,
      )
      .all(userId) as Record<string, unknown>[];
    return rows.map((r) => r.session_id as string);
  }

  async addUserPermissionOverride(args: {
    userId: string;
    permission: string;
    effect: "allow" | "deny";
  }): Promise<PermissionOverrideRecord> {
    const id = randomUUID();
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO ai_user_permissions_override (id, user_id, permission, effect, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, args.userId, args.permission, args.effect, ts);
    return {
      id,
      user_id: args.userId,
      permission: args.permission,
      effect: args.effect,
      created_at: ts,
    };
  }

  async getUserPermissionOverrides(
    userId: string,
  ): Promise<PermissionOverrideRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM ai_user_permissions_override WHERE user_id = ?`,
      )
      .all(userId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as string,
      user_id: r.user_id as string,
      permission: r.permission as string,
      effect: r.effect as "allow" | "deny",
      created_at: r.created_at as string,
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
    const id = randomUUID();
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO ai_patch_sets
           (id, session_id, user_id, status, base_branch, target_branch, base_sha,
            patch_summary, patch_text, validation_errors, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        args.sessionId,
        args.userId ?? null,
        args.status,
        args.baseBranch,
        args.targetBranch,
        args.baseSha ?? null,
        args.patchSummary ?? null,
        args.patchText ?? null,
        args.validationErrors ? JSON.stringify(args.validationErrors) : null,
        ts,
        ts,
      );
    return (await this.getPatchSet(id))!;
  }

  async getPatchSet(id: string): Promise<PatchSetRecord | null> {
    const row = this.db
      .prepare(`SELECT * FROM ai_patch_sets WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? rowToPatchSet(row) : null;
  }

  async getPatchSetsForSession(
    sessionId: string,
    limit = 50,
  ): Promise<PatchSetRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM ai_patch_sets WHERE session_id = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(sessionId, limit) as Record<string, unknown>[];
    return rows.map(rowToPatchSet);
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
    const next = { ...current, ...patch };
    this.db
      .prepare(
        `UPDATE ai_patch_sets
           SET status = ?, base_sha = ?, validation_errors = ?, patch_summary = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        next.status,
        next.base_sha ?? null,
        next.validation_errors ? JSON.stringify(next.validation_errors) : null,
        next.patch_summary ?? null,
        now(),
        id,
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
    const id = randomUUID();
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO ai_patch_files
           (id, patch_set_id, file_path, change_type, old_content_hash, new_content_hash, patch_hunk, reason, new_content_redacted, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        args.patchSetId,
        args.filePath,
        args.changeType,
        args.oldContentHash ?? null,
        args.newContentHash ?? null,
        args.patchHunk ?? null,
        args.reason ?? null,
        args.newContentRedacted ?? null,
        ts,
      );
    return {
      id,
      patch_set_id: args.patchSetId,
      file_path: args.filePath,
      change_type: args.changeType,
      old_content_hash: args.oldContentHash ?? null,
      new_content_hash: args.newContentHash ?? null,
      patch_hunk: args.patchHunk ?? null,
      reason: args.reason ?? null,
      new_content_redacted: args.newContentRedacted ?? null,
      created_at: ts,
    };
  }

  async getPatchFiles(patchSetId: string): Promise<PatchFileRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM ai_patch_files WHERE patch_set_id = ? ORDER BY created_at ASC`,
      )
      .all(patchSetId) as Record<string, unknown>[];
    return rows.map(rowToPatchFile);
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
    const id = randomUUID();
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO ai_pull_requests
           (id, session_id, patch_set_id, user_id, github_pr_number, github_pr_url,
            branch_name, base_branch, status, error_message, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        args.sessionId,
        args.patchSetId,
        args.userId ?? null,
        args.githubPrNumber ?? null,
        args.githubPrUrl ?? null,
        args.branchName,
        args.baseBranch,
        args.status,
        args.errorMessage ?? null,
        ts,
        ts,
      );
    return {
      id,
      session_id: args.sessionId,
      patch_set_id: args.patchSetId,
      user_id: args.userId ?? null,
      github_pr_number: args.githubPrNumber ?? null,
      github_pr_url: args.githubPrUrl ?? null,
      branch_name: args.branchName,
      base_branch: args.baseBranch,
      status: args.status,
      error_message: args.errorMessage ?? null,
      created_at: ts,
      updated_at: ts,
    };
  }

  async getPullRequestsForSession(
    sessionId: string,
    limit = 50,
  ): Promise<PullRequestRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM ai_pull_requests WHERE session_id = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(sessionId, limit) as Record<string, unknown>[];
    return rows.map(rowToPullRequest);
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
    const row = this.db
      .prepare(`SELECT * FROM ai_pull_requests WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    if (!row) throw new Error(`Pull request ${id} not found`);
    const current = rowToPullRequest(row);
    const next = { ...current, ...patch };
    this.db
      .prepare(
        `UPDATE ai_pull_requests
           SET status = ?, github_pr_number = ?, github_pr_url = ?, error_message = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        next.status,
        next.github_pr_number ?? null,
        next.github_pr_url ?? null,
        next.error_message ?? null,
        now(),
        id,
      );
  }

  // --- Worker jobs / job logs (Phase 7) ---

  async createWorkerJob(input: CreateWorkerJobInput): Promise<WorkerJobRecord> {
    const id = randomUUID();
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO ai_worker_jobs
           (id, session_id, patch_set_id, pull_request_id, user_id, job_type, status,
            priority, payload, result, error_message, lease_owner, lease_expires_at,
            attempts, max_attempts, created_at, started_at, finished_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, NULL, NULL, NULL, NULL, 0, ?, ?, NULL, NULL, ?)`,
      )
      .run(
        id,
        input.sessionId ?? null,
        input.patchSetId ?? null,
        input.pullRequestId ?? null,
        input.userId ?? null,
        input.jobType,
        input.priority ?? 5,
        JSON.stringify(input.payload ?? {}),
        input.maxAttempts ?? 2,
        ts,
        ts,
      );
    return (await this.getWorkerJob(id))!;
  }

  async getWorkerJob(id: string): Promise<WorkerJobRecord | null> {
    const row = this.db
      .prepare(`SELECT * FROM ai_worker_jobs WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? rowToWorkerJob(row) : null;
  }

  async listWorkerJobsForSession(
    sessionId: string,
    limit = 50,
  ): Promise<WorkerJobRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM ai_worker_jobs WHERE session_id = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(sessionId, limit) as Record<string, unknown>[];
    return rows.map(rowToWorkerJob);
  }

  async claimNextWorkerJob(
    workerId: string,
    opts: ClaimOptions = {},
  ): Promise<WorkerJobRecord | null> {
    const nowTs = opts.now ?? now();
    const leaseMs = opts.leaseMs ?? 5 * 60_000;
    // Candidates: queued, or running with an expired/empty lease.
    const rows = this.db
      .prepare(
        `SELECT * FROM ai_worker_jobs
          WHERE status = 'queued'
             OR (status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at < ?))
          ORDER BY priority ASC, created_at ASC`,
      )
      .all(nowTs) as Record<string, unknown>[];

    for (const row of rows) {
      const job = rowToWorkerJob(row);
      if (job.attempts >= job.max_attempts) {
        // Exhausted — mark failed and skip (never claim a dead job).
        this.db
          .prepare(
            `UPDATE ai_worker_jobs
               SET status = 'failed', error_message = 'max attempts exceeded',
                   finished_at = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(nowTs, nowTs, job.id);
        continue;
      }
      const leaseExpires = new Date(Date.parse(nowTs) + leaseMs).toISOString();
      this.db
        .prepare(
          `UPDATE ai_worker_jobs
             SET status = 'running', lease_owner = ?, lease_expires_at = ?,
                 attempts = attempts + 1,
                 started_at = COALESCE(started_at, ?), updated_at = ?
           WHERE id = ?`,
        )
        .run(workerId, leaseExpires, nowTs, nowTs, job.id);
      return (await this.getWorkerJob(job.id))!;
    }
    return null;
  }

  async renewWorkerJobLease(
    jobId: string,
    workerId: string,
    leaseSeconds: number,
  ): Promise<WorkerJobRecord | null> {
    const job = await this.getWorkerJob(jobId);
    if (!job || job.status !== "running" || job.lease_owner !== workerId) {
      return null;
    }
    const ts = now();
    const leaseExpires = new Date(
      Date.parse(ts) + leaseSeconds * 1000,
    ).toISOString();
    this.db
      .prepare(
        `UPDATE ai_worker_jobs
           SET lease_expires_at = ?, updated_at = ?
         WHERE id = ? AND status = 'running' AND lease_owner = ?`,
      )
      .run(leaseExpires, ts, jobId, workerId);
    return await this.getWorkerJob(jobId);
  }

  async updateWorkerJobStatus(
    id: string,
    patch: UpdateWorkerJobStatusInput,
  ): Promise<void> {
    const current = await this.getWorkerJob(id);
    if (!current) throw new Error(`Worker job ${id} not found`);
    const status = patch.status ?? current.status;
    const result =
      patch.result !== undefined ? patch.result : current.result;
    const errorMessage =
      patch.errorMessage !== undefined
        ? patch.errorMessage
        : current.error_message;
    const leaseOwner =
      patch.leaseOwner !== undefined ? patch.leaseOwner : current.lease_owner;
    const leaseExpiresAt =
      patch.leaseExpiresAt !== undefined
        ? patch.leaseExpiresAt
        : current.lease_expires_at;
    const attempts =
      patch.attempts !== undefined ? patch.attempts : current.attempts;
    const startedAt =
      patch.startedAt !== undefined ? patch.startedAt : current.started_at;
    const finishedAt =
      patch.finishedAt !== undefined ? patch.finishedAt : current.finished_at;
    this.db
      .prepare(
        `UPDATE ai_worker_jobs
           SET status = ?, result = ?, error_message = ?, lease_owner = ?,
               lease_expires_at = ?, attempts = ?, started_at = ?, finished_at = ?,
               updated_at = ?
         WHERE id = ?`,
      )
      .run(
        status,
        result === null || result === undefined ? null : JSON.stringify(result),
        errorMessage ?? null,
        leaseOwner ?? null,
        leaseExpiresAt ?? null,
        attempts,
        startedAt ?? null,
        finishedAt ?? null,
        now(),
        id,
      );
  }

  async appendWorkerJobLog(
    jobId: string,
    stream: WorkerJobStream,
    content: string,
  ): Promise<void> {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO ai_worker_job_logs (id, job_id, stream, content, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, jobId, stream, redactSecrets(content), now());
  }

  async getWorkerJobLogs(
    jobId: string,
    limit = 500,
  ): Promise<WorkerJobLogRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM ai_worker_job_logs WHERE job_id = ? ORDER BY created_at ASC LIMIT ?`,
      )
      .all(jobId, limit) as Record<string, unknown>[];
    return rows.map(rowToWorkerJobLog);
  }

  async cancelWorkerJob(id: string): Promise<boolean> {
    const job = await this.getWorkerJob(id);
    if (!job) return false;
    if (job.status !== "queued" && job.status !== "running") return false;
    const ts = now();
    this.db
      .prepare(
        `UPDATE ai_worker_jobs
           SET status = 'cancelled', finished_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(ts, ts, id);
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
    const id = randomUUID();
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO ai_orchestration_runs
           (id, session_id, user_id, status, current_round, max_rounds, current_step,
            pending_worker_job_id, last_error, state, created_at, updated_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, NULL)`,
      )
      .run(
        id,
        args.sessionId,
        args.userId ?? null,
        args.status ?? "queued",
        args.currentRound ?? 1,
        args.maxRounds ?? 3,
        args.currentStep ?? null,
        JSON.stringify(args.state ?? {}),
        ts,
        ts,
      );
    return (await this.getOrchestrationRun(id))!;
  }

  async getOrchestrationRun(id: string): Promise<OrchestrationRunRecord | null> {
    const row = this.db
      .prepare(`SELECT * FROM ai_orchestration_runs WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? rowToOrchestrationRun(row) : null;
  }

  async getOrchestrationRunBySession(
    sessionId: string,
  ): Promise<OrchestrationRunRecord | null> {
    const row = this.db
      .prepare(
        `SELECT * FROM ai_orchestration_runs WHERE session_id = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(sessionId) as Record<string, unknown> | undefined;
    return row ? rowToOrchestrationRun(row) : null;
  }

  async listOrchestrationRuns(limit = 50): Promise<OrchestrationRunRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM ai_orchestration_runs ORDER BY created_at DESC LIMIT ?`,
      )
      .all(limit) as Record<string, unknown>[];
    return rows.map(rowToOrchestrationRun);
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
    const next = { ...current, ...patch };
    this.db
      .prepare(
        `UPDATE ai_orchestration_runs
           SET status = ?, current_round = ?, current_step = ?, pending_worker_job_id = ?,
               last_error = ?, state = ?, finished_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        next.status,
        next.current_round,
        next.current_step ?? null,
        next.pending_worker_job_id ?? null,
        next.last_error ? redactSecrets(next.last_error) : null,
        JSON.stringify(next.state ?? {}),
        next.finished_at ?? null,
        now(),
        id,
      );
  }

  async appendOrchestrationEvent(args: {
    orchestrationRunId: string;
    sessionId: string;
    eventType: string;
    metadata?: Record<string, unknown>;
  }): Promise<OrchestrationEventRecord> {
    const id = randomUUID();
    const ts = now();
    const metadata = sanitizeEventMetadata(args.metadata);
    this.db
      .prepare(
        `INSERT INTO ai_orchestration_events
           (id, orchestration_run_id, session_id, event_type, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        args.orchestrationRunId,
        args.sessionId,
        args.eventType,
        JSON.stringify(metadata),
        ts,
      );
    return {
      id,
      orchestration_run_id: args.orchestrationRunId,
      session_id: args.sessionId,
      event_type: args.eventType,
      metadata,
      created_at: ts,
    };
  }

  async getOrchestrationEvents(
    orchestrationRunId: string,
    limit = 100,
  ): Promise<OrchestrationEventRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM ai_orchestration_events WHERE orchestration_run_id = ? ORDER BY created_at ASC LIMIT ?`,
      )
      .all(orchestrationRunId, limit) as Record<string, unknown>[];
    return rows.map(rowToOrchestrationEvent);
  }

  async findOrchestrationRunByWorkerJobId(
    jobId: string,
  ): Promise<OrchestrationRunRecord | null> {
    const row = this.db
      .prepare(
        `SELECT * FROM ai_orchestration_runs WHERE pending_worker_job_id = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(jobId) as Record<string, unknown> | undefined;
    return row ? rowToOrchestrationRun(row) : null;
  }

  async cancelOrchestrationRun(id: string): Promise<boolean> {
    const run = await this.getOrchestrationRun(id);
    if (!run) return false;
    if (TERMINAL_ORCH_STATUSES.has(run.status)) return false;
    const ts = now();
    this.db
      .prepare(
        `UPDATE ai_orchestration_runs
           SET status = 'cancelled', pending_worker_job_id = NULL, finished_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(ts, ts, id);
    return true;
  }

  // --- Scheduled / cron resume (Phase 7.4) ---

  async listWaitingOrchestrationRuns(
    limit = 50,
  ): Promise<OrchestrationRunRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM ai_orchestration_runs
           WHERE status = 'waiting_for_worker'
           ORDER BY created_at ASC LIMIT ?`,
      )
      .all(limit) as Record<string, unknown>[];
    return rows.map(rowToOrchestrationRun);
  }

  async claimOrchestrationResumeLock(
    runId: string,
    owner: string,
    ttlSeconds: number,
  ): Promise<OrchestrationRunRecord | null> {
    const nowIso = now();
    const ttl = Math.max(1, Math.floor(ttlSeconds));
    const expires = new Date(Date.parse(nowIso) + ttl * 1000).toISOString();
    // SQLite is single-writer, so this conditional UPDATE is atomic: the lock is
    // taken only when the run is still waiting AND the lock is free/expired.
    // ISO-8601 UTC strings compare chronologically, so the expiry check is safe.
    const res = this.db
      .prepare(
        `UPDATE ai_orchestration_runs
           SET resume_lock_owner = ?, resume_lock_expires_at = ?,
               last_resume_attempt_at = ?, updated_at = ?
         WHERE id = ?
           AND status = 'waiting_for_worker'
           AND (resume_lock_owner IS NULL
                OR resume_lock_expires_at IS NULL
                OR resume_lock_expires_at < ?)`,
      )
      .run(owner, expires, nowIso, nowIso, runId, nowIso);
    if (!res.changes) return null;
    return this.getOrchestrationRun(runId);
  }

  async releaseOrchestrationResumeLock(
    runId: string,
    owner: string,
  ): Promise<void> {
    this.db
      .prepare(
        `UPDATE ai_orchestration_runs
           SET resume_lock_owner = NULL, resume_lock_expires_at = NULL, updated_at = ?
         WHERE id = ? AND resume_lock_owner = ?`,
      )
      .run(now(), runId, owner);
  }

  async incrementOrchestrationResumeAttempt(runId: string): Promise<void> {
    this.db
      .prepare(
        `UPDATE ai_orchestration_runs
           SET resume_attempts = resume_attempts + 1, updated_at = ?
         WHERE id = ?`,
      )
      .run(now(), runId);
  }

  async ping(): Promise<void> {
    this.db.prepare("SELECT 1").get();
  }

  async probeTableColumn(table: string, column: string): Promise<boolean> {
    // Identifiers come from a hardcoded readiness list, never user input, but
    // guard anyway since SQLite can't parameterize identifiers.
    const ident = /^[A-Za-z_][A-Za-z0-9_]*$/;
    if (!ident.test(table)) return false;
    if (column !== "*" && !ident.test(column)) return false;
    try {
      this.db.prepare(`SELECT ${column} FROM ${table} LIMIT 1`).get();
      return true;
    } catch {
      return false;
    }
  }
}

const TERMINAL_ORCH_STATUSES = new Set<OrchestrationRunStatus>([
  "passed",
  "failed",
  "needs_revision",
  "cancelled",
]);

/** Redact any string metadata values before storing an orchestration event. */
function sanitizeEventMetadata(
  meta?: Record<string, unknown>,
): Record<string, unknown> {
  if (!meta) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    out[k] = typeof v === "string" ? redactSecrets(v) : v;
  }
  return out;
}

function rowToOrchestrationRun(
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
    state: r.state ? (JSON.parse(r.state as string) as Record<string, unknown>) : {},
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
    finished_at: (r.finished_at as string | null) ?? null,
    resume_lock_owner: (r.resume_lock_owner as string | null) ?? null,
    resume_lock_expires_at: (r.resume_lock_expires_at as string | null) ?? null,
    resume_attempts: r.resume_attempts != null ? Number(r.resume_attempts) : 0,
    last_resume_attempt_at: (r.last_resume_attempt_at as string | null) ?? null,
  };
}

function rowToOrchestrationEvent(
  r: Record<string, unknown>,
): OrchestrationEventRecord {
  return {
    id: r.id as string,
    orchestration_run_id: r.orchestration_run_id as string,
    session_id: r.session_id as string,
    event_type: r.event_type as string,
    metadata: r.metadata
      ? (JSON.parse(r.metadata as string) as Record<string, unknown>)
      : {},
    created_at: r.created_at as string,
  };
}

function rowToWorkerJob(r: Record<string, unknown>): WorkerJobRecord {
  const payload = r.payload as string | null;
  const result = r.result as string | null;
  return {
    id: r.id as string,
    session_id: (r.session_id as string | null) ?? null,
    patch_set_id: (r.patch_set_id as string | null) ?? null,
    pull_request_id: (r.pull_request_id as string | null) ?? null,
    user_id: (r.user_id as string | null) ?? null,
    job_type: r.job_type as WorkerJobType,
    status: r.status as WorkerJobStatus,
    priority: Number(r.priority),
    payload: payload ? (JSON.parse(payload) as Record<string, unknown>) : {},
    result: result ? (JSON.parse(result) as Record<string, unknown>) : null,
    error_message: (r.error_message as string | null) ?? null,
    lease_owner: (r.lease_owner as string | null) ?? null,
    lease_expires_at: (r.lease_expires_at as string | null) ?? null,
    attempts: Number(r.attempts),
    max_attempts: Number(r.max_attempts),
    created_at: r.created_at as string,
    started_at: (r.started_at as string | null) ?? null,
    finished_at: (r.finished_at as string | null) ?? null,
    updated_at: r.updated_at as string,
  };
}

function rowToWorkerJobLog(r: Record<string, unknown>): WorkerJobLogRecord {
  return {
    id: r.id as string,
    job_id: r.job_id as string,
    stream: r.stream as WorkerJobStream,
    content: r.content as string,
    created_at: r.created_at as string,
  };
}

function rowToPatchSet(r: Record<string, unknown>): PatchSetRecord {
  const rawErrors = r.validation_errors as string | null;
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
    validation_errors: rawErrors ? (JSON.parse(rawErrors) as string[]) : null,
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
  };
}

function rowToPatchFile(r: Record<string, unknown>): PatchFileRecord {
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
    created_at: r.created_at as string,
  };
}

function rowToPullRequest(r: Record<string, unknown>): PullRequestRecord {
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
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
  };
}

function mapUser(r: Record<string, unknown>): UserRecord {
  return {
    id: r.id as string,
    email: (r.email as string | null) ?? null,
    display_name: (r.display_name as string | null) ?? null,
    role: r.role as UserRole,
    status: r.status as "active" | "disabled",
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
    last_seen_at: (r.last_seen_at as string | null) ?? null,
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
    last_used_at: (r.last_used_at as string | null) ?? null,
    expires_at: (r.expires_at as string | null) ?? null,
    created_at: r.created_at as string,
    revoked_at: (r.revoked_at as string | null) ?? null,
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
    created_at: r.created_at as string,
  };
}

/** Explicit alias documenting the storage backend in use. */
export { OrchestratorRepository as SQLiteRepository };

function rowToSession(r: Record<string, unknown>): SessionRecord {
  return {
    id: r.id as string,
    user_request: r.user_request as string,
    status: r.status as SessionRecord["status"],
    approval: r.approval as SessionRecord["approval"],
    rounds: Number(r.rounds),
    user_id: (r.user_id as string | null) ?? null,
    admin_key_fingerprint: (r.admin_key_fingerprint as string | null) ?? null,
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
  };
}

function rowToRun(r: Record<string, unknown>): RunRecord {
  return {
    id: r.id as string,
    session_id: r.session_id as string,
    command: r.command as string,
    allowed: Number(r.allowed) === 1,
    exit_code: r.exit_code === null ? null : Number(r.exit_code),
    stdout: r.stdout as string,
    stderr: r.stderr as string,
    step_name: (r.step_name as StepName | null) ?? null,
    status: (r.status as RunStatus) ?? "skipped",
    admin_key_fingerprint: (r.admin_key_fingerprint as string | null) ?? null,
    user_id: (r.user_id as string | null) ?? null,
    created_at: r.created_at as string,
  };
}
