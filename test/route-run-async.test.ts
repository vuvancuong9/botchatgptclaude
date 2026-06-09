process.env.AI_ORCHESTRATOR_DB = ":memory:";
process.env.AI_ORCHESTRATOR_DB_PROVIDER = "sqlite";
process.env.AI_ORCHESTRATOR_ALLOW_LEGACY_ADMIN_KEY = "1";
process.env.AI_ORCHESTRATOR_ADMIN_KEY = "run-async-admin";
process.env.AI_ORCHESTRATOR_TEST_RUNNER_MODE = "worker_async";

import { test } from "node:test";
import assert from "node:assert/strict";
import { POST } from "../app/api/ai-orchestrator/run/route";
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
const ADMIN = { [ADMIN_KEY_HEADER]: "run-async-admin" };
/* eslint-disable @typescript-eslint/no-explicit-any */

test("unauthorized run -> 401", async () => {
  const res = await POST(req({}, { request: "x" }) as any);
  assert.equal(res.status, 401);
});

test("a key without ai:run -> 403", async () => {
  const repo = getRepository();
  const user = await repo.createUser({ email: "v@x.com", role: "viewer" });
  const key = generateApiKey();
  await repo.createApiKey({ userId: user.id, keyPrefix: key.prefix, keyHash: key.hash });
  const res = await POST(req({ [API_KEY_HEADER]: key.raw }, { request: "x" }) as any);
  assert.equal(res.status, 403);
});

test("worker_async run returns 202 immediately (waiting_for_worker)", async () => {
  const res = await POST(
    req(ADMIN, { request: "build an async feature" }) as any,
  );
  assert.equal(res.status, 202);
  const body = await res.json();
  assert.equal(body.status, "waiting_for_worker");
  assert.ok(body.orchestration_run_id);
  assert.ok(body.worker_job_id);
  assert.ok(body.session_id);

  // The run is persisted, and a queued TEST_RUNNER job exists.
  const run = await getRepository().getOrchestrationRun(body.orchestration_run_id);
  assert.equal(run!.status, "waiting_for_worker");
  const job = await getRepository().getWorkerJob(body.worker_job_id);
  assert.equal(job!.status, "queued");
});
