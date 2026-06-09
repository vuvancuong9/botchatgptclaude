process.env.AI_ORCHESTRATOR_DB = ":memory:";
process.env.AI_ORCHESTRATOR_DB_PROVIDER = "sqlite";
process.env.AI_ORCHESTRATOR_ALLOW_LEGACY_ADMIN_KEY = "1";
process.env.AI_ORCHESTRATOR_ADMIN_KEY = "cron-int-admin";
process.env.AI_ORCHESTRATOR_CRON_KEY = "cron-int-key";
process.env.AI_ORCHESTRATOR_TEST_RUNNER_MODE = "worker_async";

import { test } from "node:test";
import assert from "node:assert/strict";
import { POST as runPost } from "../app/api/ai-orchestrator/run/route";
import { POST as cronPost } from "../app/api/ai-orchestrator/cron/resume/route";
import { getRepository } from "../lib/ai-orchestrator/db/factory";
import { createMemoryDb } from "../lib/ai-orchestrator/db";
import { OrchestratorRepository } from "../lib/ai-orchestrator/db/repository";
import { resumeDueOrchestrations } from "../lib/ai-orchestrator/orchestration-resume-scheduler";
import { ADMIN_KEY_HEADER } from "../lib/ai-orchestrator/security/auth";
import type { AsyncResult } from "../lib/ai-orchestrator/async-orchestrator";

const ADMIN = { [ADMIN_KEY_HEADER]: "cron-int-admin" };
const CRON = { "x-ai-cron-key": "cron-int-key" };
const CRON_URL = "http://localhost/api/ai-orchestrator/cron/resume";
/* eslint-disable @typescript-eslint/no-explicit-any */

function runReq(headers: Record<string, string>, body: unknown) {
  return {
    headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
    json: async () => body,
  };
}
function cronReq(headers: Record<string, string>, url = CRON_URL) {
  return { headers: { get: (n: string) => headers[n.toLowerCase()] ?? null }, url };
}

test("start async -> worker job finishes -> cron resume drives the run to terminal", async () => {
  const res = await runPost(runReq(ADMIN, { request: "ship a feature" }) as any);
  assert.equal(res.status, 202);
  const started = await res.json();
  const runId: string = started.orchestration_run_id;
  const jobId: string = started.worker_job_id;
  assert.equal(started.status, "waiting_for_worker");

  // The sandbox worker finishes the job (green).
  await getRepository().updateWorkerJobStatus(jobId, {
    status: "passed",
    result: { commands: [{ command: "npm test", exitCode: 0 }] },
  });

  // No UI in the loop — the cron tick resumes it.
  const cron = await cronPost(cronReq(CRON) as any);
  assert.equal(cron.status, 200);
  const summary = await cron.json();
  assert.ok(summary.resumed >= 1, "cron should resume the ready run");

  const run = await getRepository().getOrchestrationRun(runId);
  assert.ok(run);
  assert.notEqual(run!.status, "waiting_for_worker");
  assert.ok(["passed", "needs_revision", "failed"].includes(run!.status));
});

test("two overlapping cron ticks resume a run only once (lock)", async () => {
  // Isolated repo so the assertion is deterministic.
  const repo = new OrchestratorRepository(createMemoryDb());
  const session = await repo.createSession("feature");
  const job = await repo.createWorkerJob({
    sessionId: session.id,
    jobType: "test_branch",
    payload: {},
  });
  await repo.updateWorkerJobStatus(job.id, { status: "passed" });
  const run = await repo.createOrchestrationRun({
    sessionId: session.id,
    userId: null,
    status: "running",
  });
  await repo.updateOrchestrationRun(run.id, {
    status: "waiting_for_worker",
    pending_worker_job_id: job.id,
  });

  // Cron A is mid-flight and holds the lock.
  const heldByA = await repo.claimOrchestrationResumeLock(run.id, "cron-A", 120);
  assert.ok(heldByA);

  // Cron B scans while A holds the lock — it must NOT resume the run.
  const calls: string[] = [];
  const resume = async (runId: string): Promise<AsyncResult> => {
    calls.push(runId);
    return {
      orchestrationRunId: runId,
      sessionId: session.id,
      status: "passed",
      round: 1,
    };
  };
  const summary = await resumeDueOrchestrations({ repo, owner: "cron-B", resume });
  assert.equal(summary.skipped, 1);
  assert.equal(summary.resumed, 0);
  assert.equal(calls.length, 0);
});
