import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validatePatch,
  contentContainsSecret,
} from "../lib/ai-orchestrator/patch/patch-validator";
import { parsePatchArtifact } from "../lib/ai-orchestrator/patch/patch-schema";
import type { PatchArtifact } from "../lib/ai-orchestrator/patch/patch-schema";

function patch(
  files: PatchArtifact["files"],
  commands: string[] = [],
): PatchArtifact {
  return { files, commands_to_run: commands, risk_notes: [] };
}
const file = (
  path: string,
  action: "create" | "modify" | "delete" = "create",
  content = "export const x = 1;",
) => ({ path, action, content, reason: "because" });

test("absolute path is blocked", () => {
  assert.equal(validatePatch(patch([file("/etc/passwd")])).ok, false);
  assert.equal(validatePatch(patch([file("C:\\Windows\\x.ts")])).ok, false);
});

test("'..' path traversal is blocked", () => {
  const r = validatePatch(patch([file("../outside.ts")]));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("traversal")));
});

test("'~' home reference is blocked", () => {
  assert.equal(validatePatch(patch([file("~/secrets.ts")])).ok, false);
});

test(".env files are blocked", () => {
  assert.equal(validatePatch(patch([file(".env")])).ok, false);
  assert.equal(validatePatch(patch([file(".env.local")])).ok, false);
  assert.equal(validatePatch(patch([file(".env.production")])).ok, false);
});

test("node_modules writes are blocked", () => {
  assert.equal(
    validatePatch(patch([file("node_modules/left-pad/index.js")])).ok,
    false,
  );
});

test(".git internals are blocked", () => {
  assert.equal(validatePatch(patch([file(".git/config")])).ok, false);
  assert.equal(validatePatch(patch([file("sub/.git/hooks/pre-push")])).ok, false);
});

test("package-lock.json requires explicit approval", () => {
  const p = patch([file("package-lock.json", "modify", "{}")]);
  assert.equal(validatePatch(p).ok, false);
  assert.equal(validatePatch(p, { packageLockApproved: true }).ok, true);
});

test("commands outside the allowlist are blocked", () => {
  const r = validatePatch(patch([file("src/a.ts")], ["rm -rf /"]));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("command not allowed")));
  // allowlisted commands pass.
  assert.equal(
    validatePatch(patch([file("src/a.ts")], ["npm test", "npm run build"])).ok,
    true,
  );
});

test("delete requires owner/admin", () => {
  const p = patch([{ path: "src/old.ts", action: "delete", reason: "gone" }]);
  assert.equal(validatePatch(p, { canDelete: false }).ok, false);
  assert.equal(validatePatch(p, { canDelete: true }).ok, true);
});

test("destructive migration is blocked", () => {
  const r = validatePatch(
    patch([file("migrations/x.sql", "create", "DROP TABLE users;")]),
  );
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("destructive migration")));
});

test("CI workflow production deploy is blocked", () => {
  const r = validatePatch(
    patch([
      file(
        ".github/workflows/deploy.yml",
        "create",
        "jobs:\n  deploy:\n    steps:\n      - run: vercel deploy --prod",
      ),
    ]),
  );
  assert.equal(r.ok, false);
});

test("secrets/tokens in content are blocked", () => {
  assert.equal(contentContainsSecret("const k = 'sk-ABCD1234efgh5678ijkl';"), true);
  assert.equal(
    contentContainsSecret("token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"),
    true,
  );
  const r = validatePatch(
    patch([file("src/cfg.ts", "create", "export const k = 'sk-ABCD1234efgh5678ijkl';")]),
  );
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("secret/token")));
});

test("a clean patch passes", () => {
  const r = validatePatch(
    patch([file("src/feature.ts", "create", "export const f = () => 42;")], [
      "npm run typecheck",
      "npm test",
    ]),
  );
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test("parsePatchArtifact extracts JSON from a code fence", () => {
  const text =
    "Here is the patch:\n```json\n" +
    JSON.stringify({
      files: [{ path: "a.ts", action: "create", content: "x", reason: "r" }],
      commands_to_run: ["npm test"],
      risk_notes: [],
    }) +
    "\n```";
  const parsed = parsePatchArtifact(text);
  assert.equal(parsed.files.length, 1);
  assert.equal(parsed.files[0].path, "a.ts");
});
