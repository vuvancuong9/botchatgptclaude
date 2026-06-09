process.env.AI_ORCHESTRATOR_DB = ":memory:";
process.env.AI_ORCHESTRATOR_DB_PROVIDER = "sqlite";
process.env.AI_ORCHESTRATOR_ALLOW_LEGACY_ADMIN_KEY = "1";
process.env.AI_ORCHESTRATOR_ADMIN_KEY = "run-worker-admin";
// Worker mode for TEST_RUNNER, with a tiny wait so the request can't hang.
process.env.AI_ORCHESTRATOR_TEST_RUNNER_MODE = "worker";
process.env.AI_ORCHESTRATOR_TEST_JOB_TIMEOUT_MS = "40";
process.env.AI_ORCHESTRATOR_TEST_JOB_POLL_MS = "10";

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
const ADMIN = { [ADMIN_KEY_HEADER]: "run-worker-admin" };
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
  const res = await POST(
    req({ [API_KEY_HEADER]: key.raw }, { request: "x" }) as any,
  );
  assert.equal(res.status, 403);
});

test("worker mode: run enqueues a test job and never hangs (wait times out)", async () => {
  const res = await POST(
    req(ADMIN, { request: "build a small feature" }) as any,
  );
  assert.equal(res.status, 200);
  const detail = await res.json();
  // No worker is running, so the TEST_RUNNER wait times out -> not passed.
  assert.notEqual(detail.session.status, "passed");

  // An orchestrator_test_runner job was enqueued for this session.
  const jobs = await getRepository().listWorkerJobsForSession(detail.session.id);
  assert.ok(jobs.length >= 1);
  assert.ok(
    jobs.some(
      (j) =>
        j.job_type === "test_branch" &&
        (j.payload as { source?: string }).source === "orchestrator_test_runner",
    ),
  );
});
