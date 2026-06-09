import { test } from "node:test";
import assert from "node:assert/strict";
import { PostgresRepository } from "../lib/ai-orchestrator/db/postgres-repository";
import {
  runWorkerClaimSmoke,
  shouldRunWorkerClaimSmoke,
} from "../lib/ai-orchestrator/worker/claim-smoke";
import { FakeAtomicGateway } from "./_fake-atomic-gateway";

test("smoke is skipped unless the backend is Postgres", () => {
  assert.equal(shouldRunWorkerClaimSmoke({}), false);
  assert.equal(shouldRunWorkerClaimSmoke({ AI_ORCHESTRATOR_DB_PROVIDER: "sqlite" }), false);
  assert.equal(shouldRunWorkerClaimSmoke({ AI_ORCHESTRATOR_DB_PROVIDER: "postgres" }), true);
  assert.equal(shouldRunWorkerClaimSmoke({ AI_ORCHESTRATOR_DB_PROVIDER: "supabase" }), true);
});

test("smoke: exactly 1 of N concurrent claims wins (mock atomic gateway)", async () => {
  const gw = new FakeAtomicGateway();
  const repo = new PostgresRepository(gw);
  const result = await runWorkerClaimSmoke({ repo, workerCount: 5 });
  assert.equal(result.passed, true, JSON.stringify(result.steps));
  assert.equal(result.claimedCount, 1);
  assert.ok(result.claimedBy);
});

test("smoke: cleanup deletes the job rows", async () => {
  const gw = new FakeAtomicGateway();
  const repo = new PostgresRepository(gw);
  const result = await runWorkerClaimSmoke({
    repo,
    workerCount: 3,
    cleanup: true,
    deleteJob: async (id) => {
      await gw.delete("ai_worker_job_logs", { job_id: id });
      await gw.delete("ai_worker_jobs", { id });
    },
  });
  assert.equal(result.passed, true);
  assert.equal((gw.tables.get("ai_worker_jobs") ?? []).length, 0);
});
