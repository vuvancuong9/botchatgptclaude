import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildBranchName,
  createSessionBranch,
  shortSessionId,
} from "../lib/ai-orchestrator/github/branch-service";
import {
  CreatePullRequestArgs,
  CreatedPullRequest,
  DeleteFileArgs,
  GithubClient,
  GithubFileContent,
  PutFileArgs,
} from "../lib/ai-orchestrator/github/types";

/** Fake GitHub client that records writes and simulates branch existence. */
class FakeGithub implements GithubClient {
  created: string[] = [];
  puts: string[] = [];
  existing = new Set<string>();
  shaByBranch = new Map<string, string>([["main", "basesha123"]]);

  async getBranchSha(branch: string): Promise<string | null> {
    return this.shaByBranch.get(branch) ?? null;
  }
  async branchExists(branch: string): Promise<boolean> {
    return this.existing.has(branch);
  }
  async createBranch(newBranch: string, _fromSha: string): Promise<void> {
    if (newBranch === "main" || newBranch === "master") {
      throw new Error("must never create main/master");
    }
    this.created.push(newBranch);
    this.existing.add(newBranch);
  }
  async getFile(): Promise<GithubFileContent | null> {
    return null;
  }
  async putFile(args: PutFileArgs): Promise<void> {
    this.puts.push(args.branch);
  }
  async deleteFile(_args: DeleteFileArgs): Promise<void> {}
  async createPullRequest(
    _args: CreatePullRequestArgs,
  ): Promise<CreatedPullRequest> {
    return { number: 1, url: "https://example/pull/1" };
  }
}

const SID = "11111111-2222-3333-4444-555555555555";

test("branch name has the correct format", () => {
  assert.equal(shortSessionId(SID), "11111111");
  assert.equal(
    buildBranchName(SID, 1700000000000),
    "ai-orchestrator/session-11111111-1700000000000",
  );
  assert.match(
    buildBranchName(SID, 1700000000000),
    /^ai-orchestrator\/session-[a-z0-9]{1,8}-\d+$/,
  );
});

test("creates a branch off main and never pushes main", async () => {
  const gh = new FakeGithub();
  const r = await createSessionBranch(gh, {
    sessionId: SID,
    baseBranch: "main",
    timestamp: 1700000000000,
  });
  assert.ok(r.branchName.startsWith("ai-orchestrator/session-"));
  assert.equal(r.baseSha, "basesha123");
  assert.equal(gh.created.length, 1);
  assert.equal(gh.created.includes("main"), false);
});

test("branch conflict appends a numeric suffix", async () => {
  const gh = new FakeGithub();
  const root = buildBranchName(SID, 1700000000000);
  gh.existing.add(root); // first candidate is taken
  const r = await createSessionBranch(gh, {
    sessionId: SID,
    baseBranch: "main",
    timestamp: 1700000000000,
  });
  assert.equal(r.branchName, `${root}-2`);
  assert.equal(gh.created[0], `${root}-2`);
});

test("missing base branch fails", async () => {
  const gh = new FakeGithub();
  gh.shaByBranch.delete("main");
  await assert.rejects(() =>
    createSessionBranch(gh, {
      sessionId: SID,
      baseBranch: "main",
      timestamp: 1,
    }),
  );
});
