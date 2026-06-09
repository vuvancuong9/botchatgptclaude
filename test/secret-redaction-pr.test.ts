process.env.AI_ORCHESTRATOR_DB = ":memory:";
process.env.AI_ORCHESTRATOR_DB_PROVIDER = "sqlite";

import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryDb } from "../lib/ai-orchestrator/db";
import { OrchestratorRepository } from "../lib/ai-orchestrator/db/repository";
import { redactSecrets, REDACTED } from "../lib/ai-orchestrator/security/redact";
import { validateAndStorePatch } from "../lib/ai-orchestrator/github/patch-service";

const SK = "sk-ABCD1234efgh5678ijklMNOP";
const GH = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

test("redactSecrets masks sk- and GitHub tokens", () => {
  assert.equal(redactSecrets(`key=${SK}`).includes(SK), false);
  assert.equal(redactSecrets(`key=${SK}`).includes(REDACTED), true);
  assert.equal(redactSecrets(`token=${GH}`).includes(GH), false);
  assert.equal(redactSecrets(`token=${GH}`).includes(REDACTED), true);
});

test("redactSecrets masks the GITHUB_TOKEN env value", () => {
  const out = redactSecrets("authorize with supersecretvalue12345", {
    GITHUB_TOKEN: "supersecretvalue12345",
  });
  assert.equal(out.includes("supersecretvalue12345"), false);
});

test("a patch containing sk-xxx is redacted before storage", async () => {
  const repo = new OrchestratorRepository(createMemoryDb());
  const session = await repo.createSession("leak test");
  const artifact = JSON.stringify({
    files: [
      {
        path: "src/config.ts",
        action: "create",
        content: `export const apiKey = "${SK}";`,
        reason: "store key",
      },
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
    targetBranch: "ai-orchestrator/session-x-1",
    canDelete: false,
  });

  // The validator rejects the secret, but whatever IS stored must be redacted.
  assert.equal(stored.ok, false);
  const set = await repo.getPatchSet(stored.patchSet.id);
  assert.ok(set);
  assert.equal((set!.patch_text ?? "").includes(SK), false);

  const files = await repo.getPatchFiles(stored.patchSet.id);
  for (const f of files) {
    assert.equal((f.patch_hunk ?? "").includes(SK), false);
  }
});
