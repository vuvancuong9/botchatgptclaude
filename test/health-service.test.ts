process.env.AI_ORCHESTRATOR_DB = ":memory:";

import { test } from "node:test";
import assert from "node:assert/strict";
import { getHealthReport } from "../lib/ai-orchestrator/health";

test("health: sqlite + memory reports ok", async () => {
  process.env.AI_ORCHESTRATOR_DB_PROVIDER = "sqlite";
  delete process.env.AI_ORCHESTRATOR_RATE_LIMIT_PROVIDER;
  const report = await getHealthReport();
  assert.equal(report.db_provider, "sqlite");
  assert.equal(report.db_status, "ok");
  assert.equal(report.rate_limit_provider, "memory");
  assert.equal(report.rate_limit_status, "ok");
  assert.equal(report.ok, true);
  assert.equal(typeof report.has_openai_key, "boolean");
  assert.equal(typeof report.has_anthropic_key, "boolean");
  assert.equal(typeof report.timestamp, "string");
});

test("health: never returns secret VALUES", async () => {
  process.env.AI_ORCHESTRATOR_DB_PROVIDER = "sqlite";
  process.env.AI_ORCHESTRATOR_ADMIN_KEY = "super-secret-admin-key-xyz";
  const report = await getHealthReport();
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes("super-secret-admin-key-xyz"), false);
  delete process.env.AI_ORCHESTRATOR_ADMIN_KEY;
});

test("health: postgres without env reports db_status fail (no throw)", async () => {
  process.env.AI_ORCHESTRATOR_DB_PROVIDER = "postgres";
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  const report = await getHealthReport();
  assert.equal(report.db_provider, "postgres");
  assert.equal(report.db_status, "fail");
  assert.equal(report.ok, false);
  process.env.AI_ORCHESTRATOR_DB_PROVIDER = "sqlite";
});
