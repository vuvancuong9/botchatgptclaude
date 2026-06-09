import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryDb } from "../lib/ai-orchestrator/db";
import { OrchestratorRepository } from "../lib/ai-orchestrator/db/repository";
import { PostgresRepository } from "../lib/ai-orchestrator/db/postgres-repository";
import { FakeAtomicGateway } from "./_fake-atomic-gateway";

const PAYLOAD = {
  repo: { clone_url: "local", branch: "main" },
  commands: ["npm test"],
};

// ---- SQLite ----

test("SQLite: owner can renew a running job's lease", async () => {
  const repo = new OrchestratorRepository(createMemoryDb());
  const job = await repo.createWorkerJob({ jobType: "test_branch", payload: PAYLOAD });
  const claimed = await repo.claimNextWorkerJob("w1");
  const before = claimed!.lease_expires_at;
  const renewed = await repo.renewWorkerJobLease(job.id, "w1", 600);
  assert.ok(renewed);
  assert.equal(renewed!.lease_owner, "w1");
  assert.notEqual(renewed!.lease_expires_at, before);
});

test("SQLite: a non-owner cannot renew", async () => {
  const repo = new OrchestratorRepository(createMemoryDb());
  const job = await repo.createWorkerJob({ jobType: "test_branch", payload: PAYLOAD });
  await repo.claimNextWorkerJob("w1");
  assert.equal(await repo.renewWorkerJobLease(job.id, "w2", 300), null);
});

test("SQLite: a cancelled / finished job cannot be renewed", async () => {
  for (const action of ["cancelled", "passed", "failed"] as const) {
    const repo = new OrchestratorRepository(createMemoryDb());
    const job = await repo.createWorkerJob({ jobType: "test_branch", payload: PAYLOAD });
    await repo.claimNextWorkerJob("w1");
    if (action === "cancelled") await repo.cancelWorkerJob(job.id);
    else await repo.updateWorkerJobStatus(job.id, { status: action });
    assert.equal(await repo.renewWorkerJobLease(job.id, "w1", 300), null, action);
  }
});

// ---- Postgres (RPC) ----

test("Postgres: renew goes through the RPC and never read-then-writes", async () => {
  const gw = new FakeAtomicGateway();
  const repo = new PostgresRepository(gw);
  const job = await repo.createWorkerJob({ jobType: "test_branch", payload: PAYLOAD });
  await repo.claimNextWorkerJob("w1");

  gw.calls.rpc = 0;
  gw.calls.selectMany = 0;
  gw.calls.update = 0;

  const renewed = await repo.renewWorkerJobLease(job.id, "w1", 300);
  assert.ok(renewed);
  assert.equal(renewed!.lease_owner, "w1");
  assert.equal(gw.calls.rpc, 1);
  assert.equal(gw.calls.selectMany, 0);
  assert.equal(gw.calls.update, 0);

  // Non-owner -> RPC returns empty -> null.
  assert.equal(await repo.renewWorkerJobLease(job.id, "w2", 300), null);
});

test("Postgres: a missing renewal RPC throws a clear 'apply migration 009' error", async () => {
  class MissingRpc extends FakeAtomicGateway {
    async rpc<T>(): Promise<T> {
      throw new Error(
        "Could not find the function public.renew_ai_worker_job_lease in the schema cache",
      );
    }
  }
  const repo = new PostgresRepository(new MissingRpc());
  await assert.rejects(
    () => repo.renewWorkerJobLease("any-id", "w1", 300),
    /009_worker_lease_renewal/,
  );
});
