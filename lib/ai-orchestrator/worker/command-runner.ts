import { spawn } from "node:child_process";
import { redactSecrets } from "../security/redact";
import { WORKER_COMMAND_ALLOWLIST } from "./types";

/** Per-command hard timeout (ms). */
const COMMAND_TIMEOUTS: Record<string, number> = {
  "npm ci": 180_000,
  "npm run typecheck": 120_000,
  "npm test": 180_000,
  "npm run build": 180_000,
  "git diff": 30_000,
};

/** Max captured bytes per stream before truncation. */
export const OUTPUT_LIMIT_BYTES = 200 * 1024;

/** Secret env names that must NEVER reach a child process. */
export const FORBIDDEN_CHILD_ENV: readonly string[] = [
  "SUPABASE_SERVICE_ROLE_KEY",
  "DATABASE_URL",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GITHUB_TOKEN",
  "GITHUB_READ_TOKEN",
  "AI_ORCHESTRATOR_ADMIN_KEY",
  "AI_ORCHESTRATOR_API_KEY_PEPPER",
];

export interface CommandCheck {
  allowed: boolean;
  reason: string;
}

/** Validate a command against the worker allowlist + injection guard. */
export function validateWorkerCommand(raw: string): CommandCheck {
  // Reject any shell-control / chaining characters in the RAW string.
  if (/[;&|`$><\n\r]|\$\(|&&|\|\|/.test(raw)) {
    return {
      allowed: false,
      reason: "command contains shell control characters",
    };
  }
  const cmd = raw.trim().replace(/\s+/g, " ");
  if (!(WORKER_COMMAND_ALLOWLIST as readonly string[]).includes(cmd)) {
    return {
      allowed: false,
      reason: `"${cmd}" is not on the worker allowlist`,
    };
  }
  return { allowed: true, reason: "ok" };
}

export function commandTimeoutMs(command: string): number {
  return COMMAND_TIMEOUTS[command.trim()] ?? 120_000;
}

/**
 * Build the child env from scratch — only safe, execution-essential variables.
 * No secret is ever copied; process.env is NOT spread in.
 */
export function buildSandboxEnv(
  base: Record<string, string | undefined> = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "test",
    CI: "1",
    NEXT_TELEMETRY_DISABLED: "1",
    npm_config_loglevel: "warn",
  };
  // Only the minimal system vars needed to locate + launch node/npm/git.
  const passthrough =
    process.platform === "win32"
      ? [
          "PATH",
          "Path",
          "SystemRoot",
          "ComSpec",
          "PATHEXT",
          "TEMP",
          "TMP",
          "windir",
          "NUMBER_OF_PROCESSORS",
          "APPDATA",
          "LOCALAPPDATA",
          "USERPROFILE",
        ]
      : ["PATH", "HOME", "TMPDIR", "LANG"];
  for (const k of passthrough) {
    if (base[k]) env[k] = base[k];
  }
  // Defense in depth: never leak a forbidden secret even via a name collision.
  for (const k of FORBIDDEN_CHILD_ENV) delete env[k];
  return env;
}

/** Split an allowlisted command into an executable + args (no shell). */
export function resolveExecutable(command: string): {
  file: string;
  args: string[];
} {
  const parts = command.trim().split(/\s+/);
  let file = parts[0];
  const args = parts.slice(1);
  if (process.platform === "win32") {
    if (file === "npm") file = "npm.cmd";
    else if (file === "npx") file = "npx.cmd";
  }
  return { file, args };
}

export interface CommandRunResult {
  command: string;
  allowed: boolean;
  reason?: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
  /** True when the command was killed by an AbortSignal (cancel / lease loss). */
  aborted?: boolean;
}

/** Minimal child shape the runner needs (real ChildProcess satisfies this). */
export interface SpawnedChild {
  stdout: { on(ev: "data", cb: (chunk: Buffer | string) => void): void } | null;
  stderr: { on(ev: "data", cb: (chunk: Buffer | string) => void): void } | null;
  on(ev: "close", cb: (code: number | null) => void): void;
  on(ev: "error", cb: (err: Error) => void): void;
  kill(signal?: NodeJS.Signals): void;
  /** Real ChildProcess pid; used for process-group kill on Linux/Docker. */
  pid?: number;
}

export type SpawnFn = (
  file: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv },
) => SpawnedChild;

const defaultSpawn: SpawnFn = (file, args, opts) =>
  spawn(file, args, {
    cwd: opts.cwd,
    env: opts.env,
    // NEVER shell:true — args are passed as an array.
    shell: false,
    windowsHide: true,
    // On Linux/Docker run in its own process group so a kill takes the whole
    // tree (npm spawns child processes). Windows uses a plain child.kill().
    detached: process.platform !== "win32",
  }) as unknown as SpawnedChild;

/** Kill a child + its process group (Linux/Docker), falling back to child.kill. */
function killChild(child: SpawnedChild, signal: NodeJS.Signals = "SIGTERM"): void {
  if (process.platform !== "win32" && typeof child.pid === "number" && child.pid > 0) {
    try {
      // Negative pid targets the child's process group (it is the leader because
      // we spawned it detached) — never our own group.
      process.kill(-child.pid, signal);
      return;
    } catch {
      /* fall through to child.kill */
    }
  }
  try {
    child.kill(signal);
  } catch {
    /* already dead */
  }
}

export interface RunCommandOptions {
  cwd: string;
  /** Base env to derive the (filtered) child env from. */
  env?: NodeJS.ProcessEnv;
  /** Injectable for tests; defaults to node:child_process spawn. */
  spawnImpl?: SpawnFn;
  /** Override timeout (ms) — tests use a tiny value. */
  timeoutMs?: number;
  /** Abort the command (cancel / lease loss) — kills the child process tree. */
  signal?: AbortSignal;
}

/**
 * Run a single allowlisted command in a child process. No shell, args array,
 * per-command timeout, 200KB/stream output cap, and redacted output. Returns a
 * structured result (never throws on a non-zero exit).
 */
export function runWorkerCommand(
  command: string,
  opts: RunCommandOptions,
): Promise<CommandRunResult> {
  const check = validateWorkerCommand(command);
  if (!check.allowed) {
    return Promise.resolve({
      command,
      allowed: false,
      reason: check.reason,
      exitCode: null,
      stdout: "",
      stderr: `BLOCKED: ${check.reason}`,
      timedOut: false,
      truncated: false,
      durationMs: 0,
    });
  }

  const { file, args } = resolveExecutable(command);
  const timeoutMs = opts.timeoutMs ?? commandTimeoutMs(command);
  const env = buildSandboxEnv(opts.env);
  const spawnFn = opts.spawnImpl ?? defaultSpawn;
  const start = Date.now();

  // Already aborted before we even start — don't spawn.
  if (opts.signal?.aborted) {
    return Promise.resolve({
      command,
      allowed: true,
      exitCode: null,
      stdout: "",
      stderr: "[ABORTED] command not started",
      timedOut: false,
      truncated: false,
      durationMs: 0,
      aborted: true,
    });
  }

  return new Promise<CommandRunResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let outTrunc = false;
    let errTrunc = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const append = (current: string, chunk: Buffer | string): [string, boolean] => {
      if (current.length >= OUTPUT_LIMIT_BYTES) return [current, true];
      let next = current + chunk.toString();
      if (next.length >= OUTPUT_LIMIT_BYTES) {
        next = next.slice(0, OUTPUT_LIMIT_BYTES) + "\n[TRUNCATED]";
        return [next, true];
      }
      return [next, false];
    };

    let child: SpawnedChild;
    try {
      child = spawnFn(file, args, { cwd: opts.cwd, env });
    } catch (err) {
      resolve({
        command,
        allowed: true,
        exitCode: null,
        stdout: "",
        stderr: redactSecrets(`[spawn error] ${(err as Error).message}`),
        timedOut: false,
        truncated: false,
        durationMs: Date.now() - start,
      });
      return;
    }

    child.stdout?.on("data", (c) => {
      [stdout, outTrunc] = append(stdout, c);
    });
    child.stderr?.on("data", (c) => {
      [stderr, errTrunc] = append(stderr, c);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      killChild(child);
    }, timeoutMs);

    const onAbort = () => {
      aborted = true;
      killChild(child);
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      const suffix = timedOut
        ? `\n[TIMEOUT] exceeded ${timeoutMs}ms`
        : aborted
          ? `\n[ABORTED] command killed`
          : "";
      resolve({
        command,
        allowed: true,
        exitCode: timedOut || aborted ? null : code,
        stdout: redactSecrets(stdout),
        stderr: redactSecrets(stderr + suffix),
        timedOut,
        truncated: outTrunc || errTrunc,
        durationMs: Date.now() - start,
        aborted,
      });
    };

    child.on("error", (err) => {
      stderr += `\n[spawn error] ${err.message}`;
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });
}
