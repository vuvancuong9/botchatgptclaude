import { NextResponse } from "next/server";
import { HeaderCarrier } from "./auth";
import { rateLimit, RateLimitOptions } from "./rate-limit";
import { getRateLimitStore } from "./redis-rate-limit";
import { recordAudit } from "../audit";
import { resolveAuthContext, AuthContext } from "../auth/context";
import { Permission } from "../auth/permissions";

export function getClientIp(req: HeaderCarrier): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}

export type GuardOutcome =
  | { ok: true; context: AuthContext }
  | { ok: false; response: NextResponse };

export interface GuardOptions {
  rateLimited?: boolean;
  rateLimit?: RateLimitOptions;
  /** Permission required for the route (403 if missing). */
  permission?: Permission;
  /** Disable audit writes (used by tests to avoid DB I/O). */
  audit?: boolean;
}

/**
 * Every route's entry point: resolve the AuthContext (API key or legacy admin),
 * rate limit, then enforce the required permission. Emits audit events; audit
 * failures never block the request.
 */
export async function guardRequest(
  req: HeaderCarrier,
  opts: GuardOptions = {},
): Promise<GuardOutcome> {
  const auditEnabled = opts.audit ?? true;
  const ip = getClientIp(req);
  const userAgent = req.headers.get("user-agent");

  const resolution = await resolveAuthContext(req);
  if (!resolution.ok) {
    if (auditEnabled) {
      await recordAudit({
        eventType: resolution.auditEvent,
        status: "denied",
        ip,
        userAgent,
        metadata: { reason: resolution.error },
      });
    }
    return {
      ok: false,
      response: NextResponse.json(
        { error: resolution.error },
        { status: resolution.status },
      ),
    };
  }

  const context = resolution.context;
  const identifier = context.keyFingerprint || context.userId || ip;

  if (auditEnabled) {
    await recordAudit({
      eventType: resolution.auditEvent,
      status: "ok",
      userId: context.userId,
      adminKeyFingerprint: context.keyFingerprint,
      ip,
      userAgent,
      metadata: { role: context.role, legacyAdmin: context.legacyAdmin },
    });
  }

  if (opts.rateLimited) {
    const store = opts.rateLimit?.store ?? getRateLimitStore();
    const rl = await rateLimit(identifier, { ...opts.rateLimit, store });
    if (!rl.ok) {
      if (auditEnabled) {
        await recordAudit({
          eventType: "rate_limited",
          status: "denied",
          userId: context.userId,
          adminKeyFingerprint: context.keyFingerprint,
          ip,
          userAgent,
          metadata: { retryAfter: rl.retryAfter },
        });
      }
      const response = NextResponse.json(
        {
          error: `Rate limit exceeded. Try again in ${rl.retryAfter}s.`,
          retryAfter: rl.retryAfter,
        },
        { status: 429 },
      );
      response.headers.set("Retry-After", String(rl.retryAfter));
      return { ok: false, response };
    }
  }

  if (opts.permission && !context.permissions.includes(opts.permission)) {
    if (auditEnabled) {
      await recordAudit({
        eventType: "permission_denied",
        status: "denied",
        userId: context.userId,
        adminKeyFingerprint: context.keyFingerprint,
        ip,
        userAgent,
        metadata: { required: opts.permission, role: context.role },
      });
    }
    return {
      ok: false,
      response: NextResponse.json(
        { error: `Missing required permission: ${opts.permission}` },
        { status: 403 },
      ),
    };
  }

  return { ok: true, context };
}
