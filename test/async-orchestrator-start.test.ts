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

test("start runs the pre-worker steps and stops at the worker wait", async () => {
  const { repo, queue, orch } = build();
  const result = await orch.start("Build a TODO API");

  assert.equal(result.status, "waiting_for_worker");
  assert.equal(result.round, 1);
  assert.ok(result.orchestrationRunId);
  assert.ok(result.sessionId);
  assert.ok(result.workerJobId);
  assert.equal(result.stillWaiting, false);

  // The run is persisted waiting on the job.
  const run = await repo.getOrchestrationRun(result.orchestrationRunId);
  assert.equal(run!.status, "waiting_for_worker");
  assert.equal(run!.current_step, "TEST_RUNNER");
  assert.equal(run!.current_round, 1);
  assert.equal(run!.pending_worker_job_id, result.workerJobId);

  // State captured the pre-worker artifacts.
  assert.ok((run!.state as { specText?: string }).specText);
  assert.ok((run!.state as { planText?: string }).planText);
  assert.ok((run!.state as { patchText?: string }).patchText);

  // The TEST_RUNNER job is enqueued (queued, NOT run) with the orchestrator source.
  const jobs = await queue.listForSession(result.sessionId);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, "queued");
  assert.equal(jobs[0].job_type, "test_branch");
  assert.equal(
    (jobs[0].payload as { source?: string }).source,
    "orchestrator_test_runner",
  );

  // Pre-worker messages persisted (spec, critique, plan, implementer).
  const detail = await repo.getSessionDetail(result.sessionId);
  const steps = new Set(detail!.messages.map((m) => m.step));
  for (const s of [
    "GPT_PRODUCT_SPEC",
    "CLAUDE_CRITICAL_REVIEW",
    "GPT_IMPLEMENTATION_PLAN",
    "CLAUDE_CODE_IMPLEMENTER",
  ]) {
    assert.ok(steps.has(s as never), s);
  }
});

test("start records orchestration_async_started + waiting events", async () => {
  const { repo, orch } = build();
  const result = await orch.start("X");
  const events = await repo.getOrchestrationEvents(result.orchestrationRunId);
  const types = events.map((e) => e.event_type);
  assert.ok(types.includes("orchestration_async_started"));
  assert.ok(types.includes("orchestration_waiting_for_worker"));
  assert.ok(types.includes("orchestration_worker_job_linked"));
});
