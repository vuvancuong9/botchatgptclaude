process.env.AI_ORCHESTRATOR_DB = ":memory:";
process.env.AI_ORCHESTRATOR_DB_PROVIDER = "sqlite";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMemoryDb } from "../lib/ai-orchestrator/db";
import { OrchestratorRepository } from "../lib/ai-orchestrator/db/repository";
import { validateAndStorePatch } from "../lib/ai-orchestrator/github/patch-service";
import { applyPatchSet } from "../lib/ai-orchestrator/worker/patch-applier";

// A large body (>4KB) proves new_content_redacted stores the FULL content,
// unlike patch_hunk which is truncated to a 4KB preview.
const BIG = "export const x = 1;\n".repeat(400); // ~7.6 KB

test("validate stores the full content (not just the truncated preview)", async () => {
  const repo = new OrchestratorRepository(createMemoryDb());
  const session = await repo.createSession("storage test");
  const artifact = JSON.stringify({
    files: [{ path: "src/big.ts", action: "create", content: BIG, reason: "big" }],
    commands_to_run: ["npm test"],
    risk_notes: [],
  });
  const stored = await validateAndStorePatch({
    repo,
    session,
    userId: null,
    artifactText: artifact,
    baseBranch: "main",
    targetBranch: "ai/x",
    canDelete: false,
  });
  assert.equal(stored.ok, true);
  const files = await repo.getPatchFiles(stored.patchSet.id);
  assert.equal(files[0].new_content_redacted, BIG);
  assert.ok(files[0].new_content_redacted!.length > 4096);
  // patch_hunk stays a truncated preview.
  assert.ok((files[0].patch_hunk ?? "").length <= 4000);
});

test("the worker can apply exactly the stored content", async () => {
  const repo = new OrchestratorRepository(createMemoryDb());
  const session = await repo.createSession("apply storage");
  const artifact = JSON.stringify({
    files: [{ path: "src/big.ts", action: "create", content: BIG, reason: "big" }],
    commands_to_run: ["npm test"],
    risk_notes: [],
  });
  const stored = await validateAndStorePatch({
    repo,
    session,
    userId: null,
    artifactText: artifact,
    baseBranch: "main",
    targetBranch: "ai/x",
    canDelete: false,
  });
  const ws = mkdtempSync(join(tmpdir(), "ai-store-"));
  try {
    const r = await applyPatchSet(ws, repo, stored.patchSet.id, {
      gitDiffStat: async () => "",
    });
    assert.equal(r.patchApplied, true);
    assert.equal(readFileSync(join(ws, "src/big.ts"), "utf8"), BIG);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("a patch containing sk-xxx is rejected and no raw secret is stored", async () => {
  const SK = "sk-ABCD1234efgh5678ijklMNOP";
  const repo = new OrchestratorRepository(createMemoryDb());
  const session = await repo.createSession("secret test");
  const artifact = JSON.stringify({
    files: [
      { path: "src/cfg.ts", action: "create", content: `const k="${SK}";`, reason: "k" },
    ],
    commands_to_run: ["npm test"],
    risk_notes: [],
  });
  const stored = await validateAndStorePatch({
    repo,
    session,
    userId: null,
    artifactText: artifact,
    baseBranch: "main",
    targetBranch: "ai/x",
    canDelete: false,
  });
  assert.equal(stored.ok, false); // validator rejects secrets
  const set = await repo.getPatchSet(stored.patchSet.id);
  assert.equal(set!.status, "failed");
  assert.equal((set!.patch_text ?? "").includes(SK), false);
  const files = await repo.getPatchFiles(stored.patchSet.id);
  for (const f of files) {
    assert.equal((f.new_content_redacted ?? "").includes(SK), false);
    assert.equal((f.patch_hunk ?? "").includes(SK), false);
  }
});
