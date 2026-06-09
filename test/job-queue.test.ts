import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryDb } from "../lib/ai-orchestrator/db";
import { OrchestratorRepository } from "../lib/ai-orchestrator/db/repository";
import {
  InMemoryJobQueue,
  RepositoryJobQueue,
} from "../lib/ai-orchestrator/worker/job-queue";
import { JobQueue } from "../lib/ai-orchestrator/worker/types";

const PAYLOAD = {
  repo: { clone_url: "local", branch: "main" },
  commands: ["npm test"],
};

const T0 = "2026-06-04T10:00:00.000Z";
const T10 = "2026-06-04T10:10:00.000Z";
const T20 = "2026-06-04T10:20:00.000Z";

function repoQueue(): JobQueue {
  return new RepositoryJobQueue(new OrchestratorRepository(createMemoryDb()));
}

// Run the same suite against both providers.
const factories: [string, () => JobQueue][] = [
  ["repository(sqlite)", repoQueue],
  ["in-memory", () => new InMemoryJobQueue()],
];

for (const [name, make] of factories) {
  test(`[${name}] enqueue creates a queued job`, async () => {
    const q = make();
    const job = await q.enqueue({ jobType: "test_branch", payload: PAYLOAD });
    assert.equal(job.status, "queued");
    assert.equal(job.attempts, 0);
    assert.equal(job.max_attempts, 2);
    const read = await q.get(job.id);
    assert.equal(read?.status, "queued");
  });

  test(`[${name}] claimNext leases the job to a worker`, async () => {
    const q = make();
    await q.enqueue({ jobType: "test_branch", payload: PAYLOAD });
    const claimed = await q.claimNext("w1", { now: T0 });
    assert.ok(claimed);
    assert.equal(claimed!.status, "running");
    assert.equal(claimed!.lease_owner, "w1");
    assert.equal(claimed!.attempts, 1);
    assert.ok(claimed!.lease_expires_at);
    // No other claimable job while the lease is fresh.
    assert.equal(await q.claimNext("w2", { now: T0 }), null);
  });

  test(`[${name}] an expired lease is re-claimable (retry)`, async () => {
    const q = make();
    const job = await q.enqueue({ jobType: "test_branch", payload: PAYLOAD });
    await q.claimNext("w1", { now: T0 }); // attempts 1
    // Same instant -> not claimable.
    assert.equal(await q.claimNext("w2", { now: T0 }), null);
    // After the lease window -> re-claimable, attempts increments.
    const again = await q.claimNext("w2", { now: T10 });
    assert.ok(again);
    assert.equal(again!.id, job.id);
    assert.equal(again!.attempts, 2);
    assert.equal(again!.lease_owner, "w2");
  });

  test(`[${name}] a job that exhausts max_attempts is failed, not claimed`, async () => {
    const q = make();
    const job = await q.enqueue({ jobType: "test_branch", payload: PAYLOAD });
    await q.claimNext("w1", { now: T0 }); // attempts 1
    await q.claimNext("w1", { now: T10 }); // attempts 2
    const third = await q.claimNext("w1", { now: T20 }); // exhausted
    assert.equal(third, null);
    const read = await q.get(job.id);
    assert.equal(read?.status, "failed");
    assert.equal(read?.error_message, "max attempts exceeded");
  });

  test(`[${name}] cancel applies only to queued/running`, async () => {
    const q = make();
    const job = await q.enqueue({ jobType: "test_branch", payload: PAYLOAD });
    assert.equal(await q.cancel(job.id), true);
    assert.equal((await q.get(job.id))?.status, "cancelled");
    // Already terminal -> cannot cancel again.
    assert.equal(await q.cancel(job.id), false);
  });

  test(`[${name}] logs are redacted before storage`, async () => {
    const q = make();
    const job = await q.enqueue({ jobType: "test_branch", payload: PAYLOAD });
    await q.appendLog(job.id, "stdout", "leaked sk-ABCD1234efgh5678ijkl tail");
    const logs = await q.getLogs(job.id);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].content.includes("sk-ABCD1234efgh5678ijkl"), false);
  });
}
