import { test } from "node:test";
import assert from "node:assert/strict";
import { runSandboxJob } from "../lib/ai-orchestrator/worker/sandbox-runner";
import { CommandRunResult } from "../lib/ai-orchestrator/worker/command-runner";

test("aborting mid-command stops the run and skips later commands", async () => {
  const ac = new AbortController();
  const ran: string[] = [];
  let sawSignal = false;

  const out = await runSandboxJob(
    {
      jobId: "j1",
      jobType: "test_branch",
      repo: { clone_url: "local", branch: "main" },
      commands: ["npm ci", "npm test", "npm run build"],
    },
    {
      prepare: async () => ({ dir: "/tmp/ws", mode: "copy" }),
      cleanup: () => {},
      abortSignal: ac.signal,
      runCommand: async (command, opts): Promise<CommandRunResult> => {
        ran.push(command);
        if (opts.signal) sawSignal = true;
        if (command === "npm ci") {
          // Simulate an external cancel arriving while this command runs.
          ac.abort("external_cancel");
          return {
            command,
            allowed: true,
            exitCode: null,
            stdout: "",
            stderr: "[ABORTED] command killed",
            timedOut: false,
            truncated: false,
            durationMs: 5,
            aborted: true,
          };
        }
        return {
          command,
          allowed: true,
          exitCode: 0,
          stdout: "",
          stderr: "",
          timedOut: false,
          truncated: false,
          durationMs: 1,
        };
      },
    },
  );

  assert.equal(out.status, "cancelled");
  assert.equal(out.result.cancelled_by_signal, true);
  assert.equal(sawSignal, true); // the abort signal is threaded to the command
  assert.deepEqual(ran, ["npm ci"]); // later commands never ran
});

test("a pre-aborted signal runs no commands at all", async () => {
  const ac = new AbortController();
  ac.abort();
  const ran: string[] = [];
  const out = await runSandboxJob(
    {
      jobId: "j2",
      jobType: "test_branch",
      repo: { clone_url: "local", branch: "main" },
      commands: ["npm ci", "npm test"],
    },
    {
      prepare: async () => ({ dir: "/tmp/ws", mode: "copy" }),
      cleanup: () => {},
      abortSignal: ac.signal,
      runCommand: async (c) => {
        ran.push(c);
        return {
          command: c,
          allowed: true,
          exitCode: 0,
          stdout: "",
          stderr: "",
          timedOut: false,
          truncated: false,
          durationMs: 1,
        };
      },
    },
  );
  assert.equal(out.status, "cancelled");
  assert.deepEqual(ran, []);
});
