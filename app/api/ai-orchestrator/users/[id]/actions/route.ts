import { NextRequest, NextResponse } from "next/server";
import { getRepository } from "@/lib/ai-orchestrator/service";
import { getClientIp, guardRequest } from "@/lib/ai-orchestrator/security/guard";
import { recordAudit } from "@/lib/ai-orchestrator/audit";
import { PERMISSIONS } from "@/lib/ai-orchestrator/auth/permissions";
import { canManageUser } from "@/lib/ai-orchestrator/auth/rbac";
import { generateApiKey } from "@/lib/ai-orchestrator/auth/api-key";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Action = "disable" | "enable" | "create_key" | "revoke_key";

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const gate = await guardRequest(req, {
    permission: PERMISSIONS.USERS_MANAGE,
  });
  if (!gate.ok) return gate.response;

  const { id } = await ctx.params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const b = (body ?? {}) as {
    action?: Action;
    keyId?: string;
    keyName?: string;
  };

  const repo = getRepository();
  const target = await repo.getUserById(id);
  if (!target) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }
  // Cannot act on a user whose role is at/above your own.
  if (!canManageUser(gate.context, target.role)) {
    return NextResponse.json(
      { error: "Cannot manage a user with a role at/above your own" },
      { status: 403 },
    );
  }

  const ip = getClientIp(req);
  const userAgent = req.headers.get("user-agent");
  const actorFp = gate.context.keyFingerprint;
  const actorId = gate.context.userId;

  switch (b.action) {
    case "disable": {
      await repo.updateUserStatus(id, "disabled");
      await recordAudit({
        eventType: "user_disabled",
        status: "ok",
        userId: actorId,
        adminKeyFingerprint: actorFp,
        ip,
        userAgent,
        metadata: { targetUserId: id },
      });
      return NextResponse.json({ ok: true }, { status: 200 });
    }
    case "enable": {
      await repo.updateUserStatus(id, "active");
      await recordAudit({
        eventType: "user_enabled",
        status: "ok",
        userId: actorId,
        adminKeyFingerprint: actorFp,
        ip,
        userAgent,
        metadata: { targetUserId: id },
      });
      return NextResponse.json({ ok: true }, { status: 200 });
    }
    case "create_key": {
      if (!gate.context.permissions.includes(PERMISSIONS.APIKEY_MANAGE)) {
        return NextResponse.json(
          { error: "Missing permission: ai:apikey:manage" },
          { status: 403 },
        );
      }
      const generated = generateApiKey();
      const key = await repo.createApiKey({
        userId: id,
        keyPrefix: generated.prefix,
        keyHash: generated.hash,
        name: typeof b.keyName === "string" ? b.keyName : null,
      });
      await recordAudit({
        eventType: "api_key_created",
        status: "ok",
        userId: actorId,
        adminKeyFingerprint: actorFp,
        ip,
        userAgent,
        metadata: { targetUserId: id, apiKeyId: key.id },
      });
      // The raw key is returned exactly ONCE and never stored.
      return NextResponse.json(
        { apiKey: generated.raw, keyId: key.id, prefix: key.key_prefix },
        { status: 200 },
      );
    }
    case "revoke_key": {
      if (!gate.context.permissions.includes(PERMISSIONS.APIKEY_MANAGE)) {
        return NextResponse.json(
          { error: "Missing permission: ai:apikey:manage" },
          { status: 403 },
        );
      }
      if (!b.keyId) {
        return NextResponse.json(
          { error: "Field 'keyId' is required" },
          { status: 400 },
        );
      }
      const key = await repo.getApiKeyById(b.keyId);
      if (!key || key.user_id !== id) {
        return NextResponse.json({ error: "Key not found" }, { status: 404 });
      }
      await repo.revokeApiKey(b.keyId);
      await recordAudit({
        eventType: "api_key_revoked",
        status: "ok",
        userId: actorId,
        adminKeyFingerprint: actorFp,
        ip,
        userAgent,
        metadata: { targetUserId: id, apiKeyId: b.keyId },
      });
      return NextResponse.json({ ok: true }, { status: 200 });
    }
    default:
      return NextResponse.json(
        { error: "Unknown action" },
        { status: 400 },
      );
  }
}
