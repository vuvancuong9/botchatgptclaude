process.env.AI_ORCHESTRATOR_DB = ":memory:";
process.env.AI_ORCHESTRATOR_DB_PROVIDER = "sqlite";

import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryDb } from "../lib/ai-orchestrator/db";
import { OrchestratorRepository } from "../lib/ai-orchestrator/db/repository";
import {
  getProductionReadinessReport,
  ReadinessReport,
} from "../lib/ai-orchestrator/production-readiness";

const KEYS = [
  "NODE_ENV",
  "AI_ORCHESTRATOR_DB_PROVIDER",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "AI_ORCHESTRATOR_WORKER_PROVIDER",
  "AI_ORCHESTRATOR_REPO_CLONE_URL",
  "AI_ORCHESTRATOR_WORKER_CLAIM_VERIFIED",
  "AI_ORCHESTRATOR_WORKER_LEASE_VERIFIED",
  "AI_ORCHESTRATOR_WORKER_CONCURRENCY",
  "AI_ORCHESTRATOR_WORKER_LEASE_SECONDS",
  "AI_ORCHESTRATOR_WORKER_HEARTBEAT_INTERVAL_MS",
  "AI_ORCHESTRATOR_TEST_RUNNER_MODE",
  "AI_ORCHESTRATOR_CRON_KEY",
  "CRON_SECRET",
  "AI_ORCHESTRATOR_ALLOW_CRON_QUERY_KEY",
  "AI_ORCHESTRATOR_RATE_LIMIT_PROVIDER",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "AI_ORCHESTRATOR_SUPABASE_SMOKE_PASSED_AT",
  "AI_ORCHESTRATOR_ENABLE_GITHUB_PR",
  "AI_ORCHESTRATOR_PR_DRY_RUN",
  "GITHUB_TOKEN",
  "GITHUB_OWNER",
  "GITHUB_REPO",
  "AI_ORCHESTRATOR_ALLOW_LEGACY_ADMIN_KEY",
  "NEXT_PUBLIC_OPENAI_API_KEY",
  "NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY",
];
const saved: Record<string, string | undefined> = {};
for (const k of KEYS) saved[k] = process.env[k];
const E = process.env as Record<string, string | undefined>;

function apply(env: Record<string, string>) {
  for (const k of KEYS) delete E[k];
  for (const [k, v] of Object.entries(env)) E[k] = v;
}
function restore() {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete E[k];
    else E[k] = saved[k];
  }
}

function baseProd(): Record<string, string> {
  return {
    NODE_ENV: "production",
    AI_ORCHESTRATOR_DB_PROVIDER: "postgres",
    SUPABASE_URL: "https://proj.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-secret-aaa",
    OPENAI_API_KEY: "sk-openai-aaa",
    ANTHROPIC_API_KEY: "sk-ant-aaa",
    AI_ORCHESTRATOR_WORKER_PROVIDER: "database",
    AI_ORCHESTRATOR_REPO_CLONE_URL: "https://github.com/o/r.git",
    AI_ORCHESTRATOR_WORKER_CLAIM_VERIFIED: "1",
    AI_ORCHESTRATOR_WORKER_LEASE_VERIFIED: "1",
    AI_ORCHESTRATOR_WORKER_CONCURRENCY: "1",
    AI_ORCHESTRATOR_TEST_RUNNER_MODE: "worker_async",
    AI_ORCHESTRATOR_CRON_KEY: "cron-secret-aaa",
    AI_ORCHESTRATOR_RATE_LIMIT_PROVIDER: "upstash",
    UPSTASH_REDIS_REST_URL: "https://redis.upstash.io",
    UPSTASH_REDIS_REST_TOKEN: "upstash-token-aaa",
    AI_ORCHESTRATOR_SUPABASE_SMOKE_PASSED_AT: "2026-06-01T00:00:00Z",
  };
}

async function freshRepo(withOwner = true): Promise<OrchestratorRepository> {
  const repo = new OrchestratorRepository(createMemoryDb());
  if (withOwner) {
    const owner = await repo.createUser({ email: "o@test.local", role: "owner" });
    await repo.createApiKey({
      userId: owner.id,
      keyPrefix: "pfx12345",
      keyHash: "hash-value",
    });
  }
  return repo;
}

