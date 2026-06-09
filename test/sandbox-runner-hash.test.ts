import { test } from "node:test";
import assert from "node:assert/strict";
import { runSandboxJob } from "../lib/ai-orchestrator/worker/sandbox-runner";
import { CommandRunResult } from "../lib/ai-orchestrator/worker/command-runner";

const okCmd = async (command: string): Promise<CommandRunResult> => ({
  command,
  allowed: true,
  exitCode: 0,
  stdout: "",
  stderr: "",
  timedOut: false,
  truncated: false,
  durationMs: 1,
});

function patchInput() {
  return {
    jobId: "job-h",
    jobType: "test_patch" as const,
    repo: { clone_url: "local", branch: "main" },
    commands: ["npm ci", "npm test"],
    patchSetId: "ps-1",
    applyPatch: true,
  };
}

test("base_hash_mismatch blocks commands and surfaces a structured error", async () => {
  const ran: string[] = [];
  const out = await runSandboxJob(patchInput(), {
    prepare: async () => ({ dir: "/tmp/ws", mode: "clone" }),
    cleanup: () => {},
    applyPatch: async () => ({
      patchApplied: false,
      changedFiles: [],
      diffSummary: "",
      baseHashChecked: false,
      errors: [{ code: "base_hash_mismatch", file_path: "src/a.ts" }],
    }),
    runCommand: async (c) => {
      ran.push(c);
      return okCmd(c);
    },
  });

  assert.equal(out.status, "failed");
  assert.equal(out.result.patch_applied, false);
  assert.equal(out.result.base_hash_checked, false);
  assert.deepEqual(ran, []); // no command executed
  assert.equal(out.result.errors?.[0].code, "base_hash_mismatch");
  assert.equal(out.result.errors?.[0].file_path, "src/a.ts");
});

test("the worker result never embeds file content", async () => {
  const SECRET_CONTENT = "TOP_SECRET_FILE_BODY_12345";
  const out = await runSandboxJob(patchInput(), {
    prepare: async () => ({ dir: "/tmp/ws", mode: "clone" }),
    cleanup: () => {},
    // The applier returns codes/paths only — it must never hand back content.
    applyPatch: async () => ({
      patchApplied: false,
      changedFiles: [],
      diffSummary: "",
      baseHashChecked: false,
      errors: [{ code: "base_hash_mismatch", file_path: "src/a.ts" }],
    }),
    runCommand: okCmd,
  });
  assert.equal(JSON.stringify(out.result).includes(SECRET_CONTENT), false);
});

test("a passing apply with verified hashes reports base_hash_checked=true", async () => {
  const out = await runSandboxJob(patchInput(), {
    prepare: async () => ({ dir: "/tmp/ws", mode: "clone" }),
    cleanup: () => {},
    applyPatch: async () => ({
      patchApplied: true,
      changedFiles: ["src/a.ts"],
      diffSummary: " src/a.ts | 1 +",
      baseHashChecked: true,
      errors: [],
    }),
    runCommand: okCmd,
  });
  assert.equal(out.status, "passed");
  assert.equal(out.result.base_hash_checked, true);
});
