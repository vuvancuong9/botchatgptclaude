/**
 * GitHub integration types (Phase 6).
 *
 * Security invariants encoded here:
 *  - The token lives ONLY in GithubConfig (server-side); it is never part of
 *    any record, response, or log.
 *  - The client surface offers NO merge / force-push / delete-branch /
 *    deploy operation. It can read refs/files, create a branch from the
 *    default branch, write/delete files on that branch, and open a PR.
 */

export interface GithubConfig {
  /** Personal access / app token. Server-side only — never serialized. */
  token: string;
  owner: string;
  repo: string;
  /** The protected base branch (e.g. "main"). Never written to directly. */
  defaultBranch: string;
}

/** Runtime feature flags resolved from env. */
export interface GithubFlags {
  /** Master switch: AI_ORCHESTRATOR_ENABLE_GITHUB_PR === "1". */
  enableGithubPr: boolean;
  /** Safe default ON: live only when AI_ORCHESTRATOR_PR_DRY_RUN === "0". */
  dryRun: boolean;
}

export interface GithubFileContent {
  /** UTF-8 decoded file content. */
  content: string;
  /** Blob SHA used for optimistic concurrency on update/delete. */
  sha: string;
}

export interface PutFileArgs {
  path: string;
  /** Raw (decoded) file content; the client base64-encodes it. */
  content: string;
  message: string;
  branch: string;
  /** Required when overwriting an existing file (its current blob SHA). */
  sha?: string;
}

export interface DeleteFileArgs {
  path: string;
  message: string;
  branch: string;
  /** Current blob SHA of the file being removed. */
  sha: string;
}

export interface CreatePullRequestArgs {
  title: string;
  /** Source branch (the AI branch). */
  head: string;
  /** Target branch (the default/base branch). */
  base: string;
  body: string;
}

export interface CreatedPullRequest {
  number: number;
  url: string;
}

/**
 * Minimal GitHub port the services depend on. A fake implementing this
 * interface drives the unit tests with zero network access.
 */
export interface GithubClient {
  /** Latest commit SHA of a branch, or null if the branch does not exist. */
  getBranchSha(branch: string): Promise<string | null>;
  branchExists(branch: string): Promise<boolean>;
  /** Create a new branch ref pointing at an existing commit SHA. */
  createBranch(newBranch: string, fromSha: string): Promise<void>;
  /** Read a file at a ref, or null if it does not exist. */
  getFile(path: string, ref: string): Promise<GithubFileContent | null>;
  putFile(args: PutFileArgs): Promise<void>;
  deleteFile(args: DeleteFileArgs): Promise<void>;
  createPullRequest(args: CreatePullRequestArgs): Promise<CreatedPullRequest>;
}
