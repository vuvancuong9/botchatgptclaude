// Route tests against in-memory SQLite, using the legacy-admin owner path plus a
// real viewer key for the forbidden case. Each file runs in its own process, so
// these env mutations don't leak to other test files.
process.env.AI_ORCHESTRATOR_DB = ":memory:";
process.env.AI_ORCHESTRATOR_DB_PROVIDER = "sqlite";
process.env.AI_ORCHESTRATOR_ALLOW_LEGACY_ADMIN_KEY = "1";
process.env.AI_ORCHESTRATOR_ADMIN_KEY = "route-admin-key";

import { test } from "node:test";
import assert from "node:assert/strict";
import { POST } from "../app/api/ai-orchestrator/sessions/[id]/pull-request/route";
import { getRepository } from "../lib/ai-orchestrator/db/factory";
import { ADMIN_KEY_HEADER } from "../lib/ai-orchestrator/security/auth";
import {
  API_KEY_HEADER,
  generateApiKey,
} from "../lib/ai-orchestrator/auth/api-key";

const PATCH = JSON.stringify({
  files: [
    {
      path: "src/feature.ts",
      action: "create",
      content: "export const feature = () => 42;",
      reason: "add feature",
    },
  ],
  commands_to_run: ["npm test"],
  risk_notes: [],
});

type Req = { headers: { get(name: string): string | null } };
function req(headers: Record<string, string>): Req {
  return {
    headers: {
      get(name: string): string | null {
        return headers[name.toLowerCase()] ?? null;
      },
    },
  };
}
function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

const ADMIN = { [ADMIN_KEY_HEADER]: "route-admin-key" };

/** Volatile env touched by individual tests — reset before each. */
function resetGithubEnv() {
  delete process.env.AI_ORCHESTRATOR_ENABLE_GITHUB_PR;
  delete process.env.AI_ORCHESTRATOR_PR_DRY_RUN;
  delete process.env.AI_ORCHESTRATOR_REQUIRE_SMOKE_PASS;
  delete process.env.AI_ORCHESTRATOR_SUPABASE_SMOKE_PASSED_AT;
  delete process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_OWNER;
  delete process.env.GITHUB_REPO;
}

async function seedApprovedSession(): Promise<string> {
  const repo = getRepository();
  const s = await repo.createSession("seed request");
  await repo.addMessage({
    sessionId: s.id,
    step: "CLAUDE_CODE_IMPLEMENTER",
    provider: "anthropic",
    round: 1,
    output: {
      status: "pass",
      summary: "patch",
      issues: [],
      next_action: "continue",
      artifacts: [{ type: "patch", content: PATCH }],
    },
  });
  await repo.updateSession(s.id, { approval: "approved" });
  return s.id;
}

// We cast the minimal req to the route's NextRequest param (only headers used).
/* eslint-disable @typescript-eslint/no-explicit-any */

test("unauthorized request -> 401", async () => {
  resetGithubEnv();
  const res = await POST(req({}) as any, ctx("any-id") as any);
  assert.equal(res.status, 401);
});

test("authenticated but without ai:pr:create -> 403", async () => {
  resetGithubEnv();
  process.env.AI_ORCHESTRATOR_ENABLE_GITHUB_PR = "1";
  const repo = getRepository();
  const user = await repo.createUser({ email: "viewer@x.com", role: "viewer" });
  const key = generateApiKey();
  await repo.createApiKey({
    userId: user.id,
    keyPrefix: key.prefix,
    keyHash: key.hash,
  });
  const id = await seedApprovedSession();
  const res = await POST(
    req({ [API_KEY_HEADER]: key.raw }) as any,
    ctx(id) as any,
  );
  assert.equal(res.status, 403);
});

test("enabled + dry-run default -> 200 dry_run", async () => {
  resetGithubEnv();
  process.env.AI_ORCHESTRATOR_ENABLE_GITHUB_PR = "1"; // dry-run is the default
  const id = await seedApprovedSession();
  const res = await POST(req(ADMIN) as any, ctx(id) as any);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.mode, "dry_run");
  assert.equal(body.prUrl, null);
});

test("feature disabled -> 403 github_disabled", async () => {
  resetGithubEnv(); // ENABLE unset
  const id = await seedApprovedSession();
  const res = await POST(req(ADMIN) as any, ctx(id) as any);
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.blockedReason, "github_disabled");
});

test("live mode blocked when smoke pass is required but missing -> 412", async () => {
  resetGithubEnv();
  process.env.AI_ORCHESTRATOR_ENABLE_GITHUB_PR = "1";
  process.env.AI_ORCHESTRATOR_PR_DRY_RUN = "0"; // live
  process.env.GITHUB_TOKEN = "ghp_dummy_token_value_1234567890";
  process.env.GITHUB_OWNER = "o";
  process.env.GITHUB_REPO = "r";
  process.env.AI_ORCHESTRATOR_REQUIRE_SMOKE_PASS = "1";
  const id = await seedApprovedSession();
  const res = await POST(req(ADMIN) as any, ctx(id) as any);
  assert.equal(res.status, 412);
  const body = await res.json();
  assert.equal(body.blockedReason, "smoke_required");
  resetGithubEnv();
});
