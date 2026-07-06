import { describe, it, expect } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "migrations",
);

const readMigration = async (filename: string): Promise<string> =>
  readFile(join(migrationsDir, filename), "utf8");

const EXPECTED_TABLES = [
  "notifications",
  "notification_templates",
  "delivery_attempts",
  "user_preferences",
  "partner_webhooks",
];

const LIFECYCLE_EVENTS = [
  "tx.created",
  "payment.captured",
  "tx.signed",
  "tx.confirmed",
  "tx.failed",
  "tx.refunded",
];

describe("migrations", () => {
  it("lists migrations in sorted order matching table creation order", async () => {
    const files = await readdir(migrationsDir);
    const sql = files.filter((f) => f.endsWith(".sql")).sort();
    expect(sql).toEqual([
      "001_create_notifications.sql",
      "002_create_notification_templates.sql",
      "003_create_delivery_attempts.sql",
      "004_create_user_preferences.sql",
      "005_create_partner_webhooks.sql",
      "006_seed_lifecycle_templates.sql",
    ]);
  });

  it.each(EXPECTED_TABLES)("creates the %s table", async (table) => {
    const files = await readdir(migrationsDir);
    const sql = (
      await Promise.all(
        files.filter((f) => f.endsWith(".sql")).map((f) =>
          readFile(join(migrationsDir, f), "utf8"),
        ),
      )
    ).join("\n");
    expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
  });

  it("notifications table has the README data model columns", async () => {
    const sql = await readMigration("001_create_notifications.sql");
    for (const col of [
      "id",
      "event_id",
      "channel",
      "recipient",
      "template_id",
      "status",
      "created_at",
      "sent_at",
    ]) {
      expect(sql).toContain(col);
    }
    expect(sql).toContain("notifications_event_channel_recipient_idx");
    expect(sql).toContain("ON notifications (event_id, channel, recipient)");
  });

  it("notification_templates table is keyed by event type + channel + locale", async () => {
    const sql = await readMigration("002_create_notification_templates.sql");
    expect(sql).toContain("event_type");
    expect(sql).toContain("channel");
    expect(sql).toContain("locale");
    expect(sql).toContain("UNIQUE (event_type, channel, locale)");
  });

  it("delivery_attempts table has the README data model columns", async () => {
    const sql = await readMigration("003_create_delivery_attempts.sql");
    for (const col of [
      "notification_id",
      "channel",
      "provider",
      "provider_message_id",
      "status",
      "attempt_no",
      "error",
    ]) {
      expect(sql).toContain(col);
    }
    expect(sql).toContain("delivery_attempts_notification_attempt_idx");
    expect(sql).toContain("ON delivery_attempts (notification_id, attempt_no)");
  });

  it("user_preferences table supports per-user opt-in/opt-out, locale, quiet hours", async () => {
    const sql = await readMigration("004_create_user_preferences.sql");
    expect(sql).toContain("email_opt_in");
    expect(sql).toContain("sms_opt_in");
    expect(sql).toContain("push_opt_in");
    expect(sql).toContain("webhook_opt_in");
    expect(sql).toContain("locale");
    expect(sql).toContain("quiet_hours_start");
    expect(sql).toContain("quiet_hours_end");
  });

  it("partner_webhooks table has the README data model columns", async () => {
    const sql = await readMigration("005_create_partner_webhooks.sql");
    for (const col of [
      "url",
      "secret",
      "event_filters",
      "retry_policy",
      "batch_window",
      "status",
    ]) {
      expect(sql).toContain(col);
    }
  });

  it("seeds all six lifecycle events", async () => {
    const sql = await readMigration("006_seed_lifecycle_templates.sql");
    for (const event of LIFECYCLE_EVENTS) {
      expect(sql).toContain(`'${event}'`);
    }
    expect(sql).toContain("ON CONFLICT (event_type, channel, locale) DO NOTHING");
  });

  it("seeds templates for all four channels per lifecycle event", async () => {
    const sql = await readMigration("006_seed_lifecycle_templates.sql");
    for (const event of LIFECYCLE_EVENTS) {
      for (const channel of ["email", "sms", "push", "webhook"]) {
        expect(sql).toContain(`('${event}', '${channel}'`);
      }
    }
  });
});