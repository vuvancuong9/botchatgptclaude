process.env.AI_ORCHESTRATOR_DB = ":memory:";
process.env.AI_ORCHESTRATOR_DB_PROVIDER = "sqlite";
process.env.AI_ORCHESTRATOR_API_KEY_PEPPER = "settings-test-pepper-zz";

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getModelKeyStatus,
  resolveModelKeys,
  setModelApiKey,
  setModelName,
} from "../lib/ai-orchestrator/settings";

const E = process.env as Record<string, string | undefined>;

test("a DB key overrides the env key", async () => {
  E.OPENAI_API_KEY = "env-openai-key";
  await setModelApiKey("openai", "db-openai-key");
  const keys = await resolveModelKeys();
  assert.equal(keys.openai, "db-openai-key");
  delete E.OPENAI_API_KEY;
});

test("status reports set + source, never the value", async () => {
  await setModelApiKey("anthropic", "sk-ant-db-secret-xyz");
  await setModelName("anthropic", "claude-sonnet-4-5");
  const st = await getModelKeyStatus();
  assert.equal(st.anthropic_set, true);
  assert.equal(st.anthropic_in_db, true);
  assert.equal(st.anthropic_model, "claude-sonnet-4-5");
  assert.equal(JSON.stringify(st).includes("sk-ant-db-secret-xyz"), false);
});

test("clearing a DB key falls back to env", async () => {
  await setModelApiKey("openai", "to-be-cleared");
  await setModelApiKey("openai", ""); // clear
  E.OPENAI_API_KEY = "env-fallback";
  const keys = await resolveModelKeys();
  assert.equal(keys.openai, "env-fallback");
  delete E.OPENAI_API_KEY;
});

test("the stored value is encrypted (not plaintext)", async () => {
  const { getRepository } = await import("../lib/ai-orchestrator/db/factory");
  await setModelApiKey("openai", "sk-plain-should-be-encrypted");
  const row = await getRepository().getSetting("openai_api_key");
  assert.ok(row);
  assert.equal(row!.value.includes("sk-plain-should-be-encrypted"), false);
  assert.ok(row!.value.startsWith("v1:"));
});
