/**
 * Secret redaction for anything that may be persisted or logged
 * (command stdout/stderr, error messages, etc.).
 *
 * Two layers:
 *   1. Known env-var VALUES are replaced wherever they appear verbatim.
 *   2. Structural patterns (sk- tokens, bearer headers) are masked even if the
 *      value is not currently in the environment.
 */

export const REDACTED = "***REDACTED***";

/** Env var names whose values must never leak. */
export const SENSITIVE_ENV_NAMES: readonly string[] = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "AI_ORCHESTRATOR_ADMIN_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "DATABASE_URL",
  // Phase 6: GitHub token used for branch/file/PR writes — server-side only.
  "GITHUB_TOKEN",
];

const STRUCTURAL_PATTERNS: RegExp[] = [
  // OpenAI / generic "sk-" secret keys (sk-, sk-proj-, sk-ant-, ...).
  /sk-[A-Za-z0-9_-]{2,}/g,
  // Anthropic admin/api style tokens.
  /sk-ant-[A-Za-z0-9_-]{2,}/g,
  // GitHub tokens: classic PAT (ghp_), OAuth (gho_), user/server/refresh
  // (ghu_/ghs_/ghr_) and fine-grained PAT (github_pat_...).
  /\bgh[posru]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  // Authorization: Bearer <token>
  /(authorization\s*[:=]\s*bearer\s+)[A-Za-z0-9._-]+/gi,
  // x-api-key / x-ai-admin-key header dumps.
  /((?:x-api-key|x-ai-admin-key)\s*[:=]\s*)[A-Za-z0-9._-]+/gi,
];

export function redactSecrets(
  text: string,
  env: Record<string, string | undefined> = process.env,
): string {
  if (!text) return text;
  let out = text;

  // 1. Replace exact env values (literal, no regex needed).
  for (const name of SENSITIVE_ENV_NAMES) {
    const value = env[name];
    if (value && value.length >= 4) {
      out = out.split(value).join(REDACTED);
    }
  }

  // 2. Structural masks.
  for (const pattern of STRUCTURAL_PATTERNS) {
    out = out.replace(pattern, (match, prefix?: string) =>
      prefix ? `${prefix}${REDACTED}` : REDACTED,
    );
  }

  return out;
}
