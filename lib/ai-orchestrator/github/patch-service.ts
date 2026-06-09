import { createHash } from "node:crypto";
import type { AiOrchestratorRepository } from "../db/repository.interface";
import { redactSecrets } from "../security/redact";
import { PatchSetRecord, SessionRecord } from "../types";
import { GithubApiError } from "./github-client";
import { GithubClient } from "./types";
import {
  PatchArtifact,
  PatchParseError,
  parsePatchArtifact,
} from "../patch/patch-schema";
import {
  PatchValidationResult,
  validatePatch,
  ValidatePatchOptions,
} from "../patch/patch-validator";

/** Deterministic content hash (sha256 hex). Not a secret — safe to store/audit. */
export function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

const HUNK_LIMIT = 4000;
const REASON_LIMIT = 500;
const PATCH_TEXT_LIMIT = 200_000;

export interface ValidateAndStoreParams {
  repo: AiOrchestratorRepository;
  session: SessionRecord;
  userId: string | null;
  /** Raw latest patch artifact text from the implementer. */
  artifactText: string;
  baseBranch: string;
  targetBranch: string;
  /** owner/admin may delete files. */
  canDelete: boolean;
  packageLockApproved?: boolean;
  /**
   * Phase 7.1.1: returns the base-drift hash of a file on the base branch (or
   * null if unavailable). Used to capture old_content_hash for modify/delete so
   * the worker can detect base drift. Optional — null hashes fall back to the
   * worker's strict-mode policy.
   */
  baseFileHasher?: (path: string) => Promise<string | null>;
}

export interface ValidateAndStoreResult {
  patchSet: PatchSetRecord;
  validation: PatchValidationResult | null;
  /** Parsed artifact when structurally valid (null on parse failure). */
  patch: PatchArtifact | null;
  ok: boolean;
  errors: string[];
}

/**
 * Validate a patch artifact and persist a patch_set (+ patch_files). The patch
 * text is redacted before storage; per-file hunks/reasons are redacted too.
 * Never throws on validation failure — it records a `failed` patch_set instead.
 */
export async function validateAndStorePatch(
  params: ValidateAndStoreParams,
): Promise<ValidateAndStoreResult> {
  const {
    repo,
    session,
    userId,
    artifactText,
    baseBranch,
    targetBranch,
  } = params;

  let patch: PatchArtifact | null = null;
  let validation: PatchValidationResult | null = null;
  let errors: string[] = [];

  try {
    patch = parsePatchArtifact(artifactText);
  } catch (err) {
    errors = [
      err instanceof PatchParseError
        ? err.message
        : `parse error: ${(err as Error).message}`,
    ];
  }

  if (patch) {
    const opts: ValidatePatchOptions = {
      canDelete: params.canDelete,
      packageLockApproved: params.packageLockApproved,
    };
    validation = validatePatch(patch, opts);
    errors = validation.errors;
  }

  const ok = Boolean(patch) && (validation?.ok ?? false);

  const patchSet = await repo.createPatchSet({
    sessionId: session.id,
    userId,
    status: ok ? "validated" : "failed",
    baseBranch,
    targetBranch,
    baseSha: null,
    patchSummary: patch
      ? `${patch.files.length} file(s); ${patch.commands_to_run.length} command(s)`
      : "unparseable patch artifact",
    patchText: redactSecrets(artifactText).slice(0, PATCH_TEXT_LIMIT),
    validationErrors: ok ? null : errors,
  });

  if (patch) {
    for (const file of patch.files) {
      const content = file.content ?? "";
      // Phase 7.1.1: capture the base hash for modify/delete (drift detection).
      const oldContentHash =
        file.action === "create" || !params.baseFileHasher
          ? null
          : await params.baseFileHasher(file.path).catch(() => null);
      await repo.addPatchFile({
        patchSetId: patchSet.id,
        filePath: file.path,
        changeType: file.action,
        oldContentHash,
        newContentHash:
          file.action === "delete" || content.length === 0
            ? null
            : hashContent(content),
        patchHunk: redactSecrets(content).slice(0, HUNK_LIMIT),
        reason: file.reason ? redactSecrets(file.reason).slice(0, REASON_LIMIT) : null,
        // Phase 7.1: full redacted content for the worker to apply. A validated
        // patch has no secrets (the validator rejects them), so redaction is a
        // no-op here; a secret-bearing patch never reaches a worker apply.
        newContentRedacted:
          file.action === "delete" ? null : redactSecrets(content),
      });
    }
  }

  return { patchSet, validation, patch, ok, errors };
}

export interface AppliedFile {
  path: string;
  action: "create" | "modify" | "delete";
  oldContentHash: string | null;
  newContentHash: string | null;
}

export interface ApplyPatchParams {
  client: GithubClient;
  /** The freshly-created AI branch (never the base). */
  branch: string;
  /** The base branch to read current file state from. */
  baseBranch: string;
  patch: PatchArtifact;
  /** Commit message prefix, e.g. the session id. */
  messagePrefix: string;
}

/**
 * Apply patch files to an existing AI branch via the GitHub API.
 *
 * Pre-write invariants (per file):
 *   - create  → must NOT already exist.
 *   - modify  → must exist (and we pass its current SHA → no blind overwrite).
 *   - delete  → must exist.
 * GitHub's contents API rejects a stale SHA, so a concurrent change → failure
 * rather than a silent overwrite.
 */
export async function applyPatchFiles(
  params: ApplyPatchParams,
): Promise<AppliedFile[]> {
  const { client, branch, baseBranch, patch, messagePrefix } = params;
  const applied: AppliedFile[] = [];

  for (const file of patch.files) {
    const existing = await client.getFile(file.path, baseBranch);
    const message = `${messagePrefix}: ${file.action} ${file.path}`;

    if (file.action === "create") {
      if (existing) {
        throw new GithubApiError(
          `create failed: file already exists: ${file.path}`,
          409,
        );
      }
      const content = file.content ?? "";
      await client.putFile({ path: file.path, content, message, branch });
      applied.push({
        path: file.path,
        action: "create",
        oldContentHash: null,
        newContentHash: hashContent(content),
      });
    } else if (file.action === "modify") {
      if (!existing) {
        throw new GithubApiError(
          `modify failed: file does not exist: ${file.path}`,
          409,
        );
      }
      const content = file.content ?? "";
      await client.putFile({
        path: file.path,
        content,
        message,
        branch,
        sha: existing.sha,
      });
      applied.push({
        path: file.path,
        action: "modify",
        oldContentHash: hashContent(existing.content),
        newContentHash: hashContent(content),
      });
    } else {
      // delete
      if (!existing) {
        throw new GithubApiError(
          `delete failed: file does not exist: ${file.path}`,
          409,
        );
      }
      await client.deleteFile({
        path: file.path,
        message,
        branch,
        sha: existing.sha,
      });
      applied.push({
        path: file.path,
        action: "delete",
        oldContentHash: hashContent(existing.content),
        newContentHash: null,
      });
    }
  }

  return applied;
}
