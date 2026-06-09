import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  driftHash,
  driftHashFile,
  hashFile,
  normalizeTextForHash,
  sha256Buffer,
  sha256Text,
} from "../lib/ai-orchestrator/patch/hash";

test("sha256Text is stable + deterministic", () => {
  const a = sha256Text("hello world");
  const b = sha256Text("hello world");
  assert.equal(a, b);
  assert.match(a, /^[a-f0-9]{64}$/);
  assert.notEqual(sha256Text("hello world"), sha256Text("hello worlld"));
});

test("sha256Buffer matches sha256Text for the same UTF-8 bytes", () => {
  assert.equal(sha256Buffer(Buffer.from("abc", "utf8")), sha256Text("abc"));
});

test("hashFile hashes the file's raw bytes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-hash-"));
  try {
    const p = join(dir, "f.txt");
    writeFileSync(p, "content-123", "utf8");
    assert.equal(await hashFile(p), sha256Buffer(Buffer.from("content-123", "utf8")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("normalizeTextForHash collapses CRLF/CR to LF", () => {
  assert.equal(normalizeTextForHash("a\r\nb\rc"), "a\nb\nc");
});

test("driftHash is line-ending agnostic (CRLF == LF)", () => {
  assert.equal(driftHash("a\r\nb"), driftHash("a\nb"));
  assert.equal(driftHash("x\ny"), driftHash("x\r\ny"));
  assert.notEqual(driftHash("a\nb"), driftHash("a\nb\n")); // trailing newline matters
});

test("driftHashFile normalizes line endings before hashing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-hash-"));
  try {
    const p = join(dir, "crlf.txt");
    writeFileSync(p, "line1\r\nline2", "utf8");
    assert.equal(await driftHashFile(p), driftHash("line1\nline2"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hashes are hex digests, never the content itself", () => {
  const secretish = "sk-ABCDEF";
  const h = sha256Text(secretish);
  assert.equal(h.includes(secretish), false);
  assert.match(h, /^[a-f0-9]{64}$/);
});
