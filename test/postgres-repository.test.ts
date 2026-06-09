import { test } from "node:test";
import assert from "node:assert/strict";
import { PostgresRepository } from "../lib/ai-orchestrator/db/postgres-repository";
import type { TableGateway } from "../lib/ai-orchestrator/db/supabase-server";
import {
  resolveDbProvider,
  getRepository,
  __resetRepositoryFactory,
} from "../lib/ai-orchestrator/db/factory";
import { OrchestratorRepository } from "../lib/ai-orchestrator/db/repository";
import { AgentOutput } from "../lib/ai-orchestrator/types";

// In-memory fake of the narrow data-access port — no network.
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
    if (opts?.orderBy) {
      const { column, ascending } = opts.orderBy;
      res = [...res].sort(
        (a, b) =>
          String(a[column]).localeCompare(String(b[column])) *
          (ascending ? 1 : -1),
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
    for (const r of this.rows(table)) {
      if (this.matches(r, match)) Object.assign(r, patch);
    }
  }
  async delete(table: string, match: Record<string, unknown>) {
    const kept = this.rows(table).filter((r) => !this.matches(r, match));
    this.tables.set(table, kept);
  }
  async rpc<T>(): Promise<T> {
    throw new Error("rpc not supported in this fake");
  }
  async probe(table: string): Promise<void> {
    if (!this.tables.has(table)) throw new Error(`probe ${table}: no such table`);
  }
}

const OUTPUT: AgentOutput = {
  status: "pass",
  summary: "ok",
  issues: [],
  next_action: "continue",
  artifacts: [{ type: "spec", content: "hello spec" }],
};

test("PostgresRepository: create + read session round-trips", async () => {
  const repo = new PostgresRepository(new FakeTableGateway());
  const s = await repo.createSession("Build X", {
    adminKeyFingerprint: "admin:abc",
  });
  assert.equal(s.status, "running");
  assert.equal(s.admin_key_fingerprint, "admin:abc");
  const got = await repo.getSession(s.id);
  assert.equal(got?.id, s.id);
  assert.equal(got?.user_request, "Build X");
});

test("PostgresRepository: addMessage persists artifacts and maps output", async () => {
  const gw = new FakeTableGateway();
  const repo = new PostgresRepository(gw);
  const s = await repo.createSession("req");
  await repo.addMessage({
    sessionId: s.id,
    step: "GPT_PRODUCT_SPEC",
    provider: "openai",
    round: 0,
    output: OUTPUT,
  });
  const messages = await repo.getMessages(s.id);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].output.summary, "ok");
  assert.equal(messages[0].output.artifacts[0].type, "spec");
  const artifacts = await repo.getArtifacts(s.id);
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].content, "hello spec");
});

test("PostgresRepository: getMessages handles JSONB string form too", async () => {
  const gw = new FakeTableGateway();
  const repo = new PostgresRepository(gw);
  // Simulate a driver that returns `output` as a JSON string.
  await gw.insert("ai_messages", {
    id: "m1",
    session_id: "s1",
    step: "QA_JUDGE",
    provider: "openai",
    round: 1,
    status: "pass",
    output: JSON.stringify(OUTPUT),
    created_at: "2026-01-01T00:00:00.000Z",
  });
  const messages = await repo.getMessages("s1");
  assert.equal(messages[0].output.summary, "ok");
});

test("PostgresRepository: addRun redacts secrets BEFORE persisting", async () => {
  const gw = new FakeTableGateway();
  const repo = new PostgresRepository(gw);
  const s = await repo.createSession("req");
  const run = await repo.addRun({
    sessionId: s.id,
    command: "npm test",
    allowed: true,
    exitCode: 0,
    stdout: "token sk-supersecretvalue123 leaked",
    stderr: "",
    step: "TEST_RUNNER",
  });
  // Returned value is redacted.
  assert.equal(run.stdout.includes("sk-supersecretvalue123"), false);
  // The value actually written to storage is redacted.
  const stored = gw.tables.get("ai_runs")![0];
  assert.equal(String(stored.stdout).includes("sk-supersecretvalue123"), false);
  // Status derived correctly.
  assert.equal(run.status, "passed");
  assert.equal(run.step_name, "TEST_RUNNER");
});

test("PostgresRepository: getSessionDetail returns full shape", async () => {
  const repo = new PostgresRepository(new FakeTableGateway());
  const s = await repo.createSession("req");
  await repo.addMessage({
    sessionId: s.id,
    step: "GPT_PRODUCT_SPEC",
    provider: "openai",
    round: 0,
    output: OUTPUT,
  });
  await repo.addRun({
    sessionId: s.id,
    command: "git diff",
    allowed: true,
    exitCode: 0,
    stdout: "",
    stderr: "",
  });
  const detail = await repo.getSessionDetail(s.id);
  assert.ok(detail);
  assert.equal(detail!.session.id, s.id);
  assert.equal(detail!.messages.length, 1);
  assert.equal(detail!.artifacts.length, 1);
  assert.equal(detail!.runs.length, 1);
});

test("PostgresRepository: updateSession merges status/approval/rounds", async () => {
  const repo = new PostgresRepository(new FakeTableGateway());
  const s = await repo.createSession("req");
  await repo.updateSession(s.id, { status: "passed", rounds: 2 });
  const got = await repo.getSession(s.id);
  assert.equal(got?.status, "passed");
  assert.equal(got?.rounds, 2);
  assert.equal(got?.approval, "pending"); // untouched
});

// ---- factory ----

test("factory: resolveDbProvider defaults to sqlite when unset", () => {
  assert.equal(resolveDbProvider(undefined), "sqlite");
  assert.equal(resolveDbProvider(""), "sqlite");
  assert.equal(resolveDbProvider("sqlite"), "sqlite");
});

test("factory: resolveDbProvider maps postgres/supabase", () => {
  assert.equal(resolveDbProvider("postgres"), "postgres");
  assert.equal(resolveDbProvider("supabase"), "postgres");
  assert.equal(resolveDbProvider("POSTGRES"), "postgres");
});

test("factory: unknown provider throws", () => {
  assert.throws(() => resolveDbProvider("mysql"), /Unknown AI_ORCHESTRATOR_DB_PROVIDER/);
});

test("factory: chooses SQLite repository when provider unset", () => {
  process.env.AI_ORCHESTRATOR_DB = ":memory:";
  delete process.env.AI_ORCHESTRATOR_DB_PROVIDER;
  __resetRepositoryFactory();
  const repo = getRepository();
  assert.ok(repo instanceof OrchestratorRepository);
});

test("factory: chooses Postgres repository when provider=postgres", () => {
  process.env.AI_ORCHESTRATOR_DB_PROVIDER = "postgres";
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test-key";
  __resetRepositoryFactory();
  const repo = getRepository();
  assert.ok(repo instanceof PostgresRepository);
  delete process.env.AI_ORCHESTRATOR_DB_PROVIDER;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  __resetRepositoryFactory();
});

test("factory: postgres selected but missing env throws (no silent fallback)", () => {
  process.env.AI_ORCHESTRATOR_DB_PROVIDER = "postgres";
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  __resetRepositoryFactory();
  assert.throws(() => getRepository(), /missing env/i);
  delete process.env.AI_ORCHESTRATOR_DB_PROVIDER;
  __resetRepositoryFactory();
});
