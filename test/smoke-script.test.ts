import { test } from "node:test";
import assert from "node:assert/strict";
import { PostgresRepository } from "../lib/ai-orchestrator/db/postgres-repository";
import type { TableGateway } from "../lib/ai-orchestrator/db/supabase-server";
import { runSupabaseSmoke, SMOKE_FAKE_SECRET } from "../lib/ai-orchestrator/smoke";

// In-memory fake gateway (no network) — same shape used in postgres tests.
class FakeTableGateway implements TableGateway {
  tables = new Map<string, Record<string, unknown>[]>();
  private rows(t: string) {
    if (!this.tables.has(t)) this.tables.set(t, []);
    return this.tables.get(t)!;
  }
  private matches(row: Record<string, unknown>, match: Record<string, unknown>) {
    return Object.entries(match).every(([k, v]) => row[k] === v);
  }
  async insert(table: string, row: Record<string, unknown>) {
    this.rows(table).push({ ...row });
  }
  async selectOne<T>(table: string, match: Record<string, unknown>) {
    return (this.rows(table).find((r) => this.matches(r, match)) ?? null) as
      | T
      | null;
  }
  async selectMany<T>(
    table: string,
    match: Record<string, unknown>,
    opts?: { orderBy?: { column: string; ascending: boolean }; limit?: number },
  ) {
    let res = this.rows(table).filter((r) => this.matches(r, match));
    if (opts?.limit !== undefined) res = res.slice(0, opts.limit);
    return res as T[];
  }
  async update(
    table: string,
    match: Record<string, unknown>,
    patch: Record<string, unknown>,
  ) {
    for (const r of this.rows(table))
      if (this.matches(r, match)) Object.assign(r, patch);
  }
  async delete(table: string, match: Record<string, unknown>) {
    this.tables.set(
      table,
      this.rows(table).filter((r) => !this.matches(r, match)),
    );
  }
  async rpc<T>(): Promise<T> {
    throw new Error("rpc not supported in this fake");
  }
  async probe(table: string): Promise<void> {
    if (!this.tables.has(table)) throw new Error(`probe ${table}: no such table`);
  }
}

test("smoke: passes end-to-end against a fake gateway (no network)", async () => {
  const gw = new FakeTableGateway();
  const repo = new PostgresRepository(gw);
  const result = await runSupabaseSmoke({ repo, gateway: gw, cleanup: false });
  assert.equal(result.passed, true, JSON.stringify(result.steps));
  const redactionStep = result.steps.find((s) =>
    s.name.includes("secret redacted"),
  );
  assert.ok(redactionStep?.ok);
  // The fake secret must not survive anywhere in the stored run row.
  const runRow = gw.tables.get("ai_runs")![0];
  assert.equal(String(runRow.stdout).includes(SMOKE_FAKE_SECRET), false);
});

test("smoke: cleanup=1 removes the test session rows", async () => {
  const gw = new FakeTableGateway();
  const repo = new PostgresRepository(gw);
  const result = await runSupabaseSmoke({ repo, gateway: gw, cleanup: true });
  assert.equal(result.passed, true, JSON.stringify(result.steps));
  assert.equal((gw.tables.get("ai_sessions") ?? []).length, 0);
});
