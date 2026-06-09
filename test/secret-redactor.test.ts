import { test } from "node:test";
import assert from "node:assert/strict";
import {
  redactSecrets,
  REDACTED,
} from "../lib/ai-orchestrator/security/redact";

test("redacts sk- tokens", () => {
  const out = redactSecrets("key is sk-abc123DEF456ghi here", {});
  assert.equal(out.includes("sk-abc123DEF456ghi"), false);
  assert.ok(out.includes(REDACTED));
});

test("redacts sk-ant- tokens", () => {
  const out = redactSecrets("auth sk-ant-xyz789TOKEN done", {});
  assert.equal(out.includes("sk-ant-xyz789TOKEN"), false);
});

test("redacts admin key value from env", () => {
  const env = { AI_ORCHESTRATOR_ADMIN_KEY: "my-admin-key-9999" };
  const out = redactSecrets("header x-ai-admin-key: my-admin-key-9999", env);
  assert.equal(out.includes("my-admin-key-9999"), false);
  assert.ok(out.includes(REDACTED));
});

test("redacts DATABASE_URL and service role key", () => {
  const env = {
    DATABASE_URL: "postgres://user:pass@host:5432/db",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-secret-abcdef",
  };
  const out = redactSecrets(
    "url=postgres://user:pass@host:5432/db role=service-role-secret-abcdef",
    env,
  );
  assert.equal(out.includes("postgres://user:pass@host:5432/db"), false);
  assert.equal(out.includes("service-role-secret-abcdef"), false);
});

test("redacts Authorization bearer and x-api-key headers", () => {
  const out = redactSecrets(
    "Authorization: Bearer abc.def.ghi\nx-api-key: someverysecretvalue",
    {},
  );
  assert.equal(out.includes("abc.def.ghi"), false);
  assert.equal(out.includes("someverysecretvalue"), false);
});

test("leaves harmless text intact", () => {
  const text = "Build succeeded in 7.2s. 5 routes generated.";
  assert.equal(redactSecrets(text, {}), text);
});

test("does not leak OPENAI/ANTHROPIC env values", () => {
  const env = {
    OPENAI_API_KEY: "sk-openaivalue123456",
    ANTHROPIC_API_KEY: "sk-ant-anthropicvalue654321",
  };
  const out = redactSecrets(
    "openai=sk-openaivalue123456 anthropic=sk-ant-anthropicvalue654321",
    env,
  );
  assert.equal(out.includes("sk-openaivalue123456"), false);
  assert.equal(out.includes("sk-ant-anthropicvalue654321"), false);
});
