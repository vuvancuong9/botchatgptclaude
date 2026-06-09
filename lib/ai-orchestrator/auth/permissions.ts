import { Role } from "./roles";

/** The 14 permission constants. */
export const PERMISSIONS = {
  RUN: "ai:run",
  SESSION_CREATE: "ai:session:create",
  SESSION_READ: "ai:session:read",
  SESSION_READ_ALL: "ai:session:read_all",
  SESSION_APPROVE: "ai:session:approve",
  SESSION_REJECT: "ai:session:reject",
  ARTIFACT_CREATE: "ai:artifact:create",
  AUDIT_READ: "ai:audit:read",
  USERS_MANAGE: "ai:users:manage",
  APIKEY_MANAGE: "ai:apikey:manage",
  CONFIG_MANAGE: "ai:config:manage",
  // Phase 6: validate a patch set (ai:patch:create) + open a pull request.
  PATCH_CREATE: "ai:patch:create",
  PR_CREATE: "ai:pr:create",
  // Phase 7: enqueue + cancel sandbox test/build jobs.
  RUN_TESTS: "ai:run_tests",
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSIONS: Permission[] = Object.values(PERMISSIONS);

const P = PERMISSIONS;

/** Base permissions granted by each role (before per-user overrides). */
export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  owner: [...ALL_PERMISSIONS],
  admin: [
    P.RUN,
    P.SESSION_CREATE,
    P.SESSION_READ,
    P.SESSION_READ_ALL,
    P.SESSION_APPROVE,
    P.SESSION_REJECT,
    P.ARTIFACT_CREATE,
    P.AUDIT_READ,
    P.USERS_MANAGE,
    P.APIKEY_MANAGE,
    P.PATCH_CREATE,
    P.PR_CREATE,
    P.RUN_TESTS,
  ],
  developer: [
    P.RUN,
    P.SESSION_CREATE,
    P.SESSION_READ,
    P.ARTIFACT_CREATE,
    // Developers may validate patch sets and run sandbox tests, but NOT open PRs.
    P.PATCH_CREATE,
    P.RUN_TESTS,
  ],
  reviewer: [P.SESSION_READ],
  viewer: [P.SESSION_READ],
};

export type OverrideEffect = "allow" | "deny";

export interface PermissionOverride {
  permission: Permission;
  effect: OverrideEffect;
}

/**
 * Effective permissions = base role permissions, plus explicit allows, minus
 * explicit denies. Deny always wins when both exist for the same permission.
 */
export function effectivePermissions(
  role: Role,
  overrides: PermissionOverride[] = [],
): Permission[] {
  const set = new Set<Permission>(ROLE_PERMISSIONS[role] ?? []);
  for (const o of overrides) {
    if (o.effect === "allow") set.add(o.permission);
  }
  for (const o of overrides) {
    if (o.effect === "deny") set.delete(o.permission);
  }
  return [...set];
}
