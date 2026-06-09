import { NextRequest, NextResponse } from "next/server";
import { guardRequest } from "@/lib/ai-orchestrator/security/guard";
import { PERMISSIONS } from "@/lib/ai-orchestrator/auth/permissions";
import { AuthContext } from "@/lib/ai-orchestrator/auth/context";
import { recordAudit } from "@/lib/ai-orchestrator/audit";
import {
  getModelKeyStatus,
  setModelApiKey,
  setModelName,
} from "@/lib/ai-orchestrator/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isAdminish(ctx: AuthContext): boolean {
  return (
    ctx.role === "owner" ||
    ctx.role === "admin" ||
    ctx.permissions.includes(PERMISSIONS.CONFIG_MANAGE)
  );
}

/** Status only — never returns the key VALUES. */
export async function GET(req: NextRequest) {
  const gate = await guardRequest(req);
  if (!gate.ok) return gate.response;
  if (!isAdminish(gate.context)) {
    return NextResponse.json(
      { error: "Forbidden: owner/admin only" },
      { status: 403 },
    );
  }
  return NextResponse.json(await getModelKeyStatus(), { status: 200 });
}

/** Save model keys (AES-encrypted) + model names. Owner/admin only. */
export async function POST(req: NextRequest) {
  const gate = await guardRequest(req);
  if (!gate.ok) return gate.response;
  if (!isAdminish(gate.context)) {
    return NextResponse.json(
      { error: "Forbidden: owner/admin only" },
      { status: 403 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const b = body as Record<string, unknown>;
  const changed: string[] = [];
  try {
    if (typeof b.openai_api_key === "string") {
      await setModelApiKey("openai", b.openai_api_key);
      changed.push(b.openai_api_key ? "openai_key" : "openai_key_cleared");
    }
    if (typeof b.anthropic_api_key === "string") {
      await setModelApiKey("anthropic", b.anthropic_api_key);
      changed.push(b.anthropic_api_key ? "anthropic_key" : "anthropic_key_cleared");
    }
    if (typeof b.openai_model === "string" && b.openai_model.trim()) {
      await setModelName("openai", b.openai_model);
      changed.push("openai_model");
    }
    if (typeof b.anthropic_model === "string" && b.anthropic_model.trim()) {
      await setModelName("anthropic", b.anthropic_model);
      changed.push("anthropic_model");
    }
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 400 },
    );
  }

  // Audit WHICH settings changed — never the key values.
  await recordAudit({
    eventType: "model_key_updated",
    status: "ok",
    userId: gate.context.userId,
    adminKeyFingerprint: gate.context.keyFingerprint,
    metadata: { changed },
  });

  return NextResponse.json(await getModelKeyStatus(), { status: 200 });
}
