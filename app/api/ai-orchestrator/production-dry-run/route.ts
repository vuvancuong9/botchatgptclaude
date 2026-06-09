import { NextRequest, NextResponse } from "next/server";
import { guardRequest } from "@/lib/ai-orchestrator/security/guard";
import { PERMISSIONS } from "@/lib/ai-orchestrator/auth/permissions";
import { getProductionDryRunStatus } from "@/lib/ai-orchestrator/production-dry-run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Phase 9 — production dry-run go/no-go status. NOT public: requires an API key
 * and owner/admin (or ai:config:manage). Pure inspection — never creates a
 * session, calls a model, runs a command, applies a migration, or returns a
 * secret value. Always 200; the body carries `dry_run_safe` + blockers/warnings.
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

  const status = await getProductionDryRunStatus();
  return NextResponse.json(status, { status: 200 });
}
