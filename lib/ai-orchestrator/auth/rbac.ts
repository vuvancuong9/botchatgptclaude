import { Role, ROLE_RANK } from "./roles";
import {
  ALL_PERMISSIONS,
  Permission,
  PERMISSIONS,
  ROLE_PERMISSIONS,
} from "./permissions";

export class PermissionError extends Error {
  constructor(public readonly permission: Permission) {
    super(`Missing required permission: ${permission}`);
    this.name = "PermissionError";
  }
}

/** Minimal subject used by the RBAC checks. */
export interface RbacSubject {
  userId: string | null;
  role: Role;
  permissions: Permission[];
}

/** Minimal session shape the RBAC checks need. */
export interface RbacSession {
  user_id: string | null;
  status: string;
  approval: string;
}

/** Does a bare role grant a permission (ignoring per-user overrides)? */
export function hasPermission(role: Role, permission: Permission): boolean {
  return (ROLE_PERMISSIONS[role] ?? []).includes(permission);
}

/** Does the resolved subject (effective permissions) hold the permission? */
export function subjectHasPermission(
  subject: Pick<RbacSubject, "permissions">,
  permission: Permission,
): boolean {
  return subject.permissions.includes(permission);
}

/** Throw PermissionError unless the subject holds the permission. */
export function requirePermission(
  subject: Pick<RbacSubject, "permissions">,
  permission: Permission,
): void {
  if (!subjectHasPermission(subject, permission)) {
    throw new PermissionError(permission);
  }
}

export interface AccessOptions {
  /** True when the subject is a collaborator on the session. */
  isCollaborator?: boolean;
}

export function canAccessSession(
  subject: RbacSubject,
  session: RbacSession,
  opts: AccessOptions = {},
): boolean {
  if (subjectHasPermission(subject, PERMISSIONS.SESSION_READ_ALL)) return true;
  if (!subjectHasPermission(subject, PERMISSIONS.SESSION_READ)) return false;
  if (subject.userId && session.user_id === subject.userId) return true;
  return Boolean(opts.isCollaborator);
}

export function canApproveSession(
  subject: RbacSubject,
  session: RbacSession,
  opts: AccessOptions = {},
): boolean {
  return (
    subjectHasPermission(subject, PERMISSIONS.SESSION_APPROVE) &&
    canAccessSession(subject, session, opts)
  );
}

export function canRejectSession(
  subject: RbacSubject,
  session: RbacSession,
  opts: AccessOptions = {},
): boolean {
  return (
    subjectHasPermission(subject, PERMISSIONS.SESSION_REJECT) &&
    canAccessSession(subject, session, opts)
  );
}

/**
 * Patch validation (Phase 6). Requires the patch permission and access to the
 * session. Does NOT require approval — validating a patch is read-only and is a
 * prerequisite for the (approval-gated) PR step.
 */
export function canValidatePatch(
  subject: RbacSubject,
  session: RbacSession,
  opts: AccessOptions = {},
): boolean {
  if (!subjectHasPermission(subject, PERMISSIONS.PATCH_CREATE)) return false;
  return canAccessSession(subject, session, opts);
}

/**
 * PR creation (used by Phase 6). Requires the permission, access to the
 * session, and that a human has approved it (or it passed).
 */
export function canCreatePullRequest(
  subject: RbacSubject,
  session: RbacSession,
  opts: AccessOptions = {},
): boolean {
  if (!subjectHasPermission(subject, PERMISSIONS.PR_CREATE)) return false;
  if (!canAccessSession(subject, session, opts)) return false;
  const approved =
    session.approval === "approved" || session.status === "passed";
  return approved;
}

/**
 * Can `actor` manage `targetRole`? Requires users:manage, and the actor's role
 * must outrank the target (so an admin cannot manage an owner).
 */
export function canManageUser(
  actor: RbacSubject,
  targetRole: Role,
): boolean {
  if (!subjectHasPermission(actor, PERMISSIONS.USERS_MANAGE)) return false;
  return ROLE_RANK[actor.role] >= ROLE_RANK[targetRole] && actor.role !== "viewer";
}

export { ALL_PERMISSIONS, PERMISSIONS };
