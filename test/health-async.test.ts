process.env.AI_ORCHESTRATOR_DB = ":memory:";
process.env.AI_ORCHESTRATOR_DB_PROVIDER = "sqlite";

import { test } from "node:test";
import assert from "node:assert/strict";
import { getHealthReport } from "../lib/ai-orchestrator/health";

function reset() {
  delete process.env.AI_ORCHESTRATOR_TEST_RUNNER_MODE;
  delete process.env.AI_ORCHESTRATOR_REPO_CLONE_URL;
  delete process.env.AI_ORCHESTRATOR_WORKER_PROVIDER;
  delete process.env.GITHUB_OWNER;
  delete process.env.GITHUB_REPO;
  delete (process.env as Record<string, string>).NODE_ENV;
}

test("production defaults to worker_async (recommended)", async () => {
  reset();
  (process.env as Record<string, string>).NODE_ENV = "production";
  try {
    const r = await getHealthReport();
    assert.equal(r.test_runner_mode, "worker_async");
    assert.equal(r.worker_async_recommended, true);
  } finally {
    reset();
  }
});

test("worker_async warns when the repo clone url is missing", async () => {
  reset();
  process.env.AI_ORCHESTRATOR_TEST_RUNNER_MODE = "worker_async";
  try {
    const r = await getHealthReport();
    assert.notEqual(r.worker_async_warning, null);
    assert.ok(r.worker_async_warning!.includes("REPO_CLONE_URL"));
  } finally {
    reset();
  }
});

test("worker_async with a non-database provider is unsupported + warned", async () => {
  reset();
  process.env.AI_ORCHESTRATOR_TEST_RUNNER_MODE = "worker_async";
  process.env.AI_ORCHESTRATOR_WORKER_PROVIDER = "local";
  try {
    const r = await getHealthReport();
    assert.equal(r.async_orchestration_supported, false);
    assert.notEqual(r.worker_async_warning, null);
    assert.ok(r.worker_async_warning!.includes("database"));
  } finally {
    reset();
  }
});

test("health never leaks secret values", async () => {
  reset();
  process.env.OPENAI_API_KEY = "sk-async-secret-value-123456";
  try {
    const json = JSON.stringify(await getHealthReport());
    assert.equal(json.includes("sk-async-secret-value-123456"), false);
  } finally {
    delete process.env.OPENAI_API_KEY;
  }
});
