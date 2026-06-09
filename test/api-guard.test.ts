// Guard tests use the legacy-admin path (enabled here) against in-memory SQLite.
process.env.AI_ORCHESTRATOR_DB = ":memory:";
process.env.AI_ORCHESTRATOR_DB_PROVIDER = "sqlite";
process.env.AI_ORCHESTRATOR_ALLOW_LEGACY_ADMIN_KEY = "1";

import { test } from "node:test";
import assert from "node:assert/strict";
import { guardRequest } from "../lib/ai-orchestrator/security/guard";
import { InMemoryRateLimitStore } from "../lib/ai-orchestrator/security/rate-limit";
import { ADMIN_KEY_HEADER } from "../lib/ai-orchestrator/security/auth";

const KEY = "route-test-admin-key";

function req(headers: Record<string, string>) {
  return {
    headers: {
      get(name: string): string | null {
        return headers[name.toLowerCase()] ?? null;
      },
    },
  };
}

// audit:false avoids DB writes in these unit tests.
const NO_AUDIT = { audit: false as const };

test("guard: missing key -> 401", async () => {
  process.env.AI_ORCHESTRATOR_ADMIN_KEY = KEY;
  const out = await guardRequest(req({}), NO_AUDIT);
  assert.equal(out.ok, false);
  if (!out.ok) assert.equal(out.response.status, 401);
  delete process.env.AI_ORCHESTRATOR_ADMIN_KEY;
});

test("guard: wrong legacy admin key -> 401", async () => {
  process.env.AI_ORCHESTRATOR_ADMIN_KEY = KEY;
  const out = await guardRequest(req({ [ADMIN_KEY_HEADER]: "wrong" }), NO_AUDIT);
  assert.equal(out.ok, false);
  if (!out.ok) assert.equal(out.response.status, 401);
  delete process.env.AI_ORCHESTRATOR_ADMIN_KEY;
});

test("guard: correct legacy admin key -> ok (owner context)", async () => {
  process.env.AI_ORCHESTRATOR_ADMIN_KEY = KEY;
  const out = await guardRequest(req({ [ADMIN_KEY_HEADER]: KEY }), NO_AUDIT);
  assert.equal(out.ok, true);
  if (out.ok) {
    assert.equal(out.context.role, "owner");
    assert.equal(out.context.legacyAdmin, true);
  }
  delete process.env.AI_ORCHESTRATOR_ADMIN_KEY;
});

test("guard: rate limit returns 429 after the cap", async () => {
  process.env.AI_ORCHESTRATOR_ADMIN_KEY = KEY;
  const store = new InMemoryRateLimitStore();
  const opts = {
    ...NO_AUDIT,
    rateLimited: true as const,
    rateLimit: { limit: 2, store },
  };
  const r = () => guardRequest(req({ [ADMIN_KEY_HEADER]: KEY }), opts);
  assert.equal((await r()).ok, true);
  assert.equal((await r()).ok, true);
  const blocked = await r();
  assert.equal(blocked.ok, false);
  if (!blocked.ok) {
    assert.equal(blocked.response.status, 429);
    assert.ok(blocked.response.headers.get("Retry-After"));
  }
  delete process.env.AI_ORCHESTRATOR_ADMIN_KEY;
});
