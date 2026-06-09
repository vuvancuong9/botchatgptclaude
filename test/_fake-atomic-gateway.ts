import type { TableGateway } from "../lib/ai-orchestrator/db/supabase-server";

/**
 * In-memory TableGateway whose `rpc("claim_ai_worker_job", ...)` reproduces the
 * SQL function's semantics. Because JS is single-threaded and the rpc body is
 * synchronous, concurrent claims serialize — so the first call wins and the rest
 * see the job already running (exactly like FOR UPDATE SKIP LOCKED).
 */
export class FakeAtomicGateway implements TableGateway {
  tables = new Map<string, Record<string, unknown>[]>();
  // Call counters to prove the repo uses RPC (no read-then-write claim).
  calls = { insert: 0, selectOne: 0, selectMany: 0, update: 0, delete: 0, rpc: 0 };
  private clockMs = Date.parse("2026-06-04T10:00:00.000Z");

  setNow(iso: string) {
    this.clockMs = Date.parse(iso);
  }
  private nowIso(): string {
    return new Date(this.clockMs).toISOString();
  }
  private rows(t: string) {
    if (!this.tables.has(t)) this.tables.set(t, []);
    return this.tables.get(t)!;
  }
  private matches(row: Record<string, unknown>, match: Record<string, unknown>) {
    return Object.entries(match).every(([k, v]) => row[k] === v);
  }

  async insert(table: string, row: Record<string, unknown>) {
    this.calls.insert++;
    this.rows(table).push({ ...row });
  }
  async selectOne<T>(table: string, match: Record<string, unknown>) {
    this.calls.selectOne++;
    return (this.rows(table).find((r) => this.matches(r, match)) ?? null) as T | null;
  }
  async selectMany<T>(
    table: string,
    match: Record<string, unknown>,
    opts?: { orderBy?: { column: string; ascending: boolean }; limit?: number },
  ) {
    this.calls.selectMany++;
    let res = this.rows(table).filter((r) => this.matches(r, match));
    if (opts?.orderBy) {
      const { column, ascending } = opts.orderBy;
      res = [...res].sort(
        (a, b) =>
          String(a[column]).localeCompare(String(b[column])) * (ascending ? 1 : -1),
      );
    }
    if (opts?.limit !== undefined) res = res.slice(0, opts.limit);
    return res as T[];
  }
  async update(
    table: string,
    match: Record<string, unknown>,
    patch: Record<string, unknown>,
  ) {
    this.calls.update++;
    for (const r of this.rows(table)) if (this.matches(r, match)) Object.assign(r, patch);
  }
  async delete(table: string, match: Record<string, unknown>) {
    this.calls.delete++;
    this.tables.set(table, this.rows(table).filter((r) => !this.matches(r, match)));
  }
  async probe(table: string): Promise<void> {
    if (!this.tables.has(table)) throw new Error(`probe ${table}: no such table`);
  }

  async rpc<T>(name: string, params: Record<string, unknown>): Promise<T> {
    this.calls.rpc++;
    if (name === "renew_ai_worker_job_lease") {
      const jobs = this.rows("ai_worker_jobs");
      const job = jobs.find((j) => j.id === params.p_job_id);
      if (
        !job ||
        job.status !== "running" ||
        job.lease_owner !== params.p_worker_id
      ) {
        return [] as unknown as T;
      }
      const leaseSeconds = Number(params.p_lease_seconds ?? 300);
      job.lease_expires_at = new Date(
        this.clockMs + leaseSeconds * 1000,
      ).toISOString();
      job.updated_at = this.nowIso();
      return [{ ...job }] as unknown as T;
    }
    if (name !== "claim_ai_worker_job") {
      throw new Error(`unknown rpc ${name}`);
    }
    const now = this.nowIso();
    const nowMs = this.clockMs;
    const jobs = this.rows("ai_worker_jobs");
    const claimable = (j: Record<string, unknown>) =>
      j.status === "queued" ||
      (j.status === "running" &&
        (!j.lease_expires_at || Date.parse(String(j.lease_expires_at)) < nowMs));

    // Fail any claimable job that exhausted its attempts.
    for (const j of jobs) {
      if (claimable(j) && Number(j.attempts) >= Number(j.max_attempts)) {
        j.status = "failed";
        j.error_message = "max attempts exceeded";
        j.finished_at = now;
        j.updated_at = now;
      }
    }

    const eligible = jobs
      .filter((j) => claimable(j) && Number(j.attempts) < Number(j.max_attempts))
      .sort(
        (a, b) =>
          Number(a.priority) - Number(b.priority) ||
          Date.parse(String(a.created_at)) - Date.parse(String(b.created_at)),
      );
    const job = eligible[0];
    if (!job) return [] as unknown as T;

    const leaseSeconds = Number(params.p_lease_seconds ?? 300);
    job.status = "running";
    job.lease_owner = params.p_worker_id;
    job.lease_expires_at = new Date(nowMs + leaseSeconds * 1000).toISOString();
    job.attempts = Number(job.attempts) + 1;
    job.started_at = job.started_at ?? now;
    job.updated_at = now;
    return [{ ...job }] as unknown as T;
  }
}
