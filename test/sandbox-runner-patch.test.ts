import { test } from "node:test";
import assert from "node:assert/strict";
import { runSandboxJob } from "../lib/ai-orchestrator/worker/sandbox-runner";
import { CommandRunResult } from "../lib/ai-orchestrator/worker/command-runner";
import { ApplyPatchResult } from "../lib/ai-orchestrator/worker/patch-applier";

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

const goodApply: ApplyPatchResult = {
  patchApplied: true,
  changedFiles: ["src/a.ts", "src/b.ts"],
  diffSummary: " src/a.ts | 2 +-\n src/b.ts | 1 +",
  baseHashChecked: true,
  errors: [],
};

function patchInput() {
  return {
    jobId: "job1",
    jobType: "test_patch" as const,
    repo: { clone_url: "local", branch: "main" },
    commands: ["npm ci", "npm test"],
    patchSetId: "ps-1",
    applyPatch: true,
  };
}

test("test_patch applies the patch BEFORE running commands", async () => {
  const events: string[] = [];
  const out = await runSandboxJob(patchInput(), {
    prepare: async () => ({ dir: "/tmp/ws", mode: "clone" }),
    cleanup: () => {},
    applyPatch: async () => {
      events.push("apply");
      return goodApply;
    },
    runCommand: async (c) => {
      events.push(`cmd:${c}`);
      return okCmd(c);
    },
  });
  assert.equal(out.status, "passed");
  assert.equal(events[0], "apply");
  assert.deepEqual(events, ["apply", "cmd:npm ci", "cmd:npm test"]);
  assert.equal(out.result.patch_applied, true);
  assert.deepEqual(out.result.changed_files, ["src/a.ts", "src/b.ts"]);
  assert.ok((out.result.diff_summary ?? "").length > 0);
  assert.equal(out.result.patch_set_id, "ps-1");
});

test("a failed patch apply blocks commands and fails the job", async () => {
  const events: string[] = [];
  const out = await runSandboxJob(patchInput(), {
    prepare: async () => ({ dir: "/tmp/ws", mode: "clone" }),
    cleanup: () => {},
    applyPatch: async () => {
      events.push("apply");
      return {
        patchApplied: false,
        changedFiles: [],
        diffSummary: "",
        baseHashChecked: false,
        errors: [{ code: "create_existing_file", file_path: "x" }],
      };
    },
    runCommand: async (c) => {
      events.push(`cmd:${c}`);
      return okCmd(c);
    },
  });
  assert.equal(out.status, "failed");
  assert.equal(out.result.patch_applied, false);
  assert.deepEqual(events, ["apply"]); // no commands ran
});

test("missing patch_set_id fails a test_patch job", async () => {
  const out = await runSandboxJob(
    { ...patchInput(), patchSetId: null },
    {
      prepare: async () => ({ dir: "/tmp/ws", mode: "clone" }),
      cleanup: () => {},
      applyPatch: async () => goodApply,
      runCommand: okCmd,
    },
  );
  assert.equal(out.status, "failed");
});

test("apply_patch=false is rejected in production", async () => {
  let applied = false;
  const out = await runSandboxJob(
    { ...patchInput(), applyPatch: false },
    {
      prepare: async () => ({ dir: "/tmp/ws", mode: "clone" }),
      cleanup: () => {},
      env: { NODE_ENV: "production" } as unknown as NodeJS.ProcessEnv,
      applyPatch: async () => {
        applied = true;
        return goodApply;
      },
      runCommand: okCmd,
    },
  );
  assert.equal(out.status, "failed");
  assert.equal(applied, false);
});
