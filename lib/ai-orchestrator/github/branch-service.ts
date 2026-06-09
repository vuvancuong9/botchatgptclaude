import { GithubApiError } from "./github-client";
import { GithubClient } from "./types";

/** Branches we will never create or write to. */
const PROTECTED_BRANCHES = new Set(["main", "master"]);

/** Short, ref-safe session id (hex, no dashes). */
export function shortSessionId(sessionId: string): string {
  const hex = sessionId.replace(/[^A-Za-z0-9]/g, "");
  return (hex || "session").slice(0, 8);
}

/**
 * Branch name format: ai-orchestrator/session-<short_session_id>-<timestamp>
 * `timestamp` is passed in (epoch ms) so the name is deterministic + testable.
 */
export function buildBranchName(sessionId: string, timestamp: number): string {
  return `ai-orchestrator/session-${shortSessionId(sessionId)}-${timestamp}`;
}

export interface CreateBranchParams {
  sessionId: string;
  baseBranch: string;
  /** Epoch ms used in the branch name (deterministic for tests). */
  timestamp: number;
  /** Conflict-suffix attempts (-2, -3, ...). Default 5. */
  maxAttempts?: number;
}

export interface CreatedBranch {
  branchName: string;
  baseSha: string;
}

/**
 * Create a fresh branch off the default branch.
 *  - Reads the latest base SHA (fails if the base branch is missing).
 *  - On name collision, appends -2, -3, ... up to maxAttempts.
 *  - NEVER targets main/master and NEVER force-pushes or deletes.
 */
export async function createSessionBranch(
  client: GithubClient,
  params: CreateBranchParams,
): Promise<CreatedBranch> {
  const { sessionId, baseBranch, timestamp } = params;
  const maxAttempts = params.maxAttempts ?? 5;

  const baseSha = await client.getBranchSha(baseBranch);
  if (!baseSha) {
    throw new GithubApiError(
      `Base branch "${baseBranch}" not found; cannot branch from it.`,
      404,
    );
  }

  const root = buildBranchName(sessionId, timestamp);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const branchName = attempt === 1 ? root : `${root}-${attempt}`;

    // Invariant: never create/operate on a protected base branch.
    if (branchName === baseBranch || PROTECTED_BRANCHES.has(branchName)) {
      throw new GithubApiError(
        `Refusing to create protected branch "${branchName}".`,
        400,
      );
    }

    if (await client.branchExists(branchName)) continue;

    await client.createBranch(branchName, baseSha);
    return { branchName, baseSha };
  }

  throw new GithubApiError(
    `Could not find a free branch name after ${maxAttempts} attempts (base "${root}").`,
    409,
  );
}
