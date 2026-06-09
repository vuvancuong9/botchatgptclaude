process.env.AI_ORCHESTRATOR_DB = ":memory:";
process.env.AI_ORCHESTRATOR_DB_PROVIDER = "sqlite";

import { test } from "node:test";
import assert from "node:assert/strict";
import { getHealthReport } from "../lib/ai-orchestrator/health";

function reset() {
  delete process.env.AI_ORCHESTRATOR_TEST_RUNNER_MODE;
  delete process.env.AI_ORCHESTRATOR_REPO_CLONE_URL;
  delete process.env.GITHUB_OWNER;
  delete process.env.GITHUB_REPO;
  delete (process.env as Record<string, string>).NODE_ENV;
}

test("health reports the test_runner_mode + timeouts", async () => {
  reset();
  const r = await getHealthReport();
  assert.ok(["inline", "worker"].includes(r.test_runner_mode));
  assert.equal(typeof r.test_job_timeout_ms, "number");
  assert.equal(typeof r.test_job_poll_ms, "number");
});

test("warns when production runs the TEST_RUNNER inline", async () => {
  reset();
  (process.env as Record<string, string>).NODE_ENV = "production";
  process.env.AI_ORCHESTRATOR_TEST_RUNNER_MODE = "inline";
  try {
    const r = await getHealthReport();
    assert.equal(r.test_runner_mode, "inline");
    assert.notEqual(r.test_runner_warning, null);
  } finally {
    reset();
  }
});

test("warns when worker mode lacks a repo clone url", async () => {
  reset();
  process.env.AI_ORCHESTRATOR_TEST_RUNNER_MODE = "worker_async";
  // provider defaults to "database"; no repo clone url + no github config.
  try {
    const r = await getHealthReport();
    assert.equal(r.test_runner_mode, "worker_async");
    assert.notEqual(r.test_runner_warning, null);
    assert.ok(r.test_runner_warning!.includes("REPO_CLONE_URL"));
  } finally {
    reset();
  }
});

test("health never leaks secret values", async () => {
  reset();
  process.env.GITHUB_TOKEN = "ghp_testrunner_secret_abcdef123456";
  try {
    const json = JSON.stringify(await getHealthReport());
    assert.equal(json.includes("ghp_testrunner_secret_abcdef123456"), false);
  } finally {
    delete process.env.GITHUB_TOKEN;
  }
});
