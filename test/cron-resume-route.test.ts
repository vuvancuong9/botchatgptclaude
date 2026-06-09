process.env.AI_ORCHESTRATOR_DB = ":memory:";
process.env.AI_ORCHESTRATOR_DB_PROVIDER = "sqlite";
process.env.AI_ORCHESTRATOR_CRON_KEY = "cron-secret-xyz";
process.env.AI_ORCHESTRATOR_TEST_RUNNER_MODE = "worker_async";

import { test } from "node:test";
import assert from "node:assert/strict";
import { POST as cronPost } from "../app/api/ai-orchestrator/cron/resume/route";

const CRON_KEY = "cron-secret-xyz";
const URL = "http://localhost/api/ai-orchestrator/cron/resume";

type Req = { headers: { get(n: string): string | null }; url: string };
function req(headers: Record<string, string>, url: string = URL): Req {
  return { headers: { get: (n) => headers[n.toLowerCase()] ?? null }, url };
}
/* eslint-disable @typescript-eslint/no-explicit-any */

test("missing cron key -> 401", async () => {
  const res = await cronPost(req({}) as any);
  assert.equal(res.status, 401);
});

test("wrong cron key -> 401", async () => {
  const res = await cronPost(req({ "x-ai-cron-key": "nope" }) as any);
  assert.equal(res.status, 401);
});

test("correct cron key -> 200 and runs the scheduler", async () => {
  const res = await cronPost(req({ "x-ai-cron-key": CRON_KEY }) as any);
  assert.equal(res.status, 200);
  const body = await res.json();
  // Empty DB -> nothing due, but the scheduler ran and returned its summary.
  assert.equal(body.scanned, 0);
  assert.equal(body.resumed, 0);
  assert.ok(Array.isArray(body.results));
});

test("Authorization: Bearer <key> is accepted (Vercel Cron path)", async () => {
  const res = await cronPost(
    req({ authorization: `Bearer ${CRON_KEY}` }) as any,
  );
  assert.equal(res.status, 200);
});

test("non-worker_async mode is skipped (unless ?force=1)", async () => {
  process.env.AI_ORCHESTRATOR_TEST_RUNNER_MODE = "inline";
  try {
    const skipped = await cronPost(req({ "x-ai-cron-key": CRON_KEY }) as any);
    assert.equal(skipped.status, 200);
    assert.equal((await skipped.json()).skipped, true);

    const forced = await cronPost(
      req({ "x-ai-cron-key": CRON_KEY }, `${URL}?force=1`) as any,
    );
    assert.equal(forced.status, 200);
    assert.notEqual((await forced.json()).skipped, true);
  } finally {
    process.env.AI_ORCHESTRATOR_TEST_RUNNER_MODE = "worker_async";
  }
});

test("query token is rejected unless explicitly enabled", async () => {
  const res = await cronPost(req({}, `${URL}?cron_key=${CRON_KEY}`) as any);
  assert.equal(res.status, 401);
});

test("query token works when AI_ORCHESTRATOR_ALLOW_CRON_QUERY_KEY=1", async () => {
  process.env.AI_ORCHESTRATOR_ALLOW_CRON_QUERY_KEY = "1";
  try {
    const res = await cronPost(req({}, `${URL}?cron_key=${CRON_KEY}`) as any);
    assert.equal(res.status, 200);
  } finally {
    delete process.env.AI_ORCHESTRATOR_ALLOW_CRON_QUERY_KEY;
  }
});

test("responses never echo the cron key value", async () => {
  const unauth = await cronPost(req({ "x-ai-cron-key": "nope" }) as any);
  assert.equal((JSON.stringify(await unauth.json())).includes(CRON_KEY), false);
  const ok = await cronPost(req({ "x-ai-cron-key": CRON_KEY }) as any);
  assert.equal((JSON.stringify(await ok.json())).includes(CRON_KEY), false);
});
