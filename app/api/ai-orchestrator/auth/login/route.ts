import { NextRequest, NextResponse } from "next/server";
import { loginWithPassword } from "@/lib/ai-orchestrator/auth/login-service";
import { getClientIp } from "@/lib/ai-orchestrator/security/guard";
import { rateLimit } from "@/lib/ai-orchestrator/security/rate-limit";
import { getRateLimitStore } from "@/lib/ai-orchestrator/security/redis-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Phase 10 — web login. Public (it IS the auth) but rate-limited by IP to slow
 * brute force. On success returns a short-lived API key the browser stores +
 * sends as x-ai-api-key. The password is never stored or logged.
 */
export async function POST(req: NextRequest) {
  const ip = getClientIp(req);
  const userAgent = req.headers.get("user-agent");

  try {
    const rl = await rateLimit(`login:${ip}`, { store: getRateLimitStore() });
    if (!rl.ok) {
      return NextResponse.json(
        { error: `Quá nhiều lần thử. Thử lại sau ${rl.retryAfter}s.` },
        { status: 429 },
      );
    }
  } catch {
    /* rate-limit store unavailable — do not block login */
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const email = (body as { email?: unknown })?.email;
  const password = (body as { password?: unknown })?.password;
  if (typeof email !== "string" || typeof password !== "string") {
    return NextResponse.json(
      { error: "email + password là bắt buộc" },
      { status: 400 },
    );
  }

  const result = await loginWithPassword(email, password, { ip, userAgent });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 401 });
  }
  return NextResponse.json(
    { api_key: result.apiKey, user: result.user },
    { status: 200 },
  );
}
