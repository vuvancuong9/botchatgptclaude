process.env.AI_ORCHESTRATOR_DB = ":memory:";
process.env.AI_ORCHESTRATOR_DB_PROVIDER = "sqlite";

import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryDb } from "../lib/ai-orchestrator/db";
import { OrchestratorRepository } from "../lib/ai-orchestrator/db/repository";
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
  files: [
    { path: "src/feature.ts", action: "create", content: "export const f=1;", reason: "x" },
  ],
  commands_to_run: ["npm test"],
  risk_notes: [],
});

class FakeGithub implements GithubClient {
  calls = { createBranch: 0, createPullRequest: 0 };
  async getBranchSha() {
    return "basesha";
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
    return { number: 9, url: "https://github.com/o/r/pull/9" };
  }
}

function subject(): RbacSubject {
  return { userId: "u1", role: "admin", permissions: effectivePermissions("admin") };
}

function config(): PrFlowConfig {
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
    patchHashStrict: false,
  };
}

function job(
  patchSetId: string | null,
  status: WorkerJobRecord["status"],
  patchApplied: boolean,
): WorkerJobRecord {
  return {
    id: "job-x",
    session_id: "s1",
    patch_set_id: patchSetId,
    pull_request_id: null,
    user_id: "u1",
    job_type: "test_patch",
    status,
    priority: 5,
    payload: {},
    result: { summary: "ok", patch_applied: patchApplied },
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
  workerJob: WorkerJobRecord | null,
) {
  return createPullRequestForSession({
    repo,
    subject: subject(),
    session,
    patchArtifactText: PATCH,
    existingPatchSet: patchSet as never,
    config: config(),
    githubClient: fake,
    healthCheck: async () => true,
    findRequiredWorkerJob: async () => workerJob,
    timestamp: 1700000000000,
  });
}

test("PR blocked when a passed job tested a DIFFERENT patch set", async () => {
  const { repo, session, patchSet } = await setup();
  const fake = new FakeGithub();
  const r = await run(repo, session, patchSet, fake, job("OTHER", "passed", true));
  assert.equal(r.ok, false);
  assert.equal(r.blockedReason, "worker_patch_mismatch");
  assert.equal(fake.calls.createBranch, 0);
});

test("PR blocked when the matching job did not apply the patch", async () => {
  const { repo, session, patchSet } = await setup();
  const fake = new FakeGithub();
  const r = await run(repo, session, patchSet, fake, job(patchSet.id, "passed", false));
  assert.equal(r.ok, false);
  assert.equal(r.blockedReason, "worker_required");
  assert.equal(fake.calls.createBranch, 0);
});

test("PR allowed when the matching job passed with patch applied", async () => {
  const { repo, session, patchSet } = await setup();
  const fake = new FakeGithub();
  const r = await run(repo, session, patchSet, fake, job(patchSet.id, "passed", true));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(fake.calls.createPullRequest, 1);
});

test("re-validating produces a newer patch set, so the old job no longer matches", async () => {
  const { repo, session, patchSet } = await setup();
  // The job passed for the FIRST patch set.
  const oldJob = job(patchSet.id, "passed", true);
  // A newer validated patch set (different id).
  const newer = await validateAndStorePatch({
    repo,
    session,
    userId: null,
    artifactText: PATCH,
    baseBranch: "main",
    targetBranch: "ai/y",
    canDelete: true,
  });
  assert.notEqual(newer.patchSet.id, patchSet.id);
  const fake = new FakeGithub();
  const r = await run(repo, session, newer.patchSet, fake, oldJob);
  assert.equal(r.ok, false);
  assert.equal(r.blockedReason, "worker_patch_mismatch");
});
