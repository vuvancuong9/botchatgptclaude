process.env.AI_ORCHESTRATOR_DB = ":memory:";
process.env.AI_ORCHESTRATOR_DB_PROVIDER = "sqlite";

import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryDb } from "../lib/ai-orchestrator/db";
import { OrchestratorRepository } from "../lib/ai-orchestrator/db/repository";
import { RepositoryJobQueue } from "../lib/ai-orchestrator/worker/job-queue";
import { processClaimedJob } from "../lib/ai-orchestrator/worker/job-service";
import {
  AbortReason,
  Heartbeat,
  HeartbeatController,
  HeartbeatDeps,
  HeartbeatStats,
} from "../lib/ai-orchestrator/worker/heartbeat";
import { CommandRunResult } from "../lib/ai-orchestrator/worker/command-runner";
import { WorkerJobRecord } from "../lib/ai-orchestrator/types";

const PAYLOAD = {
  repo: { clone_url: "local", branch: "main" },
  commands: ["npm test"],
};
const okCmd = async (command: string): Promise<CommandRunResult> => ({
  command,
  allowed: true,
  exitCode: 0,
  stdout: "",
  stderr: "",
  timedOut: false,
  truncated: false,
  durationMs: 1,
});
const job = (): WorkerJobRecord => ({
  id: "j",
  session_id: null,
  patch_set_id: null,
  pull_request_id: null,
  user_id: null,
  job_type: "test_branch",
  status: "running",
  priority: 5,
  payload: {},
  result: null,
  error_message: null,
  lease_owner: "w1",
  lease_expires_at: null,
  attempts: 1,
  max_attempts: 2,
  created_at: "x",
  started_at: null,
  finished_at: null,
  updated_at: "x",
});

// ---- Heartbeat class (deterministic via tick) ----

test("tick renews the lease and records the renewal", async () => {
  let aborted: AbortReason | null = null;
  const hb = new Heartbeat({
    jobId: "j",
    workerId: "w1",
    leaseSeconds: 300,
    intervalMs: 60000,
    renew: async () => job(),
    onAbort: (r) => (aborted = r),
  });
  await hb.tick();
  assert.equal(hb.stats.renewals, 1);
  assert.equal(hb.stats.leaseRenewed, true);
  assert.equal(aborted, null);
});

test("3 consecutive failures -> fail-closed abort lease_renewal_failed", async () => {
  const reasons: AbortReason[] = [];
  const hb = new Heartbeat({
    jobId: "j",
    workerId: "w1",
    leaseSeconds: 300,
    intervalMs: 60000,
    renew: async () => {
      throw new Error("network down");
    },
    onAbort: (r) => reasons.push(r),
  });
  await hb.tick();
  await hb.tick();
  assert.deepEqual(reasons, []); // not yet
  await hb.tick();
  assert.deepEqual(reasons, ["lease_renewal_failed"]);
  assert.equal(hb.stats.failures, 3);
});

test("a null renew on a cancelled job aborts external_cancel", async () => {
  const reasons: AbortReason[] = [];
  const hb = new Heartbeat({
    jobId: "j",
    workerId: "w1",
    leaseSeconds: 300,
    intervalMs: 60000,
    renew: async () => null,
    getStatus: async () => "cancelled",
    onAbort: (r) => reasons.push(r),
  });
  await hb.tick();
  assert.deepEqual(reasons, ["external_cancel"]);
});

test("heartbeat failure logs are redacted", async () => {
  const logs: string[] = [];
  const hb = new Heartbeat({
    jobId: "j",
    workerId: "w1",
    leaseSeconds: 300,
    intervalMs: 60000,
    renew: async () => {
      throw new Error("boom sk-ABCD1234efgh5678ijkl tail");
    },
    onAbort: () => {},
    log: (m) => {
      logs.push(m);
    },
  });
  await hb.tick();
  assert.ok(logs.some((l) => l.includes("heartbeat failed")));
  assert.equal(logs.join("\n").includes("sk-ABCD1234efgh5678ijkl"), false);
});

// ---- processClaimedJob integration (fake heartbeat controller) ----

class FakeHeartbeat implements HeartbeatController {
  started = false;
  stopped = false;
  stats: HeartbeatStats = { renewals: 0, failures: 0, leaseRenewed: false, reason: null };
  constructor(
    private deps: HeartbeatDeps,
    private abortReason?: AbortReason,
  ) {}
  start() {
    this.started = true;
    if (this.abortReason) {
      this.stats.reason = this.abortReason;
      this.deps.onAbort(this.abortReason);
    } else {
      this.stats.renewals = 1;
      this.stats.leaseRenewed = true;
    }
  }
  stop() {
    this.stopped = true;
    return this.stats;
  }
}

async function claimedJob() {
  const repo = new OrchestratorRepository(createMemoryDb());
  const q = new RepositoryJobQueue(repo);
  await q.enqueue({ jobType: "test_branch", payload: PAYLOAD });
  const claimed = await q.claimNext("w1");
  return { q, claimed: claimed! };
}

test("heartbeat is started and stopped around a passing job", async () => {
  const { q, claimed } = await claimedJob();
  let hb: FakeHeartbeat | null = null;
  const out = await processClaimedJob(q, claimed, {
    makeHeartbeat: (d) => (hb = new FakeHeartbeat(d)),
    runner: {
      prepare: async () => ({ dir: "/tmp/ws", mode: "copy" }),
      cleanup: () => {},
      runCommand: okCmd,
    },
  });
  assert.equal(out.status, "passed");
  assert.equal(hb!.started, true);
  assert.equal(hb!.stopped, true);
  assert.equal(out.result.lease_renewed, true);
});

test("heartbeat is cleared when the job fails", async () => {
  const { q, claimed } = await claimedJob();
  let hb: FakeHeartbeat | null = null;
  const out = await processClaimedJob(q, claimed, {
    makeHeartbeat: (d) => (hb = new FakeHeartbeat(d)),
    runner: {
      prepare: async () => ({ dir: "/tmp/ws", mode: "copy" }),
      cleanup: () => {},
      runCommand: async (c) => ({ ...(await okCmd(c)), exitCode: 1 }),
    },
  });
  assert.equal(out.status, "failed");
  assert.equal(hb!.stopped, true);
});

test("a lease_renewal_failed heartbeat fails the job (fail-closed)", async () => {
  const { q, claimed } = await claimedJob();
  const out = await processClaimedJob(q, claimed, {
    makeHeartbeat: (d) => new FakeHeartbeat(d, "lease_renewal_failed"),
    runner: {
      prepare: async () => ({ dir: "/tmp/ws", mode: "copy" }),
      cleanup: () => {},
      runCommand: okCmd,
    },
  });
  assert.equal(out.status, "failed");
  assert.ok((out.result.errors ?? []).some((e) => e.code === "lease_renewal_failed"));
  assert.equal(out.result.cancelled_by_signal, true);
});
