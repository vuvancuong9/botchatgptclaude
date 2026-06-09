import { NextRequest, NextResponse } from "next/server";
import {
  getOrchestrationView,
  getSessionWithAccessFlags,
  subjectFromContext,
} from "@/lib/ai-orchestrator/service";
import { guardRequest } from "@/lib/ai-orchestrator/security/guard";
import { PERMISSIONS } from "@/lib/ai-orchestrator/auth/permissions";
import { canAccessSession } from "@/lib/ai-orchestrator/auth/rbac";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Read an orchestration run: status, step, round, pending job, events. */
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const gate = await guardRequest(req, { permission: PERMISSIONS.SESSION_READ });
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

  const { run, events, pendingJob } = view;
  const state = run.state as Record<string, unknown>;
  return NextResponse.json(
    {
      id: run.id,
      session_id: run.session_id,
      status: run.status,
      current_round: run.current_round,
      max_rounds: run.max_rounds,
      current_step: run.current_step,
      pending_worker_job_id: run.pending_worker_job_id,
      last_error: run.last_error,
      finished_at: run.finished_at,
      // State summary only (full text stays server-side; it is redacted anyway).
      state_summary: {
        has_spec: Boolean(state.specText),
        has_plan: Boolean(state.planText),
        has_patch: Boolean(state.patchText),
        has_test_report: Boolean(state.lastTestReport),
      },
      pending_job: pendingJob
        ? {
            id: pendingJob.id,
            status: pendingJob.status,
            job_type: pendingJob.job_type,
          }
        : null,
      events: events.map((e) => ({
        event_type: e.event_type,
        metadata: e.metadata,
        created_at: e.created_at,
      })),
    },
    { status: 200 },
  );
}
