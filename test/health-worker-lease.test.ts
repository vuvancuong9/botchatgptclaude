process.env.AI_ORCHESTRATOR_DB = ":memory:";
process.env.AI_ORCHESTRATOR_DB_PROVIDER = "sqlite";

import { test } from "node:test";
import assert from "node:assert/strict";
import { getHealthReport } from "../lib/ai-orchestrator/health";

function reset() {
  delete process.env.AI_ORCHESTRATOR_WORKER_LEASE_SECONDS;
  delete process.env.AI_ORCHESTRATOR_WORKER_HEARTBEAT_INTERVAL_MS;
  delete process.env.AI_ORCHESTRATOR_WORKER_CONCURRENCY;
}

test("health reports lease seconds + heartbeat interval (defaults, no warning)", async () => {
  reset();
  const r = await getHealthReport();
  assert.equal(r.worker_lease_seconds, 300);
  assert.equal(r.worker_heartbeat_interval_ms, 60000);
  assert.equal(r.worker_lease_renewal_supported, true); // sqlite
  assert.equal(r.worker_lease_warning, null);
});

test("custom lease/interval are reflected", async () => {
  reset();
  process.env.AI_ORCHESTRATOR_WORKER_LEASE_SECONDS = "120";
  process.env.AI_ORCHESTRATOR_WORKER_HEARTBEAT_INTERVAL_MS = "30000";
  try {
    const r = await getHealthReport();
    assert.equal(r.worker_lease_seconds, 120);
    assert.equal(r.worker_heartbeat_interval_ms, 30000);
    assert.equal(r.worker_lease_warning, null);
  } finally {
    reset();
  }
});

test("warns when heartbeat interval >= lease", async () => {
  reset();
  process.env.AI_ORCHESTRATOR_WORKER_LEASE_SECONDS = "300";
  process.env.AI_ORCHESTRATOR_WORKER_HEARTBEAT_INTERVAL_MS = "400000"; // 400s >= 300s
  try {
    const r = await getHealthReport();
    assert.notEqual(r.worker_lease_warning, null);
  } finally {
    reset();
  }
});

test("health never leaks secret values", async () => {
  reset();
  process.env.GITHUB_TOKEN = "ghp_lease_secret_value_abcdef123456";
  try {
    const json = JSON.stringify(await getHealthReport());
    assert.equal(json.includes("ghp_lease_secret_value_abcdef123456"), false);
  } finally {
    delete process.env.GITHUB_TOKEN;
  }
});
