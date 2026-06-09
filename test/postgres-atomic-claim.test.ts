import { test } from "node:test";
import assert from "node:assert/strict";
import { PostgresRepository } from "../lib/ai-orchestrator/db/postgres-repository";
import { FakeAtomicGateway } from "./_fake-atomic-gateway";

const PAYLOAD = {
  repo: { clone_url: "local", branch: "main" },
  commands: ["npm test"],
};

test("claim goes through the RPC and maps the result shape", async () => {
  const gw = new FakeAtomicGateway();
  const repo = new PostgresRepository(gw);
  await repo.createWorkerJob({ jobType: "test_branch", payload: PAYLOAD });

  gw.calls.selectMany = 0;
  gw.calls.update = 0;
  gw.calls.rpc = 0;

  const claimed = await repo.claimNextWorkerJob("w1");
  assert.ok(claimed);
  assert.equal(claimed!.status, "running");
  assert.equal(claimed!.lease_owner, "w1");
  assert.equal(claimed!.attempts, 1);
  assert.ok(claimed!.lease_expires_at);

  // It used the RPC ONLY — no read-then-write claim path.
  assert.equal(gw.calls.rpc, 1);
  assert.equal(gw.calls.selectMany, 0);
  assert.equal(gw.calls.update, 0);
});

test("an empty RPC result maps to null", async () => {
  const gw = new FakeAtomicGateway(); // no jobs queued
  const repo = new PostgresRepository(gw);
  assert.equal(await repo.claimNextWorkerJob("w1"), null);
});

test("a missing RPC function throws a clear 'apply migration 008' error", async () => {
  class MissingRpcGateway extends FakeAtomicGateway {
    async rpc<T>(): Promise<T> {
      throw new Error(
        "Could not find the function public.claim_ai_worker_job(p_worker_id, p_lease_seconds) in the schema cache",
      );
    }
  }
  const repo = new PostgresRepository(new MissingRpcGateway());
  await repo.createWorkerJob({ jobType: "test_branch", payload: PAYLOAD });
  await assert.rejects(
    () => repo.claimNextWorkerJob("w1"),
    /008_atomic_worker_claim/,
  );
});

test("a generic RPC error is propagated as-is", async () => {
  class BoomGateway extends FakeAtomicGateway {
    async rpc<T>(): Promise<T> {
      throw new Error("connection reset");
    }
  }
  const repo = new PostgresRepository(new BoomGateway());
  await repo.createWorkerJob({ jobType: "test_branch", payload: PAYLOAD });
  await assert.rejects(() => repo.claimNextWorkerJob("w1"), /connection reset/);
});
