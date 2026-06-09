import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryDb } from "../lib/ai-orchestrator/db";
import { OrchestratorRepository } from "../lib/ai-orchestrator/db/repository";
import { Orchestrator, MAX_ROUNDS } from "../lib/ai-orchestrator/orchestrator";
import { AIAdapter, AdapterRequest, AdapterResult } from "../lib/ai-orchestrator/adapters/types";
import { AgentOutput } from "../lib/ai-orchestrator/types";

/** Adapter that honours the orchestrator's mockOutput (simulates offline mode). */
class PassthroughAdapter implements AIAdapter {
  constructor(public readonly provider: "openai" | "anthropic") {}
  readonly model = "fake";
  isLive() {
    return false;
  }
  async complete(req: AdapterRequest): Promise<AdapterResult> {
    return {
      output: req.mockOutput!,
      raw: "fake",
      mode: "mock",
      model: this.model,
    };
  }
}

/** Adapter that always returns a fixed output (used to inject a bad patch). */
class FixedAdapter implements AIAdapter {
  constructor(
    public readonly provider: "openai" | "anthropic",
    private readonly fixed: AgentOutput,
  ) {}
  readonly model = "fixed";
  isLive() {
    return false;
  }
  async complete(): Promise<AdapterResult> {
    return { output: this.fixed, raw: "fixed", mode: "mock", model: this.model };
  }
}

function repo() {
  return new OrchestratorRepository(createMemoryDb());
}

test("happy path completes and persists full session", async () => {
  const r = repo();
  const orch = new Orchestrator(r, {
    openai: new PassthroughAdapter("openai"),
    anthropic: new PassthroughAdapter("anthropic"),
    executeTests: false,
  });
  const result = await orch.run("Build a TODO API");
  assert.equal(result.status, "passed");
  assert.ok(result.rounds >= 1 && result.rounds <= MAX_ROUNDS);

  const detail = (await r.getSessionDetail(result.sessionId))!;
  assert.ok(detail.messages.length >= 6, "all steps persisted");
  // The seven distinct steps must all appear.
  const steps = new Set(detail.messages.map((m) => m.step));
  for (const s of [
    "GPT_PRODUCT_SPEC",
    "CLAUDE_CRITICAL_REVIEW",
    "GPT_IMPLEMENTATION_PLAN",
    "CLAUDE_CODE_IMPLEMENTER",
    "TEST_RUNNER",
    "GPT_CODE_REVIEWER",
    "QA_JUDGE",
  ]) {
    assert.ok(steps.has(s as never), `step ${s} present`);
  }
  // Runs (allowlisted commands) persisted.
  assert.ok(detail.runs.length >= 1);
  assert.ok(detail.runs.every((run) => run.allowed));
  // Artifacts persisted with correct types.
  const types = new Set(detail.artifacts.map((a) => a.type));
  assert.ok(types.has("spec"));
  assert.ok(types.has("plan"));
  assert.ok(types.has("patch"));
  assert.ok(types.has("test_report"));
});

test("never exceeds MAX_ROUNDS when judge keeps requesting revision", async () => {
  const r = repo();
  const needsRevision: AgentOutput = {
    status: "needs_revision",
    summary: "more work needed",
    issues: ["x"],
    next_action: "revise",
    artifacts: [{ type: "review", content: "revise please" }],
  };
  // openai drives QA_JUDGE + reviewer -> always needs_revision.
  const orch = new Orchestrator(r, {
    openai: new FixedAdapter("openai", needsRevision),
    anthropic: new PassthroughAdapter("anthropic"),
    executeTests: false,
  });
  const result = await orch.run("infinite loop attempt");
  assert.equal(result.status, "needs_revision");
  assert.equal(result.rounds, MAX_ROUNDS);
});

test("safety guard fails the run on a forbidden patch (rm -rf)", async () => {
  const r = repo();
  const badPatch: AgentOutput = {
    status: "pass",
    summary: "patch",
    issues: [],
    next_action: "continue",
    artifacts: [{ type: "patch", content: "run: rm -rf ./dist to clean" }],
  };
  const orch = new Orchestrator(r, {
    openai: new PassthroughAdapter("openai"),
    anthropic: new FixedAdapter("anthropic", badPatch),
    executeTests: false,
  });
  const result = await orch.run("please delete everything");
  assert.equal(result.status, "failed");

  const detail = (await r.getSessionDetail(result.sessionId))!;
  const flagged = detail.messages.find(
    (m) => m.provider === "system" && m.step === "CLAUDE_CODE_IMPLEMENTER",
  );
  assert.ok(flagged, "safety violation recorded");
  assert.equal(flagged!.output.status, "fail");
});

test("approval flag lets a destructive migration patch proceed", async () => {
  const r = repo();
  const migrationPatch: AgentOutput = {
    status: "pass",
    summary: "patch",
    issues: [],
    next_action: "continue",
    artifacts: [{ type: "patch", content: "DROP TABLE legacy_users;" }],
  };
  const orch = new Orchestrator(r, {
    openai: new PassthroughAdapter("openai"),
    anthropic: new FixedAdapter("anthropic", migrationPatch),
    humanApproved: true,
    executeTests: false,
  });
  const result = await orch.run("drop the legacy table, approved");
  // With approval, the destructive-migration guard does not block; the run
  // proceeds to completion instead of failing.
  assert.notEqual(result.status, "failed");
});
