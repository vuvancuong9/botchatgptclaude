process.env.AI_ORCHESTRATOR_DB = ":memory:";
process.env.AI_ORCHESTRATOR_DB_PROVIDER = "sqlite";

import { test } from "node:test";
import assert from "node:assert/strict";
import { getHealthReport } from "../lib/ai-orchestrator/health";

function reset() {
  delete process.env.AI_ORCHESTRATOR_TEST_RUNNER_MODE;
  delete process.env.AI_ORCHESTRATOR_CRON_KEY;
  delete process.env.AI_ORCHESTRATOR_RESUME_BATCH_SIZE;
  delete process.env.AI_ORCHESTRATOR_RESUME_LOCK_TTL_SECONDS;
}

test("cron_key_configured is false (and warned) when worker_async lacks a key", async () => {
  reset();
  process.env.AI_ORCHESTRATOR_TEST_RUNNER_MODE = "worker_async";
  try {
    const r = await getHealthReport();
    assert.equal(r.cron_key_configured, false);
    assert.equal(r.cron_resume_enabled, false);
    assert.notEqual(r.cron_resume_warning, null);
    assert.ok(r.cron_resume_warning!.includes("AI_ORCHESTRATOR_CRON_KEY"));
  } finally {
    reset();
  }
});

test("cron_key_configured is true (no missing-key warning) when a key is set", async () => {
  reset();
  process.env.AI_ORCHESTRATOR_TEST_RUNNER_MODE = "worker_async";
  process.env.AI_ORCHESTRATOR_CRON_KEY = "a-cron-key";
  try {
    const r = await getHealthReport();
    assert.equal(r.cron_key_configured, true);
    assert.equal(r.cron_resume_enabled, true);
    assert.equal(r.cron_resume_warning, null);
    assert.equal(r.resume_batch_size, 5);
    assert.equal(r.resume_lock_ttl_seconds, 120);
  } finally {
    reset();
  }
});

test("an oversized resume batch is warned", async () => {
  reset();
  process.env.AI_ORCHESTRATOR_TEST_RUNNER_MODE = "worker_async";
  process.env.AI_ORCHESTRATOR_CRON_KEY = "a-cron-key";
  process.env.AI_ORCHESTRATOR_RESUME_BATCH_SIZE = "40";
  try {
    const r = await getHealthReport();
    assert.equal(r.resume_batch_size, 40);
    assert.notEqual(r.cron_resume_warning, null);
    assert.ok(r.cron_resume_warning!.toLowerCase().includes("batch"));
  } finally {
    reset();
  }
});

test("health never leaks the cron key value", async () => {
  reset();
  process.env.AI_ORCHESTRATOR_CRON_KEY = "super-secret-cron-key-9999";
  try {
    const json = JSON.stringify(await getHealthReport());
    assert.equal(json.includes("super-secret-cron-key-9999"), false);
  } finally {
    reset();
  }
});
