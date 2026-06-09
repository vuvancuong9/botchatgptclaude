import { NextRequest, NextResponse } from "next/server";
import { listSessionsForContext } from "@/lib/ai-orchestrator/service";
import { guardRequest } from "@/lib/ai-orchestrator/security/guard";
import { PERMISSIONS } from "@/lib/ai-orchestrator/auth/permissions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const gate = await guardRequest(req, {
    permission: PERMISSIONS.SESSION_READ,
  });
  if (!gate.ok) return gate.response;

  try {
    // owner/admin (read_all) see everything; others see own + collaborator.
    const sessions = await listSessionsForContext(gate.context, 100);
    return NextResponse.json({ sessions }, { status: 200 });
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to list sessions: ${(err as Error).message}` },
      { status: 500 },
    );
  }
}
