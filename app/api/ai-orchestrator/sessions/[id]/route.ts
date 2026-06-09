import { NextRequest, NextResponse } from "next/server";
import {
  getSessionDetail,
  getSessionWithAccessFlags,
  setApproval,
} from "@/lib/ai-orchestrator/service";
import { getClientIp, guardRequest } from "@/lib/ai-orchestrator/security/guard";
import { recordAudit } from "@/lib/ai-orchestrator/audit";
import { PERMISSIONS } from "@/lib/ai-orchestrator/auth/permissions";
import {
  canAccessSession,
  canApproveSession,
  canRejectSession,
} from "@/lib/ai-orchestrator/auth/rbac";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const gate = await guardRequest(req, {
    permission: PERMISSIONS.SESSION_READ,
  });
  if (!gate.ok) return gate.response;

  const { id } = await ctx.params;
  const access = await getSessionWithAccessFlags(gate.context, id);
  if (!access) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }
  if (
    !canAccessSession(gate.context, access.session, {
      isCollaborator: access.isCollaborator,
    })
  ) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const detail = await getSessionDetail(id);
  if (!detail) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }
  return NextResponse.json(detail, { status: 200 });
}

/** Approve / Reject the session (human gate). */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const gate = await guardRequest(req, {
    permission: PERMISSIONS.SESSION_READ,
  });
  if (!gate.ok) return gate.response;

  const { id } = await ctx.params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const action =
    body && typeof body === "object" && "action" in body
      ? (body as { action?: unknown }).action
      : undefined;

  if (action !== "approve" && action !== "reject") {
    return NextResponse.json(
      { error: "Field 'action' must be 'approve' or 'reject'" },
      { status: 400 },
    );
  }

  const access = await getSessionWithAccessFlags(gate.context, id);
  if (!access) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const opts = { isCollaborator: access.isCollaborator };
  const allowed =
    action === "approve"
      ? canApproveSession(gate.context, access.session, opts)
      : canRejectSession(gate.context, access.session, opts);
  if (!allowed) {
    await recordAudit({
      eventType: "permission_denied",
      status: "denied",
      sessionId: id,
      userId: gate.context.userId,
      adminKeyFingerprint: gate.context.keyFingerprint,
      ip: getClientIp(req),
      userAgent: req.headers.get("user-agent"),
      metadata: { action },
    });
    return NextResponse.json(
      { error: `Not allowed to ${action} this session` },
      { status: 403 },
    );
  }

  const detail = await setApproval(
    id,
    action === "approve" ? "approved" : "rejected",
  );
  if (!detail) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  await recordAudit({
    eventType: action === "approve" ? "session_approved" : "session_rejected",
    status: "ok",
    sessionId: id,
    userId: gate.context.userId,
    adminKeyFingerprint: gate.context.keyFingerprint,
    ip: getClientIp(req),
    userAgent: req.headers.get("user-agent"),
  });

  return NextResponse.json(detail, { status: 200 });
}
