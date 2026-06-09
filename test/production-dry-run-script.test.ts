import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const SCRIPT = "scripts/ai-orchestrator-production-dry-run.ts";

/** A development env where every dry-run gate is green. */
const SAFE_ENV: Record<string, string> = {
  NODE_ENV: "development",
  AI_ORCHESTRATOR_DB: ":memory:",
  AI_ORCHESTRATOR_DB_PROVIDER: "sqlite",
  AI_ORCHESTRATOR_TEST_RUNNER_MODE: "worker_async",
  AI_ORCHESTRATOR_WORKER_PROVIDER: "database",
  AI_ORCHESTRATOR_ALLOW_INLINE_COMMANDS: "0",
  AI_ORCHESTRATOR_PR_DRY_RUN: "1",
  AI_ORCHESTRATOR_ENABLE_GITHUB_PR: "1",
  AI_ORCHESTRATOR_CRON_KEY: "cron-secret-script",
  AI_ORCHESTRATOR_PROD_DRY_RUN_ALLOW_MODEL_CALLS: "0",
};

function runScript(
  extraEnv: Record<string, string> = {},
  flags: string[] = [],
): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(
    process.execPath,
    ["--import", "tsx", SCRIPT, ...flags],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, ...SAFE_ENV, ...extraEnv },
    },
  );
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

test("exits 0 when the dry-run is safe", () => {
  const r = runScript();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /SAFE FOR DRY-RUN/);
});

test("exits 1 when a blocker is present (PR_DRY_RUN=0)", () => {
  const r = runScript({ AI_ORCHESTRATOR_PR_DRY_RUN: "0" });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /NOT SAFE/);
});

test("--create-test-session does NOT call a model without the ALLOW flag", () => {
  const r = runScript({}, ["--create-test-session"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /skipped/i);
  assert.match(r.stdout, /ALLOW_MODEL_CALLS/);
  // it must NOT have started an orchestration
  assert.equal(r.stdout.includes("started orchestration"), false);
});

test("--json prints a valid status and exits 0", () => {
  const r = runScript({}, ["--json"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(typeof parsed.dry_run_safe, "boolean");
  assert.ok(Array.isArray(parsed.blockers));
  assert.ok(Array.isArray(parsed.warnings));
});
