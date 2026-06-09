import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * API key format:  aiorch_<random>     (e.g. aiorch_3f9a...c21)
 *
 * - The RAW key is shown to the user exactly once and never stored.
 * - We store key_prefix (fast lookup) + key_hash (verification).
 * - key_hash is HMAC-SHA256 when AI_ORCHESTRATOR_API_KEY_PEPPER is set,
 *   otherwise SHA-256. Both are one-way.
 */

export const API_KEY_HEADER = "x-ai-api-key";
const PREFIX_TOKEN = "aiorch_";
const LOOKUP_PREFIX_LEN = 12;

export interface GeneratedApiKey {
  /** Full raw key — show once, never persist. */
  raw: string;
  /** Stored for fast lookup. */
  prefix: string;
  /** Stored for verification. */
  hash: string;
}

function base62(bytes: Buffer): string {
  const alphabet =
    "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let out = "";
  for (const b of bytes) out += alphabet[b % 62];
  return out;
}

export function hashApiKey(
  raw: string,
  pepper: string | undefined = process.env.AI_ORCHESTRATOR_API_KEY_PEPPER,
): string {
  if (pepper && pepper.length > 0) {
    return createHmac("sha256", pepper).update(raw).digest("hex");
  }
  return createHash("sha256").update(raw).digest("hex");
}

export function generateApiKey(): GeneratedApiKey {
  const random = base62(randomBytes(32));
  const raw = `${PREFIX_TOKEN}${random}`;
  return {
    raw,
    prefix: random.slice(0, LOOKUP_PREFIX_LEN),
    hash: hashApiKey(raw),
  };
}

export interface ParsedApiKey {
  prefix: string;
  raw: string;
}

/** Parse an incoming key; returns null when malformed. */
export function parseApiKey(raw: string | null | undefined): ParsedApiKey | null {
  if (!raw || !raw.startsWith(PREFIX_TOKEN)) return null;
  const random = raw.slice(PREFIX_TOKEN.length);
  if (random.length < LOOKUP_PREFIX_LEN) return null;
  return { prefix: random.slice(0, LOOKUP_PREFIX_LEN), raw };
}

/** Timing-safe comparison of the provided key against a stored hash. */
export function verifyApiKey(raw: string, storedHash: string): boolean {
  const candidate = Buffer.from(hashApiKey(raw), "utf8");
  const stored = Buffer.from(storedHash, "utf8");
  if (candidate.length !== stored.length) return false;
  return timingSafeEqual(candidate, stored);
}

/** Short non-reversible fingerprint for rate-limiting / audit (never the key). */
export function apiKeyFingerprint(prefix: string): string {
  return `key:${prefix}`;
}
