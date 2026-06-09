import type { AiOrchestratorRepository } from "../db/repository.interface";
import { recordAudit } from "../audit";
import { getHealthReport } from "../health";
import { redactSecrets } from "../security/redact";
import {
  formatTestReport,
  runTestSuite,
  TestReport,
} from "../test-runner";
import {
  PatchSetRecord,
  PullRequestRecord,
  SessionRecord,
  WorkerJobRecord,
} from "../types";
import { isProductionEnv } from "../worker/job-queue";
import { findLatestRequiredWorkerJob } from "../worker/job-service";
import { resolvePatchHashStrict } from "../worker/patch-applier";
import {
  canAccessSession,
  RbacSubject,
  subjectHasPermission,
} from "../auth/rbac";
import { PERMISSIONS } from "../auth/permissions";
import {
  buildBranchName,
  createSessionBranch,
  shortSessionId,
} from "./branch-service";
import { createGithubClient, resolveGithubConfig, resolveGithubFlags } from "./github-client";
import { applyPatchFiles, validateAndStorePatch } from "./patch-service";
import { GithubClient, GithubConfig } from "./types";
import {
  PatchArtifact,
  parsePatchArtifact,
} from "../patch/patch-schema";
import { validatePatch } from "../patch/patch-validator";

export type PrBlockReason =
  | "permission_denied"
  | "not_approved"
  | "patch_not_validated"
  | "github_disabled"
  | "github_not_configured"
  | "tests_disabled"
  | "tests_failed"
  | "health_failed"
  | "smoke_required"
  | "worker_required"
  | "worker_failed"
  | "worker_patch_mismatch"
  | "worker_hash_not_checked"
  | "base_hash_mismatch"
  | "github_error";

export interface PrFlowConfig {
  enableGithubPr: boolean;
  dryRun: boolean;
  executeTests: boolean;
  requireSmokePass: boolean;
  smokePassedAt: string | null;
  /** Null when GITHUB_TOKEN/OWNER/REPO are missing. */
  githubConfig: GithubConfig | null;
  defaultBranch: string;
  // Phase 7 — execution plane.
  /** "database" (default): require a passed sandbox worker job. "local": dev. */
  workerProvider: "database" | "local";
  /** When true, fall back to running tests inline (dev only; never production). */
  allowInlineCommands: boolean;
  /** Phase 7.1.1: require the worker to have verified base hashes (no drift). */
  patchHashStrict: boolean;
}

export interface PrFlowDeps {
  repo: AiOrchestratorRepository;
  subject: RbacSubject;
  isCollaborator?: boolean;
  session: SessionRecord;
  /** Latest patch artifact text from the implementer (validated/applied here). */
  patchArtifactText: string | null;
  /** Optional already-validated patch set to reuse instead of re-validating. */
  existingPatchSet?: PatchSetRecord | null;
  config: PrFlowConfig;
  /** Inject a fake client in tests; falls back to REST when null + live. */
  githubClient?: GithubClient | null;
  /** Inject to stub pass/fail in tests; defaults to the real allowlisted suite. */
  runTests?: () => TestReport;
  /** Inject to stub health in tests; defaults to getHealthReport().ok. */
  healthCheck?: () => Promise<boolean>;
  /** Worker-mode gate: latest required sandbox job. Defaults to a repo lookup. */
  findRequiredWorkerJob?: () => Promise<WorkerJobRecord | null>;
  /** Epoch ms used for the branch name (deterministic in tests). */
  timestamp: number;
  ip?: string | null;
  userAgent?: string | null;
}

export interface PrFlowResult {
  ok: boolean;
  httpStatus: number;
  mode: "dry_run" | "live";
  blockedReason?: PrBlockReason;
  message: string;
  patchSetId: string | null;
  branchName?: string;
  pullRequest?: PullRequestRecord;
  prUrl?: string | null;
  validationErrors?: string[];
  testReport?: string;
}

