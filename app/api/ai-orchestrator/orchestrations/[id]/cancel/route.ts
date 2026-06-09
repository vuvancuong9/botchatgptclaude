import { NextRequest, NextResponse } from "next/server";
import {
  cancelOrchestration,
  getOrchestrationView,
  getSessionWithAccessFlags,
  subjectFromContext,
} from "@/lib/ai-orchestrator/service";
import { getClientIp, guardRequest } from "@/lib/ai-orchestrator/security/guard";
import { PERMISSIONS } from "@/lib/ai-orchestrator/auth/permissions";
import { canAccessSession } from "@/lib/ai-orchestrator/auth/rbac";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Cancel an orchestration run + its pending worker job. */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const gate = await guardRequest(req, { permission: PERMISSIONS.RUN });
  if (!gate.ok) return gate.response;

  const { id } = await ctx.params;
  const view = await getOrchestrationView(id);
  if (!view) {
    return NextResponse.json({ error: "Orchestration not found" }, { status: 404 });
  }
  const subject = subjectFromContext(gate.context);
  const access = await getSessionWithAccessFlags(gate.context, view.run.session_id);
  if (
    !access ||
    !canAccessSession(subject, access.session, {
      isCollaborator: access.isCollaborator,
    })
  ) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const result = await cancelOrchestration(gate.context, id, {
    ip: getClientIp(req),
    userAgent: req.headers.get("user-agent"),
  });
  return NextResponse.json(result, {
    status: result.cancelled ? 200 : 409,
  });
}
