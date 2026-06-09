/** Fixed role set for the AI Orchestrator. */
export const ROLES = [
  "owner",
  "admin",
  "developer",
  "reviewer",
  "viewer",
] as const;

export type Role = (typeof ROLES)[number];

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

/** Privilege ranking (higher = more powerful). Used to stop lower roles
 * managing higher ones (e.g. admin cannot manage an owner). */
export const ROLE_RANK: Record<Role, number> = {
  owner: 100,
  admin: 80,
  developer: 50,
  reviewer: 30,
  viewer: 10,
};
