// In-memory SQLite for the repo + audit factory (audit writes never block).
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
import { effectivePermissions } from "../lib/ai-orchestrator/auth/permissions";
import { RbacSubject } from "../lib/ai-orchestrator/auth/rbac";
import { Role } from "../lib/ai-orchestrator/auth/roles";
import {
  CreatePullRequestArgs,
  CreatedPullRequest,
  GithubClient,
  GithubFileContent,
} from "../lib/ai-orchestrator/github/types";
import { SessionRecord } from "../lib/ai-orchestrator/types";

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
  calls = {
    createBranch: 0,
    putFile: 0,
    deleteFile: 0,
    createPullRequest: 0,
    getFile: 0,
  };
  async getBranchSha(): Promise<string | null> {
    return "basesha";
  }
  async branchExists(): Promise<boolean> {
    return false;
  }
  async createBranch(): Promise<void> {
    this.calls.createBranch++;
  }
  async getFile(): Promise<GithubFileContent | null> {
    this.calls.getFile++;
    return null; // file does not exist -> "create" is valid
  }
  async putFile(): Promise<void> {
    this.calls.putFile++;
  }
  async deleteFile(): Promise<void> {
    this.calls.deleteFile++;
  }
  async createPullRequest(
    _args: CreatePullRequestArgs,
  ): Promise<CreatedPullRequest> {
    this.calls.createPullRequest++;
    return { number: 42, url: "https://github.com/o/r/pull/42" };
  }
}

function subject(role: Role): RbacSubject {
  return { userId: "u1", role, permissions: effectivePermissions(role) };
}

function liveConfig(over: Partial<PrFlowConfig> = {}): PrFlowConfig {
  return {
    enableGithubPr: true,
    dryRun: false,
    executeTests: true,
    requireSmokePass: false,
    smokePassedAt: null,
    githubConfig: { token: "x", owner: "o", repo: "r", defaultBranch: "main" },
    defaultBranch: "main",
    // Phase 6 tests exercise the inline path with injected runTests.
    workerProvider: "local",
    allowInlineCommands: true,
    patchHashStrict: false,
    ...over,
  };
}

async function approvedSession(
  repo: OrchestratorRepository,
): Promise<SessionRecord> {
  const s = await repo.createSession("Build a feature");
  await repo.updateSession(s.id, { approval: "approved" });
  return (await repo.getSession(s.id))!;
}

const PASS_TESTS = () => ({ results: [], passed: true });
const FAIL_TESTS = () => ({ results: [], passed: false });
const HEALTH_OK = async () => true;

test("dry-run validates + persists but never calls GitHub write", async () => {
  const repo = new OrchestratorRepository(createMemoryDb());
  const session = await approvedSession(repo);
  const fake = new FakeGithub();

  const r = await createPullRequestForSession({
    repo,
    subject: subject("admin"),
    session,
    patchArtifactText: PATCH,
    config: liveConfig({ dryRun: true }),
    githubClient: fake,
    runTests: PASS_TESTS,
    healthCheck: HEALTH_OK,
    timestamp: 1700000000000,
  });

  assert.equal(r.ok, true);
  assert.equal(r.mode, "dry_run");
  assert.equal(fake.calls.createBranch, 0);
  assert.equal(fake.calls.putFile, 0);
  assert.equal(fake.calls.createPullRequest, 0);

  // patch_set + patch_files persisted; a dry_run PR row recorded.
  const sets = await repo.getPatchSetsForSession(session.id);
  assert.equal(sets.length, 1);
  assert.equal(sets[0].status, "validated");
  const files = await repo.getPatchFiles(sets[0].id);
  assert.equal(files.length, 1);
  const prs = await repo.getPullRequestsForSession(session.id);
  assert.equal(prs[0].status, "dry_run");
});

test("live mode without the enable flag fails", async () => {
  const repo = new OrchestratorRepository(createMemoryDb());
  const session = await approvedSession(repo);
  const fake = new FakeGithub();
  const r = await createPullRequestForSession({
    repo,
    subject: subject("admin"),
    session,
    patchArtifactText: PATCH,
    config: liveConfig({ enableGithubPr: false }),
    githubClient: fake,
    runTests: PASS_TESTS,
    healthCheck: HEALTH_OK,
    timestamp: 1,
  });
  assert.equal(r.ok, false);
  assert.equal(r.blockedReason, "github_disabled");
  assert.equal(fake.calls.createBranch, 0);
});

