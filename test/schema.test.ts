import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseAgentOutput,
  extractJsonObject,
  AgentOutputError,
} from "../lib/ai-orchestrator/schema";

const VALID = {
  status: "pass",
  summary: "ok",
  issues: [],
  next_action: "continue",
  artifacts: [{ type: "spec", content: "hello" }],
};

test("parses clean JSON", () => {
  const out = parseAgentOutput(JSON.stringify(VALID));
  assert.equal(out.status, "pass");
  assert.equal(out.artifacts[0].type, "spec");
});

test("extracts JSON from prose + code fence", () => {
  const wrapped = "Here you go:\n```json\n" + JSON.stringify(VALID) + "\n```\nThanks!";
  const out = parseAgentOutput(wrapped);
  assert.equal(out.summary, "ok");
});

test("extracts nested-brace JSON correctly", () => {
  const text = 'prefix {"a":{"b":1}} suffix';
  assert.equal(extractJsonObject(text), '{"a":{"b":1}}');
});

test("rejects invalid status", () => {
  const bad = { ...VALID, status: "great" };
  assert.throws(() => parseAgentOutput(JSON.stringify(bad)), AgentOutputError);
});

test("rejects wrong artifact type", () => {
  const bad = { ...VALID, artifacts: [{ type: "image", content: "x" }] };
  assert.throws(() => parseAgentOutput(JSON.stringify(bad)), AgentOutputError);
});

test("rejects missing fields", () => {
  assert.throws(
    () => parseAgentOutput('{"status":"pass"}'),
    AgentOutputError,
  );
});

test("rejects no-JSON text", () => {
  assert.throws(() => parseAgentOutput("no json here"), AgentOutputError);
});