/** Build the flow config from env (used by the route; tests build it directly). */
export function resolvePrFlowConfig(
  env: Record<string, string | undefined> = process.env,
): PrFlowConfig {
  const flags = resolveGithubFlags(env);
  const { config } = resolveGithubConfig(env);
  return {
    enableGithubPr: flags.enableGithubPr,
    dryRun: flags.dryRun,
    executeTests: env.AI_ORCHESTRATOR_EXECUTE_TESTS === "1",
    requireSmokePass: env.AI_ORCHESTRATOR_REQUIRE_SMOKE_PASS === "1",
    smokePassedAt: env.AI_ORCHESTRATOR_SUPABASE_SMOKE_PASSED_AT?.trim() || null,
    githubConfig: config,
    defaultBranch:
      config?.defaultBranch ?? env.GITHUB_DEFAULT_BRANCH?.trim() ?? "main",
    workerProvider:
      (env.AI_ORCHESTRATOR_WORKER_PROVIDER ?? "database").trim().toLowerCase() ===
      "local"
        ? "local"
        : "database",
    allowInlineCommands: env.AI_ORCHESTRATOR_ALLOW_INLINE_COMMANDS === "1",
    patchHashStrict: resolvePatchHashStrict(env),
  };
}

function roleCanDelete(subject: RbacSubject): boolean {
  return subject.role === "owner" || subject.role === "admin";
}

/**
 * The Phase 6 PR flow. Ordered, fail-closed gates; dry-run is the safe default
 * and never touches GitHub. Live mode runs real tests, creates a branch off the
 * base, writes files, and opens a PR — never merges, never pushes/forces base.
 */
