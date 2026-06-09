/**
 * Real Supabase/Postgres smoke test (run manually, never in CI).
 *
 *   AI_ORCHESTRATOR_DB_PROVIDER=postgres \
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... AI_ORCHESTRATOR_ADMIN_KEY=... \
 *   [AI_ORCHESTRATOR_SMOKE_CLEANUP=1] \
 *   npm run smoke:supabase
 *
 * It does NOT run migrations / create tables / alter schema. It only checks the
 * tables exist, writes a tiny session/message/artifact/run/audit row, verifies
 * secret redaction, updates status, and optionally cleans up. No secret value
 * is ever printed.
 */
import { resolveDbProvider } from "../lib/ai-orchestrator/db/factory";
import { createSupabaseGateway } from "../lib/ai-orchestrator/db/supabase-server";
import { PostgresRepository } from "../lib/ai-orchestrator/db/postgres-repository";
import { runSupabaseSmoke } from "../lib/ai-orchestrator/smoke";
import { redactSecrets } from "../lib/ai-orchestrator/security/redact";

// Exit codes: 0 = PASS, 1 = FAIL, 2 = SKIP (preconditions not met).
const SKIP = 2;

function skip(message: string): never {
  console.error(`[smoke] SKIP: ${message}`);
  process.exit(SKIP);
}

async function main(): Promise<void> {
  let provider: string;
  try {
    provider = resolveDbProvider();
  } catch (err) {
    return skip(redactSecrets(String((err as Error).message)));
  }
  if (provider !== "postgres") {
    return skip("AI_ORCHESTRATOR_DB_PROVIDER must be 'postgres'.");
  }
  for (const name of [
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "AI_ORCHESTRATOR_ADMIN_KEY",
  ]) {
    if (!process.env[name]) return skip(`missing env ${name}`);
  }

  const gateway = createSupabaseGateway();
  const repo = new PostgresRepository(gateway);
  const cleanup = process.env.AI_ORCHESTRATOR_SMOKE_CLEANUP === "1";

  const result = await runSupabaseSmoke({
    repo,
    gateway,
    cleanup,
    log: (m) => console.log("[smoke]", m),
  });

  console.log(
    `\n[smoke] RESULT: ${result.passed ? "PASS" : "FAIL"} ` +
      `(session ${result.sessionId ?? "n/a"}, cleanup ${cleanup ? "on" : "off"})`,
  );
  process.exit(result.passed ? 0 : 1);
}

main().catch((err) => {
  console.error("[smoke] FATAL:", redactSecrets(String(err?.message ?? err)));
  process.exit(1);
});
