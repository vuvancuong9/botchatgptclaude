process.env.AI_ORCHESTRATOR_DB = ":memory:";
process.env.AI_ORCHESTRATOR_DB_PROVIDER = "sqlite";

import { test } from "node:test";
import assert from "node:assert/strict";
import { getHealthReport } from "../lib/ai-orchestrator/health";

test("health reports the worker provider + execution-plane fields", async () => {
  process.env.AI_ORCHESTRATOR_WORKER_PROVIDER = "database";
  const report = await getHealthReport();
  assert.equal(report.worker_provider, "database");
  assert.equal(typeof report.inline_commands_enabled, "boolean");
  assert.equal(typeof report.repo_clone_configured, "boolean");
  assert.ok(["ok", "fail", "local"].includes(report.worker_queue_status));
});

test("health never leaks secret VALUES", async () => {
  process.env.GITHUB_TOKEN = "ghp_supersecrettoken1234567890";
  process.env.OPENAI_API_KEY = "sk-openaisecretvalue123";
  const report = await getHealthReport();
  const json = JSON.stringify(report);
  assert.equal(json.includes("ghp_supersecrettoken1234567890"), false);
  assert.equal(json.includes("sk-openaisecretvalue123"), false);
  assert.equal(report.has_github_token, true);
  delete process.env.GITHUB_TOKEN;
  delete process.env.OPENAI_API_KEY;
});

test("production + inline commands -> worker_mode_warning", async () => {
  const prevNodeEnv = process.env.NODE_ENV;
  // NODE_ENV is augmented to a union; assign via the record to satisfy TS.
  (process.env as Record<string, string>).NODE_ENV = "production";
  process.env.AI_ORCHESTRATOR_ALLOW_INLINE_COMMANDS = "1";
  try {
    const report = await getHealthReport();
    assert.notEqual(report.worker_mode_warning, null);
    assert.equal(report.inline_commands_enabled, true);
  } finally {
    if (prevNodeEnv === undefined) delete (process.env as Record<string, string>).NODE_ENV;
    else (process.env as Record<string, string>).NODE_ENV = prevNodeEnv;
    delete process.env.AI_ORCHESTRATOR_ALLOW_INLINE_COMMANDS;
  }
});

test("non-production: no inline warning by default", async () => {
  delete process.env.AI_ORCHESTRATOR_ALLOW_INLINE_COMMANDS;
  const report = await getHealthReport();
  assert.equal(report.worker_mode_warning, null);
});
