process.env.AI_ORCHESTRATOR_DB = ":memory:";
process.env.AI_ORCHESTRATOR_DB_PROVIDER = "sqlite";

import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryDb } from "../lib/ai-orchestrator/db";
import { OrchestratorRepository } from "../lib/ai-orchestrator/db/repository";
import {
  getProductionDryRunStatus,
  ProductionDryRunStatus,
} from "../lib/ai-orchestrator/production-dry-run";

const KEYS = [
  "NODE_ENV",
  "AI_ORCHESTRATOR_DB_PROVIDER",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "AI_ORCHESTRATOR_WORKER_PROVIDER",
  "AI_ORCHESTRATOR_TEST_RUNNER_MODE",
  "AI_ORCHESTRATOR_ALLOW_INLINE_COMMANDS",
  "AI_ORCHESTRATOR_PR_DRY_RUN",
  "AI_ORCHESTRATOR_ENABLE_GITHUB_PR",
  "AI_ORCHESTRATOR_CRON_KEY",
  "NEXT_PUBLIC_OPENAI_API_KEY",
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

/** A development env where every dry-run gate is green. */
function safeBase(): Record<string, string> {
  return {
    NODE_ENV: "development",
    AI_ORCHESTRATOR_TEST_RUNNER_MODE: "worker_async",
    AI_ORCHESTRATOR_WORKER_PROVIDER: "database",
    AI_ORCHESTRATOR_ALLOW_INLINE_COMMANDS: "0",
    AI_ORCHESTRATOR_PR_DRY_RUN: "1",
    AI_ORCHESTRATOR_ENABLE_GITHUB_PR: "1",
    AI_ORCHESTRATOR_CRON_KEY: "cron-secret-dry",
  };
}

function freshRepo(): OrchestratorRepository {
  return new OrchestratorRepository(createMemoryDb());
}

async function run(env: Record<string, string>): Promise<ProductionDryRunStatus> {
  apply(env);
  try {
    return await getProductionDryRunStatus({ repo: freshRepo() });
  } finally {
    restore();
  }
}

test("a green dev env (PR_DRY_RUN=1) is dry_run_safe", async () => {
  const status = await run(safeBase());
  assert.equal(status.dry_run_safe, true, JSON.stringify(status.blockers));
  assert.equal(status.blockers.length, 0);
});

test("PR_DRY_RUN=0 is a blocker (no live PR in a dry-run)", async () => {
  const status = await run({ ...safeBase(), AI_ORCHESTRATOR_PR_DRY_RUN: "0" });
  assert.equal(status.dry_run_safe, false);
  assert.ok(status.blockers.some((b) => b.includes("PR_DRY_RUN=0")));
});

test("non-worker_async test runner is a blocker", async () => {
  const status = await run({
    ...safeBase(),
    AI_ORCHESTRATOR_TEST_RUNNER_MODE: "inline",
  });
  assert.equal(status.dry_run_safe, false);
  assert.ok(status.blockers.some((b) => b.toLowerCase().includes("worker_async")));
});

test("inline commands enabled is a blocker", async () => {
  const status = await run({
    ...safeBase(),
    AI_ORCHESTRATOR_ALLOW_INLINE_COMMANDS: "1",
  });
  assert.equal(status.dry_run_safe, false);
  assert.ok(status.blockers.some((b) => b.includes("ALLOW_INLINE_COMMANDS")));
});

test("missing cron key in worker_async is a WARNING outside production", async () => {
  const env = safeBase();
  delete env.AI_ORCHESTRATOR_CRON_KEY;
  const status = await run(env);
  assert.equal(status.dry_run_safe, true); // warning, not a blocker, in dev
  assert.ok(status.warnings.some((w) => w.includes("CRON_KEY")));
  assert.equal(status.blockers.some((b) => b.includes("CRON_KEY")), false);
});

test("a readiness failure makes the dry-run unsafe", async () => {
  // production + sqlite provider => readiness db_provider fail (critical).
  const status = await run({
    ...safeBase(),
    NODE_ENV: "production",
    AI_ORCHESTRATOR_DB_PROVIDER: "sqlite",
  });
  assert.equal(status.dry_run_safe, false);
  assert.ok(status.blockers.length > 0);
});

test("the status never leaks a secret value", async () => {
  const status = await run({
    ...safeBase(),
    OPENAI_API_KEY: "sk-dryrun-secret-xyz",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-dryrun-xyz",
  });
  const json = JSON.stringify(status);
  assert.equal(json.includes("sk-dryrun-secret-xyz"), false);
  assert.equal(json.includes("service-role-dryrun-xyz"), false);
});
