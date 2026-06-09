import { getRepository } from "./db/factory";
import {
  decryptSecret,
  encryptSecret,
  encryptionConfigured,
} from "./security/crypto";

/**
 * Phase 10 — model API keys entered via the web, stored AES-encrypted in
 * ai_settings. Resolution order: DB (decrypted) first, else process.env. The
 * plaintext key never leaves the server and is never returned by status APIs.
 */

const K_OPENAI = "openai_api_key";
const K_ANTHROPIC = "anthropic_api_key";
const K_OPENAI_MODEL = "openai_model";
const K_ANTHROPIC_MODEL = "anthropic_model";

export type ModelProvider = "openai" | "anthropic";

export interface ResolvedModelKeys {
  openai?: string;
  anthropic?: string;
  openaiModel?: string;
  anthropicModel?: string;
}

export interface ModelKeyStatus {
  openai_set: boolean;
  anthropic_set: boolean;
  openai_in_db: boolean;
  anthropic_in_db: boolean;
  openai_model: string | null;
  anthropic_model: string | null;
  encryption_configured: boolean;
}

/** Decrypt a stored secret; returns null when absent, empty (cleared), or tampered. */
async function readSecret(key: string): Promise<string | null> {
  const row = await getRepository().getSetting(key);
  if (!row) return null;
  try {
    const v = decryptSecret(row.value);
    return v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

async function readPlain(key: string): Promise<string | null> {
  const row = await getRepository().getSetting(key);
  return row && row.value.length > 0 ? row.value : null;
}

/** Resolve effective model keys + model names (DB first, then env). */
export async function resolveModelKeys(): Promise<ResolvedModelKeys> {
  const [dbOpenai, dbAnthropic, dbOpenaiModel, dbAnthropicModel] =
    await Promise.all([
      readSecret(K_OPENAI),
      readSecret(K_ANTHROPIC),
      readPlain(K_OPENAI_MODEL),
      readPlain(K_ANTHROPIC_MODEL),
    ]);
  return {
    openai: dbOpenai ?? process.env.OPENAI_API_KEY ?? undefined,
    anthropic: dbAnthropic ?? process.env.ANTHROPIC_API_KEY ?? undefined,
    openaiModel: dbOpenaiModel ?? process.env.OPENAI_MODEL ?? undefined,
    anthropicModel: dbAnthropicModel ?? process.env.ANTHROPIC_MODEL ?? undefined,
  };
}

/** Save (encrypt) a provider's API key. Empty string clears it (falls back to env). */
export async function setModelApiKey(
  provider: ModelProvider,
  rawKey: string,
): Promise<void> {
  if (rawKey && !encryptionConfigured()) {
    throw new Error(
      "Cannot store a key: set AI_ORCHESTRATOR_API_KEY_PEPPER to enable encryption.",
    );
  }
  const key = provider === "openai" ? K_OPENAI : K_ANTHROPIC;
  await getRepository().setSetting(key, encryptSecret(rawKey ?? ""));
}

/** Save a non-secret model name (e.g. "gpt-4o", "claude-sonnet-4-5"). */
export async function setModelName(
  provider: ModelProvider,
  model: string,
): Promise<void> {
  const key = provider === "openai" ? K_OPENAI_MODEL : K_ANTHROPIC_MODEL;
  await getRepository().setSetting(key, model.trim());
}

/** Booleans + model names for the UI. NEVER returns key values. */
export async function getModelKeyStatus(): Promise<ModelKeyStatus> {
  const [dbOpenai, dbAnthropic, openaiModel, anthropicModel] =
    await Promise.all([
      readSecret(K_OPENAI),
      readSecret(K_ANTHROPIC),
      readPlain(K_OPENAI_MODEL),
      readPlain(K_ANTHROPIC_MODEL),
    ]);
  return {
    openai_set: Boolean(dbOpenai ?? process.env.OPENAI_API_KEY),
    anthropic_set: Boolean(dbAnthropic ?? process.env.ANTHROPIC_API_KEY),
    openai_in_db: Boolean(dbOpenai),
    anthropic_in_db: Boolean(dbAnthropic),
    openai_model: openaiModel ?? process.env.OPENAI_MODEL ?? null,
    anthropic_model: anthropicModel ?? process.env.ANTHROPIC_MODEL ?? null,
    encryption_configured: encryptionConfigured(),
  };
}
