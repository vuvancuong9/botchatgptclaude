import { redactSecrets } from "../security/redact";
import {
  CreatePullRequestArgs,
  CreatedPullRequest,
  DeleteFileArgs,
  GithubClient,
  GithubConfig,
  GithubFileContent,
  GithubFlags,
  PutFileArgs,
} from "./types";

const GITHUB_API = "https://api.github.com";
const PROTECTED_BRANCHES = new Set(["main", "master"]);

export interface ResolvedGithubConfig {
  config: GithubConfig | null;
  /** Names of required env vars that were missing. */
  missing: string[];
}

/**
 * Read GitHub config from env. Returns a null config + a `missing` list rather
 * than throwing, so the PR gate can refuse cleanly (G7) instead of 500-ing.
 * The token is read but NEVER logged or echoed.
 */
export function resolveGithubConfig(
  env: Record<string, string | undefined> = process.env,
): ResolvedGithubConfig {
  const token = env.GITHUB_TOKEN?.trim();
  const owner = env.GITHUB_OWNER?.trim();
  const repo = env.GITHUB_REPO?.trim();
  const defaultBranch = env.GITHUB_DEFAULT_BRANCH?.trim() || "main";

  const missing: string[] = [];
  if (!token) missing.push("GITHUB_TOKEN");
  if (!owner) missing.push("GITHUB_OWNER");
  if (!repo) missing.push("GITHUB_REPO");

  if (missing.length > 0) return { config: null, missing };
  return {
    config: {
      token: token as string,
      owner: owner as string,
      repo: repo as string,
      defaultBranch,
    },
    missing: [],
  };
}

/** Resolve the GitHub feature flags. Dry-run is ON unless explicitly "0". */
export function resolveGithubFlags(
  env: Record<string, string | undefined> = process.env,
): GithubFlags {
  return {
    enableGithubPr: env.AI_ORCHESTRATOR_ENABLE_GITHUB_PR === "1",
    dryRun: env.AI_ORCHESTRATOR_PR_DRY_RUN !== "0",
  };
}

export class GithubApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    // Defense in depth: never let a token leak through an error string.
    super(redactSecrets(message));
    this.name = "GithubApiError";
  }
}

function assertWritableBranch(branch: string, config: GithubConfig): void {
  if (branch === config.defaultBranch || PROTECTED_BRANCHES.has(branch)) {
    throw new GithubApiError(
      `Refusing to write to protected base branch "${branch}".`,
      400,
    );
  }
}

/** Real REST client. Server-side only — never construct this in the browser. */
export class RestGithubClient implements GithubClient {
  constructor(
    private readonly config: GithubConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private get base(): string {
    const { owner, repo } = this.config;
    return `${GITHUB_API}/repos/${owner}/${repo}`;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "ai-orchestrator",
      "Content-Type": "application/json",
    };
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; data: T | null }> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 404) return { status: 404, data: null };
    const text = await res.text();
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
    if (!res.ok) {
      const msg =
        (data as { message?: string } | null)?.message ?? `HTTP ${res.status}`;
      throw new GithubApiError(`GitHub ${method} ${path} failed: ${msg}`, res.status);
    }
    return { status: res.status, data: data as T };
  }

  async getBranchSha(branch: string): Promise<string | null> {
    const { data } = await this.request<{ object?: { sha?: string } }>(
      "GET",
      `/git/ref/heads/${encodeURIComponent(branch)}`,
    );
    return data?.object?.sha ?? null;
  }

  async branchExists(branch: string): Promise<boolean> {
    return (await this.getBranchSha(branch)) !== null;
  }

  async createBranch(newBranch: string, fromSha: string): Promise<void> {
    assertWritableBranch(newBranch, this.config);
    await this.request("POST", `/git/refs`, {
      ref: `refs/heads/${newBranch}`,
      sha: fromSha,
    });
  }

  async getFile(path: string, ref: string): Promise<GithubFileContent | null> {
    const { data } = await this.request<{ content?: string; sha?: string }>(
      "GET",
      `/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`,
    );
    if (!data || !data.sha) return null;
    const decoded = data.content
      ? Buffer.from(data.content.replace(/\s/g, ""), "base64").toString("utf8")
      : "";
    return { content: decoded, sha: data.sha };
  }

  async putFile(args: PutFileArgs): Promise<void> {
    assertWritableBranch(args.branch, this.config);
    await this.request("PUT", `/contents/${encodePath(args.path)}`, {
      message: args.message,
      content: Buffer.from(args.content, "utf8").toString("base64"),
      branch: args.branch,
      ...(args.sha ? { sha: args.sha } : {}),
    });
  }

  async deleteFile(args: DeleteFileArgs): Promise<void> {
    assertWritableBranch(args.branch, this.config);
    await this.request("DELETE", `/contents/${encodePath(args.path)}`, {
      message: args.message,
      branch: args.branch,
      sha: args.sha,
    });
  }

  async createPullRequest(
    args: CreatePullRequestArgs,
  ): Promise<CreatedPullRequest> {
    const { data } = await this.request<{ number: number; html_url: string }>(
      "POST",
      `/pulls`,
      {
        title: args.title,
        head: args.head,
        base: args.base,
        body: args.body,
        // Never auto-merge / never draft-merge; a human merges in GitHub.
        maintainer_can_modify: true,
      },
    );
    if (!data) throw new GithubApiError("GitHub returned no PR payload", 502);
    return { number: data.number, url: data.html_url };
  }
}

/** Encode a repo-relative path for the contents API (keep slashes). */
function encodePath(path: string): string {
  return path
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

/** Build the real client from config. */
export function createGithubClient(
  config: GithubConfig,
  fetchImpl: typeof fetch = fetch,
): GithubClient {
  return new RestGithubClient(config, fetchImpl);
}
