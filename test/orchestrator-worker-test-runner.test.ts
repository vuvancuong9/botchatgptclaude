process.env.AI_ORCHESTRATOR_DB = ":memory:";
process.env.AI_ORCHESTRATOR_DB_PROVIDER = "sqlite";

import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryDb } from "../lib/ai-orchestrator/db";
import { OrchestratorRepository } from "../lib/ai-orchestrator/db/repository";
import { RepositoryJobQueue } from "../lib/ai-orchestrator/worker/job-queue";
import { runOrchestratorTestJob } from "../lib/ai-orchestrator/test-runner-worker";
import { Orchestrator } from "../lib/ai-orchestrator/orchestrator";
import { TestExecutor } from "../lib/ai-orchestrator/test-runner";
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

async function setup() {
  const repo = new OrchestratorRepository(createMemoryDb());
  const q = new RepositoryJobQueue(repo);
  const session = await repo.createSession("orchestrator test");
  return { q, sessionId: session.id };
}

// ---- runOrchestratorTestJob ----

test("worker mode enqueues an orchestrator_test_runner job", async () => {
  const { q, sessionId } = await setup();
  const r = await runOrchestratorTestJob(
    { sessionId, round: 1 },
    {
      queue: q,
      repoCloneUrl: "local",
      branch: "main",
      waitForTerminal: async (qq, id) => {
        await qq.setStatus(id, {
          status: "passed",
          result: { commands: [{ command: "npm test", exitCode: 0 }], summary: "ok" },
        });
        return qq.get(id);
      },
    },
  );
  assert.equal(r.mode, "worker");
  assert.equal(r.report.passed, true);
  assert.ok(r.workerJobId);

  const jobs = await q.listForSession(sessionId);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].job_type, "test_branch");
  assert.equal(
    (jobs[0].payload as { source?: string }).source,
    "orchestrator_test_runner",
  );
});

test("a failed/timed_out worker job yields a failed report", async () => {
  for (const status of ["failed", "timed_out", "cancelled"] as const) {
    const { q, sessionId } = await setup();
    const r = await runOrchestratorTestJob(
      { sessionId, round: 1 },
      {
        queue: q,
        repoCloneUrl: "local",
        branch: "main",
        waitForTerminal: async (qq, id) => {
          await qq.setStatus(id, { status });
          return qq.get(id);
        },
      },
    );
    assert.equal(r.report.passed, false, status);
  }
});

test("a wait timeout returns a failed report without hanging", async () => {
  const { q, sessionId } = await setup();
  const r = await runOrchestratorTestJob(
    { sessionId, round: 1 },
    {
      queue: q,
      repoCloneUrl: "local",
      branch: "main",
      waitForTerminal: async () => null, // simulate timeout
    },
  );
  assert.equal(r.report.passed, false);
  assert.ok(r.workerJobId);
  assert.ok(r.report.results[0].stderr.includes("[WAIT TIMEOUT]"));
});

// ---- Orchestrator integration (QA fail-safe) ----

const passExecutor = (): TestExecutor => ({
  run: async () => ({
    report: {
      results: [{ command: "npm test", allowed: true, reason: "w", exitCode: 0, stdout: "", stderr: "", executed: true }],
      passed: true,
    },
    mode: "worker",
    workerJobId: "job-pass",
  }),
});
const failExecutor = (): TestExecutor => ({
  run: async () => ({
    report: {
      results: [{ command: "npm test", allowed: true, reason: "w", exitCode: 1, stdout: "", stderr: "boom", executed: true }],
      passed: false,
    },
    mode: "worker",
    workerJobId: "job-fail",
  }),
});

test("QA cannot pass when the worker test failed (fail-safe held)", async () => {
  const repo = new OrchestratorRepository(createMemoryDb());
  const orch = new Orchestrator(repo, {
    openai: new PassthroughAdapter("openai"),
    anthropic: new PassthroughAdapter("anthropic"),
    testExecutor: failExecutor(),
  });
  const result = await orch.run("build X");
  assert.equal(result.status, "needs_revision");

  const detail = (await repo.getSessionDetail(result.sessionId))!;
  const testMsg = detail.messages.find((m) => m.step === "TEST_RUNNER");
  assert.ok(testMsg);
  // The worker job id is recorded in the test report artifact.
  const artifact = testMsg!.output.artifacts.find((a) => a.type === "test_report");
  assert.ok(artifact!.content.includes("job-fail"));
});

test("a passing worker test lets the run pass", async () => {
  const repo = new OrchestratorRepository(createMemoryDb());
  const orch = new Orchestrator(repo, {
    openai: new PassthroughAdapter("openai"),
    anthropic: new PassthroughAdapter("anthropic"),
    testExecutor: passExecutor(),
  });
  const result = await orch.run("build Y");
  assert.equal(result.status, "passed");
});
