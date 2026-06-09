import { getDb } from ".";
import { OrchestratorRepository } from "./repository";
import { PostgresRepository } from "./postgres-repository";
import { createSupabaseGateway } from "./supabase-server";
import type { AiOrchestratorRepository } from "./repository.interface";

export type DbProvider = "sqlite" | "postgres";

/**
 * Resolve the configured backend. Default is SQLite (local/MVP). Setting
 * AI_ORCHESTRATOR_DB_PROVIDER=postgres selects the Supabase/Postgres backend.
 * An unknown value throws rather than guessing.
 */
export function resolveDbProvider(
  raw: string | undefined = process.env.AI_ORCHESTRATOR_DB_PROVIDER,
): DbProvider {
  const value = (raw ?? "sqlite").trim().toLowerCase();
  if (value === "" || value === "sqlite") return "sqlite";
  if (value === "postgres" || value === "supabase") return "postgres";
  throw new Error(
    `Unknown AI_ORCHESTRATOR_DB_PROVIDER="${raw}" (expected "sqlite" or "postgres").`,
  );
}

// The Postgres gateway is stateless-ish and safe to reuse across requests.
let postgresSingleton: AiOrchestratorRepository | null = null;

/**
 * Factory used by the service layer. Selects the backend from env. When
 * "postgres" is selected but required env is missing, it throws — it never
 * silently falls back to SQLite (which would lose data on serverless).
 */
export function getRepository(): AiOrchestratorRepository {
  const provider = resolveDbProvider();
  if (provider === "postgres") {
    if (!postgresSingleton) {
      postgresSingleton = new PostgresRepository(createSupabaseGateway());
    }
    return postgresSingleton;
  }
  return new OrchestratorRepository(getDb());
}

/** Test/diagnostic helper to clear the cached Postgres repository. */
export function __resetRepositoryFactory(): void {
  postgresSingleton = null;
}
