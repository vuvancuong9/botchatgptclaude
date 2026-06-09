process.env.AI_ORCHESTRATOR_DB = ":memory:";
process.env.AI_ORCHESTRATOR_DB_PROVIDER = "sqlite";
process.env.AI_ORCHESTRATOR_ALLOW_LEGACY_ADMIN_KEY = "1";
process.env.AI_ORCHESTRATOR_ADMIN_KEY = "worker-route-admin";
// In-memory queue shared across route calls in this process.
process.env.AI_ORCHESTRATOR_WORKER_PROVIDER = "local";

import { test } from "node:test";
import assert from "node:assert/strict";
import { POST as testJobPost } from "../app/api/ai-orchestrator/sessions/[id]/test-job/route";
import { GET as jobGet } from "../app/api/ai-orchestrator/jobs/[id]/route";
import { POST as cancelPost } from "../app/api/ai-orchestrator/jobs/[id]/cancel/route";
import { getRepository } from "../lib/ai-orchestrator/db/factory";
import { ADMIN_KEY_HEADER } from "../lib/ai-orchestrator/security/auth";
import {
  API_KEY_HEADER,
  generateApiKey,
} from "../lib/ai-orchestrator/auth/api-key";

type Req = { headers: { get(n: string): string | null } };
function req(headers: Record<string, string>): Req {
  return {
    headers: {
      get: (n: string) => headers[n.toLowerCase()] ?? null,
    },
  };
}
function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}
const ADMIN = { [ADMIN_KEY_HEADER]: "worker-route-admin" };
/* eslint-disable @typescript-eslint/no-explicit-any */

async function newSession(): Promise<string> {
  const s = await getRepository().createSession("worker route session");
  return s.id;
}

async function newSessionWithValidatedPatch(): Promise<string> {
  const repo = getRepository();
  const s = await repo.createSession("worker route session with patch");
  await repo.createPatchSet({
    sessionId: s.id,
    userId: null,
    status: "validated",
    baseBranch: "main",
    targetBranch: "ai/x",
    baseSha: null,
    patchSummary: "1 file",
    patchText: "preview",
    validationErrors: null,
  });
  return s.id;
}

let jobId = "";

test("unauthorized -> 401", async () => {
  const res = await testJobPost(req({}) as any, ctx("any") as any);
  assert.equal(res.status, 401);
});

test("authenticated without ai:run_tests -> 403", async () => {
  const repo = getRepository();
  const user = await repo.createUser({ email: "v@x.com", role: "viewer" });
  const key = generateApiKey();
  await repo.createApiKey({
    userId: user.id,
    keyPrefix: key.prefix,
    keyHash: key.hash,
  });
  const id = await newSession();
  const res = await testJobPost(
    req({ [API_KEY_HEADER]: key.raw }) as any,
    ctx(id) as any,
  );
  assert.equal(res.status, 403);
});

test("create test job -> 201 with job_id (validated patch present)", async () => {
  const id = await newSessionWithValidatedPatch();
  const res = await testJobPost(req(ADMIN) as any, ctx(id) as any);
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(body.job_id);
  assert.equal(body.status, "queued");
  assert.equal(body.job_type, "test_patch");
  jobId = body.job_id;
});

test("create test job without validated patch -> 409", async () => {
  const id = await newSession();
  const res = await testJobPost(req(ADMIN) as any, ctx(id) as any);
  assert.equal(res.status, 409);
});

test("get job status -> 200", async () => {
  const res = await jobGet(req(ADMIN) as any, ctx(jobId) as any);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.job.id, jobId);
  assert.equal(body.job.status, "queued");
  assert.ok(Array.isArray(body.logs));
});

test("cancel job -> 200 cancelled", async () => {
  const res = await cancelPost(req(ADMIN) as any, ctx(jobId) as any);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.status, "cancelled");
});

test("get unknown job -> 404", async () => {
  const res = await jobGet(req(ADMIN) as any, ctx("nope") as any);
  assert.equal(res.status, 404);
});
