import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMemoryDb } from "../lib/ai-orchestrator/db";
import { OrchestratorRepository } from "../lib/ai-orchestrator/db/repository";
import {
  applyPatchSet,
  isUnsafePatchPath,
} from "../lib/ai-orchestrator/worker/patch-applier";
import { PatchFileChangeType } from "../lib/ai-orchestrator/types";

interface SeedFile {
  path: string;
  action: PatchFileChangeType;
  content?: string | null;
}

async function seed(files: SeedFile[]) {
  const repo = new OrchestratorRepository(createMemoryDb());
  const session = await repo.createSession("apply test");
  const ps = await repo.createPatchSet({
    sessionId: session.id,
    userId: null,
    status: "validated",
    baseBranch: "main",
    targetBranch: "ai/x",
    baseSha: null,
    patchSummary: "seed",
    patchText: "preview",
    validationErrors: null,
  });
  for (const f of files) {
    await repo.addPatchFile({
      patchSetId: ps.id,
      filePath: f.path,
      changeType: f.action,
      oldContentHash: null,
      newContentHash: null,
      patchHunk: null,
      reason: null,
      newContentRedacted: f.content ?? null,
    });
  }
  return { repo, patchSetId: ps.id };
}

function workspace(): string {
  return mkdtempSync(join(tmpdir(), "ai-applier-"));
}

const noGit = { gitDiffStat: async () => "" };

test("isUnsafePatchPath blocks dangerous paths", () => {
  assert.ok(isUnsafePatchPath("/etc/passwd"));
  assert.ok(isUnsafePatchPath("../escape.ts"));
  assert.ok(isUnsafePatchPath("~/x"));
  assert.ok(isUnsafePatchPath(".git/config"));
  assert.ok(isUnsafePatchPath("node_modules/x.js"));
  assert.ok(isUnsafePatchPath(".env"));
  assert.ok(isUnsafePatchPath(".env.production"));
  assert.equal(isUnsafePatchPath("src/ok.ts"), null);
});

test("create writes a new file", async () => {
  const ws = workspace();
  try {
    const { repo, patchSetId } = await seed([
      { path: "src/new.ts", action: "create", content: "export const a = 1;" },
    ]);
    const r = await applyPatchSet(ws, repo, patchSetId, noGit);
    assert.equal(r.patchApplied, true);
    assert.deepEqual(r.changedFiles, ["src/new.ts"]);
    assert.equal(readFileSync(join(ws, "src/new.ts"), "utf8"), "export const a = 1;");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("modify rewrites an existing file", async () => {
  const ws = workspace();
  try {
    writeFileSync(join(ws, "f.ts"), "old");
    const { repo, patchSetId } = await seed([
      { path: "f.ts", action: "modify", content: "new content" },
    ]);
    const r = await applyPatchSet(ws, repo, patchSetId, noGit);
    assert.equal(r.patchApplied, true);
    assert.equal(readFileSync(join(ws, "f.ts"), "utf8"), "new content");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("delete removes an existing file", async () => {
  const ws = workspace();
  try {
    writeFileSync(join(ws, "gone.ts"), "x");
    const { repo, patchSetId } = await seed([
      { path: "gone.ts", action: "delete" },
    ]);
    const r = await applyPatchSet(ws, repo, patchSetId, noGit);
    assert.equal(r.patchApplied, true);
    assert.equal(existsSync(join(ws, "gone.ts")), false);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("modify a missing file fails", async () => {
  const ws = workspace();
  try {
    const { repo, patchSetId } = await seed([
      { path: "missing.ts", action: "modify", content: "x" },
    ]);
    const r = await applyPatchSet(ws, repo, patchSetId, noGit);
    assert.equal(r.patchApplied, false);
    assert.equal(r.errors[0].code, "modify_missing_file");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("create over an existing file fails", async () => {
  const ws = workspace();
  try {
    writeFileSync(join(ws, "exists.ts"), "x");
    const { repo, patchSetId } = await seed([
      { path: "exists.ts", action: "create", content: "y" },
    ]);
    const r = await applyPatchSet(ws, repo, patchSetId, noGit);
    assert.equal(r.patchApplied, false);
    assert.equal(r.errors[0].code, "create_existing_file");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("path traversal is blocked and nothing is written outside", async () => {
  const ws = workspace();
  try {
    const { repo, patchSetId } = await seed([
      { path: "../escape.ts", action: "create", content: "pwned" },
    ]);
    const r = await applyPatchSet(ws, repo, patchSetId, noGit);
    assert.equal(r.patchApplied, false);
    assert.equal(existsSync(join(ws, "..", "escape.ts")), false);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test(".env writes are blocked", async () => {
  const ws = workspace();
  try {
    const { repo, patchSetId } = await seed([
      { path: ".env", action: "create", content: "SECRET=1" },
    ]);
    const r = await applyPatchSet(ws, repo, patchSetId, noGit);
    assert.equal(r.patchApplied, false);
    assert.equal(existsSync(join(ws, ".env")), false);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("changed_files lists every applied file", async () => {
  const ws = workspace();
  try {
    mkdirSync(join(ws, "src"), { recursive: true });
    const { repo, patchSetId } = await seed([
      { path: "src/a.ts", action: "create", content: "a" },
      { path: "src/b.ts", action: "create", content: "b" },
    ]);
    const r = await applyPatchSet(ws, repo, patchSetId, noGit);
    assert.equal(r.patchApplied, true);
    assert.deepEqual(r.changedFiles.sort(), ["src/a.ts", "src/b.ts"]);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("a non-validated patch set is not applyable", async () => {
  const ws = workspace();
  try {
    const repo = new OrchestratorRepository(createMemoryDb());
    const s = await repo.createSession("x");
    const ps = await repo.createPatchSet({
      sessionId: s.id,
      userId: null,
      status: "failed",
      baseBranch: "main",
      targetBranch: "ai/x",
      baseSha: null,
      patchSummary: null,
      patchText: null,
      validationErrors: ["bad"],
    });
    await repo.addPatchFile({
      patchSetId: ps.id,
      filePath: "a.ts",
      changeType: "create",
      oldContentHash: null,
      newContentHash: null,
      patchHunk: null,
      reason: null,
      newContentRedacted: "x",
    });
    const r = await applyPatchSet(ws, repo, ps.id, noGit);
    assert.equal(r.patchApplied, false);
    assert.equal(r.errors[0].code, "patch_set_not_applyable");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
