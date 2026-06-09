process.env.AI_ORCHESTRATOR_DB = ":memory:";
process.env.AI_ORCHESTRATOR_DB_PROVIDER = "sqlite";
process.env.AI_ORCHESTRATOR_ALLOW_LEGACY_ADMIN_KEY = "1";
process.env.AI_ORCHESTRATOR_ADMIN_KEY = "dryrun-admin";

import { test } from "node:test";
import assert from "node:assert/strict";
import { GET as dryRunGet } from "../app/api/ai-orchestrator/production-dry-run/route";
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
const ADMIN = { [ADMIN_KEY_HEADER]: "dryrun-admin" };
const E = process.env as Record<string, string | undefined>;
/* eslint-disable @typescript-eslint/no-explicit-any */

test("no API key -> 401", async () => {
  const res = await dryRunGet(req({}) as any);
  assert.equal(res.status, 401);
});

test("a viewer -> 403", async () => {
  const repo = getRepository();
  const user = await repo.createUser({ email: "dv@x.com", role: "viewer" });
  const key = generateApiKey();
  await repo.createApiKey({
    userId: user.id,
    keyPrefix: key.prefix,
    keyHash: key.hash,
  });
  const res = await dryRunGet(req({ [API_KEY_HEADER]: key.raw }) as any);
  assert.equal(res.status, 403);
});

test("owner/admin -> 200 with dry_run_safe + blockers/warnings", async () => {
  const res = await dryRunGet(req(ADMIN) as any);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(typeof body.dry_run_safe, "boolean");
  assert.ok(Array.isArray(body.blockers));
  assert.ok(Array.isArray(body.warnings));
  assert.ok(body.health);
  assert.ok(body.readiness);
});

test("the response never leaks a secret value", async () => {
  E.OPENAI_API_KEY = "sk-dryrun-route-secret";
  E.SUPABASE_SERVICE_ROLE_KEY = "service-role-route-secret";
  try {
    const res = await dryRunGet(req(ADMIN) as any);
    const json = JSON.stringify(await res.json());
    assert.equal(json.includes("sk-dryrun-route-secret"), false);
    assert.equal(json.includes("service-role-route-secret"), false);
  } finally {
    delete E.OPENAI_API_KEY;
    delete E.SUPABASE_SERVICE_ROLE_KEY;
  }
});