async function run(
  env: Record<string, string>,
  repo: OrchestratorRepository,
): Promise<ReadinessReport> {
  apply(env);
  try {
    return await getProductionReadinessReport({ repo });
  } finally {
    restore();
  }
}

function find(r: ReadinessReport, id: string) {
  const c = r.checks.find((x) => x.id === id);
  assert.ok(c, `check ${id} missing`);
  return c!;
}

test("production with sqlite provider -> db_provider fail critical", async () => {
  const report = await run(
    { ...baseProd(), AI_ORCHESTRATOR_DB_PROVIDER: "sqlite" },
    await freshRepo(),
  );
  const c = find(report, "db_provider");
  assert.equal(c.status, "fail");
  assert.equal(c.severity, "critical");
  assert.equal(report.ok, false);
});

test("missing Supabase env -> supabase_env fail critical", async () => {
  const env = baseProd();
  delete env.SUPABASE_URL;
  delete env.SUPABASE_SERVICE_ROLE_KEY;
  const report = await run(env, await freshRepo());
  const c = find(report, "supabase_env");
  assert.equal(c.status, "fail");
  assert.equal(c.severity, "critical");
});

test("missing model keys -> model_keys fail high", async () => {
  const env = baseProd();
  delete env.OPENAI_API_KEY;
  delete env.ANTHROPIC_API_KEY;
  const report = await run(env, await freshRepo());
  const c = find(report, "model_keys");
  assert.equal(c.status, "fail");
  assert.equal(c.severity, "high");
});

test("in-memory rate limit in production -> rate_limit warn high", async () => {
  const env = baseProd();
  env.AI_ORCHESTRATOR_RATE_LIMIT_PROVIDER = "memory";
  delete env.UPSTASH_REDIS_REST_URL;
  delete env.UPSTASH_REDIS_REST_TOKEN;
  const report = await run(env, await freshRepo());
  const c = find(report, "rate_limit");
  assert.equal(c.status, "warn");
  assert.equal(c.severity, "high");
});

test("unsafe NEXT_PUBLIC secret -> unsafe_public_secrets fail critical", async () => {
  const env = baseProd();
  env.NEXT_PUBLIC_OPENAI_API_KEY = "sk-leaked-to-browser";
  const report = await run(env, await freshRepo());
  const c = find(report, "unsafe_public_secrets");
  assert.equal(c.status, "fail");
  assert.equal(c.severity, "critical");
  assert.equal(report.ok, false);
  // never echoes the secret VALUE
  assert.equal(JSON.stringify(report).includes("sk-leaked-to-browser"), false);
});

test("missing smoke flags -> smoke_flags warn high", async () => {
  const env = baseProd();
  delete env.AI_ORCHESTRATOR_SUPABASE_SMOKE_PASSED_AT;
  delete env.AI_ORCHESTRATOR_WORKER_CLAIM_VERIFIED;
  delete env.AI_ORCHESTRATOR_WORKER_LEASE_VERIFIED;
  const report = await run(env, await freshRepo());
  const c = find(report, "smoke_flags");
  assert.equal(c.status, "warn");
  assert.equal(c.severity, "high");
});

test("a fully configured production env -> ok true, no fails", async () => {
  const report = await run(baseProd(), await freshRepo(true));
  assert.equal(report.environment, "production");
  assert.equal(report.summary.fail, 0, JSON.stringify(report.checks));
  assert.equal(report.ok, true);
});

test("non-production skips the production-only checks", async () => {
  const report = await run({ NODE_ENV: "development" }, await freshRepo(false));
  assert.equal(report.environment, "development");
  assert.equal(find(report, "db_provider").status, "skip");
  assert.equal(find(report, "rbac_owner").status, "skip");
  // schema + unsafe-secret checks still run even in dev
  assert.equal(find(report, "schema_tables").status, "pass");
  assert.equal(find(report, "unsafe_public_secrets").status, "pass");
});
