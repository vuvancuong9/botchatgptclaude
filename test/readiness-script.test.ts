import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const SCRIPT = "scripts/ai-orchestrator-readiness.ts";

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
      env: {
        ...process.env,
        NODE_ENV: "development",
        AI_ORCHESTRATOR_DB: ":memory:",
        AI_ORCHESTRATOR_DB_PROVIDER: "sqlite",
        AI_ORCHESTRATOR_ALLOW_CRON_QUERY_KEY: "0",
        ...extraEnv,
      },
    },
  );
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

test("exits 0 when readiness passes (dev, no fails)", () => {
  const r = runScript();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /READY/);
});

test("--json prints a valid report and exits 0", () => {
  const r = runScript({}, ["--json"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.ok(Array.isArray(parsed.checks));
  assert.ok(parsed.summary);
  assert.equal(typeof parsed.ok, "boolean");
});

test("exits 1 when a check fails (unsafe NEXT_PUBLIC secret)", () => {
  const r = runScript({ NEXT_PUBLIC_OPENAI_API_KEY: "sk-leak-script" });
  assert.equal(r.status, 1);
  // the failing secret value is never printed
  assert.equal(r.stdout.includes("sk-leak-script"), false);
});

test("--strict-warnings exits 1 when there are warnings", () => {
  // Enabling the query-key fallback raises a warning (no failure).
  const warn = runScript({ AI_ORCHESTRATOR_ALLOW_CRON_QUERY_KEY: "1" });
  assert.equal(warn.status, 0, "warning alone should not fail without --strict");

  const strict = runScript(
    { AI_ORCHESTRATOR_ALLOW_CRON_QUERY_KEY: "1" },
    ["--strict-warnings"],
  );
  assert.equal(strict.status, 1);
});
