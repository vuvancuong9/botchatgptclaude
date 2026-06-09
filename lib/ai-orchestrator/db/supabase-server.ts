import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Narrow data-access port the PostgresRepository depends on. Keeping the
 * surface tiny makes the repository trivial to unit-test with a fake and keeps
 * the concrete Supabase dependency isolated to this file.
 */
export interface TableGateway {
  insert(table: string, row: Record<string, unknown>): Promise<void>;
  selectOne<T>(
    table: string,
    match: Record<string, unknown>,
  ): Promise<T | null>;
  selectMany<T>(
    table: string,
    match: Record<string, unknown>,
    opts?: {
      orderBy?: { column: string; ascending: boolean };
      limit?: number;
    },
  ): Promise<T[]>;
  update(
    table: string,
    match: Record<string, unknown>,
    patch: Record<string, unknown>,
  ): Promise<void>;
  delete(table: string, match: Record<string, unknown>): Promise<void>;
  /** Call a Postgres function (RPC). Used for atomic worker-job claim. */
  rpc<T>(name: string, params: Record<string, unknown>): Promise<T>;
  /**
   * Bounded existence probe for the readiness gate: select `columns` from
   * `table` (limit 1). Throws if the table or a column is missing. Reads nothing
   * sensitive and writes nothing.
   */
  probe(table: string, columns: string): Promise<void>;
}

export class MissingSupabaseConfigError extends Error {
  constructor(missing: string[]) {
    super(
      `Postgres backend selected but missing env: ${missing.join(", ")}. ` +
        `Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (server-side only).`,
    );
    this.name = "MissingSupabaseConfigError";
  }
}

/**
 * Build the Supabase service-role client. SERVER-SIDE ONLY — the service role
 * bypasses RLS and must never reach the browser. Throws clearly (no silent
 * SQLite fallback) when required env is absent.
 */
export function createSupabaseGateway(
  env: Record<string, string | undefined> = process.env,
): TableGateway {
  const url = env.SUPABASE_URL ?? env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;

  const missing: string[] = [];
  if (!url) missing.push("SUPABASE_URL");
  if (!serviceKey) missing.push("SUPABASE_SERVICE_ROLE_KEY");
  if (missing.length > 0) throw new MissingSupabaseConfigError(missing);

  const client = createClient(url as string, serviceKey as string, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return new SupabaseTableGateway(client);
}

class SupabaseTableGateway implements TableGateway {
  constructor(private readonly client: SupabaseClient) {}

  async insert(table: string, row: Record<string, unknown>): Promise<void> {
    const { error } = await this.client.from(table).insert(row);
    if (error) throw new Error(`insert ${table} failed: ${error.message}`);
  }

  async selectOne<T>(
    table: string,
    match: Record<string, unknown>,
  ): Promise<T | null> {
    const { data, error } = await this.client
      .from(table)
      .select("*")
      .match(match)
      .maybeSingle();
    if (error) throw new Error(`selectOne ${table} failed: ${error.message}`);
    return (data as T) ?? null;
  }

  async selectMany<T>(
    table: string,
    match: Record<string, unknown>,
    opts?: {
      orderBy?: { column: string; ascending: boolean };
      limit?: number;
    },
  ): Promise<T[]> {
    let query = this.client.from(table).select("*").match(match);
    if (opts?.orderBy) {
      query = query.order(opts.orderBy.column, {
        ascending: opts.orderBy.ascending,
      });
    }
    if (opts?.limit !== undefined) query = query.limit(opts.limit);
    const { data, error } = await query;
    if (error) throw new Error(`selectMany ${table} failed: ${error.message}`);
    return (data as T[]) ?? [];
  }

  async update(
    table: string,
    match: Record<string, unknown>,
    patch: Record<string, unknown>,
  ): Promise<void> {
    const { error } = await this.client.from(table).update(patch).match(match);
    if (error) throw new Error(`update ${table} failed: ${error.message}`);
  }

  async delete(table: string, match: Record<string, unknown>): Promise<void> {
    const { error } = await this.client.from(table).delete().match(match);
    if (error) throw new Error(`delete ${table} failed: ${error.message}`);
  }

  async rpc<T>(name: string, params: Record<string, unknown>): Promise<T> {
    // The error message from PostgREST carries the function name (used to detect
    // a missing migration) — it never contains the service-role key.
    const { data, error } = await this.client.rpc(name, params);
    if (error) throw new Error(`rpc ${name} failed: ${error.message}`);
    return data as T;
  }

  async probe(table: string, columns: string): Promise<void> {
    const { error } = await this.client.from(table).select(columns).limit(1);
    if (error) throw new Error(`probe ${table}.${columns} failed: ${error.message}`);
  }
}
