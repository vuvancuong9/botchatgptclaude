import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMemoryDb } from "../lib/ai-orchestrator/db";
import { OrchestratorRepository } from "../lib/ai-orchestrator/db/repository";
import { applyPatchSet } from "../lib/ai-orchestrator/worker/patch-applier";
import { driftHash } from "../lib/ai-orchestrator/patch/hash";
import { PatchFileChangeType } from "../lib/ai-orchestrator/types";

interface SeedFile {
  path: string;
  action: PatchFileChangeType;
  content?: string | null;
  oldHash?: string | null;
}

async function seed(files: SeedFile[]) {
  const repo = new OrchestratorRepository(createMemoryDb());
  const session = await repo.createSession("hash apply");
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
      oldContentHash: f.oldHash ?? null,
      newContentHash: null,
      patchHunk: null,
      reason: null,
      newContentRedacted: f.content ?? null,
    });
  }
  return { repo, patchSetId: ps.id };
}

const ws = () => mkdtempSync(join(tmpdir(), "ai-hash-apply-"));
const noGit = { gitDiffStat: async () => "" };

test("modify passes when the current hash matches old_content_hash (CRLF tolerant)", async () => {
  const dir = ws();
  try {
    writeFileSync(join(dir, "f.ts"), "base\r\nline"); // CRLF on disk
    const { repo, patchSetId } = await seed([
      { path: "f.ts", action: "modify", content: "new", oldHash: driftHash("base\nline") },
    ]);
    const r = await applyPatchSet(dir, repo, patchSetId, noGit);
    assert.equal(r.patchApplied, true);
    assert.equal(r.baseHashChecked, true);
    assert.equal(readFileSync(join(dir, "f.ts"), "utf8"), "new");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("modify fails (base_hash_mismatch) when the file drifted", async () => {
  const dir = ws();
  try {
    writeFileSync(join(dir, "f.ts"), "changed by someone else");
    const { repo, patchSetId } = await seed([
      { path: "f.ts", action: "modify", content: "new", oldHash: driftHash("original") },
    ]);
    const r = await applyPatchSet(dir, repo, patchSetId, noGit);
    assert.equal(r.patchApplied, false);
    assert.equal(r.errors[0].code, "base_hash_mismatch");
    assert.equal(r.errors[0].file_path, "f.ts");
    // The file is NOT overwritten when drift is detected.
    assert.equal(readFileSync(join(dir, "f.ts"), "utf8"), "changed by someone else");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("delete passes on match, fails on mismatch", async () => {
  const dir = ws();
  try {
    writeFileSync(join(dir, "del.ts"), "gone");
    const ok = await seed([
      { path: "del.ts", action: "delete", oldHash: driftHash("gone") },
    ]);
    const r1 = await applyPatchSet(dir, ok.repo, ok.patchSetId, noGit);
    assert.equal(r1.patchApplied, true);
    assert.equal(existsSync(join(dir, "del.ts")), false);

    writeFileSync(join(dir, "del2.ts"), "actual");
    const bad = await seed([
      { path: "del2.ts", action: "delete", oldHash: driftHash("expected") },
    ]);
    const r2 = await applyPatchSet(dir, bad.repo, bad.patchSetId, noGit);
    assert.equal(r2.patchApplied, false);
    assert.equal(r2.errors[0].code, "base_hash_mismatch");
    assert.equal(existsSync(join(dir, "del2.ts")), true); // not deleted
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("strict + missing old_content_hash fails (missing_old_content_hash)", async () => {
  const dir = ws();
  try {
    writeFileSync(join(dir, "f.ts"), "base");
    const { repo, patchSetId } = await seed([
      { path: "f.ts", action: "modify", content: "new", oldHash: null },
    ]);
    const r = await applyPatchSet(dir, repo, patchSetId, { ...noGit, strict: true });
    assert.equal(r.patchApplied, false);
    assert.equal(r.errors[0].code, "missing_old_content_hash");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("non-strict + missing hash applies but base_hash_checked=false", async () => {
  const dir = ws();
  try {
    writeFileSync(join(dir, "f.ts"), "base");
    const { repo, patchSetId } = await seed([
      { path: "f.ts", action: "modify", content: "new", oldHash: null },
    ]);
    const r = await applyPatchSet(dir, repo, patchSetId, { ...noGit, strict: false });
    assert.equal(r.patchApplied, true);
    assert.equal(r.baseHashChecked, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("create over an existing file still fails; rename is unsupported", async () => {
  const dir = ws();
  try {
    writeFileSync(join(dir, "exists.ts"), "x");
    const c = await seed([
      { path: "exists.ts", action: "create", content: "y" },
    ]);
    const r1 = await applyPatchSet(dir, c.repo, c.patchSetId, noGit);
    assert.equal(r1.errors[0].code, "create_existing_file");

    const rn = await seed([{ path: "r.ts", action: "rename", content: "z" }]);
    const r2 = await applyPatchSet(dir, rn.repo, rn.patchSetId, noGit);
    assert.equal(r2.errors[0].code, "rename_not_supported");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
