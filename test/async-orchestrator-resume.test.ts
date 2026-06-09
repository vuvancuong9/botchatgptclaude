process.env.AI_ORCHESTRATOR_DB = ":memory:";
process.env.AI_ORCHESTRATOR_DB_PROVIDER = "sqlite";

import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryDb } from "../lib/ai-orchestrator/db";
import { OrchestratorRepository } from "../lib/ai-orchestrator/db/repository";
import { RepositoryJobQueue } from "../lib/ai-orchestrator/worker/job-queue";
import { AsyncOrchestrator } from "../lib/ai-orchestrator/async-orchestrator";
import {
  AIAdapter,
  AdapterRequest,
  AdapterResult,
} from "../lib/ai-orchestrator/adapters/types";

class PassthroughAdapter implements AIAdapter {
  constructor(public readonly provider: "openai" | "anthropic") {}
  readonly model = "fake";
  isLive() {
    return false;
  }
  async complete(req: AdapterRequest): Promise<AdapterResult> {
    return { output: req.mockOutput!, raw: "fake", mode: "mock", model: this.model };
  }
}

function build() {
  const repo = new OrchestratorRepository(createMemoryDb());
  const queue = new RepositoryJobQueue(repo);
  const orch = new AsyncOrchestrator({
    repo,
    queue,
    repoCloneUrl: "local",
    branch: "main",
    openai: new PassthroughAdapter("openai"),
    anthropic: new PassthroughAdapter("anthropic"),
  });
  return { repo, queue, orch };
}

async function finishJob(
  repo: OrchestratorRepository,
  jobId: string,
  status: "passed" | "failed",
) {
  await repo.updateWorkerJobStatus(jobId, {
    status,
    result: {
      commands: [{ command: "npm test", exitCode: status === "passed" ? 0 : 1 }],
      summary: status,
    },
  });
}

test("resume while the job is still running -> still_waiting", async () => {
  const { orch } = build();
  const started = await orch.start("X");
  const r = await orch.resume(started.orchestrationRunId);
  assert.equal(r.status, "waiting_for_worker");
  assert.equal(r.stillWaiting, true);
});

test("resume after a passed job runs review + judge and passes", async () => {
  const { repo, orch } = build();
  const started = await orch.start("X");
  await finishJob(repo, started.workerJobId!, "passed");
  const r = await orch.resume(started.orchestrationRunId);
  assert.equal(r.status, "passed");
  const session = await repo.getSession(started.sessionId);
  assert.equal(session!.status, "passed");
  const run = await repo.getOrchestrationRun(started.orchestrationRunId);
  assert.equal(run!.pending_worker_job_id, null);
  assert.ok(run!.finished_at);
});

test("a failed job triggers the next round (bounded by max_rounds)", async () => {
  const { repo, orch } = build();
  const started = await orch.start("X");
  await finishJob(repo, started.workerJobId!, "failed");
  const r2 = await orch.resume(started.orchestrationRunId);
  assert.equal(r2.status, "waiting_for_worker");
  assert.equal(r2.round, 2);
  assert.notEqual(r2.workerJobId, started.workerJobId);
});

test("repeated failures reach needs_revision at max rounds (QA never passes red tests)", async () => {
  const { repo, orch } = build();
  let res = await orch.start("X");
  // Round 1, 2, 3 all fail.
  for (let i = 0; i < 3; i++) {
    await finishJob(repo, res.workerJobId!, "failed");
    res = await orch.resume(res.orchestrationRunId);
  }
  assert.equal(res.status, "needs_revision");
  const run = await repo.getOrchestrationRun(res.orchestrationRunId);
  assert.equal(run!.current_round, 3);
  const session = await repo.getSession(res.sessionId);
  assert.equal(session!.status, "needs_revision");
});

test("resuming a terminal run is idempotent", async () => {
  const { repo, orch } = build();
  const started = await orch.start("X");
  await finishJob(repo, started.workerJobId!, "passed");
  const first = await orch.resume(started.orchestrationRunId);
  assert.equal(first.status, "passed");
  const again = await orch.resume(started.orchestrationRunId);
  assert.equal(again.status, "passed"); // no-op, no crash
});
