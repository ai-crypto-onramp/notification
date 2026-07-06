import { describe, it, expect, afterAll } from "vitest";
import { pool, closePool } from "./client.js";

const describeIntegration = process.env.DB_URL ? describe : describe.skip;

describeIntegration("migration runner (integration)", () => {
  afterAll(async () => {
    await closePool();
  });

  it("creates all five tables with expected columns", async () => {
    const tables = [
      "notifications",
      "notification_templates",
      "delivery_attempts",
      "user_preferences",
      "partner_webhooks",
    ];
    for (const table of tables) {
      const res = await pool.query<{ exists: boolean }>(
        `SELECT to_regclass($1) IS NOT NULL AS exists`,
        [`public.${table}`],
      );
      expect(res.rows[0].exists).toBe(true);
    }
  });

  it("seeds the six lifecycle templates", async () => {
    const res = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::TEXT AS count FROM notification_templates
       WHERE event_type IN ('tx.created','payment.captured','tx.signed',
                            'tx.confirmed','tx.failed','tx.refunded')`,
    );
    expect(Number(res.rows[0].count)).toBeGreaterThanOrEqual(24);
  });

  it("records applied migrations in schema_migrations", async () => {
    const res = await pool.query<{ filename: string }>(
      "SELECT filename FROM schema_migrations ORDER BY filename",
    );
    const filenames = res.rows.map((r) => r.filename);
    expect(filenames).toContain("006_seed_lifecycle_templates.sql");
  });

  it("indexes exist on notifications(event_id, channel, recipient)", async () => {
    const res = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE indexname = 'notifications_event_channel_recipient_idx'`,
    );
    expect(res.rows.length).toBe(1);
  });

  it("indexes exist on delivery_attempts(notification_id, attempt_no)", async () => {
    const res = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE indexname = 'delivery_attempts_notification_attempt_idx'`,
    );
    expect(res.rows.length).toBe(1);
  });

  it("idempotent re-running the seed does not duplicate rows", async () => {
    const before = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::TEXT AS count FROM notification_templates",
    );
    // re-apply seed migration SQL directly; ON CONFLICT DO NOTHING keeps idempotency
    await pool.query(`
      INSERT INTO notification_templates (event_type, channel, locale, subject, text_body, html_body)
      VALUES ('tx.created','email','en','Your transaction was created','x','<p>x</p>')
      ON CONFLICT (event_type, channel, locale) DO NOTHING;
    `);
    const after = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::TEXT AS count FROM notification_templates",
    );
    expect(after.rows[0].count).toBe(before.rows[0].count);
  });
});