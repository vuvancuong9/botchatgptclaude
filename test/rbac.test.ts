import { test } from "node:test";
import assert from "node:assert/strict";
import { Role } from "../lib/ai-orchestrator/auth/roles";
import {
  ALL_PERMISSIONS,
  PERMISSIONS,
  PermissionOverride,
  effectivePermissions,
} from "../lib/ai-orchestrator/auth/permissions";
import {
  RbacSubject,
  hasPermission,
  subjectHasPermission,
  requirePermission,
  PermissionError,
  canAccessSession,
  canApproveSession,
  canCreatePullRequest,
  canManageUser,
} from "../lib/ai-orchestrator/auth/rbac";

function subject(
  role: Role,
  userId: string | null = "u1",
  overrides: PermissionOverride[] = [],
): RbacSubject {
  return { userId, role, permissions: effectivePermissions(role, overrides) };
}

const session = (userId: string | null, extra = {}) => ({
  user_id: userId,
  status: "passed",
  approval: "approved",
  ...extra,
});

test("owner has every permission", () => {
  const owner = subject("owner");
  for (const p of ALL_PERMISSIONS) {
    assert.equal(subjectHasPermission(owner, p), true, p);
  }
});

test("viewer cannot run or approve", () => {
  const viewer = subject("viewer");
  assert.equal(subjectHasPermission(viewer, PERMISSIONS.RUN), false);
  assert.equal(subjectHasPermission(viewer, PERMISSIONS.SESSION_APPROVE), false);
  assert.equal(canApproveSession(viewer, session("u1")), false);
});

test("developer cannot manage users and cannot read all", () => {
  const dev = subject("developer");
  assert.equal(subjectHasPermission(dev, PERMISSIONS.USERS_MANAGE), false);
  assert.equal(subjectHasPermission(dev, PERMISSIONS.SESSION_READ_ALL), false);
  assert.equal(subjectHasPermission(dev, PERMISSIONS.RUN), true);
});

test("hasPermission works on bare roles", () => {
  assert.equal(hasPermission("admin", PERMISSIONS.SESSION_APPROVE), true);
  assert.equal(hasPermission("viewer", PERMISSIONS.RUN), false);
  assert.equal(hasPermission("owner", PERMISSIONS.CONFIG_MANAGE), true);
  assert.equal(hasPermission("admin", PERMISSIONS.CONFIG_MANAGE), false);
});

test("requirePermission throws PermissionError when missing", () => {
  const viewer = subject("viewer");
  assert.throws(
    () => requirePermission(viewer, PERMISSIONS.RUN),
    PermissionError,
  );
  assert.doesNotThrow(() =>
    requirePermission(viewer, PERMISSIONS.SESSION_READ),
  );
});

test("permission overrides: allow adds, deny removes (deny wins)", () => {
  const reviewer = subject("reviewer", "r1", [
    { permission: PERMISSIONS.SESSION_APPROVE, effect: "allow" },
  ]);
  assert.equal(
    subjectHasPermission(reviewer, PERMISSIONS.SESSION_APPROVE),
    true,
  );
  const denied = subject("admin", "a1", [
    { permission: PERMISSIONS.SESSION_APPROVE, effect: "deny" },
  ]);
  assert.equal(subjectHasPermission(denied, PERMISSIONS.SESSION_APPROVE), false);
});

test("admin cannot manage an owner, can manage an admin/developer", () => {
  const admin = subject("admin");
  assert.equal(canManageUser(admin, "owner"), false);
  assert.equal(canManageUser(admin, "admin"), true);
  assert.equal(canManageUser(admin, "developer"), true);
  const owner = subject("owner");
  assert.equal(canManageUser(owner, "owner"), true);
  const dev = subject("developer");
  assert.equal(canManageUser(dev, "viewer"), false); // no users:manage
});

test("canAccessSession: read_all sees all; others only own/collaborator", () => {
  const admin = subject("admin", "admin1");
  assert.equal(canAccessSession(admin, session("someone")), true);

  const dev = subject("developer", "dev1");
  assert.equal(canAccessSession(dev, session("dev1")), true);
  assert.equal(canAccessSession(dev, session("other")), false);
  assert.equal(
    canAccessSession(dev, session("other"), { isCollaborator: true }),
    true,
  );
});

test("canCreatePullRequest requires permission + access + approval", () => {
  const admin = subject("admin", "admin1");
  assert.equal(canCreatePullRequest(admin, session("x")), true);
  assert.equal(
    canCreatePullRequest(admin, session("x", { approval: "pending", status: "needs_revision" })),
    false,
  );
  const dev = subject("developer", "dev1");
  assert.equal(canCreatePullRequest(dev, session("dev1")), false); // no pr:create
});
