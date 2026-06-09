process.env.AI_ORCHESTRATOR_DB = ":memory:";
process.env.AI_ORCHESTRATOR_DB_PROVIDER = "sqlite";
process.env.AI_ORCHESTRATOR_ALLOW_LEGACY_ADMIN_KEY = "1";
process.env.AI_ORCHESTRATOR_ADMIN_KEY = "test-job-admin";
process.env.AI_ORCHESTRATOR_WORKER_PROVIDER = "local";

import { test } from "node:test";
import assert from "node:assert/strict";
import { POST as testJobPost } from "../app/api/ai-orchestrator/sessions/[id]/test-job/route";
import { getRepository } from "../lib/ai-orchestrator/db/factory";
import { getJobQueue } from "../lib/ai-orchestrator/worker/job-queue";
import { ADMIN_KEY_HEADER } from "../lib/ai-orchestrator/security/auth";
import {
  API_KEY_HEADER,
  generateApiKey,
} from "../lib/ai-orchestrator/auth/api-key";

type Req = { headers: { get(n: string): string | null } };
function req(headers: Record<string, string>): Req {
  return { headers: { get: (n) => headers[n.toLowerCase()] ?? null } };
}
function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}
const ADMIN = { [ADMIN_KEY_HEADER]: "test-job-admin" };
/* eslint-disable @typescript-eslint/no-explicit-any */

async function sessionWithValidatedPatch(): Promise<string> {
  const repo = getRepository();
  const s = await repo.createSession("patch job session");
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

test("without a validated patch -> 409", async () => {
  const repo = getRepository();
  const s = await repo.createSession("no patch yet");
  const res = await testJobPost(req(ADMIN) as any, ctx(s.id) as any);
  assert.equal(res.status, 409);
});

test("with a validated patch -> creates a test_patch job (apply_patch=true)", async () => {
  const id = await sessionWithValidatedPatch();
  const res = await testJobPost(req(ADMIN) as any, ctx(id) as any);
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.job_type, "test_patch");
  // The stored payload must carry apply_patch=true.
  const job = await getJobQueue().get(body.job_id);
  assert.ok(job);
  assert.equal((job!.payload as { apply_patch?: boolean }).apply_patch, true);
  assert.ok((job!.payload as { patch_set_id?: string }).patch_set_id);
});

test("user without ai:run_tests -> 403", async () => {
  const repo = getRepository();
  const user = await repo.createUser({ email: "v@x.com", role: "viewer" });
  const key = generateApiKey();
  await repo.createApiKey({
    userId: user.id,
    keyPrefix: key.prefix,
    keyHash: key.hash,
  });
  const id = await sessionWithValidatedPatch();
  const res = await testJobPost(
    req({ [API_KEY_HEADER]: key.raw }) as any,
    ctx(id) as any,
  );
  assert.equal(res.status, 403);
});
