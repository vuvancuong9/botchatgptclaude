import { test } from "node:test";
import assert from "node:assert/strict";
import { PostgresRepository } from "../lib/ai-orchestrator/db/postgres-repository";
import {
  runWorkerLeaseSmoke,
  shouldRunWorkerClaimSmoke,
} from "../lib/ai-orchestrator/worker/claim-smoke";
import { FakeAtomicGateway } from "./_fake-atomic-gateway";

test("lease smoke is skipped unless the backend is Postgres", () => {
  assert.equal(shouldRunWorkerClaimSmoke({}), false);
  assert.equal(shouldRunWorkerClaimSmoke({ AI_ORCHESTRATOR_DB_PROVIDER: "postgres" }), true);
});

test("lease smoke: owner renews, non-owner + cancelled are rejected", async () => {
  const gw = new FakeAtomicGateway();
  const repo = new PostgresRepository(gw);
  const result = await runWorkerLeaseSmoke({ repo });
  assert.equal(result.passed, true, JSON.stringify(result.steps));
  // The exact ownership checks the smoke asserts.
  const names = result.steps.map((s) => s.name);
  assert.ok(names.some((n) => n.includes("worker-1 renew succeeds")));
  assert.ok(names.some((n) => n.includes("worker-2 renew rejected")));
  assert.ok(names.some((n) => n.includes("renew after cancel rejected")));
});

test("lease smoke: cleanup removes the job", async () => {
  const gw = new FakeAtomicGateway();
  const repo = new PostgresRepository(gw);
  const result = await runWorkerLeaseSmoke({
    repo,
    cleanup: true,
    deleteJob: async (id) => {
      await gw.delete("ai_worker_job_logs", { job_id: id });
      await gw.delete("ai_worker_jobs", { id });
    },
  });
  assert.equal(result.passed, true);
  assert.equal((gw.tables.get("ai_worker_jobs") ?? []).length, 0);
});
