import { NextRequest, NextResponse } from "next/server";
import { getRepository } from "@/lib/ai-orchestrator/service";
import { getClientIp, guardRequest } from "@/lib/ai-orchestrator/security/guard";
import { recordAudit } from "@/lib/ai-orchestrator/audit";
import { PERMISSIONS } from "@/lib/ai-orchestrator/auth/permissions";
import { canManageUser } from "@/lib/ai-orchestrator/auth/rbac";
import { isRole } from "@/lib/ai-orchestrator/auth/roles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** List users (with their API key metadata — never the raw key). */
export async function GET(req: NextRequest) {
  const gate = await guardRequest(req, {
    permission: PERMISSIONS.USERS_MANAGE,
  });
  if (!gate.ok) return gate.response;

  const repo = getRepository();
  const users = await repo.listUsers(200);
  const enriched = await Promise.all(
    users.map(async (u) => ({
      ...u,
      api_keys: (await repo.listApiKeysForUser(u.id)).map((k) => ({
        id: k.id,
        key_prefix: k.key_prefix,
        name: k.name,
        status: k.status,
        last_used_at: k.last_used_at,
        created_at: k.created_at,
      })),
    })),
  );
  return NextResponse.json({ users: enriched }, { status: 200 });
}

/** Create a user. */
export async function POST(req: NextRequest) {
  const gate = await guardRequest(req, {
    permission: PERMISSIONS.USERS_MANAGE,
  });
  if (!gate.ok) return gate.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const b = (body ?? {}) as {
    email?: unknown;
    name?: unknown;
    role?: unknown;
  };
  if (!isRole(b.role)) {
    return NextResponse.json(
      { error: "Field 'role' must be a valid role" },
      { status: 400 },
    );
  }
  if (!canManageUser(gate.context, b.role)) {
    return NextResponse.json(
      { error: "Cannot create a user with a role at/above your own" },
      { status: 403 },
    );
  }

  const repo = getRepository();
  const user = await repo.createUser({
    email: typeof b.email === "string" ? b.email : null,
    displayName: typeof b.name === "string" ? b.name : null,
    role: b.role,
  });
  await recordAudit({
    eventType: "user_created",
    status: "ok",
    userId: gate.context.userId,
    adminKeyFingerprint: gate.context.keyFingerprint,
    ip: getClientIp(req),
    userAgent: req.headers.get("user-agent"),
    metadata: { createdUserId: user.id, role: user.role },
  });
  return NextResponse.json({ user }, { status: 200 });
}
