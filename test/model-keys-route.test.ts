process.env.AI_ORCHESTRATOR_DB = ":memory:";
process.env.AI_ORCHESTRATOR_DB_PROVIDER = "sqlite";
process.env.AI_ORCHESTRATOR_API_KEY_PEPPER = "mk-route-pepper-zz";
process.env.AI_ORCHESTRATOR_ALLOW_LEGACY_ADMIN_KEY = "1";
process.env.AI_ORCHESTRATOR_ADMIN_KEY = "mk-admin";

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GET as keysGet,
  POST as keysPost,
} from "../app/api/ai-orchestrator/settings/model-keys/route";
import { getRepository } from "../lib/ai-orchestrator/db/factory";
import { ADMIN_KEY_HEADER } from "../lib/ai-orchestrator/security/auth";
import {
  API_KEY_HEADER,
  generateApiKey,
} from "../lib/ai-orchestrator/auth/api-key";

/* eslint-disable @typescript-eslint/no-explicit-any */
function req(headers: Record<string, string>, body: unknown = {}) {
  return {
    headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
    json: async () => body,
  };
}
const ADMIN = { [ADMIN_KEY_HEADER]: "mk-admin" };

test("no key -> 401", async () => {
  const res = await keysGet(req({}) as any);
  assert.equal(res.status, 401);
});

test("owner/admin GET returns status booleans", async () => {
  const res = await keysGet(req(ADMIN) as any);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(typeof body.openai_set, "boolean");
  assert.equal(typeof body.anthropic_set, "boolean");
});

test("owner POST saves an (encrypted) key; status flips; no value leak", async () => {
  const res = await keysPost(
    req(ADMIN, { anthropic_api_key: "sk-ant-route-secret" }) as any,
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.anthropic_set, true);
  assert.equal(body.anthropic_in_db, true);
  assert.equal(JSON.stringify(body).includes("sk-ant-route-secret"), false);

  // stored encrypted, not plaintext
  const row = await getRepository().getSetting("anthropic_api_key");
  assert.ok(row && !row.value.includes("sk-ant-route-secret"));
});

test("a viewer is forbidden (403)", async () => {
  const repo = getRepository();
  const user = await repo.createUser({ email: "v@mk.com", role: "viewer" });
  const key = generateApiKey();
  await repo.createApiKey({
    userId: user.id,
    keyPrefix: key.prefix,
    keyHash: key.hash,
  });
  const res = await keysGet(req({ [API_KEY_HEADER]: key.raw }) as any);
  assert.equal(res.status, 403);
});
