import { z } from "zod";

/**
 * The single output contract every agent must satisfy. Models are instructed to
 * emit exactly this JSON shape; we validate before persisting or acting on it.
 */
export const AgentStatus = z.enum(["pass", "needs_revision", "fail"]);
export type AgentStatus = z.infer<typeof AgentStatus>;

export const ArtifactType = z.enum([
  "spec",
  "plan",
  "patch",
  "test_report",
  "review",
]);
export type ArtifactType = z.infer<typeof ArtifactType>;

export const ArtifactSchema = z.object({
  type: ArtifactType,
  content: z.string(),
});
export type Artifact = z.infer<typeof ArtifactSchema>;

export const AgentOutputSchema = z.object({
  status: AgentStatus,
  summary: z.string(),
  issues: z.array(z.string()),
  next_action: z.string(),
  artifacts: z.array(ArtifactSchema),
});
export type AgentOutput = z.infer<typeof AgentOutputSchema>;

/** Names of the orchestrated steps, in pipeline order. */
export const STEP_NAMES = [
  "GPT_PRODUCT_SPEC",
  "CLAUDE_CRITICAL_REVIEW",
  "GPT_IMPLEMENTATION_PLAN",
  "CLAUDE_CODE_IMPLEMENTER",
  "TEST_RUNNER",
  "GPT_CODE_REVIEWER",
  "QA_JUDGE",
] as const;
export type StepName = (typeof STEP_NAMES)[number];

export type Provider = "openai" | "anthropic" | "system";

export interface SessionRecord {
  id: string;
  user_request: string;
  status: "running" | "passed" | "needs_revision" | "failed" | "rejected";
  approval: "pending" | "approved" | "rejected";
  rounds: number;
  /** Nullable; reserved for multi-user attribution (Phase 4). */
  user_id: string | null;
  /** Nullable; non-reversible fingerprint of the admin key that ran it. */
  admin_key_fingerprint: string | null;
  created_at: string;
  updated_at: string;
}

export interface MessageRecord {
  id: string;
  session_id: string;
  step: StepName;
  provider: Provider;
  round: number;
  output: AgentOutput;
  created_at: string;
}

export interface ArtifactRecord {
  id: string;
  session_id: string;
  message_id: string;
  type: ArtifactType;
  content: string;
  created_at: string;
}

export type RunStatus = "passed" | "failed" | "blocked" | "skipped";

export interface RunRecord {
  id: string;
  session_id: string;
  command: string;
  allowed: boolean;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  /** Which workflow step triggered the run (nullable). */
  step_name: StepName | null;
  /** Derived run outcome (indexed). */
  status: RunStatus;
  /** Nullable; non-reversible fingerprint of the admin key. */
  admin_key_fingerprint: string | null;
  /** Nullable; the user who triggered the run (multi-user). */
  user_id: string | null;
  created_at: string;
}

/** Derive a stable run status from the guard + execution result. */
export function deriveRunStatus(
  allowed: boolean,
  exitCode: number | null,
): RunStatus {
  if (!allowed) return "blocked";
  if (exitCode === null) return "skipped";
  return exitCode === 0 ? "passed" : "failed";
}

/** Full hydrated view returned by the detail API and consumed by the UI. */
export interface SessionDetail {
  session: SessionRecord;
  messages: MessageRecord[];
  artifacts: ArtifactRecord[];
  runs: RunRecord[];
}

