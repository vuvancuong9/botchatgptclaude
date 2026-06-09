import { redactSecrets } from "../security/redact";
import { WorkerJobStatus, WorkerJobStream, WorkerJobType } from "../types";
import {
  CommandRunResult,
  runWorkerCommand,
  validateWorkerCommand,
} from "./command-runner";
import { isProductionEnv } from "./job-queue";
import type { ApplyPatchResult } from "./patch-applier";
import {
  cleanupWorkspace,
  keepWorkspace,
  prepareWorkspace,
} from "./workspace";
import { CommandOutcome, JobResult, RepoRef } from "./types";

export interface SandboxRunnerDeps {
  prepare?: (
    jobId: string,
    repo: RepoRef,
  ) => Promise<{ dir: string; mode: "clone" | "copy" }>;
  cleanup?: (dir: string, keep?: boolean) => void;
  runCommand?: (
    command: string,
    opts: { cwd: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal },
  ) => Promise<CommandRunResult>;
  /** Apply a patch_set into the workspace (Phase 7.1). Required for test_patch. */
  applyPatch?: (
    workspacePath: string,
    patchSetId: string,
  ) => Promise<ApplyPatchResult>;
  /** Persist a redacted log line (stdout/stderr/system). */
  appendLog?: (stream: WorkerJobStream, content: string) => Promise<void> | void;
  /** Re-checked between commands so an external cancel takes effect promptly. */
  isCancelled?: () => Promise<boolean> | boolean;
  /** Phase 7.1.3: abort a long-running command (cancel / lease loss). */
  abortSignal?: AbortSignal;
  keepWorkspace?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface RunSandboxInput {
  jobId: string;
  jobType?: WorkerJobType;
  repo: RepoRef;
  commands: string[];
  /** test_patch: the patch set to apply before tests. */
  patchSetId?: string | null;
  /** test_patch: apply the patch (default true; false only for local debug). */
  applyPatch?: boolean;
}

export interface RunSandboxResult {
  status: WorkerJobStatus;
  result: JobResult;
}

/**
 * Run a job's command sequence inside an isolated workspace. Stops at the first
 * failure/timeout, honours cancellation between commands, always cleans up the
 * workspace (unless KEEP_WORKSPACE), and returns a structured result.
 */
export async function runSandboxJob(
  input: RunSandboxInput,
  deps: SandboxRunnerDeps = {},
): Promise<RunSandboxResult> {
  const prepare = deps.prepare ?? ((id, repo) => prepareWorkspace(id, repo));
  const cleanup = deps.cleanup ?? cleanupWorkspace;
  const runCommand = deps.runCommand ?? runWorkerCommand;
  const log = async (stream: WorkerJobStream, content: string) => {
    if (deps.appendLog) await deps.appendLog(stream, redactSecrets(content));
  };
  const cancelled = async () =>
    Boolean(deps.abortSignal?.aborted) ||
    (deps.isCancelled ? Boolean(await deps.isCancelled()) : false);
  const keep = deps.keepWorkspace ?? keepWorkspace(deps.env);

  const outcomes: CommandOutcome[] = [];
  let status: WorkerJobStatus = "passed";
  let workspaceDir: string | null = null;
  let cancelledBySignal = false;
  const isPatchJob = input.jobType === "test_patch";
  let patchApplied: boolean | undefined = isPatchJob ? false : undefined;
  let changedFiles: string[] | undefined;
  let diffSummary: string | undefined;
  let baseHashChecked: boolean | undefined;
  let applyErrors: { code: string; file_path?: string }[] | undefined;

  try {
    if (await cancelled()) {
      return {
        status: "cancelled",
        result: { passed: false, commands: [], summary: "cancelled before start" },
      };
    }

    const ws = await prepare(input.jobId, input.repo);
    workspaceDir = ws.dir;
    await log("system", `workspace ready (${ws.mode})`);

    // --- Phase 7.1: apply the patch into the workspace before any command. ---
    if (isPatchJob) {
      const applyEnabled = input.applyPatch !== false;
      if (!input.patchSetId) {
        status = "failed";
        await log("system", "test_patch job is missing patch_set_id");
      } else if (!applyEnabled) {
        // apply_patch=false is a local/debug escape hatch — never in production.
        if (isProductionEnv(deps.env)) {
          status = "failed";
          await log(
            "system",
            "apply_patch=false is not allowed in production",
          );
        } else {
          await log("system", "apply_patch=false (debug): skipping patch apply");
        }
      } else if (!deps.applyPatch) {
        status = "failed";
        await log("system", "no patch applier configured for test_patch");
      } else {
        await log("system", `applying patch_set ${input.patchSetId}`);
        const ar = await deps.applyPatch(workspaceDir, input.patchSetId);
        patchApplied = ar.patchApplied;
        changedFiles = ar.changedFiles;
        diffSummary = ar.diffSummary;
        baseHashChecked = ar.baseHashChecked;
        applyErrors = ar.errors;
        if (!ar.patchApplied) {
          status = "failed";
          // Log codes + paths only — never file content.
          const codes = ar.errors
            .map((e) => `${e.code}${e.file_path ? ` ${e.file_path}` : ""}`)
            .join("; ");
          await log("system", `patch apply failed: ${codes}`);
        } else {
          await log(
            "system",
            `patch applied: ${ar.changedFiles.length} file(s), base_hash_checked=${ar.baseHashChecked}`,
          );
        }
      }
    }

    // Only run commands if the patch step (if any) succeeded.
    for (const command of status === "passed" ? input.commands : []) {
      if (await cancelled()) {
        status = "cancelled";
        await log("system", "cancelled between commands");
        break;
      }
      // Defense in depth: re-validate the command at run time.
      const check = validateWorkerCommand(command);
      if (!check.allowed) {
        status = "failed";
        await log("system", `blocked command: ${check.reason}`);
        outcomes.push({
          command,
          exitCode: null,
          durationMs: 0,
          timedOut: false,
          truncated: false,
        });
        break;
      }

      await log("system", `$ ${command}`);
      const res = await runCommand(command, {
        cwd: workspaceDir,
        env: deps.env,
        signal: deps.abortSignal,
      });
      if (res.stdout) await log("stdout", res.stdout);
      if (res.stderr) await log("stderr", res.stderr);
      outcomes.push({
        command,
        exitCode: res.exitCode,
        durationMs: res.durationMs,
        timedOut: res.timedOut,
        truncated: res.truncated,
      });

      if (res.aborted) {
        cancelledBySignal = true;
        status = "cancelled";
        await log("system", "command aborted (cancel / lease loss)");
        break;
      }
      if (res.timedOut) {
        status = "timed_out";
        break;
      }
      if (!res.allowed || (res.exitCode ?? 1) !== 0) {
        status = "failed";
        break;
      }
    }
  } catch (err) {
    status = "failed";
    await log("system", `runner error: ${redactSecrets((err as Error).message)}`);
  } finally {
    if (workspaceDir) cleanup(workspaceDir, keep);
  }

  const result: JobResult = {
    passed: status === "passed",
    commands: outcomes,
    summary: buildSummary(status, outcomes),
  };
  if (keep && workspaceDir) result.workspacePath = workspaceDir;
  if (isPatchJob) {
    result.patch_applied = patchApplied;
    result.patch_set_id = input.patchSetId ?? null;
    result.changed_files = changedFiles ?? [];
    result.diff_summary = diffSummary ?? "";
    result.base_hash_checked = baseHashChecked ?? false;
    if (applyErrors && applyErrors.length) result.errors = applyErrors;
  }
  if (cancelledBySignal) result.cancelled_by_signal = true;

  return { status, result };
}

function buildSummary(
  status: WorkerJobStatus,
  outcomes: CommandOutcome[],
): string {
  const ran = outcomes.length;
  const okCount = outcomes.filter((o) => (o.exitCode ?? 1) === 0).length;
  const failed = outcomes.find(
    (o) => o.timedOut || (o.exitCode ?? 1) !== 0,
  );
  const base = `${okCount}/${ran} command(s) passed`;
  if (status === "passed") return `${base} — all green`;
  if (status === "cancelled") return `${base} — cancelled`;
  if (status === "timed_out")
    return `${base} — timed out on "${failed?.command ?? "?"}"`;
  return `${base} — failed on "${failed?.command ?? "?"}"`;
}
