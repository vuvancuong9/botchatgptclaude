import { timingSafeEqual } from "node:crypto";

/**
 * Phase 7.4 — cron authentication for the scheduled-resume route.
 *
 * The cron route is NOT a normal user-authenticated endpoint. It is authorized
 * by a dedicated shared secret (AI_ORCHESTRATOR_CRON_KEY), accepted via:
 *   1. `x-ai-cron-key: <key>` header  (primary — use this with an external scheduler)
 *   2. `Authorization: Bearer <key>`  (Vercel Cron sends this automatically when
 *      CRON_SECRET is set; point CRON_SECRET at the same value)
 *   3. `?cron_key=<key>` query token  (opt-in only, less safe — see README)
 *
 * The key VALUE is never logged and never returned.
 */

export const CRON_KEY_HEADER = "x-ai-cron-key";

/** Minimal shape both NextRequest and a test double satisfy. */
export interface CronRequest {
  headers: { get(name: string): string | null };
  url: string;
}

export function resolveCronKey(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const k = env.AI_ORCHESTRATOR_CRON_KEY;
  return k && k.trim() ? k.trim() : undefined;
}

/** Query-token fallback is OFF unless explicitly enabled (less safe than a header). */
export function cronQueryKeyAllowed(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.AI_ORCHESTRATOR_ALLOW_CRON_QUERY_KEY === "1";
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export type CronAuthReason = "no_key_configured" | "missing_key" | "bad_key";

export interface CronAuthResult {
  ok: boolean;
  reason?: CronAuthReason;
}

/**
 * Decide whether a request may trigger the cron resume. Fail-closed: when no
 * AI_ORCHESTRATOR_CRON_KEY is configured the route is disabled (401), so an
 * unprotected cron endpoint can never run.
 */
export function checkCronKey(
  req: CronRequest,
  env: Record<string, string | undefined> = process.env,
): CronAuthResult {
  const expected = resolveCronKey(env);
  if (!expected) return { ok: false, reason: "no_key_configured" };

  // 1) Primary header.
  let provided: string | null = req.headers.get(CRON_KEY_HEADER);

  // 2) Authorization: Bearer <key> (Vercel Cron compatibility).
  if (!provided) {
    const authz = req.headers.get("authorization");
    if (authz && /^Bearer\s+/i.test(authz)) {
      provided = authz.replace(/^Bearer\s+/i, "").trim();
    }
  }

  // 3) Opt-in query token (less safe).
  if (!provided && cronQueryKeyAllowed(env)) {
    try {
      provided = new URL(req.url).searchParams.get("cron_key");
    } catch {
      provided = null;
    }
  }

  if (!provided) return { ok: false, reason: "missing_key" };
  return safeEqual(provided, expected)
    ? { ok: true }
    : { ok: false, reason: "bad_key" };
}