test("missing GitHub config fails (no token/owner/repo)", async () => {
  const repo = new OrchestratorRepository(createMemoryDb());
  const session = await approvedSession(repo);
  const r = await createPullRequestForSession({
    repo,
    subject: subject("admin"),
    session,
    patchArtifactText: PATCH,
    config: liveConfig({ githubConfig: null }),
    githubClient: null, // no injected client either
    runTests: PASS_TESTS,
    healthCheck: HEALTH_OK,
    timestamp: 1,
  });
  assert.equal(r.ok, false);
  assert.equal(r.blockedReason, "github_not_configured");
});

test("failing tests block the PR", async () => {
  const repo = new OrchestratorRepository(createMemoryDb());
  const session = await approvedSession(repo);
  const fake = new FakeGithub();
  const r = await createPullRequestForSession({
    repo,
    subject: subject("admin"),
    session,
    patchArtifactText: PATCH,
    config: liveConfig(),
    githubClient: fake,
    runTests: FAIL_TESTS,
    healthCheck: HEALTH_OK,
    timestamp: 1,
  });
  assert.equal(r.ok, false);
  assert.equal(r.blockedReason, "tests_failed");
  assert.equal(fake.calls.createBranch, 0);
  const sets = await repo.getPatchSetsForSession(session.id);
  assert.equal(sets[0].status, "failed");
});

test("an unapproved session cannot create a PR", async () => {
  const repo = new OrchestratorRepository(createMemoryDb());
  const s = await repo.createSession("not approved yet"); // pending + running
  const session = (await repo.getSession(s.id))!;
  const fake = new FakeGithub();
  const r = await createPullRequestForSession({
    repo,
    subject: subject("admin"),
    session,
    patchArtifactText: PATCH,
    config: liveConfig(),
    githubClient: fake,
    runTests: PASS_TESTS,
    healthCheck: HEALTH_OK,
    timestamp: 1,
  });
  assert.equal(r.ok, false);
  assert.equal(r.blockedReason, "not_approved");
  assert.equal(fake.calls.createBranch, 0);
});

test("a user without ai:pr:create cannot create a PR", async () => {
  const repo = new OrchestratorRepository(createMemoryDb());
  const session = await approvedSession(repo);
  const fake = new FakeGithub();
  const r = await createPullRequestForSession({
    repo,
    subject: subject("developer"), // no PR_CREATE
    session,
    patchArtifactText: PATCH,
    config: liveConfig(),
    githubClient: fake,
    runTests: PASS_TESTS,
    healthCheck: HEALTH_OK,
    timestamp: 1,
  });
  assert.equal(r.ok, false);
  assert.equal(r.blockedReason, "permission_denied");
  assert.equal(fake.calls.createBranch, 0);
});

test("approved + permitted + tests pass creates the PR via the fake client", async () => {
  const repo = new OrchestratorRepository(createMemoryDb());
  const session = await approvedSession(repo);
  const fake = new FakeGithub();
  const r = await createPullRequestForSession({
    repo,
    subject: subject("admin"),
    session,
    patchArtifactText: PATCH,
    config: liveConfig(),
    githubClient: fake,
    runTests: PASS_TESTS,
    healthCheck: HEALTH_OK,
    timestamp: 1700000000000,
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.mode, "live");
  assert.equal(r.prUrl, "https://github.com/o/r/pull/42");
  assert.equal(fake.calls.createBranch, 1);
  assert.equal(fake.calls.putFile, 1);
  assert.equal(fake.calls.createPullRequest, 1);

  const prs = await repo.getPullRequestsForSession(session.id);
  assert.equal(prs[0].status, "created");
  assert.equal(prs[0].github_pr_number, 42);
  const sets = await repo.getPatchSetsForSession(session.id);
  assert.equal(sets[0].status, "applied");
});
