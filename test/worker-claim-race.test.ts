import { test } from "node:test";
import assert from "node:assert/strict";
import { PostgresRepository } from "../lib/ai-orchestrator/db/postgres-repository";
import { FakeAtomicGateway } from "./_fake-atomic-gateway";

const PAYLOAD = {
  repo: { clone_url: "local", branch: "main" },
  commands: ["npm test"],
};

test("5 concurrent claims -> exactly 1 succeeds", async () => {
  const gw = new FakeAtomicGateway();
  const repo = new PostgresRepository(gw);
  const job = await repo.createWorkerJob({ jobType: "test_branch", payload: PAYLOAD });

  const results = await Promise.all(
    Array.from({ length: 5 }, (_u, i) => repo.claimNextWorkerJob(`w${i + 1}`)),
  );
  const claimed = results.filter(Boolean);
  assert.equal(claimed.length, 1);

  const after = await repo.getWorkerJob(job.id);
  assert.equal(after?.status, "running");
  assert.equal(after?.attempts, 1);
  assert.ok(after?.lease_owner);
});

test("an expired running job is re-claimable (attempts increments)", async () => {
  const gw = new FakeAtomicGateway();
  const repo = new PostgresRepository(gw);
  const job = await repo.createWorkerJob({ jobType: "test_branch", payload: PAYLOAD });

  const first = await repo.claimNextWorkerJob("w1"); // attempts 1, lease +300s
  assert.equal(first?.attempts, 1);
  // Same instant -> not claimable.
  assert.equal(await repo.claimNextWorkerJob("w2"), null);
  // Lease expired -> re-claimable.
  gw.setNow("2026-06-04T10:10:00.000Z");
  const again = await repo.claimNextWorkerJob("w2");
  assert.equal(again?.id, job.id);
  assert.equal(again?.attempts, 2);
  assert.equal(again?.lease_owner, "w2");
});

test("a job that exhausts max_attempts is failed, not re-claimed", async () => {
  const gw = new FakeAtomicGateway();
  const repo = new PostgresRepository(gw);
  const job = await repo.createWorkerJob({ jobType: "test_branch", payload: PAYLOAD });

  await repo.claimNextWorkerJob("w1"); // attempts 1
  gw.setNow("2026-06-04T10:10:00.000Z");
  await repo.claimNextWorkerJob("w1"); // attempts 2
  gw.setNow("2026-06-04T10:20:00.000Z");
  const third = await repo.claimNextWorkerJob("w1"); // exhausted
  assert.equal(third, null);
  assert.equal((await repo.getWorkerJob(job.id))?.status, "failed");
});

test("cancelled / failed / passed jobs are never claimed", async () => {
  for (const terminal of ["cancelled", "failed", "passed", "timed_out"] as const) {
    const gw = new FakeAtomicGateway();
    const repo = new PostgresRepository(gw);
    const job = await repo.createWorkerJob({ jobType: "test_branch", payload: PAYLOAD });
    if (terminal === "cancelled") await repo.cancelWorkerJob(job.id);
    else await repo.updateWorkerJobStatus(job.id, { status: terminal });
    assert.equal(await repo.claimNextWorkerJob("w1"), null, terminal);
  }
});
