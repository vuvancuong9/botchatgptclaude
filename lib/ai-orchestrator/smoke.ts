import { redactSecrets } from "./security/redact";
import type { AiOrchestratorRepository } from "./db/repository.interface";
import type { TableGateway } from "./db/supabase-server";

/** A recognizable fake secret used to prove redaction works end-to-end. */
export const SMOKE_FAKE_SECRET = "sk-smokefake1234567890";

const SMOKE_TABLES = [
  "ai_sessions",
  "ai_messages",
  "ai_artifacts",
  "ai_runs",
  "ai_audit_logs",
] as const;

export interface SmokeStep {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface SmokeResult {
  passed: boolean;
  steps: SmokeStep[];
  sessionId: string | null;
}

export interface SmokeDeps {
  repo: AiOrchestratorRepository;
  /** Used only for table-existence checks and optional cleanup. */
  gateway: Pick<TableGateway, "selectMany" | "delete">;
  cleanup: boolean;
  log?: (message: string) => void;
}

/**
 * Read/write smoke test for a real Postgres/Supabase backend.
 *
 * It NEVER runs migrations, creates tables, or alters schema — it only checks
 * the tables exist, writes a small test session/message/artifact/run/audit row,
 * reads them back, verifies secret redaction, updates status, and (optionally)
 * cleans up. No secret value is ever logged.
 */
export async function runSupabaseSmoke(deps: SmokeDeps): Promise<SmokeResult> {
  const steps: SmokeStep[] = [];
  let sessionId: string | null = null;
  const add = (name: string, ok: boolean, detail?: string) => {
    steps.push({ name, ok, detail });
    deps.log?.(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? `: ${detail}` : ""}`);
  };

  try {
    // 1) tables exist (read-only probe; no DDL)
    for (const table of SMOKE_TABLES) {
      try {
        await deps.gateway.selectMany(table, {}, { limit: 1 });
        add(`table ${table} exists`, true);
      } catch (err) {
        add(`table ${table} exists`, false, redactSecrets(String((err as Error).message)));
      }
    }

    // 2) create a test session
    const session = await deps.repo.createSession("[smoke] readiness check", {
      adminKeyFingerprint: "smoke",
    });
    sessionId = session.id;
    add("create session", true, session.id);

    // 3) write + read message (+ artifact)
    await deps.repo.addMessage({
      sessionId: session.id,
      step: "GPT_PRODUCT_SPEC",
      provider: "openai",
      round: 0,
      output: {
        status: "pass",
        summary: "smoke",
        issues: [],
        next_action: "continue",
        artifacts: [{ type: "spec", content: "smoke spec" }],
      },
    });
    const messages = await deps.repo.getMessages(session.id);
    add("write + read message", messages.length >= 1);
    const artifacts = await deps.repo.getArtifacts(session.id);
    add("write + read artifact", artifacts.length >= 1);

    // 4) write a run with a fake secret in stdout/stderr
    await deps.repo.addRun({
      sessionId: session.id,
      command: "npm test",
      allowed: true,
      exitCode: 0,
      stdout: `output leaking ${SMOKE_FAKE_SECRET} here`,
      stderr: `err ${SMOKE_FAKE_SECRET}`,
      step: "TEST_RUNNER",
    });
    add("write run", true);

    // 5) verify the secret was redacted on read-back
    const detail = await deps.repo.getSessionDetail(session.id);
    const stored = detail?.runs[0];
    const redacted =
      !!stored &&
      !stored.stdout.includes(SMOKE_FAKE_SECRET) &&
      !stored.stderr.includes(SMOKE_FAKE_SECRET);
    add("secret redacted in run output", redacted);

    // 6) audit log write + read
    await deps.repo.addAuditLog({
      eventType: "ai_run_completed",
      status: "ok",
      sessionId: session.id,
      adminKeyFingerprint: "smoke",
      metadata: { smoke: true },
    });
    const logs = await deps.repo.getAuditLogs(5);
    add("write + read audit log", logs.length >= 1);

    // 7) update status
    await deps.repo.updateSession(session.id, { status: "passed" });
    const after = await deps.repo.getSession(session.id);
    add("update session status", after?.status === "passed");

    // 8) optional cleanup
    if (deps.cleanup) {
      await deps.gateway.delete("ai_audit_logs", { session_id: session.id });
      await deps.gateway.delete("ai_sessions", { id: session.id }); // cascades
      add("cleanup", true);
    } else {
      add("cleanup skipped (rows retained for audit)", true);
    }
  } catch (err) {
    add("unexpected error", false, redactSecrets(String((err as Error).message)));
  }

  return { passed: steps.every((s) => s.ok), steps, sessionId };
}
