import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import type { AiOrchestratorRepository } from "../db/repository.interface";
import { driftHashFile } from "../patch/hash";
import { redactSecrets } from "../security/redact";
import { WorkerJobStream } from "../types";
import { isProductionEnv } from "./job-queue";

/** A structured apply error — code + file_path ONLY, never file content. */
export interface ApplyError {
  code: string;
  file_path?: string;
}

export interface ApplyPatchResult {
  patchApplied: boolean;
  changedFiles: string[];
  diffSummary: string;
  /** True when every modify/delete verified a matching old_content_hash. */
  baseHashChecked: boolean;
  errors: ApplyError[];
}

/** Patch-set statuses the worker is allowed to apply (validated preferred). */
const APPLYABLE_STATUSES = new Set(["validated", "applied", "draft"]);

/** Resolve strict hash mode: explicit 1/0, else true in production. */
export function resolvePatchHashStrict(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = env.AI_ORCHESTRATOR_PATCH_HASH_STRICT;
  if (raw === "1") return true;
  if (raw === "0") return false;
  return isProductionEnv(env);
}

/**
 * Independent path guard (defense in depth — the validator already blocks these
 * at validate time). Returns a reason string when the path is unsafe, else null.
 */
export function isUnsafePatchPath(rel: string): string | null {
  const p = (rel ?? "").trim();
  if (!p) return "empty path";
  if (isAbsolute(p) || /^[A-Za-z]:[/\\]/.test(p) || /^[/\\]/.test(p)) {
    return "absolute path";
  }
  if (p.includes("..")) return "path traversal (..)";
  if (p.includes("~")) return "home reference (~)";
  const posix = p.replace(/\\/g, "/");
  if (/(^|\/)\.git(\/|$)/.test(posix)) return ".git is forbidden";
  if (/(^|\/)node_modules(\/|$)/.test(posix)) return "node_modules is forbidden";
  const base = posix.split("/").pop() ?? posix;
  if (base === ".env" || base.startsWith(".env.")) return ".env files are forbidden";
  return null;
}

export interface ApplyOptions {
  appendLog?: (stream: WorkerJobStream, content: string) => Promise<void> | void;
  /** Best-effort `git diff --stat`; injectable for tests. */
  gitDiffStat?: (cwd: string) => Promise<string>;
  /** Strict base-hash mode: a missing old_content_hash on modify/delete fails. */
  strict?: boolean;
  /** Workspace-file drift hash; injectable for tests. */
  hashFile?: (path: string) => Promise<string>;
}

/**
 * Apply a patch_set's files into an isolated workspace BEFORE tests run, with a
 * BASE-DRIFT guard (Phase 7.1.1):
 *  - create: must not exist.
 *  - modify/delete: must exist; if old_content_hash is present it must match the
 *    current workspace file (else base_hash_mismatch); if it is missing and
 *    strict mode is on, that fails (missing_old_content_hash).
 *  - Writes the FULL redacted content (new_content_redacted). Never writes
 *    outside the workspace; blocks traversal/.git/node_modules/.env. Stops at the
 *    first error and runs no further. Never throws.
 */
