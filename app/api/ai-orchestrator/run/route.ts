import { NextRequest, NextResponse } from "next/server";
import {
  runOrchestration,
  startAsyncOrchestrationForContext,
} from "@/lib/ai-orchestrator/service";
import { resolveTestRunnerMode } from "@/lib/ai-orchestrator/test-runner-worker";
import { getClientIp, guardRequest } from "@/lib/ai-orchestrator/security/guard";
import { recordAudit } from "@/lib/ai-orchestrator/audit";
import { PERMISSIONS } from "@/lib/ai-orchestrator/auth/permissions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  // Auth + rate-limit + permission BEFORE any model call or session creation.
  const gate = await guardRequest(req, {
    rateLimited: true,
    permission: PERMISSIONS.RUN,
  });
  if (!gate.ok) return gate.response;
  const ctx = gate.context;

  const ip = getClientIp(req);
  const userAgent = req.headers.get("user-agent");

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const request =
    body && typeof body === "object" && "request" in body
      ? (body as { request?: unknown }).request
      : undefined;

  if (typeof request !== "string" || request.trim().length === 0) {
    return NextResponse.json(
      { error: "Field 'request' (non-empty string) is required" },
      { status: 400 },
    );
  }

  const humanApproved =
    body && typeof body === "object" && "humanApproved" in body
      ? Boolean((body as { humanApproved?: unknown }).humanApproved)
      : false;

  await recordAudit({
    eventType: "ai_run_started",
    status: "ok",
    userId: ctx.userId,
    adminKeyFingerprint: ctx.keyFingerprint,
    ip,
    userAgent,
    metadata: { requestChars: request.trim().length, humanApproved },
  });

  try {
    // Phase 7.3: in worker_async mode, enqueue + return 202 immediately so the
    // request never holds open across a long sandbox build (Vercel timeout).
    if (resolveTestRunnerMode() === "worker_async") {
      const result = await startAsyncOrchestrationForContext(
        ctx,
        request.trim(),
        humanApproved,
      );
      await recordAudit({
        eventType: "ai_run_completed",
        status: result.status,
        sessionId: result.sessionId,
        userId: ctx.userId,
        adminKeyFingerprint: ctx.keyFingerprint,
        ip,
        userAgent,
        metadata: { async: true, orchestrationRunId: result.orchestrationRunId },
      });
      return NextResponse.json(
        {
          session_id: result.sessionId,
          orchestration_run_id: result.orchestrationRunId,
          status: result.status,
          worker_job_id: result.workerJobId ?? null,
          round: result.round,
          message: "Orchestration waiting for worker",
        },
        { status: 202 },
      );
    }

    const detail = await runOrchestration(request.trim(), {
      humanApproved,
      userId: ctx.userId,
      adminKeyFingerprint: ctx.keyFingerprint,
    });
    await recordAudit({
      eventType: "ai_run_completed",
      status: detail.session.status,
      sessionId: detail.session.id,
      userId: ctx.userId,
      adminKeyFingerprint: ctx.keyFingerprint,
      ip,
      userAgent,
      metadata: { rounds: detail.session.rounds },
    });
    return NextResponse.json(detail, { status: 200 });
  } catch (err) {
    await recordAudit({
      eventType: "ai_run_failed",
      status: "fail",
      userId: ctx.userId,
      adminKeyFingerprint: ctx.keyFingerprint,
      ip,
      userAgent,
      metadata: { error: (err as Error).message },
    });
    return NextResponse.json(
      { error: `Orchestration failed: ${(err as Error).message}` },
      { status: 500 },
    );
  }
}
