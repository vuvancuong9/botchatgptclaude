/**
 * Bootstrap the first owner user + API key.
 *
 *   AI_OWNER_EMAIL=you@example.com AI_OWNER_NAME="You" npm run ai:create-owner
 *
 * Prints the raw API key EXACTLY ONCE (it is never stored — only its hash is).
 * Refuses to create a second owner unless AI_ORCHESTRATOR_FORCE_CREATE_OWNER=1.
 * Never prints DB credentials or other secrets.
 */
import { getRepository } from "../lib/ai-orchestrator/db/factory";
import { generateApiKey } from "../lib/ai-orchestrator/auth/api-key";
import { recordAudit } from "../lib/ai-orchestrator/audit";

async function main(): Promise<void> {
  const email = process.env.AI_OWNER_EMAIL ?? null;
  const name = process.env.AI_OWNER_NAME ?? null;
  const force = process.env.AI_ORCHESTRATOR_FORCE_CREATE_OWNER === "1";

  const repo = getRepository();
  const users = await repo.listUsers(1000);
  const existingOwner = users.find((u) => u.role === "owner");
  if (existingOwner && !force) {
    console.log(
      `[create-owner] An owner already exists (${existingOwner.id}). ` +
        `Set AI_ORCHESTRATOR_FORCE_CREATE_OWNER=1 to create another.`,
    );
    process.exit(0);
  }

  const user = await repo.createUser({
    email,
    displayName: name,
    role: "owner",
  });
  const generated = generateApiKey();
  const key = await repo.createApiKey({
    userId: user.id,
    keyPrefix: generated.prefix,
    keyHash: generated.hash,
    name: "bootstrap-owner-key",
  });

  // Best-effort audit (table may not exist on very first run).
  await recordAudit({
    eventType: "user_created",
    status: "ok",
    userId: user.id,
    metadata: { role: "owner", bootstrap: true },
  });
  await recordAudit({
    eventType: "api_key_created",
    status: "ok",
    userId: user.id,
    metadata: { apiKeyId: key.id, bootstrap: true },
  });

  console.log(`\n[create-owner] Owner created: ${user.id} ${email ?? "(no email)"}`);
  console.log("[create-owner] API KEY (shown ONCE — store it now):\n");
  console.log(`    ${generated.raw}\n`);
  console.log('[create-owner] Send it as header:  x-ai-api-key: <key>');
  process.exit(0);
}

main().catch((err) => {
  console.error("[create-owner] FATAL:", (err as Error).message);
  process.exit(1);
});
