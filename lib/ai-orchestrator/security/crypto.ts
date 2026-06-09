import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

/**
 * Phase 10 — symmetric encryption for secrets stored in the DB (model API keys
 * entered via the web). AES-256-GCM with a key derived from a server secret.
 * The plaintext NEVER leaves the server; only the ciphertext is persisted.
 */

type Env = Record<string, string | undefined>;

/** 32-byte AES key derived from a server-only secret (never the raw secret). */
function aesKey(env: Env = process.env): Buffer {
  const secret =
    env.AI_ORCHESTRATOR_ENCRYPTION_KEY || env.AI_ORCHESTRATOR_API_KEY_PEPPER;
  if (!secret || secret.trim().length === 0) {
    throw new Error(
      "Encryption requires AI_ORCHESTRATOR_API_KEY_PEPPER (or AI_ORCHESTRATOR_ENCRYPTION_KEY).",
    );
  }
  return createHash("sha256").update(secret).digest();
}

/** True when a key is configured (so callers can fail fast / show a warning). */
export function encryptionConfigured(env: Env = process.env): boolean {
  return Boolean(
    (env.AI_ORCHESTRATOR_ENCRYPTION_KEY || env.AI_ORCHESTRATOR_API_KEY_PEPPER)?.trim(),
  );
}

/** Encrypt plaintext → "v1:<iv>:<tag>:<ciphertext>" (all base64). */
export function encryptSecret(plain: string, env: Env = process.env): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", aesKey(env), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}

/** Decrypt a "v1:..." blob produced by encryptSecret. Throws on tamper/bad key. */
export function decryptSecret(blob: string, env: Env = process.env): string {
  const parts = blob.split(":");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new Error("Malformed ciphertext.");
  }
  const [, ivB, tagB, ctB] = parts;
  const decipher = createDecipheriv(
    "aes-256-gcm",
    aesKey(env),
    Buffer.from(ivB, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tagB, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(ctB, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
