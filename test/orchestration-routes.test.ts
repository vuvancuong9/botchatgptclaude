process.env.AI_ORCHESTRATOR_DB = ":memory:";
process.env.AI_ORCHESTRATOR_DB_PROVIDER = "sqlite";
process.env.AI_ORCHESTRATOR_ALLOW_LEGACY_ADMIN_KEY = "1";
process.env.AI_ORCHESTRATOR_ADMIN_KEY = "orch-routes-admin";
process.env.AI_ORCHESTRATOR_TEST_RUNNER_MODE = "worker_async";

import { test } from "node:test";
import assert from "node:assert/strict";
import { POST as runPost } from "../app/api/ai-orchestrator/run/route";
import { GET as orchGet } from "../app/api/ai-orchestrator/orchestrations/[id]/route";
import { POST as resumePost } from "../app/api/ai-orchestrator/orchestrations/[id]/resume/route";
import { POST as cancelPost } from "../app/api/ai-orchestrator/orchestrations/[id]/cancel/route";
import { getRepository } from "../lib/ai-orchestrator/db/factory";
import { ADMIN_KEY_HEADER } from "../lib/ai-orchestrator/security/auth";
import {
  API_KEY_HEADER,
  generateApiKey,
} from "../lib/ai-orchestrator/auth/api-key";

type Req = {
  headers: { get(n: string): string | null };
  json: () => Promise<unknown>;
};
function req(headers: Record<string, string>, body: unknown = {}): Req {
  return {
    headers: { get: (n) => headers[n.toLowerCase()] ?? null },
    json: async () => body,
  };
}
function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}
const ADMIN = { [ADMIN_KEY_HEADER]: "orch-routes-admin" };
/* eslint-disable @typescript-eslint/no-explicit-any */

async function startRun(): Promise<{ runId: string; jobId: string }> {
  const res = await runPost(req(ADMIN, { request: "feature" }) as any);
  const body = await res.json();
  return { runId: body.orchestration_run_id, jobId: body.worker_job_id };
}

test("GET orchestration returns status + pending job", async () => {
  const { runId } = await startRun();
  const res = await orchGet(req(ADMIN) as any, ctx(runId) as any);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, "waiting_for_worker");
  assert.ok(body.pending_job);
  assert.ok(Array.isArray(body.events));
});

test("resume while the job is queued -> 202 still_waiting", async () => {
  const { runId } = await startRun();
  const res = await resumePost(req(ADMIN) as any, ctx(runId) as any);
  assert.equal(res.status, 202);
  const body = await res.json();
  assert.equal(body.still_waiting, true);
});

test("resume after the job passes -> 200 passed", async () => {
  const { runId, jobId } = await startRun();
  await getRepository().updateWorkerJobStatus(jobId, {
    status: "passed",
    result: { commands: [{ command: "npm test", exitCode: 0 }] },
  });
  const res = await resumePost(req(ADMIN) as any, ctx(runId) as any);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, "passed");
});

test("cancel a waiting run -> 200 cancelled", async () => {
  const { runId } = await startRun();
  const res = await cancelPost(req(ADMIN) as any, ctx(runId) as any);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.cancelled, true);
});

test("a viewer cannot read someone else's orchestration -> 403", async () => {
  const { runId } = await startRun();
  const repo = getRepository();
  const user = await repo.createUser({ email: "v@x.com", role: "viewer" });
  const key = generateApiKey();
  await repo.createApiKey({ userId: user.id, keyPrefix: key.prefix, keyHash: key.hash });
  const res = await orchGet(
    req({ [API_KEY_HEADER]: key.raw }) as any,
    ctx(runId) as any,
  );
  assert.equal(res.status, 403);
});

test("GET an unknown orchestration -> 404", async () => {
  const res = await orchGet(req(ADMIN) as any, ctx("nope") as any);
  assert.equal(res.status, 404);
});
