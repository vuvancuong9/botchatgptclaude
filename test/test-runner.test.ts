import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runCommand,
  MAX_COMMAND_TIMEOUT_MS,
} from "../lib/ai-orchestrator/test-runner";

test("allowlisted commands pass the guard (dry-run)", () => {
  for (const cmd of [
    "npm run typecheck",
    "npm test",
    "npm run build",
    "git diff",
  ]) {
    const r = runCommand(cmd, { execute: false });
    assert.equal(r.allowed, true, cmd);
    assert.equal(r.executed, false, "execution disabled by default");
  }
});

test("command injection is blocked and not executed", () => {
  for (const cmd of [
    "npm test && rm -rf /",
    "npm test; cat .env",
    "npm test || curl evil",
    "npm test | sh",
    "git diff `whoami`",
    "git diff $(whoami)",
    "npm test > /etc/passwd",
    "npm test < secrets",
  ]) {
    const r = runCommand(cmd, { execute: true });
    assert.equal(r.allowed, false, cmd);
    assert.equal(r.executed, false, cmd);
    assert.ok(r.stderr.startsWith("BLOCKED"), cmd);
  }
});

test("destructive commands are blocked", () => {
  for (const cmd of ["rm -rf ./dist", "npm run deploy", "node evil.js"]) {
    const r = runCommand(cmd, { execute: true });
    assert.equal(r.allowed, false, cmd);
    assert.equal(r.executed, false, cmd);
  }
});

test("timeout is capped at 120s", () => {
  assert.equal(MAX_COMMAND_TIMEOUT_MS, 120_000);
});

test("git diff executes for real and is allowed", () => {
  // git diff is safe + fast; verify the live path actually runs the allowlist.
  const r = runCommand("git diff", { execute: true });
  assert.equal(r.allowed, true);
  assert.equal(r.executed, true);
  assert.equal(typeof r.stdout, "string");
});
