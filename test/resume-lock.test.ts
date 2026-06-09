process.env.AI_ORCHESTRATOR_DB = ":memory:";
process.env.AI_ORCHESTRATOR_DB_PROVIDER = "sqlite";

import { test } from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { createMemoryDb } from "../lib/ai-orchestrator/db";
import { OrchestratorRepository } from "../lib/ai-orchestrator/db/repository";

function fresh(): { db: DatabaseSync; repo: OrchestratorRepository } {
  const db = createMemoryDb();
  return { db, repo: new OrchestratorRepository(db) };
}

async function makeWaiting(repo: OrchestratorRepository): Promise<string> {
  const session = await repo.createSession("req");
  const run = await repo.createOrchestrationRun({
    sessionId: session.id,
    userId: null,
    status: "running",
  });
  await repo.updateOrchestrationRun(run.id, { status: "waiting_for_worker" });
  return run.id;
}

test("claim succeeds when the lock is free", async () => {
  const { repo } = fresh();
  const runId = await makeWaiting(repo);
  const locked = await repo.claimOrchestrationResumeLock(runId, "owner-a", 120);
  assert.ok(locked);
  assert.equal(locked!.resume_lock_owner, "owner-a");
  assert.ok(locked!.resume_lock_expires_at);
});

test("claim fails when another owner holds a fresh lock", async () => {
  const { repo } = fresh();
  const runId = await makeWaiting(repo);
  await repo.claimOrchestrationResumeLock(runId, "owner-a", 120);
  const second = await repo.claimOrchestrationResumeLock(runId, "owner-b", 120);
  assert.equal(second, null);
  assert.equal(
    (await repo.getOrchestrationRun(runId))!.resume_lock_owner,
    "owner-a",
  );
});

test("claim succeeds when the existing lock has expired", async () => {
  const { db, repo } = fresh();
  const runId = await makeWaiting(repo);
  await repo.claimOrchestrationResumeLock(runId, "owner-a", 120);
  // Force the lock into the past.
  db.prepare(
    "UPDATE ai_orchestration_runs SET resume_lock_expires_at = ? WHERE id = ?",
  ).run("2000-01-01T00:00:00.000Z", runId);
  const reclaimed = await repo.claimOrchestrationResumeLock(runId, "owner-b", 120);
  assert.ok(reclaimed);
  assert.equal(reclaimed!.resume_lock_owner, "owner-b");
});

test("claim fails when the run is not waiting_for_worker", async () => {
  const { repo } = fresh();
  const session = await repo.createSession("req");
  const run = await repo.createOrchestrationRun({
    sessionId: session.id,
    userId: null,
    status: "running",
  });
  const locked = await repo.claimOrchestrationResumeLock(run.id, "owner-a", 120);
  assert.equal(locked, null);
});

test("release by the holding owner frees the lock", async () => {
  const { repo } = fresh();
  const runId = await makeWaiting(repo);
  await repo.claimOrchestrationResumeLock(runId, "owner-a", 120);
  await repo.releaseOrchestrationResumeLock(runId, "owner-a");
  assert.equal(
    (await repo.getOrchestrationRun(runId))!.resume_lock_owner,
    null,
  );
  // Now another owner can claim it.
  const reclaim = await repo.claimOrchestrationResumeLock(runId, "owner-b", 120);
  assert.ok(reclaim);
});

test("release by a non-holder is a no-op", async () => {
  const { repo } = fresh();
  const runId = await makeWaiting(repo);
  await repo.claimOrchestrationResumeLock(runId, "owner-a", 120);
  await repo.releaseOrchestrationResumeLock(runId, "intruder");
  assert.equal(
    (await repo.getOrchestrationRun(runId))!.resume_lock_owner,
    "owner-a",
  );
});

test("the resume-attempt counter increments", async () => {
  const { repo } = fresh();
  const runId = await makeWaiting(repo);
  await repo.incrementOrchestrationResumeAttempt(runId);
  await repo.incrementOrchestrationResumeAttempt(runId);
  assert.equal((await repo.getOrchestrationRun(runId))!.resume_attempts, 2);
});
