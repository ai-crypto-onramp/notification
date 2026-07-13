import { Pool } from "pg";
import { MigrationRunner, type DbClient } from "./db.js";

/**
 * Stage 1: `npm run migrate` entrypoint.
 *
 * Connects to PostgreSQL via `DB_URL` and applies all `migrations/*.sql` files
 * in order, recording each in the `schema_migrations` table. When `DB_URL` is
 * absent it runs in dry-run mode (lists pending migrations without executing),
 * which is what CI does without a live database.
 */
async function main(): Promise<void> {
  const dbUrl = process.env.DB_URL;

  if (!dbUrl) {
    const runner = new MigrationRunner(new DryRunClient());
    console.log("DB_URL not set; dry-run mode. Migration files:");
    for (const f of runner.listFiles()) console.log("  -", f);
    return;
  }

  const pool = new Pool({ connectionString: dbUrl });
  const client: DbClient = {
    async query(sql, params) {
      const r = await pool.query(sql, params as never);
      return { rows: r.rows, rowCount: r.rowCount ?? 0 };
    },
    async exec(sql) {
      await pool.query(sql);
    },
  };
  try {
    const runner = new MigrationRunner(client);
    const applied = await runner.run();
    console.log(`Applied ${applied.length} migration(s):`);
    for (const f of applied) console.log("  -", f);
  } finally {
    await pool.end();
  }
}

class DryRunClient implements DbClient {
  async query(): Promise<{ rows: unknown[]; rowCount: number }> {
    return { rows: [], rowCount: 0 };
  }
  async exec(): Promise<void> {
    /* no-op */
  }
}

main().catch((err: unknown) => {
  console.error("migrate failed:", err);
  process.exit(1);
});