import type { AiOrchestratorRepository } from "../db/repository.interface";

/** The worker-claim smoke only runs against a real Postgres backend. */
export function shouldRunWorkerClaimSmoke(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const p = (env.AI_ORCHESTRATOR_DB_PROVIDER ?? "").trim().toLowerCase();
  return p === "postgres" || p === "supabase";
}

export interface WorkerClaimSmokeDeps {
  repo: AiOrchestratorRepository;
  /** Number of concurrent claim attempts (default 5). */
  workerCount?: number;
  cleanup?: boolean;
  /** Row deletion for cleanup (real Postgres provides this via the gateway). */
  deleteJob?: (jobId: string) => Promise<void>;
  log?: (message: string) => void;
}

export interface WorkerClaimSmokeResult {
  passed: boolean;
  jobId: string;
  claimedCount: number;
  claimedBy: string | null;
  steps: { name: string; ok: boolean }[];
}

/**
 * Prove atomicity: enqueue ONE job, fire N concurrent claims with distinct
 * worker ids, and assert EXACTLY ONE succeeds. Never logs secrets.
 */
export async function runWorkerClaimSmoke(
  deps: WorkerClaimSmokeDeps,
): Promise<WorkerClaimSmokeResult> {
  const n = deps.workerCount ?? 5;
  const steps: { name: string; ok: boolean }[] = [];
  const add = (name: string, ok: boolean) => {
    steps.push({ name, ok });
    deps.log?.(`${ok ? "PASS" : "FAIL"} — ${name}`);
  };

  const job = await deps.repo.createWorkerJob({
    jobType: "test_branch",
    payload: {
      repo: { clone_url: "local", branch: "main" },
      commands: ["npm test"],
    },
  });
  add(`created queued job ${job.id}`, job.status === "queued");

  const results = await Promise.all(
    Array.from({ length: n }, (_unused, i) =>
      deps.repo.claimNextWorkerJob(`smoke-worker-${i + 1}`).catch(() => null),
    ),
  );
  const claimed = results.filter(Boolean) as NonNullable<(typeof results)[number]>[];
  const claimedCount = claimed.length;
  add(
    `exactly 1 of ${n} concurrent claims succeeded (got ${claimedCount})`,
    claimedCount === 1,
  );
  const claimedBy = claimed[0]?.lease_owner ?? null;

  const after = await deps.repo.getWorkerJob(job.id);
  add(
    "job is running with a single lease owner",
    after?.status === "running" && !!after?.lease_owner,
  );

  if (deps.cleanup && deps.deleteJob) {
    await deps.deleteJob(job.id).catch(() => {});
    add("cleanup", true);
  }

  return {
    passed: steps.every((s) => s.ok),
    jobId: job.id,
    claimedCount,
    claimedBy,
    steps,
  };
}

export interface WorkerLeaseSmokeResult {
  passed: boolean;
  jobId: string;
  steps: { name: string; ok: boolean }[];
}

/**
 * Prove lease renewal ownership: only the OWNER of a running job may renew, and
 * a cancelled job can't be renewed. Never logs secrets.
 */
export async function runWorkerLeaseSmoke(
  deps: WorkerClaimSmokeDeps,
): Promise<WorkerLeaseSmokeResult> {
  const steps: { name: string; ok: boolean }[] = [];
  const add = (name: string, ok: boolean) => {
    steps.push({ name, ok });
    deps.log?.(`${ok ? "PASS" : "FAIL"} — ${name}`);
  };

  const job = await deps.repo.createWorkerJob({
    jobType: "test_branch",
    payload: {
      repo: { clone_url: "local", branch: "main" },
      commands: ["npm test"],
    },
  });
  const claimed = await deps.repo.claimNextWorkerJob("smoke-worker-1");
  add("claimed by worker-1", claimed?.lease_owner === "smoke-worker-1");

  const r1 = await deps.repo.renewWorkerJobLease(job.id, "smoke-worker-1", 300);
  add("worker-1 renew succeeds", !!r1);

  const r2 = await deps.repo.renewWorkerJobLease(job.id, "smoke-worker-2", 300);
  add("worker-2 renew rejected (not owner)", r2 === null);

  await deps.repo.cancelWorkerJob(job.id);
  const r3 = await deps.repo.renewWorkerJobLease(job.id, "smoke-worker-1", 300);
  add("renew after cancel rejected", r3 === null);

  if (deps.cleanup && deps.deleteJob) {
    await deps.deleteJob(job.id).catch(() => {});
    add("cleanup", true);
  }

  return { passed: steps.every((s) => s.ok), jobId: job.id, steps };
}
