// Ensure DB-backed audit tests use an isolated in-memory SQLite DB.
process.env.AI_ORCHESTRATOR_DB = ":memory:";
process.env.AI_ORCHESTRATOR_DB_PROVIDER = "sqlite";

import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryDb } from "../lib/ai-orchestrator/db";
import { OrchestratorRepository } from "../lib/ai-orchestrator/db/repository";
import { recordAudit, hashValue } from "../lib/ai-orchestrator/audit";
import { getRepository } from "../lib/ai-orchestrator/db/factory";

test("hashValue: deterministic, non-reversible, null-safe", () => {
  assert.equal(hashValue(null), null);
  assert.equal(hashValue(""), null);
  const h = hashValue("1.2.3.4");
  assert.equal(h, hashValue("1.2.3.4"));
  assert.notEqual(h, "1.2.3.4");
  assert.equal(typeof h, "string");
});

test("repository: addAuditLog stores hashes, getAuditLogs reads back", async () => {
  const repo = new OrchestratorRepository(createMemoryDb());
  await repo.addAuditLog({
    eventType: "auth_failed",
    status: "denied",
    adminKeyFingerprint: "admin:fp",
    ipHash: hashValue("9.9.9.9"),
    userAgentHash: hashValue("curl/8"),
    metadata: { reason: "Invalid admin key." },
  });
  const logs = await repo.getAuditLogs(10);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].event_type, "auth_failed");
  assert.equal(logs[0].status, "denied");
  // Raw IP never stored.
  assert.notEqual(logs[0].ip_hash, "9.9.9.9");
  assert.equal(logs[0].metadata.reason, "Invalid admin key.");
});

test("recordAudit: redacts secrets in metadata before storing", async () => {
  await recordAudit({
    eventType: "ai_run_failed",
    status: "fail",
    metadata: { error: "boom with token sk-leakydleaky1234567" },
  });
  const logs = await getRepository().getAuditLogs(20);
  const failed = logs.find((l) => l.event_type === "ai_run_failed");
  assert.ok(failed);
  assert.equal(
    String(failed!.metadata.error).includes("sk-leakydleaky1234567"),
    false,
  );
});

test("recordAudit: never throws even if the backend is misconfigured", async () => {
  const saved = process.env.AI_ORCHESTRATOR_DB_PROVIDER;
  process.env.AI_ORCHESTRATOR_DB_PROVIDER = "bogus-provider";
  // resolveDbProvider throws inside getRepository -> recordAudit must swallow it.
  await recordAudit({ eventType: "auth_passed", status: "ok" });
  process.env.AI_ORCHESTRATOR_DB_PROVIDER = saved;
  assert.ok(true); // reaching here means no throw
});
