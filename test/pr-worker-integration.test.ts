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
    {
      path: "src/feature.ts",
      action: "create",
      content: "export const feature = () => 42;",
      reason: "add feature",
    },
  ],
  commands_to_run: ["npm test"],
  risk_notes: [],
});

class FakeGithub implements GithubClient {
  calls = { createBranch: 0, putFile: 0, createPullRequest: 0 };
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
  async putFile() {
    this.calls.putFile++;
  }
  async deleteFile() {}
  async createPullRequest(
    _a: CreatePullRequestArgs,
  ): Promise<CreatedPullRequest> {
    this.calls.createPullRequest++;
    return { number: 7, url: "https://github.com/o/r/pull/7" };
  }
}

function subject(role: "admin"): RbacSubject {
  return { userId: "u1", role, permissions: effectivePermissions(role) };
}

function workerConfig(over: Partial<PrFlowConfig> = {}): PrFlowConfig {
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
    ...over,
  };
}

function workerJob(
  status: WorkerJobRecord["status"],
  patchSetId: string | null,
  patchApplied: boolean,
): WorkerJobRecord {
  return {
    id: "job-1",
    session_id: "s1",
    patch_set_id: patchSetId,
    pull_request_id: null,
    user_id: "u1",
    job_type: "test_patch",
    status,
    priority: 5,
    payload: {},
    result: {
      summary: "2/2 passed",
      commands: [{ command: "npm test", exitCode: 0 }],
      patch_applied: patchApplied,
    },
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

async function approvedSession(
  repo: OrchestratorRepository,
): Promise<SessionRecord> {
  const s = await repo.createSession("Build a feature");
  await repo.updateSession(s.id, { approval: "approved" });
  return (await repo.getSession(s.id))!;
}

test("PR blocked when there is no sandbox job", async () => {
  const repo = new OrchestratorRepository(createMemoryDb());
  const session = await approvedSession(repo);
  const fake = new FakeGithub();
  const r = await createPullRequestForSession({
    repo,
    subject: subject("admin"),
    session,
    patchArtifactText: PATCH,
    config: workerConfig(),
    githubClient: fake,
    healthCheck: async () => true,
    findRequiredWorkerJob: async () => null,
    timestamp: 1700000000000,
  });
  assert.equal(r.ok, false);
  assert.equal(r.blockedReason, "worker_required");
  assert.equal(fake.calls.createBranch, 0);
});

test("PR blocked when the sandbox job failed", async () => {
  const repo = new OrchestratorRepository(createMemoryDb());
  const session = await approvedSession(repo);
  const fake = new FakeGithub();
  const r = await createPullRequestForSession({
    repo,
    subject: subject("admin"),
    session,
    patchArtifactText: PATCH,
    config: workerConfig(),
    githubClient: fake,
    healthCheck: async () => true,
    findRequiredWorkerJob: async () => workerJob("failed", "any", false),
    timestamp: 1700000000000,
  });
  assert.equal(r.ok, false);
  assert.equal(r.blockedReason, "worker_failed");
  assert.equal(fake.calls.createBranch, 0);
});

test("PR allowed when a matching job passed + applied + approved", async () => {
  const repo = new OrchestratorRepository(createMemoryDb());
  const session = await approvedSession(repo);
  const stored = await validateAndStorePatch({
    repo,
    session,
    userId: null,
    artifactText: PATCH,
    baseBranch: "main",
    targetBranch: "ai/x",
    canDelete: true,
  });
  const fake = new FakeGithub();
  const r = await createPullRequestForSession({
    repo,
    subject: subject("admin"),
    session,
    patchArtifactText: PATCH,
    existingPatchSet: stored.patchSet,
    config: workerConfig(),
    githubClient: fake,
    healthCheck: async () => true,
    findRequiredWorkerJob: async () =>
      workerJob("passed", stored.patchSet.id, true),
    timestamp: 1700000000000,
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.prUrl, "https://github.com/o/r/pull/7");
  assert.equal(fake.calls.createBranch, 1);
  assert.equal(fake.calls.createPullRequest, 1);
});