export async function createPullRequestForSession(
  deps: PrFlowDeps,
): Promise<PrFlowResult> {
  const { repo, subject, session, config } = deps;
  const isCollaborator = deps.isCollaborator ?? false;
  const mode: "dry_run" | "live" = config.dryRun ? "dry_run" : "live";
  const sid = session.id;

  const audit = (
    eventType: Parameters<typeof recordAudit>[0]["eventType"],
    status: string,
    metadata: Record<string, unknown> = {},
  ) =>
    recordAudit({
      eventType,
      status,
      sessionId: sid,
      userId: subject.userId,
      ip: deps.ip ?? null,
      userAgent: deps.userAgent ?? null,
      metadata,
    });

  const blocked = (
    reason: PrBlockReason,
    httpStatus: number,
    message: string,
    patchSetId: string | null = null,
    validationErrors?: string[],
  ): PrFlowResult => ({
    ok: false,
    httpStatus,
    mode,
    blockedReason: reason,
    message,
    patchSetId,
    validationErrors,
  });

  // 1) Permission to open PRs.
  if (!subjectHasPermission(subject, PERMISSIONS.PR_CREATE)) {
    await audit("ai_pr_blocked_permission", "denied", {
      reason: "missing ai:pr:create",
    });
    return blocked("permission_denied", 403, "Missing permission ai:pr:create.");
  }
  // 2) Access to this session.
  if (!canAccessSession(subject, session, { isCollaborator })) {
    await audit("ai_pr_blocked_permission", "denied", {
      reason: "no session access",
    });
    return blocked("permission_denied", 403, "No access to this session.");
  }

  // 3) Resolve a VALIDATED patch set (reuse or validate-and-store now).
  const intendedBranch = buildBranchName(sid, deps.timestamp);
  let patchSet: PatchSetRecord;
  let patch: PatchArtifact | null = null;

  if (deps.existingPatchSet && deps.existingPatchSet.status === "validated") {
    patchSet = deps.existingPatchSet;
  } else {
    if (!deps.patchArtifactText) {
      return blocked(
        "patch_not_validated",
        409,
        "No patch artifact available to validate.",
      );
    }
    await audit("patch_validation_started", "ok", {});
    const stored = await validateAndStorePatch({
      repo,
      session,
      userId: subject.userId,
      artifactText: deps.patchArtifactText,
      baseBranch: config.defaultBranch,
      targetBranch: intendedBranch,
      canDelete: roleCanDelete(subject),
    });
    if (!stored.ok) {
      await audit("patch_validation_failed", "fail", {
        errors: stored.errors.length,
      });
      return blocked(
        "patch_not_validated",
        409,
        "Patch failed validation.",
        stored.patchSet.id,
        stored.errors,
      );
    }
    await audit("patch_validation_passed", "ok", {
      files: stored.patch?.files.length ?? 0,
    });
    patchSet = stored.patchSet;
    patch = stored.patch;
  }

  // 4) Human approval gate.
  const approved =
    session.approval === "approved" || session.status === "passed";
  if (!approved) {
    await audit("ai_pr_blocked_not_approved", "denied", {
      approval: session.approval,
      status: session.status,
    });
    return blocked(
      "not_approved",
      409,
      "Session is not approved; approve it before creating a PR.",
      patchSet.id,
    );
  }

  // 5) DRY RUN — stop here. No GitHub writes.
  if (mode === "dry_run") {
    const pr = await repo.createPullRequest({
      sessionId: sid,
      patchSetId: patchSet.id,
      userId: subject.userId,
      branchName: intendedBranch,
      baseBranch: config.defaultBranch,
      status: "dry_run",
    });
    await audit("ai_pr_dry_run_completed", "ok", {
      branchName: intendedBranch,
      patchSummary: patchSet.patch_summary,
    });
    return {
      ok: true,
      httpStatus: 200,
      mode,
      message: "DRY RUN — no GitHub write performed.",
      patchSetId: patchSet.id,
      branchName: intendedBranch,
      pullRequest: pr,
      prUrl: null,
    };
  }

  // --- LIVE MODE GATES ---

  // 6) Feature must be explicitly enabled.
  if (!config.enableGithubPr) {
    return blocked(
      "github_disabled",
      403,
      "GitHub PR creation is disabled (AI_ORCHESTRATOR_ENABLE_GITHUB_PR != 1).",
      patchSet.id,
    );
  }
  // 7) GitHub must be configured (token/owner/repo) or a client injected.
  const client =
    deps.githubClient ??
    (config.githubConfig ? createGithubClient(config.githubConfig) : null);
  if (!client) {
    return blocked(
      "github_not_configured",
      412,
      "Missing GITHUB_TOKEN / GITHUB_OWNER / GITHUB_REPO.",
      patchSet.id,
    );
  }
  // 8) Optional Supabase smoke-pass requirement.
  if (config.requireSmokePass && !config.smokePassedAt) {
    return blocked(
      "smoke_required",
      412,
      "Supabase smoke test required but not recorded (AI_ORCHESTRATOR_SUPABASE_SMOKE_PASSED_AT).",
      patchSet.id,
    );
  }
  // 9) Health must be green.
  const healthOk = deps.healthCheck
    ? await deps.healthCheck()
    : (await getHealthReport()).ok;
  if (!healthOk) {
    return blocked(
      "health_failed",
      503,
      "Health check failed; refusing to create a PR.",
      patchSet.id,
    );
  }
  // 10) Re-parse + re-validate the patch before touching GitHub.
  if (!patch) {
    if (!deps.patchArtifactText) {
      return blocked(
        "patch_not_validated",
        409,
        "Patch artifact text unavailable for apply.",
        patchSet.id,
      );
    }
    try {
      patch = parsePatchArtifact(deps.patchArtifactText);
    } catch (err) {
      return blocked(
        "patch_not_validated",
        409,
        `Patch re-parse failed: ${(err as Error).message}`,
        patchSet.id,
      );
    }
    const reval = validatePatch(patch, { canDelete: roleCanDelete(subject) });
    if (!reval.ok) {
      await repo.updatePatchSet(patchSet.id, {
        status: "failed",
        validation_errors: reval.errors,
      });
      return blocked(
        "patch_not_validated",
        409,
        "Patch failed re-validation before apply.",
        patchSet.id,
        reval.errors,
      );
    }
  }

  // 11) Test gate — sandbox worker (default) or inline (dev only).
  let testReport: string;
  let matchedJob: WorkerJobRecord | null = null;
  if (config.allowInlineCommands) {
    // Dev/local fallback. NEVER runs inside a production request.
    if (isProductionEnv()) {
      return blocked(
        "tests_disabled",
        412,
        "Inline command execution is disabled in production; use the sandbox worker.",
        patchSet.id,
      );
    }
    if (!config.executeTests) {
      return blocked(
        "tests_disabled",
        412,
        "real tests disabled (set AI_ORCHESTRATOR_EXECUTE_TESTS=1).",
        patchSet.id,
      );
    }
    const report = (deps.runTests ?? (() => runTestSuite({ execute: true })))();
    testReport = formatTestReport(report);
    if (!report.passed) {
      await repo.updatePatchSet(patchSet.id, { status: "failed" });
      await audit("ai_pr_blocked_tests_failed", "fail", {});
      return {
        ok: false,
        httpStatus: 422,
        mode,
        blockedReason: "tests_failed",
        message: "Tests failed; PR not created.",
        patchSetId: patchSet.id,
        testReport,
      };
    }
  } else {
    // Worker mode (default/production): require a PASSED sandbox job that tested
    // THIS patch set with the patch actually applied (Phase 7.1).
    const job = deps.findRequiredWorkerJob
      ? await deps.findRequiredWorkerJob()
      : await findLatestRequiredWorkerJob(repo, sid);
    if (!job) {
      await audit("pr_blocked_worker_required", "denied", {});
      return blocked(
        "worker_required",
        409,
        "Run sandbox tests first: no sandbox job for this patch.",
        patchSet.id,
      );
    }
    const jobResult = (job.result ?? {}) as {
      patch_applied?: boolean;
      base_hash_checked?: boolean;
      errors?: { code?: string }[];
    };
    const matchesPatch = job.patch_set_id === patchSet.id;
    const applied = jobResult.patch_applied === true;
    const baseHashChecked = jobResult.base_hash_checked === true;

    if (job.status === "passed" && matchesPatch && applied) {
      // Phase 7.1.1: in strict mode the worker must have verified base hashes.
      if (config.patchHashStrict && !baseHashChecked) {
        await audit("pr_blocked_worker_hash_not_checked", "denied", {
          jobId: job.id,
        });
        return blocked(
          "worker_hash_not_checked",
          409,
          "Sandbox job did not verify base hashes (base drift not checked); re-run Patch Tests.",
          patchSet.id,
        );
      }
      matchedJob = job;
      testReport = workerJobReport(job);
    } else if (job.status === "passed" && !matchesPatch) {
      await audit("pr_blocked_worker_patch_mismatch", "denied", {
        jobId: job.id,
        jobPatchSet: job.patch_set_id,
        patchSet: patchSet.id,
      });
      return blocked(
        "worker_patch_mismatch",
        409,
        "Latest sandbox job tested a different patch set; re-run sandbox tests for this patch.",
        patchSet.id,
      );
    } else if (job.status === "passed" && matchesPatch && !applied) {
      await audit("pr_blocked_worker_required", "denied", {
        jobId: job.id,
        reason: "patch_not_applied",
      });
      return blocked(
        "worker_required",
        409,
        "Sandbox job did not apply the patch (patch_applied=false); re-run sandbox tests.",
        patchSet.id,
      );
    } else if (job.status === "failed" || job.status === "timed_out") {
      // Surface base drift specifically (the worker recorded it in the result).
      const drift = (jobResult.errors ?? []).some(
        (e) => e.code === "base_hash_mismatch",
      );
      if (drift) {
        await audit("pr_blocked_worker_failed", "denied", {
          jobId: job.id,
          reason: "base_hash_mismatch",
        });
        return blocked(
          "base_hash_mismatch",
          409,
          "Base file changed after the patch was validated (base_hash_mismatch); re-validate the patch and re-run Patch Tests.",
          patchSet.id,
        );
      }
      await audit("pr_blocked_worker_failed", "denied", {
        jobId: job.id,
        jobStatus: job.status,
      });
      return blocked(
        "worker_failed",
        409,
        `Sandbox job is '${job.status}'; PR blocked until it passes.`,
        patchSet.id,
      );
    } else {
      // queued / running / cancelled
      await audit("pr_blocked_worker_required", "denied", {
        jobId: job.id,
        jobStatus: job.status,
      });
      return blocked(
        "worker_required",
        409,
        `Sandbox job is '${job.status}'; wait for it to pass.`,
        patchSet.id,
      );
    }
  }

  // 13) Create branch -> write files -> open PR.
  let branchName: string | undefined;
  try {
    const branch = await createSessionBranch(client, {
      sessionId: sid,
      baseBranch: config.defaultBranch,
      timestamp: deps.timestamp,
    });
    branchName = branch.branchName;
    await repo.updatePatchSet(patchSet.id, { base_sha: branch.baseSha });
    await audit("github_branch_created", "ok", { branchName });

    const applied = await applyPatchFiles({
      client,
      branch: branchName,
      baseBranch: config.defaultBranch,
      patch,
      messagePrefix: `ai-orchestrator ${shortSessionId(sid)}`,
    });
    for (const f of applied) {
      await audit("github_file_written", "ok", {
        path: f.path,
        action: f.action,
        old_content_hash: f.oldContentHash,
        new_content_hash: f.newContentHash,
      });
    }

    const created = await client.createPullRequest({
      title: `AI Orchestrator: ${session.user_request.slice(0, 60)}`,
      head: branchName,
      base: config.defaultBranch,
      body: buildPrBody(session, applied, testReport, {
        patchSetId: patchSet.id,
        workerJobId: matchedJob?.id ?? null,
        patchApplied: matchedJob ? true : undefined,
        changedFiles:
          (matchedJob?.result as { changed_files?: string[] } | null)
            ?.changed_files ?? undefined,
      }),
    });

    const pr = await repo.createPullRequest({
      sessionId: sid,
      patchSetId: patchSet.id,
      userId: subject.userId,
      branchName,
      baseBranch: config.defaultBranch,
      status: "created",
      githubPrNumber: created.number,
      githubPrUrl: created.url,
    });
    await repo.updatePatchSet(patchSet.id, { status: "applied" });
    await audit("github_pr_created", "ok", {
      pr_number: created.number,
      pr_url: created.url,
      branchName,
    });

    return {
      ok: true,
      httpStatus: 201,
      mode,
      message: "Pull request created. Review and merge it manually in GitHub.",
      patchSetId: patchSet.id,
      branchName,
      pullRequest: pr,
      prUrl: created.url,
      testReport,
    };
  } catch (err) {
    const msg = redactSecrets((err as Error)?.message ?? "github error");
    let prRecord: PullRequestRecord | undefined;
    try {
      prRecord = await repo.createPullRequest({
        sessionId: sid,
        patchSetId: patchSet.id,
        userId: subject.userId,
        branchName: branchName ?? intendedBranch,
        baseBranch: config.defaultBranch,
        status: "failed",
        errorMessage: msg,
      });
    } catch {
      /* secondary failure — never mask the original */
    }
    await audit("github_pr_failed", "fail", { error: msg });
    return {
      ok: false,
      httpStatus: 502,
      mode,
      blockedReason: "github_error",
      message: `GitHub operation failed: ${msg}`,
      patchSetId: patchSet.id,
      branchName,
      pullRequest: prRecord,
    };
  }
}

