import { NextRequest, NextResponse } from "next/server";
import {
  getSessionWithAccessFlags,
  subjectFromContext,
  validateSessionPatchArtifact,
} from "@/lib/ai-orchestrator/service";
import { getClientIp, guardRequest } from "@/lib/ai-orchestrator/security/guard";
import { recordAudit } from "@/lib/ai-orchestrator/audit";
import { PERMISSIONS } from "@/lib/ai-orchestrator/auth/permissions";
import { canValidatePatch } from "@/lib/ai-orchestrator/auth/rbac";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Validate the session's latest patch artifact and persist a patch_set. */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const gate = await guardRequest(req, {
    permission: PERMISSIONS.PATCH_CREATE,
  });
  if (!gate.ok) return gate.response;

  const { id } = await ctx.params;
  const access = await getSessionWithAccessFlags(gate.context, id);
  if (!access) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }
  const subject = subjectFromContext(gate.context);
  if (
    !canValidatePatch(subject, access.session, {
      isCollaborator: access.isCollaborator,
    })
  ) {
    await recordAudit({
      eventType: "permission_denied",
      status: "denied",
      sessionId: id,
      userId: gate.context.userId,
      adminKeyFingerprint: gate.context.keyFingerprint,
      ip: getClientIp(req),
      userAgent: req.headers.get("user-agent"),
      metadata: { action: "validate_patch" },
    });
    return NextResponse.json(
      { error: "Not allowed to validate patches for this session" },
      { status: 403 },
    );
  }

  const result = await validateSessionPatchArtifact(subject, id, {
    ip: getClientIp(req),
    userAgent: req.headers.get("user-agent"),
  });

  return NextResponse.json(
    {
      ok: result.ok,
      message: result.message,
      errors: result.errors,
      patchSet: result.patchSet,
    },
    { status: result.patchSet ? 200 : 404 },
  );
}
