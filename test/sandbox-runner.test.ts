import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSandboxEnv,
  commandTimeoutMs,
  FORBIDDEN_CHILD_ENV,
  runWorkerCommand,
  SpawnedChild,
  validateWorkerCommand,
} from "../lib/ai-orchestrator/worker/command-runner";
import { runSandboxJob } from "../lib/ai-orchestrator/worker/sandbox-runner";
import { CommandRunResult } from "../lib/ai-orchestrator/worker/command-runner";

/** Configurable fake child process. */
class FakeChild implements SpawnedChild {
  private outCbs: ((c: Buffer | string) => void)[] = [];
  private errCbs: ((c: Buffer | string) => void)[] = [];
  private closeCb: ((code: number | null) => void) | null = null;
  killed = false;
  stdout = {
    on: (_ev: "data", cb: (c: Buffer | string) => void) => this.outCbs.push(cb),
  };
  stderr = {
    on: (_ev: "data", cb: (c: Buffer | string) => void) => this.errCbs.push(cb),
  };
  on(ev: "close" | "error", cb: (arg: never) => void): void {
    if (ev === "close") this.closeCb = cb as (code: number | null) => void;
  }
  kill(): void {
    this.killed = true;
    this.closeCb?.(null);
  }
  emitOut(s: string) {
    this.outCbs.forEach((cb) => cb(Buffer.from(s)));
  }
  emitErr(s: string) {
    this.errCbs.forEach((cb) => cb(Buffer.from(s)));
  }
  close(code: number | null) {
    this.closeCb?.(code);
  }
}

function spawnWith(behavior: (child: FakeChild) => void) {
  return () => {
    const child = new FakeChild();
    setImmediate(() => behavior(child));
    return child;
  };
}

test("allowlist accepts the permitted commands, rejects others", () => {
  for (const c of ["npm ci", "npm run typecheck", "npm test", "npm run build", "git diff"]) {
    assert.equal(validateWorkerCommand(c).allowed, true, c);
  }
  assert.equal(validateWorkerCommand("rm -rf /").allowed, false);
  assert.equal(validateWorkerCommand("npm run deploy").allowed, false);
});

test("command injection is blocked", () => {
  for (const c of [
    "npm test && rm -rf /",
    "npm test; echo hi",
    "npm test | cat",
    "npm run build > out",
    "git diff `whoami`",
    "npm test $(id)",
  ]) {
    assert.equal(validateWorkerCommand(c).allowed, false, c);
  }
});

test("per-command timeouts are defined", () => {
  assert.equal(commandTimeoutMs("npm ci"), 180_000);
  assert.equal(commandTimeoutMs("npm run typecheck"), 120_000);
  assert.equal(commandTimeoutMs("git diff"), 30_000);
});

test("child env excludes all secrets (e.g. SUPABASE_SERVICE_ROLE_KEY)", () => {
  const env = buildSandboxEnv({
    SUPABASE_SERVICE_ROLE_KEY: "super-secret",
    OPENAI_API_KEY: "sk-openai",
    GITHUB_TOKEN: "ghp_xxx",
    PATH: "/usr/bin",
  });
  assert.equal(env.NODE_ENV, "test");
  assert.equal(env.CI, "1");
  for (const name of FORBIDDEN_CHILD_ENV) {
    assert.equal(env[name], undefined, name);
  }
  assert.equal(env.SUPABASE_SERVICE_ROLE_KEY, undefined);
});

test("a non-allowlisted command is not spawned", async () => {
  let spawned = false;
  const res = await runWorkerCommand("rm -rf /", {
    cwd: ".",
    spawnImpl: spawnWith(() => {
      spawned = true;
    }),
  });
  assert.equal(res.allowed, false);
  assert.equal(res.exitCode, null);
  assert.equal(spawned, false);
});

test("a passing command returns exit 0 with redacted output", async () => {
  const res = await runWorkerCommand("npm test", {
    cwd: ".",
    spawnImpl: spawnWith((child) => {
      child.emitOut("all good, key sk-ABCD1234efgh5678ijkl here");
      child.close(0);
    }),
  });
  assert.equal(res.exitCode, 0);
  assert.equal(res.timedOut, false);
  assert.equal(res.stdout.includes("sk-ABCD1234efgh5678ijkl"), false);
});

test("output beyond the limit is truncated", async () => {
  const huge = "x".repeat(250 * 1024);
  const res = await runWorkerCommand("npm run build", {
    cwd: ".",
    spawnImpl: spawnWith((child) => {
      child.emitOut(huge);
      child.close(0);
    }),
  });
  assert.equal(res.truncated, true);
  assert.ok(res.stdout.endsWith("[TRUNCATED]"));
});

test("a command that never closes hits the timeout and is killed", async () => {
  const res = await runWorkerCommand("npm test", {
    cwd: ".",
    timeoutMs: 20,
    spawnImpl: spawnWith(() => {
      /* never closes — let the timeout fire */
    }),
  });
  assert.equal(res.timedOut, true);
  assert.equal(res.exitCode, null);
  assert.ok(res.stderr.includes("[TIMEOUT]"));
});

test("runSandboxJob runs commands and reports passed", async () => {
  const okRun = async (command: string): Promise<CommandRunResult> => ({
    command,
    allowed: true,
    exitCode: 0,
    stdout: "ok",
    stderr: "",
    timedOut: false,
    truncated: false,
    durationMs: 1,
  });
  let cleaned = false;
  const out = await runSandboxJob(
    {
      jobId: "job1",
      repo: { clone_url: "local", branch: "main" },
      commands: ["npm ci", "npm test"],
    },
    {
      prepare: async () => ({ dir: "/tmp/ws", mode: "copy" }),
      cleanup: () => {
        cleaned = true;
      },
      runCommand: okRun,
    },
  );
  assert.equal(out.status, "passed");
  assert.equal(out.result.commands.length, 2);
  assert.equal(cleaned, true);
});

test("runSandboxJob stops and reports failed on a non-zero exit", async () => {
  const out = await runSandboxJob(
    {
      jobId: "job2",
      repo: { clone_url: "local", branch: "main" },
      commands: ["npm ci", "npm test"],
    },
    {
      prepare: async () => ({ dir: "/tmp/ws", mode: "copy" }),
      cleanup: () => {},
      runCommand: async (command) => ({
        command,
        allowed: true,
        exitCode: command === "npm test" ? 1 : 0,
        stdout: "",
        stderr: "boom",
        timedOut: false,
        truncated: false,
        durationMs: 1,
      }),
    },
  );
  assert.equal(out.status, "failed");
  // stopped at the failing command — did not run anything after it.
  assert.equal(out.result.commands.length, 2);
});
