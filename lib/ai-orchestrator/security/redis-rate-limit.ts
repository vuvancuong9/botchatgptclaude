import { randomUUID } from "node:crypto";
import {
  defaultRateLimitStore,
  RateLimitHit,
  RateLimitStore,
} from "./rate-limit";

/**
 * Upstash Redis (REST) rate-limit store. Uses plain fetch — no SDK dependency.
 *
 * Sliding window via a sorted set per identifier:
 *   ZREMRANGEBYSCORE  drop entries older than the window
 *   ZADD              add this request (score = now)
 *   ZCARD             count entries in the window
 *   ZRANGE 0 0        oldest entry (for Retry-After)
 *   PEXPIRE           bound the key's lifetime
 *
 * The Redis key uses ONLY the caller fingerprint/IP passed in — never a raw
 * admin key.
 */

export class MissingUpstashConfigError extends Error {
  constructor(missing: string[]) {
    super(
      `Upstash rate-limit selected but missing env: ${missing.join(", ")}. ` +
        `Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.`,
    );
    this.name = "MissingUpstashConfigError";
  }
}

type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface UpstashStoreOptions {
  url?: string;
  token?: string;
  keyPrefix?: string;
  fetchImpl?: FetchLike;
  env?: Record<string, string | undefined>;
}

export class UpstashRateLimitStore implements RateLimitStore {
  private readonly url: string;
  private readonly token: string;
  private readonly keyPrefix: string;
  private readonly fetchImpl: FetchLike;

  constructor(opts: UpstashStoreOptions = {}) {
    const env = opts.env ?? process.env;
    const url = opts.url ?? env.UPSTASH_REDIS_REST_URL;
    const token = opts.token ?? env.UPSTASH_REDIS_REST_TOKEN;
    const missing: string[] = [];
    if (!url) missing.push("UPSTASH_REDIS_REST_URL");
    if (!token) missing.push("UPSTASH_REDIS_REST_TOKEN");
    if (missing.length > 0) throw new MissingUpstashConfigError(missing);

    this.url = (url as string).replace(/\/$/, "");
    this.token = token as string;
    this.keyPrefix = opts.keyPrefix ?? "airl:";
    this.fetchImpl =
      opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  }

  private redisKey(identifier: string): string {
    // identifier is already a non-reversible fingerprint or IP — never raw key.
    return `${this.keyPrefix}${identifier}`;
  }

  private async pipeline(commands: (string | number)[][]): Promise<{ result: unknown }[]> {
    const res = await this.fetchImpl(`${this.url}/pipeline`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(commands),
    });
    if (!res.ok) {
      throw new Error(`Upstash pipeline failed with status ${res.status}`);
    }
    return (await res.json()) as { result: unknown }[];
  }

  async hit(key: string, windowMs: number, now: number): Promise<RateLimitHit> {
    const redisKey = this.redisKey(key);
    const member = `${now}-${randomUUID()}`;
    const results = await this.pipeline([
      ["ZREMRANGEBYSCORE", redisKey, 0, now - windowMs],
      ["ZADD", redisKey, now, member],
      ["ZCARD", redisKey],
      ["ZRANGE", redisKey, 0, 0, "WITHSCORES"],
      ["PEXPIRE", redisKey, windowMs],
    ]);
    const count = Number(results[2]?.result ?? 0);
    const oldestRange = results[3]?.result as unknown[] | undefined;
    const oldestTimestamp =
      oldestRange && oldestRange.length >= 2
        ? Number(oldestRange[1])
        : now;
    return { count, oldestTimestamp };
  }

  async reset(key?: string): Promise<void> {
    if (key === undefined) return;
    await this.pipeline([["DEL", this.redisKey(key)]]);
  }

  async ping(): Promise<boolean> {
    const res = await this.fetchImpl(`${this.url}/pipeline`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify([["PING"]]),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { result: unknown }[];
    return data[0]?.result === "PONG";
  }
}

export type RateLimitProvider = "memory" | "upstash";

export function resolveRateLimitProvider(
  raw: string | undefined = process.env.AI_ORCHESTRATOR_RATE_LIMIT_PROVIDER,
): RateLimitProvider {
  const value = (raw ?? "memory").trim().toLowerCase();
  if (value === "" || value === "memory") return "memory";
  if (value === "upstash" || value === "redis") return "upstash";
  throw new Error(
    `Unknown AI_ORCHESTRATOR_RATE_LIMIT_PROVIDER="${raw}" (expected "memory" or "upstash").`,
  );
}

let upstashSingleton: UpstashRateLimitStore | null = null;

/**
 * Returns the configured rate-limit store. "upstash" requires env (throws if
 * missing — no silent fallback to memory). "memory"/unset keeps the in-memory
 * store for local dev/test.
 */
export function getRateLimitStore(): RateLimitStore {
  if (resolveRateLimitProvider() === "upstash") {
    if (!upstashSingleton) upstashSingleton = new UpstashRateLimitStore();
    return upstashSingleton;
  }
  return defaultRateLimitStore;
}

export function __resetRateLimitFactory(): void {
  upstashSingleton = null;
}
