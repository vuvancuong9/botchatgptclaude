import { z } from "zod";
import {
  WorkerJobLogRecord,
  WorkerJobRecord,
  WorkerJobStream,
  WorkerJobType,
} from "../types";

/**
 * Phase 7 — execution plane.
 *
 * The control plane (Next.js) only ENQUEUES jobs and READS their results. A
 * separate worker process claims jobs (with a lease), checks out the repo into
 * an isolated workspace, runs allowlisted commands in a sandbox, and writes
 * redacted logs + a result back. No shell command is ever spawned inside a
 * production Next.js request.
 */

// --- Job payloads (validated with zod; the model can never smuggle commands) -

/** The exact commands the sandbox is permitted to run, in any job payload. */
export const WORKER_COMMAND_ALLOWLIST = [
  "npm ci",
  "npm run typecheck",
  "npm test",
  "npm run build",
  "git diff",
] as const;

export type WorkerCommand = (typeof WORKER_COMMAND_ALLOWLIST)[number];

const CommandSchema = z
  .string()
  .refine(
    (c) => (WORKER_COMMAND_ALLOWLIST as readonly string[]).includes(c.trim()),
    { message: "command is not on the worker allowlist" },
  );

export const RepoRefSchema = z.object({
  clone_url: z.string().min(1),
  branch: z.string().min(1),
  commit_sha: z.string().optional(),
});
export type RepoRef = z.infer<typeof RepoRefSchema>;

export const TestPatchPayloadSchema = z.object({
  repo: RepoRefSchema,
  patch_set_id: z.string().min(1),
  /** Phase 7.1: apply the patch into the workspace before testing (default true). */
  apply_patch: z.boolean().default(true),
  commands: z.array(CommandSchema).min(1),
});
export type TestPatchPayload = z.infer<typeof TestPatchPayloadSchema>;

export const TestBranchPayloadSchema = z.object({
  repo: RepoRefSchema,
  commands: z.array(CommandSchema).min(1),
});
export type TestBranchPayload = z.infer<typeof TestBranchPayloadSchema>;

/** Validate a payload for a given job type. Throws on any allowlist violation. */
export function parseJobPayload(
  jobType: WorkerJobType,
  raw: unknown,
): TestPatchPayload | TestBranchPayload {
  if (jobType === "test_patch") return TestPatchPayloadSchema.parse(raw);
  if (jobType === "test_branch") return TestBranchPayloadSchema.parse(raw);
  // build / lint reuse the branch shape (repo + commands).
  return TestBranchPayloadSchema.parse(raw);
}

// --- Job result (written back by the worker) ---------------------------------

export interface CommandOutcome {
  command: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
}

export interface JobResult {
  passed: boolean;
  commands: CommandOutcome[];
  summary: string;
  /** Only present when AI_ORCHESTRATOR_WORKER_KEEP_WORKSPACE=1 (debug). */
  workspacePath?: string;
  // --- Phase 7.1: patch application (test_patch jobs) ---
  /** True when the patch_set was applied into the workspace before tests. */
  patch_applied?: boolean;
  /** The patch_set this job tested (proves which patch passed). */
  patch_set_id?: string | null;
  /** Repo-relative paths changed by the applied patch. */
  changed_files?: string[];
  /** Redacted `git diff --stat`-style summary of the applied patch. */
  diff_summary?: string;
  // --- Phase 7.1.1: base-drift hash guard ---
  /**
   * True when every modify/delete file's old_content_hash was present AND
   * matched the workspace file (no base drift). Structured errors carry a code +
   * file_path only — never file content.
   */
  base_hash_checked?: boolean;
  errors?: { code: string; file_path?: string }[];
  // --- Phase 7.1.3: heartbeat / lease renewal ---
  heartbeat_renewals?: number;
  heartbeat_failures?: number;
  /** True when the lease was renewed at least once during the run. */
  lease_renewed?: boolean;
  /** True when the job was stopped by an abort signal (cancel / lease loss). */
  cancelled_by_signal?: boolean;
}

// --- Repository / queue argument shapes (shared) -----------------------------

export interface CreateWorkerJobInput {
  sessionId?: string | null;
  patchSetId?: string | null;
  pullRequestId?: string | null;
  userId?: string | null;
  jobType: WorkerJobType;
  payload: Record<string, unknown>;
  priority?: number;
  maxAttempts?: number;
}

export interface UpdateWorkerJobStatusInput {
  status?: WorkerJobRecord["status"];
  result?: Record<string, unknown> | null;
  errorMessage?: string | null;
  leaseOwner?: string | null;
  leaseExpiresAt?: string | null;
  attempts?: number;
  startedAt?: string | null;
  finishedAt?: string | null;
}

export interface ClaimOptions {
  /** ISO timestamp to evaluate lease expiry against (injectable for tests). */
  now?: string;
  /** Lease duration in ms (default 5 minutes). */
  leaseMs?: number;
}

/**
 * Provider-agnostic queue surface. The `database` provider delegates to the
 * repository (Postgres/SQLite); the `local` provider is in-memory (test/local).
 */
export interface JobQueue {
  enqueue(input: CreateWorkerJobInput): Promise<WorkerJobRecord>;
  get(id: string): Promise<WorkerJobRecord | null>;
  listForSession(sessionId: string, limit?: number): Promise<WorkerJobRecord[]>;
  claimNext(
    workerId: string,
    opts?: ClaimOptions,
  ): Promise<WorkerJobRecord | null>;
  /** Renew a running job's lease (heartbeat). Null if the lease was lost. */
  renewLease(
    jobId: string,
    workerId: string,
    leaseSeconds: number,
  ): Promise<WorkerJobRecord | null>;
  setStatus(id: string, patch: UpdateWorkerJobStatusInput): Promise<void>;
  appendLog(
    jobId: string,
    stream: WorkerJobStream,
    content: string,
  ): Promise<void>;
  getLogs(jobId: string, limit?: number): Promise<WorkerJobLogRecord[]>;
  cancel(id: string): Promise<boolean>;
}

export type { WorkerJobRecord, WorkerJobLogRecord, WorkerJobStream, WorkerJobType };
