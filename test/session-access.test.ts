import { test } from "node:test";
import assert from "node:assert/strict";
import { Role } from "../lib/ai-orchestrator/auth/roles";
import { effectivePermissions } from "../lib/ai-orchestrator/auth/permissions";
import {
  RbacSubject,
  canAccessSession,
  canApproveSession,
} from "../lib/ai-orchestrator/auth/rbac";

function subject(role: Role, userId: string): RbacSubject {
  return { userId, role, permissions: effectivePermissions(role) };
}
const session = (userId: string | null) => ({
  user_id: userId,
  status: "passed",
  approval: "approved",
});

test("owner and admin can view all sessions", () => {
  assert.equal(canAccessSession(subject("owner", "o"), session("x")), true);
  assert.equal(canAccessSession(subject("admin", "a"), session("x")), true);
});

test("developer can only view their own session", () => {
  const dev = subject("developer", "dev1");
  assert.equal(canAccessSession(dev, session("dev1")), true);
  assert.equal(canAccessSession(dev, session("dev2")), false);
});

test("collaborator can view a shared session", () => {
  const reviewer = subject("reviewer", "rev1");
  assert.equal(canAccessSession(reviewer, session("owner1")), false);
  assert.equal(
    canAccessSession(reviewer, session("owner1"), { isCollaborator: true }),
    true,
  );
});

test("viewer cannot approve even own session", () => {
  const viewer = subject("viewer", "v1");
  assert.equal(canApproveSession(viewer, session("v1")), false);
});

test("admin can approve any accessible session", () => {
  const admin = subject("admin", "a1");
  assert.equal(canApproveSession(admin, session("someone")), true);
});
