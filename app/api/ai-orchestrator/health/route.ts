import { NextRequest, NextResponse } from "next/server";
import { guardRequest } from "@/lib/ai-orchestrator/security/guard";
import { getHealthReport } from "@/lib/ai-orchestrator/health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const gate = await guardRequest(req);
  if (!gate.ok) return gate.response;

  const report = await getHealthReport();
  // DB unreachable => 500, but the body never contains secret values.
  return NextResponse.json(report, { status: report.db_status === "ok" ? 200 : 500 });
}
