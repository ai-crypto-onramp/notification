import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pool, closePool } from "./client.js";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "migrations");

interface AppliedMigration {
  filename: string;
}

const ensureSchemaMigrationsTable = async (): Promise<void> => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
};

const listApplied = async (): Promise<Set<string>> => {
  const result = await pool.query<AppliedMigration>(
    "SELECT filename FROM schema_migrations ORDER BY filename",
  );
  return new Set(result.rows.map((r) => r.filename));
};

const listMigrationFiles = async (): Promise<string[]> => {
  const entries = await readdir(migrationsDir);
  return entries.filter((f) => f.endsWith(".sql")).sort();
};

const applyMigration = async (filename: string): Promise<void> => {
  const sql = await readFile(join(migrationsDir, filename), "utf8");
  await pool.query("BEGIN");
  try {
    await pool.query(sql);
    await pool.query(
      "INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING",
      [filename],
    );
    await pool.query("COMMIT");
    console.log(`applied: ${filename}`);
  } catch (err) {
    await pool.query("ROLLBACK").catch(() => undefined);
    throw err;
  }
};

const runMigrations = async (): Promise<void> => {
  await ensureSchemaMigrationsTable();
  const applied = await listApplied();
  const files = await listMigrationFiles();
  const pending = files.filter((f) => !applied.has(f));
  if (pending.length === 0) {
    console.log("no pending migrations");
    return;
  }
  for (const file of pending) {
    await applyMigration(file);
  }
  console.log(`applied ${pending.length} migration(s)`);
};

const main = async (): Promise<void> => {
  try {
    await runMigrations();
  } catch (err) {
    console.error("migration failed:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
};

void main();