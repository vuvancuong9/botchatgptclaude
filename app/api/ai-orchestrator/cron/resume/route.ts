import { NextRequest, NextResponse } from "next/server";
import { checkCronKey } from "@/lib/ai-orchestrator/security/cron-auth";
import {
  resolveResumeBatchSize,
  resumeDueOrchestrations,
} from "@/lib/ai-orchestrator/orchestration-resume-scheduler";
import { resolveTestRunnerMode } from "@/lib/ai-orchestrator/test-runner-worker";
import { recordAudit } from "@/lib/ai-orchestrator/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Phase 7.4 — scheduled resume. A cron tick (Vercel Cron or an external
 * scheduler) POSTs here carrying the cron key; we resume every waiting
 * orchestration whose worker job has finished. NO command runs in this request,
 * the batch size bounds the tick (no runaway), and the per-run lock means two
 * overlapping ticks never resume the same run.
 */
export async function POST(req: NextRequest) {
  // Fail-closed dedicated cron auth (NOT a user API key). 401 reveals nothing
  // about the key and never logs it.
  const auth = checkCronKey(req);
  if (!auth.ok) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let url: URL | null = null;
  try {
    url = new URL(req.url);
  } catch {
    url = null;
  }
  const force = url?.searchParams.get("force") === "1";
  const batchParam = parseInt(url?.searchParams.get("batch") || "", 10);
  const batchSize =
    Number.isFinite(batchParam) && batchParam >= 1
      ? Math.min(50, batchParam)
      : resolveResumeBatchSize();

  // Cron resume only makes sense in worker_async; ?force=1 overrides for debug.
  const mode = resolveTestRunnerMode();
  if (mode !== "worker_async" && !force) {
    return NextResponse.json(
      {
        skipped: true,
        reason: `test_runner_mode=${mode}; cron resume runs only in worker_async (pass ?force=1 to override)`,
        scanned: 0,
        resumed: 0,
        still_waiting: 0,
        skipped_count: 0,
        failed: 0,
      },
      { status: 200 },
    );
  }

  await recordAudit({
    eventType: "orchestration_cron_resume_started",
    status: "ok",
    metadata: { batchSize, force, mode },
  });

  try {
    const summary = await resumeDueOrchestrations({ batchSize });
    await recordAudit({
      eventType: "orchestration_cron_resume_completed",
      status: "ok",
      metadata: {
        scanned: summary.scanned,
        resumed: summary.resumed,
        still_waiting: summary.still_waiting,
        skipped: summary.skipped,
        failed: summary.failed,
      },
    });
    return NextResponse.json(summary, { status: 200 });
  } catch (err) {
    await recordAudit({
      eventType: "orchestration_cron_resume_failed",
      status: "fail",
      metadata: { error: (err as Error)?.message ?? "cron resume failed" },
    });
    // Generic error body — no internals leaked to the caller.
    return NextResponse.json({ error: "Cron resume failed" }, { status: 500 });
  }
}
