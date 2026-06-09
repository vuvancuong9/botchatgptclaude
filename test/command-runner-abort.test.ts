import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runWorkerCommand,
  SpawnedChild,
} from "../lib/ai-orchestrator/worker/command-runner";

class FakeChild implements SpawnedChild {
  private outCbs: ((c: Buffer | string) => void)[] = [];
  private errCbs: ((c: Buffer | string) => void)[] = [];
  private closeCb: ((code: number | null) => void) | null = null;
  killed = false;
  stdout = { on: (_e: "data", cb: (c: Buffer | string) => void) => this.outCbs.push(cb) };
  stderr = { on: (_e: "data", cb: (c: Buffer | string) => void) => this.errCbs.push(cb) };
  on(ev: "close" | "error", cb: (arg: never) => void): void {
    if (ev === "close") this.closeCb = cb as (code: number | null) => void;
  }
  kill(): void {
    this.killed = true;
    this.closeCb?.(null); // a killed process emits 'close'
  }
  emitOut(s: string) {
    this.outCbs.forEach((cb) => cb(Buffer.from(s)));
  }
  close(code: number | null) {
    this.closeCb?.(code);
  }
}

function spawnWith(behavior: (child: FakeChild) => void) {
  return () => {
    const child = new FakeChild();
    setImmediate(() => behavior(child));
    return child;
  };
}

test("already-aborted signal -> command is not spawned", async () => {
  const ac = new AbortController();
  ac.abort();
  let spawned = false;
  const res = await runWorkerCommand("npm test", {
    cwd: ".",
    signal: ac.signal,
    spawnImpl: spawnWith(() => {
      spawned = true;
    }),
  });
  assert.equal(res.aborted, true);
  assert.equal(res.exitCode, null);
  assert.equal(spawned, false);
});

test("aborting during a run kills the child and returns aborted", async () => {
  const ac = new AbortController();
  let child: FakeChild | null = null;
  const res = await runWorkerCommand("npm test", {
    cwd: ".",
    signal: ac.signal,
    spawnImpl: () => {
      child = new FakeChild();
      // never closes on its own — wait for the abort to kill it
      setImmediate(() => ac.abort());
      return child;
    },
  });
  assert.equal(res.aborted, true);
  assert.equal(res.exitCode, null);
  assert.equal(child!.killed, true);
  assert.ok(res.stderr.includes("[ABORTED]"));
});

test("aborted output is still redacted", async () => {
  const ac = new AbortController();
  const res = await runWorkerCommand("npm test", {
    cwd: ".",
    signal: ac.signal,
    spawnImpl: spawnWith((c) => {
      c.emitOut("leak sk-ABCD1234efgh5678ijkl here");
      ac.abort();
    }),
  });
  assert.equal(res.stdout.includes("sk-ABCD1234efgh5678ijkl"), false);
});

test("timeout still fires independently of the abort signal", async () => {
  const ac = new AbortController();
  const res = await runWorkerCommand("npm test", {
    cwd: ".",
    timeoutMs: 20,
    signal: ac.signal,
    spawnImpl: spawnWith(() => {
      /* never closes; let the timeout fire */
    }),
  });
  assert.equal(res.timedOut, true);
  assert.equal(res.exitCode, null);
  assert.ok(res.stderr.includes("[TIMEOUT]"));
});
