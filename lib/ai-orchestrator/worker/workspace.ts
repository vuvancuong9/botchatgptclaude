import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { buildSandboxEnv } from "./command-runner";
import { RepoRef } from "./types";

/** Root for isolated job workspaces (never the production cwd directly). */
export function workspaceRoot(base: string = process.cwd()): string {
  return join(base, ".ai-orchestrator", "workspaces");
}

export function workspacePath(jobId: string, base?: string): string {
  return join(workspaceRoot(base), jobId);
}

export function keepWorkspace(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.AI_ORCHESTRATOR_WORKER_KEEP_WORKSPACE === "1";
}

/** Names never copied into a workspace (secrets + heavy/irrelevant dirs). */
const EXCLUDED = new Set([
  "node_modules",
  ".next",
  ".git",
  ".ai-orchestrator",
  ".data",
]);

function isExcluded(srcPath: string): boolean {
  const name = basename(srcPath);
  if (EXCLUDED.has(name)) return true;
  // Never copy any .env / .env.* file into the sandbox.
  if (name === ".env" || name.startsWith(".env.")) return true;
  return false;
}

export interface PrepareResult {
  dir: string;
  /** "clone" (real git) or "copy" (local current-repo fallback). */
  mode: "clone" | "copy";
}

export interface PrepareOptions {
  env?: Record<string, string | undefined>;
  /** Source dir for the local copy fallback (defaults to cwd). */
  localSourceDir?: string;
}

/**
 * Prepare an isolated workspace for a job.
 *  - With a clone URL → shallow `git clone --branch <branch>` (token, if any,
 *    is embedded in the URL only, never logged).
 *  - Without a clone URL → local/test fallback that copies the current repo
 *    MINUS node_modules/.git/.env*. Production REQUIRES a clone URL.
 */
export async function prepareWorkspace(
  jobId: string,
  repo: RepoRef,
  opts: PrepareOptions = {},
): Promise<PrepareResult> {
  const env = opts.env ?? process.env;
  const dir = workspacePath(jobId);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const cloneUrl =
    repo.clone_url && repo.clone_url !== "local"
      ? repo.clone_url
      : env.AI_ORCHESTRATOR_REPO_CLONE_URL?.trim();

  if (!cloneUrl) {
    if (env.NODE_ENV === "production") {
      throw new Error(
        "AI_ORCHESTRATOR_REPO_CLONE_URL is required in production (no local copy fallback).",
      );
    }
    const src = resolve(opts.localSourceDir ?? process.cwd());
    cpSync(src, dir, {
      recursive: true,
      filter: (s) => !isExcluded(s),
    });
    return { dir, mode: "copy" };
  }

  await gitClone(cloneUrl, repo.branch, dir, env);
  if (repo.commit_sha) {
    await runGit(["-C", dir, "checkout", "--quiet", repo.commit_sha], env);
  }
  return { dir, mode: "clone" };
}

/** Remove a workspace unless the operator asked to keep it for debugging. */
export function cleanupWorkspace(dir: string, keep = keepWorkspace()): void {
  if (keep) return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

/**
 * Embed a read token (if configured) into the clone URL. Returns the authed URL
 * — callers must NEVER log it. The token is used only as a spawn arg.
 */
function authedCloneUrl(
  cloneUrl: string,
  env: Record<string, string | undefined>,
): string {
  const token = env.GITHUB_READ_TOKEN?.trim();
  if (!token) return cloneUrl;
  if (!cloneUrl.startsWith("https://")) return cloneUrl;
  if (cloneUrl.includes("@")) return cloneUrl; // already has credentials
  return cloneUrl.replace(
    "https://",
    `https://x-access-token:${token}@`,
  );
}

function gitClone(
  cloneUrl: string,
  branch: string,
  dir: string,
  env: Record<string, string | undefined>,
): Promise<void> {
  const url = authedCloneUrl(cloneUrl, env);
  return runGit(
    ["clone", "--depth", "1", "--single-branch", "--branch", branch, url, dir],
    env,
  );
}

/** Run a git command (no shell). Token-bearing args are never logged. */
function runGit(
  args: string[],
  env: Record<string, string | undefined>,
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", args, {
      // Clean env (no secrets); buildSandboxEnv supplies PATH/HOME + NODE_ENV.
      env: buildSandboxEnv(env),
      shell: false,
      windowsHide: true,
    });
    let stderr = "";
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString();
    });
    child.on("error", (err: Error) =>
      reject(new Error(`git failed: ${err.message}`)),
    );
    child.on("close", (code: number | null) => {
      if (code === 0) resolvePromise();
      // Redact any accidental credential leakage in git's error output.
      else reject(new Error(`git exited ${code}: ${redactGit(stderr)}`));
    });
  });
}

/** Strip basic-auth credentials from any URL git might echo back. */
function redactGit(text: string): string {
  return text.replace(/https:\/\/[^@\s/]+@/g, "https://***@");
}
