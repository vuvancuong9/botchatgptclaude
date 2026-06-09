/**
 * Worker lease-renewal smoke test (Postgres only).
 *
 *   AI_ORCHESTRATOR_DB_PROVIDER=postgres SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     npm run smoke:worker-lease
 *   (add AI_ORCHESTRATOR_SMOKE_CLEANUP=1 to delete the test job afterwards)
 *
 * Claims a job as worker-1, then checks: worker-1 can renew, worker-2 cannot,
 * and a cancelled job can't be renewed. SKIPS cleanly (exit 0) when not
 * configured for Postgres. Never logs secrets.
 */
import { redactSecrets } from "../lib/ai-orchestrator/security/redact";
import { PostgresRepository } from "../lib/ai-orchestrator/db/postgres-repository";
import { createSupabaseGateway } from "../lib/ai-orchestrator/db/supabase-server";
import {
  runWorkerLeaseSmoke,
  shouldRunWorkerClaimSmoke,
} from "../lib/ai-orchestrator/worker/claim-smoke";

async function main(): Promise<void> {
  if (!shouldRunWorkerClaimSmoke()) {
    console.log(
      "[smoke:worker-lease] SKIP — requires AI_ORCHESTRATOR_DB_PROVIDER=postgres.",
    );
    process.exit(0);
  }

  const gateway = createSupabaseGateway();
  const repo = new PostgresRepository(gateway);
  const cleanup = process.env.AI_ORCHESTRATOR_SMOKE_CLEANUP === "1";

  const result = await runWorkerLeaseSmoke({
    repo,
    cleanup,
    deleteJob: async (id) => {
      await gateway.delete("ai_worker_job_logs", { job_id: id });
      await gateway.delete("ai_worker_jobs", { id });
    },
    log: (m) => console.log(`[smoke:worker-lease] ${m}`),
  });

  console.log(
    `[smoke:worker-lease] ${result.passed ? "PASSED" : "FAILED"}`,
  );
  process.exit(result.passed ? 0 : 1);
}

main().catch((err) => {
  console.error(
    "[smoke:worker-lease] FATAL:",
    redactSecrets(String((err as Error)?.message ?? err)),
  );
  process.exit(1);
});
