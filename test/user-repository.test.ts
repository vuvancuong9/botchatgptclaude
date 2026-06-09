import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryDb } from "../lib/ai-orchestrator/db";
import { OrchestratorRepository } from "../lib/ai-orchestrator/db/repository";
import {
  generateApiKey,
  verifyApiKey,
} from "../lib/ai-orchestrator/auth/api-key";

function repo() {
  return new OrchestratorRepository(createMemoryDb());
}

test("create user + lookup by id and email", async () => {
  const r = repo();
  const u = await r.createUser({
    email: "a@b.com",
    displayName: "A",
    role: "developer",
  });
  assert.equal(u.role, "developer");
  assert.equal(u.status, "active");
  assert.equal((await r.getUserById(u.id))?.email, "a@b.com");
  assert.equal((await r.getUserByEmail("a@b.com"))?.id, u.id);
});

test("create api key stores only the hash; raw verifies", async () => {
  const r = repo();
  const u = await r.createUser({ email: null, displayName: null, role: "admin" });
  const gen = generateApiKey();
  const key = await r.createApiKey({
    userId: u.id,
    keyPrefix: gen.prefix,
    keyHash: gen.hash,
    name: "k1",
  });
  // Raw key never stored.
  assert.equal(key.key_hash === gen.raw, false);
  assert.equal(key.key_hash, gen.hash);
  // Lookup by prefix + verify.
  const found = await r.getApiKeyByPrefix(gen.prefix);
  assert.ok(found);
  assert.equal(verifyApiKey(gen.raw, found!.key_hash), true);
  assert.equal(verifyApiKey("aiorch_wrong", found!.key_hash), false);
});

test("revoke key flips status", async () => {
  const r = repo();
  const u = await r.createUser({ email: null, displayName: null, role: "admin" });
  const gen = generateApiKey();
  const key = await r.createApiKey({
    userId: u.id,
    keyPrefix: gen.prefix,
    keyHash: gen.hash,
  });
  await r.revokeApiKey(key.id);
  const after = await r.getApiKeyById(key.id);
  assert.equal(after?.status, "revoked");
  assert.ok(after?.revoked_at);
});

test("updateApiKeyLastUsed sets a timestamp", async () => {
  const r = repo();
  const u = await r.createUser({ email: null, displayName: null, role: "admin" });
  const gen = generateApiKey();
  const key = await r.createApiKey({
    userId: u.id,
    keyPrefix: gen.prefix,
    keyHash: gen.hash,
  });
  assert.equal((await r.getApiKeyById(key.id))?.last_used_at, null);
  await r.updateApiKeyLastUsed(key.id);
  assert.ok((await r.getApiKeyById(key.id))?.last_used_at);
});

test("collaborators + permission overrides round-trip", async () => {
  const r = repo();
  const owner = await r.createUser({ email: null, displayName: null, role: "owner" });
  const session = await r.createSession("req", { userId: owner.id });
  const dev = await r.createUser({ email: null, displayName: null, role: "developer" });
  await r.addSessionCollaborator({
    sessionId: session.id,
    userId: dev.id,
    permission: "viewer",
  });
  assert.deepEqual(await r.getCollaboratorSessionIds(dev.id), [session.id]);
  assert.equal((await r.listSessionCollaborators(session.id)).length, 1);

  await r.addUserPermissionOverride({
    userId: dev.id,
    permission: "ai:session:approve",
    effect: "allow",
  });
  const overrides = await r.getUserPermissionOverrides(dev.id);
  assert.equal(overrides[0].permission, "ai:session:approve");
  assert.equal(overrides[0].effect, "allow");
});
