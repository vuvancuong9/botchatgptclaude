process.env.AI_ORCHESTRATOR_DB = ":memory:";
process.env.AI_ORCHESTRATOR_DB_PROVIDER = "sqlite";
process.env.AI_ORCHESTRATOR_ALLOW_LEGACY_ADMIN_KEY = "1";
process.env.AI_ORCHESTRATOR_ADMIN_KEY = "readiness-admin";

import { test } from "node:test";
import assert from "node:assert/strict";
import { GET as readinessGet } from "../app/api/ai-orchestrator/readiness/route";
import { getRepository } from "../lib/ai-orchestrator/db/factory";
import { ADMIN_KEY_HEADER } from "../lib/ai-orchestrator/security/auth";
import {
  API_KEY_HEADER,
  generateApiKey,
} from "../lib/ai-orchestrator/auth/api-key";

type Req = { headers: { get(n: string): string | null } };
function req(headers: Record<string, string>): Req {
  return { headers: { get: (n) => headers[n.toLowerCase()] ?? null } };
}
const ADMIN = { [ADMIN_KEY_HEADER]: "readiness-admin" };
const E = process.env as Record<string, string | undefined>;
/* eslint-disable @typescript-eslint/no-explicit-any */

test("no API key -> 401", async () => {
  const res = await readinessGet(req({}) as any);
  assert.equal(res.status, 401);
});

test("a viewer (no config:manage) -> 403", async () => {
  const repo = getRepository();
  const user = await repo.createUser({ email: "v@x.com", role: "viewer" });
  const key = generateApiKey();
  await repo.createApiKey({
    userId: user.id,
    keyPrefix: key.prefix,
    keyHash: key.hash,
  });
  const res = await readinessGet(req({ [API_KEY_HEADER]: key.raw }) as any);
  assert.equal(res.status, 403);
});

test("owner/admin -> 200 with a checks array (non-production)", async () => {
  const res = await readinessGet(req(ADMIN) as any);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.checks));
  assert.ok(body.summary);
  assert.equal(typeof body.ok, "boolean");
});

test("the report never leaks a secret value", async () => {
  E.OPENAI_API_KEY = "sk-readiness-secret-zzz";
  try {
    const res = await readinessGet(req(ADMIN) as any);
    const body = await res.json();
    assert.equal(
      JSON.stringify(body).includes("sk-readiness-secret-zzz"),
      false,
    );
  } finally {
    delete E.OPENAI_API_KEY;
  }
});

test("a critical failure returns HTTP 503", async () => {
  const savedNodeEnv = E.NODE_ENV;
  E.NODE_ENV = "production"; // production + sqlite provider => db_provider fail critical
  try {
    const res = await readinessGet(req(ADMIN) as any);
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.ok, false);
  } finally {
    if (savedNodeEnv === undefined) delete E.NODE_ENV;
    else E.NODE_ENV = savedNodeEnv;
  }
});
