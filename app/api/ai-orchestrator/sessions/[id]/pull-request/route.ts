import { NextRequest, NextResponse } from "next/server";
import {
  getLatestPatchArtifactText,
  getLatestValidatedPatchSet,
  getRepository,
  getSessionGithubState,
  getSessionWithAccessFlags,
  subjectFromContext,
} from "@/lib/ai-orchestrator/service";
import { getClientIp, guardRequest } from "@/lib/ai-orchestrator/security/guard";
import { PERMISSIONS } from "@/lib/ai-orchestrator/auth/permissions";
import { canAccessSession } from "@/lib/ai-orchestrator/auth/rbac";
import {
  createPullRequestForSession,
  resolvePrFlowConfig,
} from "@/lib/ai-orchestrator/github/pull-request-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Create a pull request (dry-run by default) from the session's patch. */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const gate = await guardRequest(req, {
    permission: PERMISSIONS.PR_CREATE,
  });
  if (!gate.ok) return gate.response;

  // A4: when the GitHub PR feature is disabled, the route is closed (403).
  if (process.env.AI_ORCHESTRATOR_ENABLE_GITHUB_PR !== "1") {
    return NextResponse.json(
      {
        ok: false,
        blockedReason: "github_disabled",
        error:
          "GitHub PR creation is disabled (set AI_ORCHESTRATOR_ENABLE_GITHUB_PR=1).",
      },
      { status: 403 },
    );
  }

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

  const [patchArtifactText, existingPatchSet] = await Promise.all([
    getLatestPatchArtifactText(id),
    getLatestValidatedPatchSet(id),
  ]);

  const result = await createPullRequestForSession({
    repo: getRepository(),
    subject,
    isCollaborator: access.isCollaborator,
    session: access.session,
    patchArtifactText,
    existingPatchSet,
    config: resolvePrFlowConfig(process.env),
    timestamp: Date.now(),
    ip: getClientIp(req),
    userAgent: req.headers.get("user-agent"),
  });

  return NextResponse.json(result, { status: result.httpStatus });
}

/** Read patch sets + PR attempts for a session. */
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const gate = await guardRequest(req, {
    permission: PERMISSIONS.SESSION_READ,
  });
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

  const state = await getSessionGithubState(id);
  return NextResponse.json(
    state ?? {
      patchSets: [],
      latestPatchFiles: [],
      pullRequests: [],
      workerJobs: [],
      latestValidatedPatchSetId: null,
    },
    { status: 200 },
  );
}
