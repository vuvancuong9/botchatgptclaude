process.env.AI_ORCHESTRATOR_DB = ":memory:";
process.env.AI_ORCHESTRATOR_DB_PROVIDER = "sqlite";

import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryDb } from "../lib/ai-orchestrator/db";
import { OrchestratorRepository } from "../lib/ai-orchestrator/db/repository";
import { RepositoryJobQueue } from "../lib/ai-orchestrator/worker/job-queue";
import {
  pollAndRunOnce,
  processClaimedJob,
} from "../lib/ai-orchestrator/worker/job-service";
import { SandboxRunnerDeps } from "../lib/ai-orchestrator/worker/sandbox-runner";
import { CommandRunResult } from "../lib/ai-orchestrator/worker/command-runner";

const PAYLOAD = {
  repo: { clone_url: "local", branch: "main" },
  commands: ["npm ci", "npm test"],
};

function queue() {
  const repo = new OrchestratorRepository(createMemoryDb());
  return { repo, q: new RepositoryJobQueue(repo) };
}

/** Sandbox deps that never touch fs; runCommand outcome is configurable. */
function runner(outcome: Partial<CommandRunResult>): SandboxRunnerDeps {
  return {
    prepare: async () => ({ dir: "/tmp/ws", mode: "copy" }),
    cleanup: () => {},
    runCommand: async (command) => ({
      command,
      allowed: true,
      exitCode: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
      truncated: false,
      durationMs: 1,
      ...outcome,
    }),
  };
}

test("queued -> running -> passed", async () => {
  const { q } = queue();
  const job = await q.enqueue({ jobType: "test_branch", payload: PAYLOAD });
  const out = await pollAndRunOnce(q, "w1", { runner: runner({ exitCode: 0 }) });
  assert.equal(out?.status, "passed");
  assert.equal((await q.get(job.id))?.status, "passed");
});

test("queued -> running -> failed", async () => {
  const { q } = queue();
  const job = await q.enqueue({ jobType: "test_branch", payload: PAYLOAD });
  const out = await pollAndRunOnce(q, "w1", { runner: runner({ exitCode: 1 }) });
  assert.equal(out?.status, "failed");
  assert.equal((await q.get(job.id))?.status, "failed");
});

test("a timed-out command -> timed_out job", async () => {
  const { q } = queue();
  const job = await q.enqueue({ jobType: "test_branch", payload: PAYLOAD });
  const out = await pollAndRunOnce(q, "w1", {
    runner: runner({ timedOut: true, exitCode: null }),
  });
  assert.equal(out?.status, "timed_out");
  assert.equal((await q.get(job.id))?.status, "timed_out");
});

test("a cancelled job is not executed", async () => {
  const { q } = queue();
  const job = await q.enqueue({ jobType: "test_branch", payload: PAYLOAD });
  const claimed = await q.claimNext("w1");
  assert.ok(claimed);
  await q.cancel(job.id); // external cancel while "running"
  const out = await processClaimedJob(q, claimed!, {
    runner: runner({ exitCode: 0 }),
  });
  assert.equal(out.status, "cancelled");
});

test("invalid payload -> failed job (no crash)", async () => {
  const { q } = queue();
  const job = await q.enqueue({
    jobType: "test_branch",
    payload: { repo: { clone_url: "local", branch: "main" }, commands: ["rm -rf /"] },
  });
  const claimed = await q.claimNext("w1");
  const out = await processClaimedJob(q, claimed!, { runner: runner({}) });
  assert.equal(out.status, "failed");
  assert.equal((await q.get(job.id))?.status, "failed");
});

test("pollAndRunOnce returns null when the queue is empty", async () => {
  const { q } = queue();
  assert.equal(await pollAndRunOnce(q, "w1"), null);
});
