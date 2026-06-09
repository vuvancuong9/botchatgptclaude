import { test } from "node:test";
import assert from "node:assert/strict";
import {
  rateLimit,
  InMemoryRateLimitStore,
} from "../lib/ai-orchestrator/security/rate-limit";

test("under the limit -> allowed", async () => {
  const store = new InMemoryRateLimitStore();
  const now = 1_000_000;
  for (let i = 0; i < 10; i++) {
    const r = await rateLimit("key", { store, now: now + i, limit: 10 });
    assert.equal(r.ok, true, `request ${i} allowed`);
    assert.equal(r.status, 200);
  }
});

test("exceeding the limit -> 429", async () => {
  const store = new InMemoryRateLimitStore();
  const now = 2_000_000;
  let last = await rateLimit("key", { store, now, limit: 10 });
  for (let i = 1; i < 11; i++) {
    last = await rateLimit("key", { store, now: now + i, limit: 10 });
  }
  assert.equal(last.ok, false);
  assert.equal(last.status, 429);
  assert.ok(last.retryAfter > 0);
});

test("window slides: old hits expire", async () => {
  const store = new InMemoryRateLimitStore();
  const windowMs = 10 * 60 * 1000;
  for (let i = 0; i < 10; i++) {
    await rateLimit("k", { store, now: 100 + i, limit: 10, windowMs });
  }
  const blocked = await rateLimit("k", { store, now: 200, limit: 10, windowMs });
  assert.equal(blocked.ok, false);
  const later = await rateLimit("k", {
    store,
    now: 200 + windowMs + 1,
    limit: 10,
    windowMs,
  });
  assert.equal(later.ok, true);
});

test("different identifiers are independent", async () => {
  const store = new InMemoryRateLimitStore();
  for (let i = 0; i < 11; i++) {
    await rateLimit("a", { store, now: 1 + i, limit: 10 });
  }
  const b = await rateLimit("b", { store, now: 50, limit: 10 });
  assert.equal(b.ok, true);
});
