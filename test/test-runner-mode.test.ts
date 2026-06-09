import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertTestRunnerModeAllowed,
  resolveTestJobPollMs,
  resolveTestJobTimeoutMs,
  resolveTestRunnerMode,
  TestRunnerModeBlockedError,
} from "../lib/ai-orchestrator/test-runner-worker";

test("mode defaults to inline in dev, worker_async in production", () => {
  assert.equal(resolveTestRunnerMode({}), "inline");
  assert.equal(resolveTestRunnerMode({ NODE_ENV: "production" }), "worker_async");
});

test("explicit mode wins; 'worker' is a legacy alias for worker_wait", () => {
  assert.equal(
    resolveTestRunnerMode({ AI_ORCHESTRATOR_TEST_RUNNER_MODE: "worker_wait" }),
    "worker_wait",
  );
  assert.equal(
    resolveTestRunnerMode({ AI_ORCHESTRATOR_TEST_RUNNER_MODE: "worker" }),
    "worker_wait",
  );
  assert.equal(
    resolveTestRunnerMode({ AI_ORCHESTRATOR_TEST_RUNNER_MODE: "worker_async" }),
    "worker_async",
  );
  assert.equal(
    resolveTestRunnerMode({
      NODE_ENV: "production",
      AI_ORCHESTRATOR_TEST_RUNNER_MODE: "inline",
    }),
    "inline",
  );
});

test("production + inline is blocked unless inline commands are explicitly allowed", () => {
  assert.throws(
    () =>
      assertTestRunnerModeAllowed({
        NODE_ENV: "production",
        AI_ORCHESTRATOR_TEST_RUNNER_MODE: "inline",
      }),
    TestRunnerModeBlockedError,
  );
  // Explicit, risky override is permitted.
  assert.doesNotThrow(() =>
    assertTestRunnerModeAllowed({
      NODE_ENV: "production",
      AI_ORCHESTRATOR_TEST_RUNNER_MODE: "inline",
      AI_ORCHESTRATOR_ALLOW_INLINE_COMMANDS: "1",
    }),
  );
});

test("dev inline and any worker mode are allowed", () => {
  assert.doesNotThrow(() => assertTestRunnerModeAllowed({}));
  assert.doesNotThrow(() =>
    assertTestRunnerModeAllowed({
      NODE_ENV: "production",
      AI_ORCHESTRATOR_TEST_RUNNER_MODE: "worker",
    }),
  );
});

test("timeout / poll config parse from env with sane defaults", () => {
  assert.equal(resolveTestJobTimeoutMs({}), 900000);
  assert.equal(
    resolveTestJobTimeoutMs({ AI_ORCHESTRATOR_TEST_JOB_TIMEOUT_MS: "5000" }),
    5000,
  );
  assert.equal(resolveTestJobPollMs({}), 3000);
  assert.equal(
    resolveTestJobPollMs({ AI_ORCHESTRATOR_TEST_JOB_POLL_MS: "250" }),
    250,
  );
});
