import { getRepository } from "../db/factory";
import { ADMIN_KEY_HEADER, checkAdminKey } from "../security/auth";
import {
  API_KEY_HEADER,
  apiKeyFingerprint,
  parseApiKey,
  verifyApiKey,
} from "./api-key";
import { isRole, Role } from "./roles";
import {
  ALL_PERMISSIONS,
  effectivePermissions,
  Permission,
} from "./permissions";
import { AuditEventType } from "../types";

/** The authenticated principal carried through every request. */
export interface AuthContext {
  userId: string | null;
  role: Role;
  permissions: Permission[];
  apiKeyId: string | null;
  /** Non-reversible fingerprint for rate-limit / audit (never the raw key). */
  keyFingerprint: string;
  legacyAdmin: boolean;
}

export type AuthResolution =
  | { ok: true; context: AuthContext; auditEvent: AuditEventType }
  | { ok: false; status: 401 | 403; error: string; auditEvent: AuditEventType };

interface HeaderCarrier {
  headers: { get(name: string): string | null };
}

/**
 * Resolve an AuthContext from the request:
 *   1. x-ai-api-key  -> user-based RBAC (preferred)
 *   2. x-ai-admin-key -> legacy owner access (only if explicitly enabled)
 */
export async function resolveAuthContext(
  req: HeaderCarrier,
): Promise<AuthResolution> {
  const repo = getRepository();

  // --- 1) API key auth ---
  const parsed = parseApiKey(req.headers.get(API_KEY_HEADER));
  if (parsed) {
    const key = await repo.getApiKeyByPrefix(parsed.prefix);
    if (!key || !verifyApiKey(parsed.raw, key.key_hash)) {
      return {
        ok: false,
        status: 401,
        error: "Invalid API key.",
        auditEvent: "auth_failed",
      };
    }
    if (key.status !== "active") {
      return {
        ok: false,
        status: 403,
        error: "API key revoked.",
        auditEvent: "auth_denied",
      };
    }
    if (key.expires_at && Date.parse(key.expires_at) < Date.now()) {
      return {
        ok: false,
        status: 403,
        error: "API key expired.",
        auditEvent: "auth_denied",
      };
    }
    const user = await repo.getUserById(key.user_id);
    if (!user) {
      return {
        ok: false,
        status: 401,
        error: "Invalid API key.",
        auditEvent: "auth_failed",
      };
    }
    if (user.status !== "active") {
      return {
        ok: false,
        status: 403,
        error: "User account disabled.",
        auditEvent: "auth_denied",
      };
    }

    const role: Role = isRole(user.role) ? user.role : "viewer";
    const overrides = await repo.getUserPermissionOverrides(user.id);
    const permissions = effectivePermissions(
      role,
      overrides.map((o) => ({
        permission: o.permission as Permission,
        effect: o.effect,
      })),
    );

    // Fire-and-forget activity timestamps (never block / crash the request).
    void repo.updateApiKeyLastUsed(key.id).catch(() => {});
    void repo.updateUserLastSeen(user.id).catch(() => {});

    return {
      ok: true,
      auditEvent: "auth_passed",
      context: {
        userId: user.id,
        role,
        permissions,
        apiKeyId: key.id,
        keyFingerprint: apiKeyFingerprint(parsed.prefix),
        legacyAdmin: false,
      },
    };
  }

  // --- 2) Legacy admin key (migration window only) ---
  if (process.env.AI_ORCHESTRATOR_ALLOW_LEGACY_ADMIN_KEY === "1") {
    const legacy = checkAdminKey(req.headers.get(ADMIN_KEY_HEADER));
    if (legacy.ok) {
      return {
        ok: true,
        auditEvent: "legacy_admin_used",
        context: {
          userId: null,
          role: "owner",
          permissions: [...ALL_PERMISSIONS],
          apiKeyId: null,
          keyFingerprint: legacy.identifier,
          legacyAdmin: true,
        },
      };
    }
  }

  return {
    ok: false,
    status: 401,
    error: "Missing or invalid API key (x-ai-api-key).",
    auditEvent: "auth_failed",
  };
}