export async function applyPatchSet(
  workspacePath: string,
  repo: AiOrchestratorRepository,
  patchSetId: string,
  opts: ApplyOptions = {},
): Promise<ApplyPatchResult> {
  const strict = opts.strict ?? false;
  const hashOf = opts.hashFile ?? driftHashFile;
  const log = async (stream: WorkerJobStream, content: string) => {
    if (opts.appendLog) await opts.appendLog(stream, redactSecrets(content));
  };
  const fail = (errors: ApplyError[], baseHashChecked = false): ApplyPatchResult => ({
    patchApplied: false,
    changedFiles: [],
    diffSummary: "",
    baseHashChecked,
    errors,
  });

  const patchSet = await repo.getPatchSet(patchSetId);
  if (!patchSet) return fail([{ code: "patch_set_not_found" }]);
  if (!APPLYABLE_STATUSES.has(patchSet.status)) {
    return fail([{ code: "patch_set_not_applyable" }]);
  }

  const files = await repo.getPatchFiles(patchSetId);
  if (files.length === 0) return fail([{ code: "patch_set_no_files" }]);

  const root = resolve(workspacePath);
  const changedFiles: string[] = [];
  const errors: ApplyError[] = [];
  let baseHashChecked = true;

  for (const file of files) {
    const fp = file.file_path;
    const unsafe = isUnsafePatchPath(fp);
    if (unsafe) {
      errors.push({ code: "path_unsafe", file_path: fp });
      break;
    }
    if (file.change_type === "rename") {
      errors.push({ code: "rename_not_supported", file_path: fp });
      break;
    }

    const target = resolve(root, fp);
    if (target !== root && !target.startsWith(root + sep)) {
      errors.push({ code: "escapes_workspace", file_path: fp });
      break;
    }

    try {
      if (file.change_type === "create") {
        if (existsSync(target)) {
          errors.push({ code: "create_existing_file", file_path: fp });
          break;
        }
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, file.new_content_redacted ?? "", "utf8");
        changedFiles.push(fp);
      } else if (file.change_type === "modify") {
        if (!existsSync(target)) {
          errors.push({ code: "modify_missing_file", file_path: fp });
          break;
        }
        const drift = await checkBaseHash(file.old_content_hash, target, hashOf, strict);
        if (drift) {
          errors.push({ code: drift, file_path: fp });
          break;
        }
        if (!file.old_content_hash) baseHashChecked = false;
        if (file.new_content_redacted === null) {
          errors.push({ code: "missing_new_content", file_path: fp });
          break;
        }
        writeFileSync(target, file.new_content_redacted, "utf8");
        changedFiles.push(fp);
      } else {
        // delete
        if (!existsSync(target)) {
          errors.push({ code: "delete_missing_file", file_path: fp });
          break;
        }
        const drift = await checkBaseHash(file.old_content_hash, target, hashOf, strict);
        if (drift) {
          errors.push({ code: drift, file_path: fp });
          break;
        }
        if (!file.old_content_hash) baseHashChecked = false;
        rmSync(target, { force: true });
        changedFiles.push(fp);
      }
    } catch {
      // Never include the raw error (it may echo file content) — code + path only.
      errors.push({ code: "io_error", file_path: fp });
      break;
    }
  }

  if (errors.length > 0) {
    const codes = errors.map((e) => `${e.code}${e.file_path ? ` ${e.file_path}` : ""}`);
    await log("system", `patch apply failed: ${codes.join("; ")}`);
    return { patchApplied: false, changedFiles, diffSummary: "", baseHashChecked, errors };
  }

  // Best-effort diff summary (never fatal; copy-mode workspaces have no .git).
  let diffSummary = "";
  try {
    const stat = opts.gitDiffStat
      ? await opts.gitDiffStat(root)
      : await defaultGitDiffStat(root);
    diffSummary = redactSecrets(stat).slice(0, 4000);
  } catch {
    diffSummary = "";
  }
  if (!diffSummary.trim()) {
    diffSummary = changedFiles.map((f) => ` M ${f}`).join("\n");
  }

  await log(
    "system",
    `patch applied: ${changedFiles.length} file(s), base_hash_checked=${baseHashChecked}`,
  );
  if (diffSummary) await log("stdout", diffSummary);
  return { patchApplied: true, changedFiles, diffSummary, baseHashChecked, errors: [] };
}

/**
 * Returns an error code when the base file drifted (or the hash is missing under
 * strict mode), else null. Compares old_content_hash to the current workspace
 * file via the normalized drift hash.
 */
async function checkBaseHash(
  oldHash: string | null,
  target: string,
  hashOf: (path: string) => Promise<string>,
  strict: boolean,
): Promise<string | null> {
  if (oldHash) {
    const current = await hashOf(target);
    if (current !== oldHash) return "base_hash_mismatch";
    return null;
  }
  if (strict) return "missing_old_content_hash";
  return null; // non-strict: allow, but caller marks base_hash_checked=false
}

/** `git add -A && git diff --cached --stat` (captures creates). Best effort. */
function defaultGitDiffStat(cwd: string): Promise<string> {
  return new Promise((resolveP) => {
    const add = spawn("git", ["-C", cwd, "add", "-A"], {
      shell: false,
      windowsHide: true,
    });
    add.on("error", () => resolveP(""));
    add.on("close", () => {
      const diff = spawn("git", ["-C", cwd, "diff", "--cached", "--stat"], {
        shell: false,
        windowsHide: true,
      });
      let out = "";
      diff.stdout?.on("data", (c) => {
        out += c.toString();
      });
      diff.on("error", () => resolveP(""));
      diff.on("close", () => resolveP(out));
    });
  });
}
