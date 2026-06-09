import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hashPassword,
  isAcceptablePassword,
  verifyPassword,
} from "../lib/ai-orchestrator/auth/password";

test("hash → verify round-trips", () => {
  const h = hashPassword("correct horse battery");
  assert.ok(verifyPassword("correct horse battery", h));
  assert.equal(verifyPassword("wrong password", h), false);
});

test("the hash never contains the raw password", () => {
  assert.equal(hashPassword("plaintextpw123").includes("plaintextpw123"), false);
});

test("verify against a null/garbage hash is false (no throw)", () => {
  assert.equal(verifyPassword("x", null), false);
  assert.equal(verifyPassword("x", "not-a-hash"), false);
  assert.equal(verifyPassword("x", "scrypt$zz$zz"), false);
});

test("two hashes of the same password differ (random salt)", () => {
  assert.notEqual(hashPassword("samepass1"), hashPassword("samepass1"));
});

test("password strength gate", () => {
  assert.equal(isAcceptablePassword("short"), false);
  assert.equal(isAcceptablePassword("12345678"), true);
});
