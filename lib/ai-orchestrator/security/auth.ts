import { timingSafeEqual } from "node:crypto";

/**
 * Admin authentication for every AI Orchestrator API route.
 *
 * Requests must carry `x-ai-admin-key: <AI_ORCHESTRATOR_ADMIN_KEY>`.
 * Missing/wrong key -> 401 BEFORE any model call or DB write.
 */

export const ADMIN_KEY_HEADER = "x-ai-admin-key";

export type AuthResult =
  | { ok: true; identifier: string }
  | { ok: false; status: 401; error: string };

/** Minimal header bag both NextRequest and web Request satisfy. */
export interface HeaderCarrier {
  headers: { get(name: string): string | null };
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Pure check: given the provided key and the configured key, decide auth.
 * Exposed for unit testing without constructing a request.
 */
export function checkAdminKey(
  providedKey: string | null | undefined,
  configuredKey: string | undefined = process.env.AI_ORCHESTRATOR_ADMIN_KEY,
): AuthResult {
  if (!configuredKey || configuredKey.length === 0) {
    return {
      ok: false,
      status: 401,
      error:
        "Server admin key not configured (set AI_ORCHESTRATOR_ADMIN_KEY).",
    };
  }
  if (!providedKey) {
    return { ok: false, status: 401, error: "Missing x-ai-admin-key header." };
  }
  if (!safeEqual(providedKey, configuredKey)) {
    return { ok: false, status: 401, error: "Invalid admin key." };
  }
  // Identify the caller by a stable, non-reversible fingerprint of the key
  // so it can key the rate limiter without ever storing the raw secret.
  return { ok: true, identifier: `admin:${fingerprint(providedKey)}` };
}

function fingerprint(value: string): string {
  // Short, non-secret tag; never the raw key.
  let h = 0;
  for (let i = 0; i < value.length; i++) {
    h = (h * 31 + value.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

/** Route-facing guard. Reads the header and validates it. */
export function requireAiAdminAuth(req: HeaderCarrier): AuthResult {
  const provided = req.headers.get(ADMIN_KEY_HEADER);
  return checkAdminKey(provided);
}
