import { getRepository } from "../db/factory";
import { generateApiKey } from "./api-key";
import { hashPassword, isAcceptablePassword, verifyPassword } from "./password";
import { AuthContext } from "./context";
import { recordAudit } from "../audit";

/**
 * Phase 10 — per-user web login (email + password). A successful login mints a
 * short-lived API key the browser stores + sends as x-ai-api-key, reusing the
 * existing RBAC/auth path. The raw password is never stored or logged.
 */

export interface LoginOutcome {
  ok: boolean;
  apiKey?: string;
  user?: {
    id: string;
    email: string | null;
    role: string;
    display_name: string | null;
  };
  error?: string;
}

const LOGIN_KEY_TTL_MS = 30 * 24 * 3600 * 1000; // 30 days

export async function loginWithPassword(
  email: string,
  password: string,
  meta: { ip?: string | null; userAgent?: string | null } = {},
): Promise<LoginOutcome> {
  const repo = getRepository();
  const normalized = (email ?? "").trim();
  const user = normalized ? await repo.getUserByEmail(normalized) : null;
  const ok =
    !!user &&
    user.status === "active" &&
    verifyPassword(password ?? "", user.password_hash);

  if (!ok || !user) {
    await recordAudit({
      eventType: "auth_failed",
      status: "denied",
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
      metadata: { method: "password" },
    });
    return { ok: false, error: "Email hoặc mật khẩu không đúng." };
  }

  const key = generateApiKey();
  await repo.createApiKey({
    userId: user.id,
    keyPrefix: key.prefix,
    keyHash: key.hash,
    name: "web-login",
    expiresAt: new Date(Date.now() + LOGIN_KEY_TTL_MS).toISOString(),
  });
  await repo.updateUserLastSeen(user.id).catch(() => {});
  await recordAudit({
    eventType: "auth_passed",
    status: "ok",
    userId: user.id,
    ip: meta.ip ?? null,
    userAgent: meta.userAgent ?? null,
    metadata: { method: "password" },
  });

  return {
    ok: true,
    apiKey: key.raw,
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      display_name: user.display_name,
    },
  };
}

/** Set/reset a user's password. Owner/admin can set anyone; a user can set self. */
export async function setPasswordForContext(
  ctx: AuthContext,
  targetUserId: string,
  newPassword: string,
): Promise<{ ok: boolean; error?: string }> {
  const isSelf = ctx.userId !== null && ctx.userId === targetUserId;
  const isAdmin = ctx.role === "owner" || ctx.role === "admin";
  if (!isSelf && !isAdmin) return { ok: false, error: "Không đủ quyền." };
  if (!isAcceptablePassword(newPassword)) {
    return { ok: false, error: "Mật khẩu phải có ít nhất 8 ký tự." };
  }
  const repo = getRepository();
  const target = await repo.getUserById(targetUserId);
  if (!target) return { ok: false, error: "User không tồn tại." };

  await repo.updateUserPassword(targetUserId, hashPassword(newPassword));
  await recordAudit({
    eventType: "user_password_set",
    status: "ok",
    userId: ctx.userId,
    adminKeyFingerprint: ctx.keyFingerprint,
    metadata: { targetUserId, self: isSelf },
  });
  return { ok: true };
}
