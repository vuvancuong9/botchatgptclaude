import { spawnSync } from "node:child_process";
import { isCommandAllowed } from "./safety";
import { redactSecrets } from "./security/redact";

/** Hard ceiling per command (ms). Each command may run at most 120 seconds. */
export const MAX_COMMAND_TIMEOUT_MS = 120_000;

export interface CommandResult {
  command: string;
  allowed: boolean;
  reason: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  executed: boolean;
}

/** The fixed suite the TEST_RUNNER step runs, in order. */
export const TEST_SUITE: readonly string[] = [
  "npm run typecheck",
  "npm test",
  "npm run build",
];

export interface RunOptions {
  /** When false (default) commands are validated but not actually spawned. */
  execute?: boolean;
  cwd?: string;
  timeoutMs?: number;
}

/**
 * Validate a command against the allowlist and (optionally) execute it.
 * Execution is OFF by default: the guard always runs, the spawn does not,
 * which keeps API/CI runs from triggering nested builds. Set execute:true
 * (or AI_ORCHESTRATOR_EXECUTE_TESTS=1) to actually run.
 */
export function runCommand(
  command: string,
  opts: RunOptions = {},
): CommandResult {
  const check = isCommandAllowed(command);
  const execute =
    opts.execute ?? process.env.AI_ORCHESTRATOR_EXECUTE_TESTS === "1";

  if (!check.allowed) {
    return {
      command,
      allowed: false,
      reason: check.reason,
      exitCode: null,
      stdout: "",
      stderr: `BLOCKED: ${check.reason}`,
      executed: false,
    };
  }

  if (!execute) {
    return {
      command,
      allowed: true,
      reason: check.reason,
      exitCode: 0,
      stdout: `[dry-run] '${command}' is allowlisted but execution is disabled.`,
      stderr: "",
      executed: false,
    };
  }

  // Clamp the timeout to the 120s hard ceiling regardless of caller input.
  const timeout = Math.min(
    opts.timeoutMs ?? MAX_COMMAND_TIMEOUT_MS,
    MAX_COMMAND_TIMEOUT_MS,
  );
  const parts = command.split(" ");
  const result = spawnSync(parts[0], parts.slice(1), {
    cwd: opts.cwd ?? process.cwd(),
    encoding: "utf8",
    timeout,
    shell: process.platform === "win32",
    maxBuffer: 10 * 1024 * 1024,
  });

  const timedOut =
    (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" ||
    result.signal === "SIGTERM";

  return {
    command,
    allowed: true,
    reason: check.reason,
    exitCode: result.status,
    // Redact secrets at capture time (the repository redacts again on persist).
    stdout: redactSecrets(result.stdout ?? ""),
    stderr: redactSecrets(
      (result.stderr ?? "") +
        (timedOut ? `\n[TIMEOUT] command exceeded ${timeout}ms` : ""),
    ),
    executed: true,
  };
}

export interface TestReport {
  results: CommandResult[];
  passed: boolean;
}

/**
 * Phase 7.2: the orchestrator's TEST_RUNNER step delegates to a TestExecutor so
 * the same workflow can run tests INLINE (dev/test) or via the sandbox WORKER
 * (production — no command ever spawns inside a Next.js request).
 */
export interface TestStepResult {
  report: TestReport;
  mode: "inline" | "worker";
  /** Set when the run was executed by a sandbox worker job. */
  workerJobId?: string | null;
}

export interface TestExecutor {
  run(ctx: { sessionId: string; round: number }): Promise<TestStepResult>;
}

export function runTestSuite(opts: RunOptions = {}): TestReport {
  const results: CommandResult[] = [];
  for (const cmd of TEST_SUITE) {
    const r = runCommand(cmd, opts);
    results.push(r);
    if (r.allowed && r.executed && r.exitCode !== 0) break; // stop at first failure
  }
  const passed = results.every((r) => r.allowed && (r.exitCode ?? 1) === 0);
  return { results, passed };
}

export function formatTestReport(report: TestReport): string {
  const lines = report.results.map((r) => {
    const status = !r.allowed
      ? "BLOCKED"
      : !r.executed
        ? "DRY-RUN(ok)"
        : r.exitCode === 0
          ? "PASS"
          : `FAIL(${r.exitCode})`;
    return `$ ${r.command}\n  -> ${status}${r.stderr ? `\n  stderr: ${r.stderr.slice(0, 400)}` : ""}`;
  });
  return `TEST REPORT (overall: ${report.passed ? "PASS" : "FAIL"})\n${lines.join("\n")}`;
}
