import { isCommandAllowed, scanContent } from "../safety";
import { redactSecrets } from "../security/redact";
import { PatchArtifact, PatchFileSpec } from "./patch-schema";

/**
 * Semantic safety validation for a (already structurally-parsed) patch artifact.
 *
 * The PR flow is intentionally STRICTER than the in-session orchestrator guard:
 * a patch destined for a real GitHub branch must not touch secrets, escape the
 * repo, modify lockfiles/CI deploy workflows, run unknown commands, or carry
 * destructive migrations. Deletes additionally require an elevated role.
 */

export interface ValidatePatchOptions {
  /** True when the caller is owner/admin (required to delete files). */
  canDelete?: boolean;
  /** Explicit human approval to modify package-lock.json. */
  packageLockApproved?: boolean;
}

export interface PatchFileFinding {
  path: string;
  action: PatchFileSpec["action"];
  errors: string[];
}

export interface PatchValidationResult {
  ok: boolean;
  errors: string[];
  fileFindings: PatchFileFinding[];
}

/** Forbidden command flag, also re-exported for tests. */
export const PATCH_COMMAND_ALLOWLIST = [
  "npm run typecheck",
  "npm test",
  "npm run build",
  "git diff",
] as const;

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

function isAbsolutePath(p: string): boolean {
  // POSIX root, UNC/backslash root, or Windows drive (C:\ or C:/).
  return /^([/\\])/.test(p) || /^[A-Za-z]:[/\\]/.test(p);
}

/** True when file content (or a reason string) embeds a secret/token. */
export function contentContainsSecret(text: string): boolean {
  if (!text) return false;
  // If redaction changes anything, a structural secret/token/env value matched
  // (sk-..., ghp_/github_pat_..., bearer, x-api-key, known env values).
  if (redactSecrets(text) !== text) return true;
  // A few extra hardcoded-credential shapes redaction does not target.
  const extra: RegExp[] = [
    /-----BEGIN[ A-Z]*PRIVATE KEY-----/,
    /\b(?:API[_-]?KEY|SECRET|ACCESS[_-]?TOKEN|PASSWORD)\b\s*[:=]\s*['"][^'"\n]{8,}['"]/i,
    /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  ];
  return extra.some((re) => re.test(text));
}

/** Does a workflow file attempt a production deploy? */
function isWorkflowProdDeploy(posixPath: string, content: string): boolean {
  const inWorkflows = /(^|\/)\.github\/workflows\//.test(posixPath);
  if (!inWorkflows) return false;
  return /\b(deploy|--prod|environment:\s*production|vercel\s+deploy|netlify\s+deploy|kubectl\s+apply|terraform\s+apply)\b/i.test(
    content,
  );
}

function validateFile(
  file: PatchFileSpec,
  opts: ValidatePatchOptions,
): string[] {
  const errors: string[] = [];
  const rawPath = file.path.trim();
  const posix = toPosix(rawPath);
  const content = file.content ?? "";

  // 1. Absolute paths.
  if (isAbsolutePath(rawPath)) {
    errors.push(`absolute path not allowed: ${rawPath}`);
  }
  // 2. Parent-directory traversal.
  if (rawPath.includes("..")) {
    errors.push(`path traversal ('..') not allowed: ${rawPath}`);
  }
  // 3. Home-directory expansion.
  if (rawPath.includes("~")) {
    errors.push(`home-directory ('~') reference not allowed: ${rawPath}`);
  }
  // 4. .git internals.
  if (/(^|\/)\.git(\/|$)/.test(posix)) {
    errors.push(`writing inside .git/ is forbidden: ${rawPath}`);
  }
  // 5. node_modules.
  if (/(^|\/)node_modules(\/|$)/.test(posix)) {
    errors.push(`writing inside node_modules/ is forbidden: ${rawPath}`);
  }
  // 6. .env files (.env, .env.local, .env.production, ...).
  const base = posix.split("/").pop() ?? posix;
  if (base === ".env" || base.startsWith(".env.")) {
    errors.push(`modifying env files is forbidden: ${rawPath}`);
  }
  // 7. package-lock.json without explicit approval.
  if (base === "package-lock.json" && !opts.packageLockApproved) {
    errors.push(
      `package-lock.json requires explicit approval (packageLockApproved): ${rawPath}`,
    );
  }
  // 9. CI workflow that deploys to production.
  if (isWorkflowProdDeploy(posix, content)) {
    errors.push(`CI workflow production deploy is forbidden: ${rawPath}`);
  }
  // 11. Deletes require an elevated role.
  if (file.action === "delete" && !opts.canDelete) {
    errors.push(
      `delete requires owner/admin role: ${rawPath}`,
    );
  }
  // create/modify must carry content.
  if (
    (file.action === "create" || file.action === "modify") &&
    content.trim().length === 0
  ) {
    errors.push(`${file.action} requires non-empty content: ${rawPath}`);
  }
  // 8. Destructive migration anywhere in the content.
  const migrationViolations = scanContent(content, {
    humanApproved: false,
  }).filter((v) => v.category === "destructive_migration");
  if (migrationViolations.length > 0) {
    errors.push(`destructive migration is forbidden: ${rawPath}`);
  }
  // 10. Secrets / tokens in content or reason.
  if (contentContainsSecret(content) || contentContainsSecret(file.reason ?? "")) {
    errors.push(`secret/token detected in patch content: ${rawPath}`);
  }

  return errors;
}

export function validatePatch(
  patch: PatchArtifact,
  opts: ValidatePatchOptions = {},
): PatchValidationResult {
  const errors: string[] = [];
  const fileFindings: PatchFileFinding[] = [];

  for (const file of patch.files) {
    const fileErrors = validateFile(file, opts);
    if (fileErrors.length > 0) errors.push(...fileErrors);
    fileFindings.push({
      path: file.path,
      action: file.action,
      errors: fileErrors,
    });
  }

  // 12. Every command must be on the allowlist.
  for (const cmd of patch.commands_to_run) {
    const check = isCommandAllowed(cmd);
    if (!check.allowed) {
      errors.push(`command not allowed: "${cmd}" (${check.reason})`);
    }
  }

  return { ok: errors.length === 0, errors, fileFindings };
}
