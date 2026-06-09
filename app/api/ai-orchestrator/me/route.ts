import { NextRequest, NextResponse } from "next/server";
import { guardRequest } from "@/lib/ai-orchestrator/security/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Returns the caller's identity/role/permissions (no secrets). */
export async function GET(req: NextRequest) {
  const gate = await guardRequest(req);
  if (!gate.ok) return gate.response;
  const { userId, role, permissions, legacyAdmin } = gate.context;
  return NextResponse.json(
    { userId, role, permissions, legacyAdmin },
    { status: 200 },
  );
}