/** Audit events recorded for security/operational forensics. */
export type AuditEventType =
  | "auth_failed"
  | "auth_passed"
  | "auth_denied"
  | "rate_limited"
  | "ai_run_started"
  | "ai_run_completed"
  | "ai_run_failed"
  | "session_approved"
  | "session_rejected"
  | "user_created"
  | "user_disabled"
  | "user_enabled"
  | "user_password_set"
  | "model_key_updated"
  | "api_key_created"
  | "api_key_revoked"
  | "permission_denied"
  | "collaborator_added"
  | "collaborator_removed"
  | "legacy_admin_used"
  // --- Phase 6: GitHub PR flow ---
  | "patch_validation_started"
  | "patch_validation_passed"
  | "patch_validation_failed"
  | "github_branch_created"
  | "github_file_written"
  | "github_pr_created"
  | "github_pr_failed"
  | "ai_pr_blocked_tests_failed"
  | "ai_pr_blocked_permission"
  | "ai_pr_blocked_not_approved"
  | "ai_pr_dry_run_completed"
  // --- Phase 7: sandbox worker / execution plane ---
  | "worker_job_created"
  | "worker_job_started"
  | "worker_job_passed"
  | "worker_job_failed"
  | "worker_job_cancelled"
  | "worker_job_timed_out"
  | "pr_blocked_worker_required"
  | "pr_blocked_worker_failed"
  // --- Phase 7.1: apply patch in sandbox ---
  | "patch_apply_started"
  | "patch_apply_passed"
  | "patch_apply_failed"
  | "pr_blocked_worker_patch_mismatch"
  // --- Phase 7.1.1: base-drift hash guard ---
  | "pr_blocked_worker_hash_not_checked"
  // --- Phase 7.1.3: heartbeat / lease renewal ---
  | "worker_heartbeat_started"
  | "worker_heartbeat_stopped"
  | "worker_lease_renewed"
  | "worker_lease_renew_failed"
  | "worker_cancel_signal_sent"
  // --- Phase 7.2: orchestrator TEST_RUNNER via worker ---
  | "orchestrator_test_job_created"
  | "orchestrator_test_job_passed"
  | "orchestrator_test_job_failed"
  | "orchestrator_test_job_timeout"
  | "orchestrator_test_runner_inline_blocked"
  // --- Phase 7.3: async (resumable) orchestration ---
  | "orchestration_async_started"
  | "orchestration_waiting_for_worker"
  | "orchestration_resume_requested"
  | "orchestration_resumed"
  | "orchestration_cancelled"
  | "orchestration_completed"
  | "orchestration_failed"
  | "orchestration_round_started"
  | "orchestration_worker_job_linked"
  // --- Phase 7.4: scheduled / cron resume ---
  | "orchestration_cron_resume_started"
  | "orchestration_cron_resume_completed"
  | "orchestration_cron_resume_failed"
  | "orchestration_resume_lock_acquired"
  | "orchestration_resume_lock_skipped"
  | "orchestration_resume_lock_released";

export type UserRole =
  | "owner"
  | "admin"
  | "developer"
  | "reviewer"
  | "viewer";

export interface UserRecord {
  id: string;
  email: string | null;
  display_name: string | null;
  role: UserRole;
  status: "active" | "disabled";
  created_at: string;
  updated_at: string;
  last_seen_at: string | null;
  /** Phase 10: scrypt hash for web login (null when no password set). */
  password_hash: string | null;
}

/** Phase 10: key-value app settings (secret values are AES-encrypted). */
export interface SettingRecord {
  key: string;
  value: string;
  updated_at: string;
}

export interface ApiKeyRecord {
  id: string;
  user_id: string;
  key_prefix: string;
  key_hash: string;
  name: string | null;
  status: "active" | "revoked";
  last_used_at: string | null;
  expires_at: string | null;
  created_at: string;
  revoked_at: string | null;
}

export interface SessionCollaboratorRecord {
  id: string;
  session_id: string;
  user_id: string;
  permission: "owner" | "editor" | "reviewer" | "viewer";
  created_at: string;
}

export interface PermissionOverrideRecord {
  id: string;
  user_id: string;
  permission: string;
  effect: "allow" | "deny";
  created_at: string;
}

