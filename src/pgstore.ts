import { Pool } from "pg";
import type { DbClient } from "./db.js";
import { MigrationRunner } from "./db.js";
import type { Store } from "./store.js";
import type {
  Notification,
  DeliveryAttempt,
  UserPreference,
  PartnerWebhook,
  NotificationTemplate,
  ChannelName,
  EventType,
  Locale,
} from "./types.js";

/**
 * Postgres-backed persistence for the notification service.
 *
 * When DB_URL is set the service applies migrations on startup (see
 * applyMigrations) and write-throughs every mutating Store operation to
 * Postgres, keeping the in-memory Store as the read cache. When DB_URL is
 * absent the service runs purely in-memory (tests / CI), matching the other
 * services' fallback convention.
 */

let pool: Pool | null = null;

export function pgEnabled(): boolean {
  return pool !== null;
}

export function initPg(dbUrl?: string): void {
  const url = dbUrl ?? process.env.DB_URL;
  if (!url) return;
  pool = new Pool({ connectionString: url });
}

export async function closePg(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

function client(): { query: Pool["query"] } | null {
  return pool;
}

/** Apply all pending migrations using a real pg Pool as the DbClient. */
export async function applyMigrations(): Promise<void> {
  if (!pool) return;
  const dbClient: DbClient = {
    async query(sql, params) {
      const r = await pool!.query(sql, params as never[]);
      return { rows: r.rows, rowCount: r.rowCount ?? 0 };
    },
    async exec(sql) {
      await pool!.query(sql);
    },
  };
  const runner = new MigrationRunner(dbClient);
  await runner.run();
}

const NOTIFICATION_COLS = `id, event_id, event_type, channel, recipient, user_id, template_id, status, traffic_class, locale, created_at, sent_at`;

function rowToNotification(r: Record<string, unknown>): Notification {
  return {
    id: String(r.id),
    event_id: String(r.event_id),
    event_type: String(r.event_type) as EventType,
    channel: String(r.channel) as ChannelName,
    recipient: String(r.recipient),
    user_id: String(r.user_id),
    template_id: String(r.template_id),
    status: String(r.status) as Notification["status"],
    traffic_class: String(r.traffic_class) as Notification["traffic_class"],
    locale: String(r.locale),
    created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    sent_at: r.sent_at instanceof Date ? r.sent_at.toISOString() : (r.sent_at ? String(r.sent_at) : null),
  };
}

function rowToAttempt(r: Record<string, unknown>): DeliveryAttempt {
  return {
    notification_id: String(r.notification_id),
    channel: String(r.channel) as ChannelName,
    provider: String(r.provider),
    provider_message_id: r.provider_message_id === null ? null : String(r.provider_message_id),
    status: String(r.status) as DeliveryAttempt["status"],
    attempt_no: Number(r.attempt_no),
    error: r.error === null ? null : String(r.error),
    created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    updated_at: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
  };
}

function rowToPreference(r: Record<string, unknown>): UserPreference {
  return {
    user_id: String(r.user_id),
    channels: {
      EMAIL: Boolean(r.email),
      SMS: Boolean(r.sms),
      PUSH: Boolean(r.push),
      WEBHOOK: Boolean(r.webhook),
    },
    locale: String(r.locale),
    quiet_hours:
      r.quiet_start && r.quiet_end
        ? { start: String(r.quiet_start), end: String(r.quiet_end) }
        : null,
  };
}

function rowToWebhook(r: Record<string, unknown>): PartnerWebhook {
  const retry = r.retry_policy ? (typeof r.retry_policy === "string" ? JSON.parse(r.retry_policy) : r.retry_policy) : { max_attempts: 3, backoff_ms: [1000, 2000, 4000] };
  const filters = r.event_filters ? (typeof r.event_filters === "string" ? JSON.parse(r.event_filters) : r.event_filters) : ["*"];
  return {
    id: String(r.id),
    url: String(r.url),
    secret: String(r.secret),
    event_filters: filters as PartnerWebhook["event_filters"],
    retry_policy: retry as PartnerWebhook["retry_policy"],
    status: String(r.status) as PartnerWebhook["status"],
    created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  };
}

function rowToTemplate(r: Record<string, unknown>): NotificationTemplate {
  return {
    event_type: String(r.event_type) as EventType,
    channel: String(r.channel) as ChannelName,
    locale: String(r.locale) as Locale,
    subject: String(r.subject ?? ""),
    text_body: String(r.text_body ?? ""),
    html_body: String(r.html_body ?? ""),
    short_body: String(r.short_body ?? ""),
  };
}

/** Persist a notification row. */
export async function pgAddNotification(n: Notification): Promise<void> {
  const c = client();
  if (!c) return;
  await c.query(
    `INSERT INTO notifications (id, event_id, event_type, channel, recipient, user_id, template_id, status, traffic_class, locale, created_at, sent_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
     ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, sent_at = EXCLUDED.sent_at, updated_at = now()`,
    [n.id, n.event_id, n.event_type, n.channel, n.recipient, n.user_id, n.template_id, n.status, n.traffic_class, n.locale, n.created_at, n.sent_at],
  );
}

export async function pgAddAttempt(a: DeliveryAttempt): Promise<void> {
  const c = client();
  if (!c) return;
  await c.query(
    `INSERT INTO delivery_attempts (notification_id, channel, provider, provider_message_id, status, attempt_no, error, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT DO NOTHING`,
    [a.notification_id, a.channel, a.provider, a.provider_message_id, a.status, a.attempt_no, a.error, a.created_at, a.updated_at],
  );
}

export async function pgUpsertPreference(p: UserPreference): Promise<void> {
  const c = client();
  if (!c) return;
  await c.query(
    `INSERT INTO user_preferences (user_id, email, sms, push, webhook, locale, quiet_start, quiet_end, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
     ON CONFLICT (user_id) DO UPDATE SET email=EXCLUDED.email, sms=EXCLUDED.sms, push=EXCLUDED.push, webhook=EXCLUDED.webhook, locale=EXCLUDED.locale, quiet_start=EXCLUDED.quiet_start, quiet_end=EXCLUDED.quiet_end, updated_at=now()`,
    [p.user_id, p.channels.EMAIL, p.channels.SMS, p.channels.PUSH, p.channels.WEBHOOK, p.locale, p.quiet_hours?.start ?? null, p.quiet_hours?.end ?? null],
  );
}

export async function pgAddWebhook(w: PartnerWebhook): Promise<void> {
  const c = client();
  if (!c) return;
  await c.query(
    `INSERT INTO partner_webhooks (id, url, secret, event_filters, retry_policy, status, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now())
     ON CONFLICT (id) DO UPDATE SET url=EXCLUDED.url, secret=EXCLUDED.secret, event_filters=EXCLUDED.event_filters, retry_policy=EXCLUDED.retry_policy, status=EXCLUDED.status, updated_at=now()`,
    [w.id, w.url, w.secret, JSON.stringify(w.event_filters), JSON.stringify(w.retry_policy), w.status, w.created_at],
  );
}

/**
 * Hydrate the given in-memory store from Postgres. Called once on startup
 * after migrations so the service starts with the existing persisted state.
 */
export async function pgHydrate(store: Store): Promise<void> {
  const c = client();
  if (!c) return;

  const notifs = await c.query(`SELECT ${NOTIFICATION_COLS} FROM notifications ORDER BY created_at`);
  for (const r of notifs.rows) {
    const n = rowToNotification(r as Record<string, unknown>);
    store.addNotification(n);
  }

  const attempts = await c.query(`SELECT notification_id, channel, provider, provider_message_id, status, attempt_no, error, created_at, updated_at FROM delivery_attempts ORDER BY id`);
  for (const r of attempts.rows) {
    store.addAttempt(rowToAttempt(r as Record<string, unknown>));
  }

  const prefs = await c.query(`SELECT user_id, email, sms, push, webhook, locale, quiet_start, quiet_end FROM user_preferences`);
  for (const r of prefs.rows) {
    store.setPreference(rowToPreference(r as Record<string, unknown>));
  }

  const webhooks = await c.query(`SELECT id, url, secret, event_filters, retry_policy, status, created_at FROM partner_webhooks`);
  for (const r of webhooks.rows) {
    store.addWebhook(rowToWebhook(r as Record<string, unknown>));
  }

  const tpls = await c.query(`SELECT event_type, channel, locale, subject, text_body, html_body, short_body FROM notification_templates`);
  if (tpls.rowCount && tpls.rowCount > 0) {
    store.templates = tpls.rows.map((r) => rowToTemplate(r as Record<string, unknown>));
  }
}