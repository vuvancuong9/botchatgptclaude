import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkAdminKey,
  requireAiAdminAuth,
  ADMIN_KEY_HEADER,
} from "../lib/ai-orchestrator/security/auth";

const CONFIGURED = "super-secret-admin-key";

function fakeReq(headerValue: string | null) {
  return {
    headers: {
      get(name: string) {
        return name.toLowerCase() === ADMIN_KEY_HEADER ? headerValue : null;
      },
    },
  };
}

test("missing key -> 401", () => {
  const r = checkAdminKey(null, CONFIGURED);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.status, 401);
});

test("empty key -> 401", () => {
  const r = checkAdminKey("", CONFIGURED);
  assert.equal(r.ok, false);
});

test("wrong key -> 401", () => {
  const r = checkAdminKey("nope", CONFIGURED);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.status, 401);
});

test("correct key -> ok with identifier", () => {
  const r = checkAdminKey(CONFIGURED, CONFIGURED);
  assert.equal(r.ok, true);
  if (r.ok) assert.match(r.identifier, /^admin:/);
});

test("identifier never contains the raw key", () => {
  const r = checkAdminKey(CONFIGURED, CONFIGURED);
  if (r.ok) assert.equal(r.identifier.includes(CONFIGURED), false);
});

test("server not configured -> 401 (closed by default)", () => {
  const r = checkAdminKey(CONFIGURED, undefined);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.status, 401);
});

test("requireAiAdminAuth reads the header", () => {
  process.env.AI_ORCHESTRATOR_ADMIN_KEY = CONFIGURED;
  assert.equal(requireAiAdminAuth(fakeReq(CONFIGURED)).ok, true);
  assert.equal(requireAiAdminAuth(fakeReq("wrong")).ok, false);
  assert.equal(requireAiAdminAuth(fakeReq(null)).ok, false);
  delete process.env.AI_ORCHESTRATOR_ADMIN_KEY;
});
