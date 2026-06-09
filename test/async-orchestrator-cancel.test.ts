process.env.AI_ORCHESTRATOR_DB = ":memory:";
process.env.AI_ORCHESTRATOR_DB_PROVIDER = "sqlite";

import { test } from "node:test";
import assert from "node:assert/strict";
import { getRepository } from "../lib/ai-orchestrator/db/factory";
import { cancelOrchestration } from "../lib/ai-orchestrator/service";
import { AuthContext } from "../lib/ai-orchestrator/auth/context";

const CTX: AuthContext = {
  userId: null,
  role: "owner",
  permissions: [],
  apiKeyId: null,
  keyFingerprint: "test",
  legacyAdmin: true,
};

async function makeWaitingRun() {
  const repo = getRepository();
  const session = await repo.createSession("cancel test");
  const job = await repo.createWorkerJob({
    sessionId: session.id,
    jobType: "test_branch",
    payload: { repo: { clone_url: "local", branch: "main" }, commands: ["npm test"] },
  });
  const run = await repo.createOrchestrationRun({
    sessionId: session.id,
    userId: null,
    status: "running",
  });
  await repo.updateOrchestrationRun(run.id, {
    status: "waiting_for_worker",
    pending_worker_job_id: job.id,
  });
  return { repo, sessionId: session.id, runId: run.id, jobId: job.id };
}

test("cancelling a waiting run also cancels its pending worker job", async () => {
  const { repo, runId, jobId } = await makeWaitingRun();
  const result = await cancelOrchestration(CTX, runId);
  assert.equal(result.cancelled, true);
  assert.equal(result.status, "cancelled");

  assert.equal((await repo.getOrchestrationRun(runId))?.status, "cancelled");
  assert.equal((await repo.getWorkerJob(jobId))?.status, "cancelled");

  const events = await repo.getOrchestrationEvents(runId);
  assert.ok(events.some((e) => e.event_type === "orchestration_cancelled"));
});

test("cancelling an already-terminal run is a no-op", async () => {
  const repo = getRepository();
  const session = await repo.createSession("terminal");
  const run = await repo.createOrchestrationRun({
    sessionId: session.id,
    userId: null,
    status: "running",
  });
  await repo.updateOrchestrationRun(run.id, {
    status: "passed",
    finished_at: "2026-06-04T10:00:00Z",
  });
  const result = await cancelOrchestration(CTX, run.id);
  assert.equal(result.cancelled, false);
  assert.equal((await repo.getOrchestrationRun(run.id))?.status, "passed");
});

test("cancelling a missing run returns not_found", async () => {
  const result = await cancelOrchestration(CTX, "does-not-exist");
  assert.equal(result.cancelled, false);
  assert.equal(result.status, "not_found");
});