export interface AuditLogRecord {
  id: string;
  event_type: string;
  session_id: string | null;
  admin_key_fingerprint: string | null;
  user_id: string | null;
  /** Hash of client IP (never the raw IP). */
  ip_hash: string | null;
  /** Hash of user-agent (never the raw UA). */
  user_agent_hash: string | null;
  status: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

// =============================================================================
// Phase 6 — GitHub PR flow (patch sets, patch files, pull requests).
// =============================================================================

/** Lifecycle of a generated patch set. */
export type PatchSetStatus =
  | "draft"
  | "validated"
  | "applied"
  | "failed"
  | "superseded";

/** Per-file change kind inside a patch set. */
export type PatchFileChangeType = "create" | "modify" | "delete" | "rename";

/** Lifecycle of a pull-request attempt (dry_run never touches GitHub). */
export type PullRequestStatus =
  | "dry_run"
  | "created"
  | "closed"
  | "merged"
  | "failed";

export interface PatchSetRecord {
  id: string;
  session_id: string;
  user_id: string | null;
  status: PatchSetStatus;
  base_branch: string;
  target_branch: string;
  base_sha: string | null;
  patch_summary: string | null;
  /** Full patch text (redacted before persistence). */
  patch_text: string | null;
  /** Validation failures, when status = 'failed'. */
  validation_errors: string[] | null;
  created_at: string;
  updated_at: string;
}

export interface PatchFileRecord {
  id: string;
  patch_set_id: string;
  file_path: string;
  change_type: PatchFileChangeType;
  old_content_hash: string | null;
  new_content_hash: string | null;
  /** Redacted snippet / new content for review (never raw secrets). */
  patch_hunk: string | null;
  reason: string | null;
  /**
   * Phase 7.1: FULL new file content (redacted) the worker applies into the
   * sandbox workspace. Null for delete. A validated patch never contains secrets
   * (the validator rejects them), so redaction is a no-op on valid content.
   */
  new_content_redacted: string | null;
  created_at: string;
}

export interface PullRequestRecord {
  id: string;
  session_id: string;
  patch_set_id: string;
  user_id: string | null;
  github_pr_number: number | null;
  github_pr_url: string | null;
  branch_name: string;
  base_branch: string;
  status: PullRequestStatus;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

// =============================================================================
// Phase 7 — sandbox worker / execution plane (jobs + job logs).
// =============================================================================

export type WorkerJobType = "test_patch" | "test_branch" | "build" | "lint";

export type WorkerJobStatus =
  | "queued"
  | "running"
  | "passed"
  | "failed"
  | "cancelled"
  | "timed_out";

export type WorkerJobStream = "stdout" | "stderr" | "system";

export interface WorkerJobRecord {
  id: string;
  session_id: string | null;
  patch_set_id: string | null;
  pull_request_id: string | null;
  user_id: string | null;
  job_type: WorkerJobType;
  status: WorkerJobStatus;
  priority: number;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error_message: string | null;
  /** The worker that currently holds the lease (null when unclaimed). */
  lease_owner: string | null;
  /** ISO timestamp the lease expires; a stale lease can be re-claimed. */
  lease_expires_at: string | null;
  attempts: number;
  max_attempts: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

export interface WorkerJobLogRecord {
  id: string;
  job_id: string;
  stream: WorkerJobStream;
  content: string;
  created_at: string;
}

// =============================================================================
// Phase 7.3 — async (resumable) orchestration.
// =============================================================================

export type OrchestrationRunStatus =
  | "queued"
  | "running"
  | "waiting_for_worker"
  | "needs_revision"
  | "passed"
  | "failed"
  | "cancelled";

export interface OrchestrationRunRecord {
  id: string;
  session_id: string;
  user_id: string | null;
  status: OrchestrationRunStatus;
  current_round: number;
  max_rounds: number;
  current_step: string | null;
  /** The worker job the run is currently waiting on (when waiting_for_worker). */
  pending_worker_job_id: string | null;
  last_error: string | null;
  /** Resumable state (redacted): spec/critique/plan/patch/review text, etc. */
  state: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
  // --- Phase 7.4: scheduled/cron resume lock (additive, nullable) ---
  /** Cron/worker that currently holds the resume lock (null when free). */
  resume_lock_owner: string | null;
  /** ISO timestamp the resume lock expires; a stale lock can be re-claimed. */
  resume_lock_expires_at: string | null;
  /** How many resume attempts have run (diagnostics; never an infinite loop). */
  resume_attempts: number;
  /** ISO timestamp of the last resume attempt. */
  last_resume_attempt_at: string | null;
}

export interface OrchestrationEventRecord {
  id: string;
  orchestration_run_id: string;
  session_id: string;
  event_type: string;
  metadata: Record<string, unknown>;
  created_at: string;
}
