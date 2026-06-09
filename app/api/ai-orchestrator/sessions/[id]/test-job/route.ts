import { NextRequest, NextResponse } from "next/server";
import {
  createTestJobForSession,
  getSessionWithAccessFlags,
  subjectFromContext,
} from "@/lib/ai-orchestrator/service";
import { getClientIp, guardRequest } from "@/lib/ai-orchestrator/security/guard";
import { PERMISSIONS } from "@/lib/ai-orchestrator/auth/permissions";
import { canAccessSession } from "@/lib/ai-orchestrator/auth/rbac";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Enqueue a sandbox test job for the session (never runs commands inline). */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const gate = await guardRequest(req, { permission: PERMISSIONS.RUN_TESTS });
  if (!gate.ok) return gate.response;

  const { id } = await ctx.params;
  const access = await getSessionWithAccessFlags(gate.context, id);
  if (!access) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }
  const subject = subjectFromContext(gate.context);
  if (
    !canAccessSession(subject, access.session, {
      isCollaborator: access.isCollaborator,
    })
  ) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let branch: string | undefined;
  let debug = false;
  try {
    const body = await req.json();
    if (body && typeof body === "object") {
      if (typeof body.branch === "string") branch = body.branch;
      debug = body.debug === true;
    }
  } catch {
    /* empty body is fine */
  }

  const result = await createTestJobForSession(subject, id, {
    branch,
    debug,
    ip: getClientIp(req),
    userAgent: req.headers.get("user-agent"),
  });

  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: result.error },
      { status: result.status },
    );
  }

  return NextResponse.json(
    {
      ok: true,
      job_id: result.job.id,
      status: result.job.status,
      job_type: result.job.job_type,
    },
    { status: 201 },
  );
}
