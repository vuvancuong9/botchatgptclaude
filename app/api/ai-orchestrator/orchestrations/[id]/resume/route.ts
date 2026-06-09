import { NextRequest, NextResponse } from "next/server";
import {
  getOrchestrationView,
  getSessionWithAccessFlags,
  resumeOrchestration,
  subjectFromContext,
} from "@/lib/ai-orchestrator/service";
import { guardRequest } from "@/lib/ai-orchestrator/security/guard";
import { PERMISSIONS } from "@/lib/ai-orchestrator/auth/permissions";
import { canAccessSession } from "@/lib/ai-orchestrator/auth/rbac";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Resume an orchestration once its worker job is terminal. */
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

  try {
    const result = await resumeOrchestration(gate.context, id);
    // Still waiting on the worker, or a new round enqueued → 202; terminal → 200.
    const httpStatus = result.status === "waiting_for_worker" ? 202 : 200;
    return NextResponse.json(
      {
        orchestration_run_id: result.orchestrationRunId,
        session_id: result.sessionId,
        status: result.status,
        round: result.round,
        worker_job_id: result.workerJobId ?? null,
        still_waiting: result.stillWaiting ?? false,
      },
      { status: httpStatus },
    );
  } catch (err) {
    return NextResponse.json(
      { error: `Resume failed: ${(err as Error).message}` },
      { status: 500 },
    );
  }
}
