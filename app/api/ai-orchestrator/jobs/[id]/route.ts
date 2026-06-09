import { NextRequest, NextResponse } from "next/server";
import {
  getSessionWithAccessFlags,
  getWorkerJob,
  getWorkerJobView,
  subjectFromContext,
} from "@/lib/ai-orchestrator/service";
import { guardRequest } from "@/lib/ai-orchestrator/security/guard";
import { PERMISSIONS } from "@/lib/ai-orchestrator/auth/permissions";
import { canAccessSession } from "@/lib/ai-orchestrator/auth/rbac";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Read a worker job: status, result, redacted log tail, timestamps. */
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const gate = await guardRequest(req, { permission: PERMISSIONS.SESSION_READ });
  if (!gate.ok) return gate.response;

  const { id } = await ctx.params;
  const job = await getWorkerJob(id);
  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  const subject = subjectFromContext(gate.context);
  if (!(await canSeeJob(gate.context, subject, job.session_id))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const view = await getWorkerJobView(id);
  return NextResponse.json(view, { status: 200 });
}

/** A job is visible if the caller can access its session (or holds read_all). */
async function canSeeJob(
  ctx: Parameters<typeof getSessionWithAccessFlags>[0],
  subject: ReturnType<typeof subjectFromContext>,
  sessionId: string | null,
): Promise<boolean> {
  if (!sessionId) {
    return subject.permissions.includes(PERMISSIONS.SESSION_READ_ALL);
  }
  const access = await getSessionWithAccessFlags(ctx, sessionId);
  if (!access) return false;
  return canAccessSession(subject, access.session, {
    isCollaborator: access.isCollaborator,
  });
}
