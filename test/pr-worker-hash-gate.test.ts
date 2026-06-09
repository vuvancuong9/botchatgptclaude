process.env.AI_ORCHESTRATOR_DB = ":memory:";
process.env.AI_ORCHESTRATOR_DB_PROVIDER = "sqlite";

import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryDb } from "../lib/ai-orchestrator/db";
import { OrchestratorRepository } from "../lib/ai-orchestrator/db/repository";
import { getRepository } from "../lib/ai-orchestrator/db/factory";
import {
  createPullRequestForSession,
  PrFlowConfig,
} from "../lib/ai-orchestrator/github/pull-request-service";
import { validateAndStorePatch } from "../lib/ai-orchestrator/github/patch-service";
import { effectivePermissions } from "../lib/ai-orchestrator/auth/permissions";
import { RbacSubject } from "../lib/ai-orchestrator/auth/rbac";
import {
  CreatePullRequestArgs,
  CreatedPullRequest,
  GithubClient,
  GithubFileContent,
} from "../lib/ai-orchestrator/github/types";
import { SessionRecord, WorkerJobRecord } from "../lib/ai-orchestrator/types";

const PATCH = JSON.stringify({
  files: [{ path: "src/f.ts", action: "create", content: "export const f=1;", reason: "x" }],
  commands_to_run: ["npm test"],
  risk_notes: [],
});

class FakeGithub implements GithubClient {
  calls = { createBranch: 0, createPullRequest: 0 };
  async getBranchSha() {
    return "sha";
  }
  async branchExists() {
    return false;
  }
  async createBranch() {
    this.calls.createBranch++;
  }
  async getFile(): Promise<GithubFileContent | null> {
    return null;
  }
  async putFile() {}
  async deleteFile() {}
  async createPullRequest(_a: CreatePullRequestArgs): Promise<CreatedPullRequest> {
    this.calls.createPullRequest++;
    return { number: 11, url: "https://github.com/o/r/pull/11" };
  }
}

function subject(): RbacSubject {
  return { userId: "u1", role: "admin", permissions: effectivePermissions("admin") };
}

function strictConfig(): PrFlowConfig {
  return {
    enableGithubPr: true,
    dryRun: false,
    executeTests: false,
    requireSmokePass: false,
    smokePassedAt: null,
    githubConfig: { token: "x", owner: "o", repo: "r", defaultBranch: "main" },
    defaultBranch: "main",
    workerProvider: "database",
    allowInlineCommands: false,
    patchHashStrict: true, // Phase 7.1.1 strict
  };
}

function job(
  patchSetId: string,
  result: Record<string, unknown>,
  status: WorkerJobRecord["status"] = "passed",
): WorkerJobRecord {
  return {
    id: "job-h",
    session_id: "s1",
    patch_set_id: patchSetId,
    pull_request_id: null,
    user_id: "u1",
    job_type: "test_patch",
    status,
    priority: 5,
    payload: {},
    result,
    error_message: null,
    lease_owner: null,
    lease_expires_at: null,
    attempts: 1,
    max_attempts: 2,
    created_at: "2026-06-04T10:00:00Z",
    started_at: null,
    finished_at: null,
    updated_at: "2026-06-04T10:00:00Z",
  };
}

async function setup() {
  const repo = new OrchestratorRepository(createMemoryDb());
  const s = await repo.createSession("feature");
  await repo.updateSession(s.id, { approval: "approved" });
  const session = (await repo.getSession(s.id))!;
  const stored = await validateAndStorePatch({
    repo,
    session,
    userId: null,
    artifactText: PATCH,
    baseBranch: "main",
    targetBranch: "ai/x",
    canDelete: true,
  });
  return { repo, session, patchSet: stored.patchSet };
}

function run(
  repo: OrchestratorRepository,
  session: SessionRecord,
  patchSet: { id: string },
  fake: FakeGithub,
  workerJob: WorkerJobRecord,
) {
  return createPullRequestForSession({
    repo,
    subject: subject(),
    session,
    patchArtifactText: PATCH,
    existingPatchSet: patchSet as never,
    config: strictConfig(),
    githubClient: fake,
    healthCheck: async () => true,
    findRequiredWorkerJob: async () => workerJob,
    timestamp: 1700000000000,
  });
}

test("strict: passed+applied but base_hash_checked=false -> blocked + audited", async () => {
  const { repo, session, patchSet } = await setup();
  const fake = new FakeGithub();
  const r = await run(
    repo,
    session,
    patchSet,
    fake,
    job(patchSet.id, { patch_applied: true, base_hash_checked: false }),
  );
  assert.equal(r.ok, false);
  assert.equal(r.blockedReason, "worker_hash_not_checked");
  assert.equal(r.httpStatus, 409);
  assert.equal(fake.calls.createBranch, 0);

  const logs = await getRepository().getAuditLogs(100);
  assert.ok(logs.some((l) => l.event_type === "pr_blocked_worker_hash_not_checked"));
});

test("strict: passed+applied+base_hash_checked=true -> allowed", async () => {
  const { repo, session, patchSet } = await setup();
  const fake = new FakeGithub();
  const r = await run(
    repo,
    session,
    patchSet,
    fake,
    job(patchSet.id, { patch_applied: true, base_hash_checked: true }),
  );
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(fake.calls.createPullRequest, 1);
});

test("a job failed with base_hash_mismatch -> blocked base_hash_mismatch", async () => {
  const { repo, session, patchSet } = await setup();
  const fake = new FakeGithub();
  const r = await run(
    repo,
    session,
    patchSet,
    fake,
    job(
      patchSet.id,
      { patch_applied: false, base_hash_checked: false, errors: [{ code: "base_hash_mismatch" }] },
      "failed",
    ),
  );
  assert.equal(r.ok, false);
  assert.equal(r.blockedReason, "base_hash_mismatch");
  assert.equal(r.httpStatus, 409);
  assert.equal(fake.calls.createBranch, 0);
});
