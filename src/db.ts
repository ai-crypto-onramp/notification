import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Stage 1: migration runner + DB access interface.
 *
 * The service talks to PostgreSQL through a small `DbClient` interface so the
 * runtime can swap in a real `pg` client while tests use the in-memory `Store`
 * (see `store.ts`). `MigrationRunner` discovers `*.sql` files under
 * `migrations/`, sorts them by filename, and applies each inside an
 * idempotent schema-migrations table.
 */

export interface DbClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number }>;
  exec(sql: string): Promise<void>;
}

export interface AppliedMigration {
  filename: string;
  applied_at: string;
}

const MIGRATIONS_DIR = process.env.MIGRATIONS_DIR
  ? resolve(process.env.MIGRATIONS_DIR)
  : join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

export class MigrationRunner {
  constructor(private client: DbClient) {}

  async ensureMigrationsTable(): Promise<void> {
    await this.client.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename    TEXT PRIMARY KEY,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
  }

  listFiles(): string[] {
    return readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
  }

  async applied(): Promise<AppliedMigration[]> {
    const { rows } = await this.client.query(
      "SELECT filename, applied_at::text AS applied_at FROM schema_migrations ORDER BY filename",
    );
    return rows as AppliedMigration[];
  }

  async run(): Promise<string[]> {
    await this.ensureMigrationsTable();
    const { rows } = await this.client.query(
      "SELECT filename FROM schema_migrations",
    );
    const done = new Set(rows.map((r) => (r as { filename: string }).filename));
    const applied: string[] = [];
    for (const file of this.listFiles()) {
      if (done.has(file)) continue;
      const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      await this.client.exec("BEGIN");
      try {
        await this.client.exec(sql);
        await this.client.query(
          "INSERT INTO schema_migrations (filename) VALUES ($1)",
          [file],
        );
        await this.client.exec("COMMIT");
        applied.push(file);
      } catch (err) {
        await this.client.exec("ROLLBACK");
        throw new Error(`migration ${file} failed: ${(err as Error).message}`);
      }
    }
    return applied;
  }
}

export function migrationsDir(): string {
  return MIGRATIONS_DIR;
}

/**
 * In-memory DbClient fake for tests. Executes SQL as no-ops while recording
 * calls, so migration runner + queries can be exercised without PostgreSQL.
 */
export class InMemoryDbClient implements DbClient {
  executedStatements: string[] = [];
  insertedMigrations: string[] = [];
  async query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
    const norm = sql.trim().toUpperCase();
    if (norm.startsWith("INSERT INTO SCHEMA_MIGRATIONS")) {
      this.insertedMigrations.push(String(params[0]));
      return { rows: [], rowCount: 1 };
    }
    if (norm.startsWith("SELECT FILENAME FROM SCHEMA_MIGRATIONS")) {
      return { rows: this.insertedMigrations.map((f) => ({ filename: f })), rowCount: this.insertedMigrations.length };
    }
    if (norm.startsWith("SELECT FILENAME, APPLIED_AT")) {
      return {
        rows: this.insertedMigrations.map((f) => ({ filename: f, applied_at: new Date().toISOString() })),
        rowCount: this.insertedMigrations.length,
      };
    }
    return { rows: [], rowCount: 0 };
  }
  async exec(sql: string): Promise<void> {
    const stmt = sql.trim().replace(/\s+/g, " ");
    if (!stmt) return;
    // Skip transaction-control statements for the fake.
    if (stmt === "BEGIN" || stmt === "COMMIT" || stmt === "ROLLBACK") return;
    this.executedStatements.push(stmt);
  }
}