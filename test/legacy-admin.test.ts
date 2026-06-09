process.env.AI_ORCHESTRATOR_DB = ":memory:";
process.env.AI_ORCHESTRATOR_DB_PROVIDER = "sqlite";

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { resolveAuthContext } from "../lib/ai-orchestrator/auth/context";
import { ADMIN_KEY_HEADER } from "../lib/ai-orchestrator/security/auth";

const ADMIN = "legacy-admin-secret";

beforeEach(() => {
  process.env.AI_ORCHESTRATOR_DB_PROVIDER = "sqlite";
});

function req(adminKey?: string) {
  return {
    headers: {
      get(name: string): string | null {
        if (name.toLowerCase() === ADMIN_KEY_HEADER && adminKey) return adminKey;
        return null;
      },
    },
  };
}

test("legacy admin key is disabled by default", async () => {
  process.env.AI_ORCHESTRATOR_ADMIN_KEY = ADMIN;
  delete process.env.AI_ORCHESTRATOR_ALLOW_LEGACY_ADMIN_KEY;
  const res = await resolveAuthContext(req(ADMIN));
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.status, 401);
  delete process.env.AI_ORCHESTRATOR_ADMIN_KEY;
});

test("legacy admin works only when explicitly enabled, audited as legacy_admin_used", async () => {
  process.env.AI_ORCHESTRATOR_ADMIN_KEY = ADMIN;
  process.env.AI_ORCHESTRATOR_ALLOW_LEGACY_ADMIN_KEY = "1";
  const res = await resolveAuthContext(req(ADMIN));
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.context.role, "owner");
    assert.equal(res.context.legacyAdmin, true);
    assert.equal(res.auditEvent, "legacy_admin_used");
  }
  delete process.env.AI_ORCHESTRATOR_ADMIN_KEY;
  delete process.env.AI_ORCHESTRATOR_ALLOW_LEGACY_ADMIN_KEY;
});

test("legacy enabled but wrong key still fails", async () => {
  process.env.AI_ORCHESTRATOR_ADMIN_KEY = ADMIN;
  process.env.AI_ORCHESTRATOR_ALLOW_LEGACY_ADMIN_KEY = "1";
  const res = await resolveAuthContext(req("wrong"));
  assert.equal(res.ok, false);
  delete process.env.AI_ORCHESTRATOR_ADMIN_KEY;
  delete process.env.AI_ORCHESTRATOR_ALLOW_LEGACY_ADMIN_KEY;
});
