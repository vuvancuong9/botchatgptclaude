process.env.AI_ORCHESTRATOR_DB = ":memory:";
process.env.AI_ORCHESTRATOR_DB_PROVIDER = "sqlite";

import { test } from "node:test";
import assert from "node:assert/strict";
import { getHealthReport } from "../lib/ai-orchestrator/health";
import { getProductionReadinessReport } from "../lib/ai-orchestrator/production-readiness";

const E = process.env as Record<string, string | undefined>;

test("health and readiness coexist and neither leaks a secret", async () => {
  E.OPENAI_API_KEY = "sk-integration-secret-1";
  E.SUPABASE_SERVICE_ROLE_KEY = "service-role-secret-2";
  E.GITHUB_TOKEN = "ghp_integration_secret_3";
  E.AI_ORCHESTRATOR_CRON_KEY = "cron-integration-secret-4";
  try {
    const health = await getHealthReport();
    const readiness = await getProductionReadinessReport();

    // health still works + does not leak.
    assert.equal(typeof health.ok, "boolean");
    const healthJson = JSON.stringify(health);
    for (const s of [
      "sk-integration-secret-1",
      "service-role-secret-2",
      "ghp_integration_secret_3",
      "cron-integration-secret-4",
    ]) {
      assert.equal(healthJson.includes(s), false, `health leaked ${s}`);
    }

    // readiness produced a report + does not leak.
    assert.ok(Array.isArray(readiness.checks));
    assert.ok(readiness.checks.length > 0);
    const readinessJson = JSON.stringify(readiness);
    for (const s of [
      "sk-integration-secret-1",
      "service-role-secret-2",
      "ghp_integration_secret_3",
      "cron-integration-secret-4",
    ]) {
      assert.equal(readinessJson.includes(s), false, `readiness leaked ${s}`);
    }
  } finally {
    delete E.OPENAI_API_KEY;
    delete E.SUPABASE_SERVICE_ROLE_KEY;
    delete E.GITHUB_TOKEN;
    delete E.AI_ORCHESTRATOR_CRON_KEY;
  }
});

test("readiness does not mutate health output", async () => {
  const before = await getHealthReport();
  await getProductionReadinessReport();
  const after = await getHealthReport();
  assert.equal(before.test_runner_mode, after.test_runner_mode);
  assert.equal(before.db_provider, after.db_provider);
  assert.equal(before.cron_key_configured, after.cron_key_configured);
});
