// Use isolated in-memory SQLite for the factory repo that resolveAuthContext uses.
process.env.AI_ORCHESTRATOR_DB = ":memory:";
process.env.AI_ORCHESTRATOR_DB_PROVIDER = "sqlite";
delete process.env.AI_ORCHESTRATOR_ALLOW_LEGACY_ADMIN_KEY;

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { getRepository } from "../lib/ai-orchestrator/db/factory";
import { resolveAuthContext } from "../lib/ai-orchestrator/auth/context";
import { generateApiKey, API_KEY_HEADER } from "../lib/ai-orchestrator/auth/api-key";

beforeEach(() => {
  process.env.AI_ORCHESTRATOR_DB_PROVIDER = "sqlite";
  delete process.env.AI_ORCHESTRATOR_ALLOW_LEGACY_ADMIN_KEY;
});

function req(apiKey?: string) {
  return {
    headers: {
      get(name: string): string | null {
        if (name.toLowerCase() === API_KEY_HEADER && apiKey) return apiKey;
        return null;
      },
    },
  };
}

async function makeUserWithKey(role: string, opts: { expiresAt?: string } = {}) {
  const repo = getRepository();
  const user = await repo.createUser({
    email: null,
    displayName: null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    role: role as any,
  });
  const gen = generateApiKey();
  const key = await repo.createApiKey({
    userId: user.id,
    keyPrefix: gen.prefix,
    keyHash: gen.hash,
    expiresAt: opts.expiresAt ?? null,
  });
  return { user, key, raw: gen.raw, repo };
}

test("valid key -> ok with role + permissions", async () => {
  const { raw, user } = await makeUserWithKey("admin");
  const res = await resolveAuthContext(req(raw));
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.context.role, "admin");
    assert.equal(res.context.userId, user.id);
    assert.ok(res.context.permissions.includes("ai:run"));
    assert.equal(res.context.legacyAdmin, false);
  }
});

test("missing key -> 401", async () => {
  const res = await resolveAuthContext(req());
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.status, 401);
});

test("wrong key -> 401", async () => {
  await makeUserWithKey("admin");
  const res = await resolveAuthContext(req("aiorch_totallyunknownkey0000000000"));
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.status, 401);
});

test("revoked key -> 403", async () => {
  const { raw, key, repo } = await makeUserWithKey("developer");
  await repo.revokeApiKey(key.id);
  const res = await resolveAuthContext(req(raw));
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.status, 403);
    assert.equal(res.auditEvent, "auth_denied");
  }
});

test("disabled user -> 403", async () => {
  const { raw, user, repo } = await makeUserWithKey("developer");
  await repo.updateUserStatus(user.id, "disabled");
  const res = await resolveAuthContext(req(raw));
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.status, 403);
});

test("expired key -> 403", async () => {
  const past = new Date(Date.parse("2000-01-01T00:00:00.000Z")).toISOString();
  const { raw } = await makeUserWithKey("admin", { expiresAt: past });
  const res = await resolveAuthContext(req(raw));
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.status, 403);
});

test("raw key is never stored in DB", async () => {
  const { raw, key } = await makeUserWithKey("viewer");
  assert.equal(key.key_hash.includes(raw), false);
  assert.notEqual(key.key_hash, raw);
});
