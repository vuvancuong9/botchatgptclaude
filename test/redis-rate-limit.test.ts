import { test } from "node:test";
import assert from "node:assert/strict";
import {
  UpstashRateLimitStore,
  MissingUpstashConfigError,
  resolveRateLimitProvider,
  getRateLimitStore,
  __resetRateLimitFactory,
} from "../lib/ai-orchestrator/security/redis-rate-limit";
import { rateLimit } from "../lib/ai-orchestrator/security/rate-limit";

interface Call {
  url: string;
  body: unknown[];
}

function makeFakeFetch() {
  const calls: Call[] = [];
  const counter = { n: 0 };
  const fetchImpl = async (
    url: string,
    init?: { body?: string },
  ) => {
    const body = JSON.parse(init?.body ?? "[]") as (string | number)[][];
    calls.push({ url, body });
    counter.n++;
    const results = body.map((cmd) => {
      const c = String(cmd[0]);
      if (c === "ZCARD") return { result: counter.n };
      if (c === "ZRANGE") return { result: ["m", String(1000)] };
      if (c === "PING") return { result: "PONG" };
      return { result: 1 };
    });
    return { ok: true, status: 200, json: async () => results };
  };
  return { fetchImpl, calls, counter };
}

test("upstash: under the limit -> allowed, over -> 429", async () => {
  const { fetchImpl } = makeFakeFetch();
  const store = new UpstashRateLimitStore({
    url: "https://example.upstash.io",
    token: "tok",
    fetchImpl,
  });
  // counter increments each hit: 1,2,3 ok (<=3), 4 blocked.
  assert.equal((await rateLimit("admin:fp", { store, limit: 3, now: 1 })).ok, true);
  assert.equal((await rateLimit("admin:fp", { store, limit: 3, now: 2 })).ok, true);
  assert.equal((await rateLimit("admin:fp", { store, limit: 3, now: 3 })).ok, true);
  const blocked = await rateLimit("admin:fp", { store, limit: 3, now: 4 });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.status, 429);
});

test("upstash: redis key uses fingerprint, never a raw admin key", async () => {
  const { fetchImpl, calls } = makeFakeFetch();
  const store = new UpstashRateLimitStore({
    url: "https://example.upstash.io",
    token: "super-secret-token",
    fetchImpl,
  });
  await store.hit("admin:fp123", 1000, 100);
  const lastBody = calls[calls.length - 1].body as (string | number)[][];
  const zadd = lastBody.find((cmd) => String(cmd[0]) === "ZADD");
  assert.ok(zadd);
  assert.equal(zadd![1], "airl:admin:fp123");
  // Token must not leak into the command body (it's a header only).
  const flat = JSON.stringify(lastBody);
  assert.equal(flat.includes("super-secret-token"), false);
});

test("upstash: ping returns true on PONG", async () => {
  const { fetchImpl } = makeFakeFetch();
  const store = new UpstashRateLimitStore({
    url: "https://example.upstash.io",
    token: "tok",
    fetchImpl,
  });
  assert.equal(await store.ping(), true);
});

test("upstash: missing env throws (no silent fallback)", () => {
  assert.throws(
    () => new UpstashRateLimitStore({ env: {} }),
    MissingUpstashConfigError,
  );
});

test("rate-limit provider resolution", () => {
  assert.equal(resolveRateLimitProvider(undefined), "memory");
  assert.equal(resolveRateLimitProvider("memory"), "memory");
  assert.equal(resolveRateLimitProvider("upstash"), "upstash");
  assert.throws(() => resolveRateLimitProvider("kafka"), /Unknown/);
});

test("getRateLimitStore: upstash provider but missing env throws", () => {
  process.env.AI_ORCHESTRATOR_RATE_LIMIT_PROVIDER = "upstash";
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  __resetRateLimitFactory();
  assert.throws(() => getRateLimitStore(), MissingUpstashConfigError);
  delete process.env.AI_ORCHESTRATOR_RATE_LIMIT_PROVIDER;
  __resetRateLimitFactory();
});

test("getRateLimitStore: memory provider returns in-memory store", () => {
  delete process.env.AI_ORCHESTRATOR_RATE_LIMIT_PROVIDER;
  __resetRateLimitFactory();
  const store = getRateLimitStore();
  assert.equal(typeof store.hit, "function");
  assert.equal(store.ping, undefined); // in-memory has no ping
});
