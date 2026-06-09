process.env.AI_ORCHESTRATOR_DB = ":memory:";
process.env.AI_ORCHESTRATOR_DB_PROVIDER = "sqlite";

import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryDb } from "../lib/ai-orchestrator/db";
import { OrchestratorRepository } from "../lib/ai-orchestrator/db/repository";
import { resumeDueOrchestrations } from "../lib/ai-orchestrator/orchestration-resume-scheduler";
import type { AsyncResult } from "../lib/ai-orchestrator/async-orchestrator";
import type {
  OrchestrationRunStatus,
  WorkerJobStatus,
} from "../lib/ai-orchestrator/types";

/** Isolated repo per test (the singleton :memory: DB is shared across a file). */
function fresh(): OrchestratorRepository {
  return new OrchestratorRepository(createMemoryDb());
}

async function makeReadyRun(
  repo: OrchestratorRepository,
  jobStatus: WorkerJobStatus = "passed",
): Promise<string> {
  const session = await repo.createSession("build me a feature");
  const job = await repo.createWorkerJob({
    sessionId: session.id,
    jobType: "test_branch",
    payload: {},
  });
  if (jobStatus !== "queued") {
    await repo.updateWorkerJobStatus(job.id, { status: jobStatus });
  }
  const run = await repo.createOrchestrationRun({
    sessionId: session.id,
    userId: null,
    status: "running",
  });
  await repo.updateOrchestrationRun(run.id, {
    status: "waiting_for_worker",
    pending_worker_job_id: job.id,
  });
  return run.id;
}

function recordingResume(
  repo: OrchestratorRepository,
  calls: string[],
  status: OrchestrationRunStatus = "passed",
) {
  return async (runId: string): Promise<AsyncResult> => {
    calls.push(runId);
    const run = await repo.getOrchestrationRun(runId);
    await repo.updateOrchestrationRun(runId, {
      status,
      pending_worker_job_id:
        status === "waiting_for_worker" ? run!.pending_worker_job_id : null,
      finished_at:
        status === "waiting_for_worker" ? null : new Date().toISOString(),
    });
    return {
      orchestrationRunId: runId,
      sessionId: run!.session_id,
      status,
      round: run!.current_round,
    };
  };
}

test("a run whose worker job is NOT terminal is not resumed", async () => {
  const repo = fresh();
  await makeReadyRun(repo, "queued");
  const calls: string[] = [];
  const summary = await resumeDueOrchestrations({
    repo,
    resume: recordingResume(repo, calls),
  });
  assert.equal(summary.scanned, 0);
  assert.equal(summary.resumed, 0);
  assert.equal(calls.length, 0);
});

test("a run whose worker job PASSED is resumed", async () => {
  const repo = fresh();
  const runId = await makeReadyRun(repo, "passed");
  const calls: string[] = [];
  const summary = await resumeDueOrchestrations({
    repo,
    resume: recordingResume(repo, calls, "passed"),
  });
  assert.equal(summary.resumed, 1);
  assert.deepEqual(calls, [runId]);
  assert.equal((await repo.getOrchestrationRun(runId))!.status, "passed");
});

test("a run whose worker job FAILED is resumed", async () => {
  const repo = fresh();
  await makeReadyRun(repo, "failed");
  const calls: string[] = [];
  const summary = await resumeDueOrchestrations({
    repo,
    resume: recordingResume(repo, calls, "failed"),
  });
  assert.equal(summary.resumed, 1);
  assert.equal(calls.length, 1);
});

test("batch size bounds how many runs a single tick resumes", async () => {
  const repo = fresh();
  await makeReadyRun(repo, "passed");
  await makeReadyRun(repo, "passed");
  await makeReadyRun(repo, "passed");
  const calls: string[] = [];
  const summary = await resumeDueOrchestrations({
    repo,
    batchSize: 2,
    resume: recordingResume(repo, calls),
  });
  assert.equal(summary.scanned, 2);
  assert.equal(summary.resumed, 2);
  assert.equal(calls.length, 2);
  // The third due run is left for the next tick.
  assert.equal((await repo.listWaitingOrchestrationRuns(10)).length, 1);
});

test("the summary has the documented shape", async () => {
  const repo = fresh();
  await makeReadyRun(repo, "passed");
  const summary = await resumeDueOrchestrations({
    repo,
    resume: recordingResume(repo, []),
  });
  for (const k of ["scanned", "resumed", "still_waiting", "skipped", "failed"]) {
    assert.ok(k in summary, `missing ${k}`);
  }
  assert.ok(Array.isArray(summary.results));
  assert.equal(summary.results.length, summary.scanned);
});

test("a still-waiting resume (next round enqueued) is counted as still_waiting", async () => {
  const repo = fresh();
  await makeReadyRun(repo, "passed");
  const summary = await resumeDueOrchestrations({
    repo,
    resume: recordingResume(repo, [], "waiting_for_worker"),
  });
  assert.equal(summary.still_waiting, 1);
  assert.equal(summary.resumed, 0);
});
