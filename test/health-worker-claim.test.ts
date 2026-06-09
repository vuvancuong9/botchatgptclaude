process.env.AI_ORCHESTRATOR_DB = ":memory:";
process.env.AI_ORCHESTRATOR_DB_PROVIDER = "sqlite";

import { test } from "node:test";
import assert from "node:assert/strict";
import { getHealthReport } from "../lib/ai-orchestrator/health";
import { __resetRepositoryFactory } from "../lib/ai-orchestrator/db/factory";

function resetPostgresEnv() {
  delete process.env.AI_ORCHESTRATOR_DB_PROVIDER;
  process.env.AI_ORCHESTRATOR_DB_PROVIDER = "sqlite";
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.AI_ORCHESTRATOR_WORKER_CLAIM_VERIFIED;
  __resetRepositoryFactory();
}

test("sqlite -> sqlite-local, atomic claim true, no warning", async () => {
  resetPostgresEnv();
  const r = await getHealthReport();
  assert.equal(r.worker_claim_mode, "sqlite-local");
  assert.equal(r.worker_atomic_claim, true);
  assert.equal(r.worker_claim_warning, null);
});

test("postgres unverified -> postgres-rpc, atomic 'unknown' + warning", async () => {
  // No SUPABASE env on purpose: the DB ping fails fast (no network); the claim
  // fields depend only on the resolved provider, not on db connectivity.
  process.env.AI_ORCHESTRATOR_DB_PROVIDER = "postgres";
  delete process.env.AI_ORCHESTRATOR_WORKER_CLAIM_VERIFIED;
  __resetRepositoryFactory();
  try {
    const r = await getHealthReport();
    assert.equal(r.worker_claim_mode, "postgres-rpc");
    assert.equal(r.worker_atomic_claim, "unknown");
    assert.notEqual(r.worker_claim_warning, null);
  } finally {
    resetPostgresEnv();
  }
});

test("postgres verified -> atomic true, no warning", async () => {
  process.env.AI_ORCHESTRATOR_DB_PROVIDER = "postgres";
  process.env.AI_ORCHESTRATOR_WORKER_CLAIM_VERIFIED = "1";
  __resetRepositoryFactory();
  try {
    const r = await getHealthReport();
    assert.equal(r.worker_claim_mode, "postgres-rpc");
    assert.equal(r.worker_atomic_claim, true);
    assert.equal(r.worker_claim_warning, null);
  } finally {
    resetPostgresEnv();
  }
});

test("health never leaks secret values", async () => {
  resetPostgresEnv();
  process.env.GITHUB_TOKEN = "ghp_supersecret_claim_test_123456";
  try {
    const json = JSON.stringify(await getHealthReport());
    assert.equal(json.includes("ghp_supersecret_claim_test_123456"), false);
  } finally {
    delete process.env.GITHUB_TOKEN;
  }
});
