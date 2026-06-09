/**
 * Sliding-window rate limiter with a swappable, async storage backend.
 *
 * The store contract is async so it works for both the in-memory MVP store and
 * a Redis/Upstash REST store (see redis-rate-limit.ts). Business rule is fixed:
 * 10 requests / 10 minutes per identifier (admin-key fingerprint or IP).
 */

export interface RateLimitOptions {
  /** Max requests allowed within the window. Default 10. */
  limit?: number;
  /** Window length in ms. Default 10 minutes. */
  windowMs?: number;
  /** Storage backend. Default: shared in-memory store. */
  store?: RateLimitStore;
  /** Injectable clock for tests. Default Date.now. */
  now?: number;
}

export interface RateLimitResult {
  ok: boolean;
  limit: number;
  remaining: number;
  /** Seconds until the window frees up (when blocked). */
  retryAfter: number;
  status: 200 | 429;
}

export interface RateLimitHit {
  /** Number of hits inside the current window (including this one). */
  count: number;
  /** Timestamp (ms) of the oldest hit still in the window. */
  oldestTimestamp: number;
}

export interface RateLimitStore {
  /** Record a hit at `now`; return the in-window count + oldest timestamp. */
  hit(key: string, windowMs: number, now: number): Promise<RateLimitHit>;
  reset(key?: string): void | Promise<void>;
  /** Optional connectivity probe (used by the health endpoint). */
  ping?(): Promise<boolean>;
}

export class InMemoryRateLimitStore implements RateLimitStore {
  private readonly hits = new Map<string, number[]>();

  async hit(key: string, windowMs: number, now: number): Promise<RateLimitHit> {
    const cutoff = now - windowMs;
    const existing = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    existing.push(now);
    this.hits.set(key, existing);
    return { count: existing.length, oldestTimestamp: existing[0] ?? now };
  }

  reset(key?: string): void {
    if (key === undefined) this.hits.clear();
    else this.hits.delete(key);
  }
}

/** Module-level default store (swap for Redis-backed store in production). */
export const defaultRateLimitStore = new InMemoryRateLimitStore();

export const DEFAULT_LIMIT = 10;
export const DEFAULT_WINDOW_MS = 10 * 60 * 1000;

export async function rateLimit(
  identifier: string,
  opts: RateLimitOptions = {},
): Promise<RateLimitResult> {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const store = opts.store ?? defaultRateLimitStore;
  const now = opts.now ?? Date.now();

  const { count, oldestTimestamp } = await store.hit(identifier, windowMs, now);
  const remaining = Math.max(0, limit - count);

  if (count > limit) {
    const retryAfter = Math.max(
      1,
      Math.ceil((oldestTimestamp + windowMs - now) / 1000),
    );
    return { ok: false, limit, remaining: 0, retryAfter, status: 429 };
  }

  return { ok: true, limit, remaining, retryAfter: 0, status: 200 };
}
