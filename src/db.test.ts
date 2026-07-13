import { describe, it, expect, beforeEach } from "vitest";
import { MigrationRunner, InMemoryDbClient, migrationsDir } from "./db.js";
import { existsSync, readdirSync } from "node:fs";

describe("MigrationRunner", () => {
  let client: InMemoryDbClient;
  let runner: MigrationRunner;

  beforeEach(() => {
    client = new InMemoryDbClient();
    runner = new MigrationRunner(client);
  });

  it("discovers all 6 migration files in order", () => {
    const files = runner.listFiles();
    expect(files).toEqual([
      "0001_notifications.sql",
      "0002_notification_templates.sql",
      "0003_delivery_attempts.sql",
      "0004_user_preferences.sql",
      "0005_partner_webhooks.sql",
      "0006_seed_templates.sql",
    ]);
  });

  it("migrations directory exists on disk", () => {
    expect(existsSync(migrationsDir())).toBe(true);
    const files = readdirSync(migrationsDir()).filter((f) => f.endsWith(".sql"));
    expect(files.length).toBe(6);
  });

  it("creates schema_migrations table on first run", async () => {
    await runner.ensureMigrationsTable();
    expect(
      client.executedStatements.some((s) =>
        s.toUpperCase().includes("CREATE TABLE") && s.includes("schema_migrations"),
      ),
    ).toBe(true);
  });

  it("applies all migrations and records them", async () => {
    const applied = await runner.run();
    expect(applied.length).toBe(6);
    expect(client.insertedMigrations).toEqual(applied);
    // Each SQL file body was executed.
    expect(client.executedStatements.length).toBeGreaterThanOrEqual(6);
  });

  it("is idempotent: second run applies nothing", async () => {
    await runner.run();
    const second = await runner.run();
    expect(second).toEqual([]);
  });

  it("lists applied migrations", async () => {
    await runner.run();
    const applied = await runner.applied();
    expect(applied.length).toBe(6);
    expect(applied[0].filename).toBe("0001_notifications.sql");
  });
});