import { createHash } from "node:crypto";
import { getRepository } from "./db/factory";
import { redactSecrets } from "./security/redact";
import { AuditEventType } from "./types";

/** One-way hash; we store hashes of IP / user-agent, never the raw values. */
export function hashValue(value?: string | null): string | null {
  if (!value) return null;
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

export interface AuditInput {
  eventType: AuditEventType;
  status?: string;
  sessionId?: string | null;
  adminKeyFingerprint?: string | null;
  userId?: string | null;
  /** Raw IP — hashed before storage. */
  ip?: string | null;
  /** Raw user-agent — hashed before storage. */
  userAgent?: string | null;
  metadata?: Record<string, unknown>;
}

/** Redact any string values that might contain secrets before persisting. */
function sanitizeMetadata(
  meta?: Record<string, unknown>,
): Record<string, unknown> {
  if (!meta) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    out[k] = typeof v === "string" ? redactSecrets(v) : v;
  }
  return out;
}

function safeInternalLog(message: string): void {
  // Only emit when explicitly debugging; the message is already redacted.
  if (process.env.AI_ORCHESTRATOR_DEBUG === "1") {
    // eslint-disable-next-line no-console
    console.warn("[audit]", message);
  }
}

/**
 * Record an audit event. NEVER throws — a failed audit write must not crash the
 * main request. Internal failures are logged (redacted) only when debugging.
 */
export async function recordAudit(input: AuditInput): Promise<void> {
  try {
    const repo = getRepository();
    await repo.addAuditLog({
      eventType: input.eventType,
      status: input.status ?? "ok",
      sessionId: input.sessionId ?? null,
      adminKeyFingerprint: input.adminKeyFingerprint ?? null,
      userId: input.userId ?? null,
      ipHash: hashValue(input.ip),
      userAgentHash: hashValue(input.userAgent),
      metadata: sanitizeMetadata(input.metadata),
    });
  } catch (err) {
    safeInternalLog(
      `audit write failed: ${redactSecrets(String((err as Error)?.message ?? err))}`,
    );
  }
}
