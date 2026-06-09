import { redactSecrets } from "../security/redact";
import { WorkerJobRecord } from "../types";

/** Reasons a heartbeat aborts the running job. */
export type AbortReason =
  | "external_cancel"
  | "lease_lost"
  | "lease_renewal_failed";

export function resolveLeaseSeconds(
  env: Record<string, string | undefined> = process.env,
): number {
  const v = parseInt(env.AI_ORCHESTRATOR_WORKER_LEASE_SECONDS || "300", 10);
  return Number.isFinite(v) && v >= 30 ? v : 300;
}

export function resolveHeartbeatIntervalMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const v = parseInt(
    env.AI_ORCHESTRATOR_WORKER_HEARTBEAT_INTERVAL_MS || "60000",
    10,
  );
  return Number.isFinite(v) && v >= 1000 ? v : 60000;
}

export interface HeartbeatStats {
  renewals: number;
  failures: number;
  leaseRenewed: boolean;
  /** The abort reason, when the heartbeat triggered an abort. */
  reason: AbortReason | null;
}

export interface HeartbeatDeps {
  jobId: string;
  workerId: string;
  leaseSeconds: number;
  intervalMs: number;
  /** Consecutive RPC failures before fail-closed abort (default 3). */
  failClosedThreshold?: number;
  renew: (
    jobId: string,
    workerId: string,
    leaseSeconds: number,
  ) => Promise<WorkerJobRecord | null>;
  /** Classify a null-renew (cancelled vs owner change). */
  getStatus?: (jobId: string) => Promise<string | null>;
  onAbort: (reason: AbortReason) => void;
  /** Redacted log sink (worker_job_logs). */
  log?: (message: string) => void | Promise<void>;
}

/** Minimal controller surface the worker uses (real Heartbeat or a test fake). */
export interface HeartbeatController {
  start(): void;
  stop(): HeartbeatStats;
}

/**
 * Periodic lease renewal for a running job. `tick()` does one renewal attempt
 * (deterministically callable in tests); `start()` schedules it on an interval.
 * On a lost lease or repeated RPC failure it fires `onAbort` so the worker can
 * stop the command (fail-closed) instead of risking duplicate execution.
 */
export class Heartbeat implements HeartbeatController {
  readonly stats: HeartbeatStats = {
    renewals: 0,
    failures: 0,
    leaseRenewed: false,
    reason: null,
  };
  private consecutive = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private aborted = false;

  constructor(private readonly deps: HeartbeatDeps) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.deps.intervalMs);
    // Never keep the worker process alive just for the heartbeat.
    this.timer.unref?.();
  }

  stop(): HeartbeatStats {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    return this.stats;
  }

  private fire(reason: AbortReason): void {
    if (this.aborted) return;
    this.aborted = true;
    this.stats.reason = reason;
    this.deps.onAbort(reason);
  }

  async tick(): Promise<void> {
    if (this.aborted) return;
    try {
      const renewed = await this.deps.renew(
        this.deps.jobId,
        this.deps.workerId,
        this.deps.leaseSeconds,
      );
      if (renewed) {
        this.stats.renewals++;
        this.stats.leaseRenewed = true;
        this.consecutive = 0;
        await this.deps.log?.("lease renewed");
        return;
      }
      // Null renew: we lost the lease. Classify why so the worker can decide
      // between a clean cancel vs a failure.
      const status = this.deps.getStatus
        ? await this.deps.getStatus(this.deps.jobId).catch(() => null)
        : null;
      const reason: AbortReason =
        status === "cancelled" ? "external_cancel" : "lease_lost";
      await this.deps.log?.(`lease renew rejected (${reason})`);
      this.fire(reason);
    } catch (err) {
      this.stats.failures++;
      this.consecutive++;
      await this.deps.log?.(
        `heartbeat failed: ${redactSecrets(String((err as Error)?.message ?? err))}`,
      );
      if (this.consecutive >= (this.deps.failClosedThreshold ?? 3)) {
        this.fire("lease_renewal_failed");
      }
    }
  }
}
