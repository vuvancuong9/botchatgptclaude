import { NextRequest, NextResponse } from "next/server";
import { guardRequest } from "@/lib/ai-orchestrator/security/guard";
import { PERMISSIONS } from "@/lib/ai-orchestrator/auth/permissions";
import {
  getProductionReadinessReport,
  hasBlockingFailure,
} from "@/lib/ai-orchestrator/production-readiness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Phase 8 — production go-live readiness gate. NOT public: requires an API key
 * and owner/admin (or ai:config:manage). Pure inspection — no command, no model,
 * no migration, no secret values in the response. 503 when a critical/high check
 * fails; 200 when only warnings remain.
 */
export async function GET(req: NextRequest) {
  const gate = await guardRequest(req);
  if (!gate.ok) return gate.response;

  const { role, permissions } = gate.context;
  const allowed =
    role === "owner" ||
    role === "admin" ||
    permissions.includes(PERMISSIONS.CONFIG_MANAGE);
  if (!allowed) {
    return NextResponse.json(
      { error: "Forbidden: requires owner/admin or ai:config:manage" },
      { status: 403 },
    );
  }

  const report = await getProductionReadinessReport();
  const status = hasBlockingFailure(report) ? 503 : 200;
  return NextResponse.json(report, { status });
}