/** Short text report from a passed worker job's result (no secrets). */
function workerJobReport(job: WorkerJobRecord): string {
  const result = job.result as
    | { summary?: string; commands?: { command: string; exitCode: number | null }[] }
    | null;
  if (!result) return `Sandbox job ${job.id}: passed`;
  const lines = (result.commands ?? [])
    .map((c) => `  $ ${c.command} -> exit ${c.exitCode}`)
    .join("\n");
  return `SANDBOX TEST REPORT (job ${job.id})\n${result.summary ?? ""}\n${lines}`;
}

interface PrBodyMeta {
  patchSetId?: string;
  workerJobId?: string | null;
  patchApplied?: boolean;
  changedFiles?: string[];
}

/** PR body lists paths/actions only (never file content / secrets). */
function buildPrBody(
  session: SessionRecord,
  applied: { path: string; action: string }[],
  testReport?: string,
  meta: PrBodyMeta = {},
): string {
  const files = applied
    .map((f) => `- \`${f.action}\` ${f.path}`)
    .join("\n");
  const provenance: string[] = [];
  if (meta.patchSetId) provenance.push(`- patch_set_id: \`${meta.patchSetId}\``);
  if (meta.workerJobId) provenance.push(`- worker_job_id: \`${meta.workerJobId}\``);
  if (meta.patchApplied !== undefined)
    provenance.push(`- patch_applied: \`${meta.patchApplied}\``);
  if (meta.changedFiles && meta.changedFiles.length)
    provenance.push(`- changed_files: ${meta.changedFiles.length}`);
  return [
    `Automated patch from AI Orchestrator session \`${session.id}\`.`,
    "",
    `**Request:** ${session.user_request.slice(0, 300)}`,
    "",
    "**Files:**",
    files,
    ...(provenance.length
      ? ["", "**Sandbox provenance:**", ...provenance]
      : []),
    ...(testReport
      ? ["", "**Sandbox test report:**", "```", testReport.slice(0, 2000), "```"]
      : []),
    "",
    "> ⚠️ Generated by an automated pipeline. **Do not auto-merge** — a human must",
    "> review and merge this PR. No production deploy is performed.",
  ].join("\n");
}
