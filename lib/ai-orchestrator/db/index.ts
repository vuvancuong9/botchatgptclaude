import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let singleton: DatabaseSync | null = null;

function migrationsDir(): string {
  // Prefer a path relative to this module; fall back to cwd for bundled runs.
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidate = join(here, "..", "migrations");
    if (existsSync(candidate)) return candidate;
  } catch {
    // import.meta.url may be unavailable in some bundlers; ignore.
  }
  return join(process.cwd(), "lib", "ai-orchestrator", "migrations");
}

function applyMigrations(db: DatabaseSync): void {
  const dir = migrationsDir();
  if (!existsSync(dir)) {
    throw new Error(`Migrations directory not found at ${dir}`);
  }
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  db.exec("PRAGMA foreign_keys = ON;");
  for (const file of files) {
    const sql = readFileSync(join(dir, file), "utf8");
    try {
      db.exec(sql);
    } catch (err) {
      // Additive ALTER ... ADD COLUMN is not idempotent in SQLite; ignore the
      // "duplicate column name" error so re-applying migrations is safe. Any
      // other error is a real problem and must propagate.
      const msg = String((err as Error)?.message ?? err);
      if (/duplicate column name/i.test(msg)) continue;
      throw err;
    }
  }
}

export function resolveDbPath(): string {
  return process.env.AI_ORCHESTRATOR_DB || join(process.cwd(), ".data", "ai-orchestrator.db");
}

export function getDb(): DatabaseSync {
  if (singleton) return singleton;
  const dbPath = resolveDbPath();
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  applyMigrations(db);
  singleton = db;
  return db;
}

/** For tests: build an isolated in-memory database with migrations applied. */
export function createMemoryDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  applyMigrations(db);
  return db;
}
