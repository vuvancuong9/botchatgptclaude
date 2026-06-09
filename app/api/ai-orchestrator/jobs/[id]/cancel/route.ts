import { NextRequest, NextResponse } from "next/server";
import {
  cancelWorkerJobById,
  getSessionWithAccessFlags,
  getWorkerJob,
  subjectFromContext,
} from "@/lib/ai-orchestrator/service";
import { getClientIp, guardRequest } from "@/lib/ai-orchestrator/security/guard";
import { PERMISSIONS } from "@/lib/ai-orchestrator/auth/permissions";
import { canAccessSession } from "@/lib/ai-orchestrator/auth/rbac";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Cancel a queued/running worker job. Requires ai:run_tests (owner/admin too). */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const gate = await guardRequest(req, { permission: PERMISSIONS.RUN_TESTS });
  if (!gate.ok) return gate.response;

  const { id } = await ctx.params;
  const job = await getWorkerJob(id);
  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  const subject = subjectFromContext(gate.context);
  let allowed = subject.permissions.includes(PERMISSIONS.SESSION_READ_ALL);
  if (!allowed && job.session_id) {
    const access = await getSessionWithAccessFlags(gate.context, job.session_id);
    allowed = Boolean(
      access &&
        canAccessSession(subject, access.session, {
          isCollaborator: access.isCollaborator,
        }),
    );
  }
  if (!allowed) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const ok = await cancelWorkerJobById(id, {
    userId: subject.userId,
    sessionId: job.session_id,
    ip: getClientIp(req),
    userAgent: req.headers.get("user-agent"),
  });

  return NextResponse.json(
    { ok, status: ok ? "cancelled" : "not_cancellable" },
    { status: ok ? 200 : 409 },
  );
}
