import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * Phase 10 — password hashing for web login (per-user email + password).
 * scrypt with a random per-password salt. Format: "scrypt$<saltHex>$<hashHex>".
 * The raw password is never stored or logged.
 */

const KEYLEN = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEYLEN);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string | null): boolean {
  if (!stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[1], "hex");
    expected = Buffer.from(parts[2], "hex");
  } catch {
    return false;
  }
  if (expected.length === 0) return false;
  const actual = scryptSync(password, salt, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Minimal strength gate for new passwords. */
export function isAcceptablePassword(password: string): boolean {
  return typeof password === "string" && password.length >= 8;
}
