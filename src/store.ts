import type {
  Notification,
  NotificationTemplate,
  DeliveryAttempt,
  UserPreference,
  PartnerWebhook,
  AuditEvent,
  EventType,
  ChannelName,
  Locale,
  TrafficClass,
} from "./types.js";
import { v7 as uuidv7 } from "uuid";
import { getRedis, dedupKey, inMemoryRedis } from "./redis.js";
import { pgEnabled, pgAddNotification, pgAddAttempt, pgUpsertPreference, pgAddWebhook } from "./pgstore.js";

function inMemoryRedisClear(): void {
  inMemoryRedis.clear();
}

const EVENTS_BY_CLASS: Record<TrafficClass, EventType[]> = {
  TRANSACTIONAL: [
    "tx.created",
    "payment.captured",
    "tx.signed",
    "tx.confirmed",
    "tx.failed",
    "tx.refunded",
    "chain.confirmed",
  ],
  MARKETING: [],
};

function seedTemplate(
  eventType: EventType,
  channel: ChannelName,
  subject: string,
  text_body: string,
  html_body: string,
  short_body: string,
): NotificationTemplate {
  return {
    event_type: eventType,
    channel,
    locale: "en",
    subject,
    text_body,
    html_body,
    short_body,
  };
}

const ALL_EVENTS: EventType[] = [
  "tx.created",
  "payment.captured",
  "tx.signed",
  "tx.confirmed",
  "tx.failed",
  "tx.refunded",
  "chain.confirmed",
];

function templates(): NotificationTemplate[] {
  const tpls: NotificationTemplate[] = [];
  const bodies: Record<EventType, { subject: string; text: string; html: string; short: string }> = {
    "tx.created": {
      subject: "Transaction {{tx_id}} created",
      text: "Hi {{user_name}}, your transaction {{tx_id}} for {{amount}} {{currency}} has been created and is awaiting payment.",
      html: "<p>Hi {{user_name}},</p><p>Your transaction <strong>{{tx_id}}</strong> for {{amount}} {{currency}} has been created and is awaiting payment.</p>",
      short: "Tx {{tx_id}} created: {{amount}} {{currency}}.",
    },
    "payment.captured": {
      subject: "Payment captured for {{tx_id}}",
      text: "Hi {{user_name}}, we captured your payment of {{amount}} {{currency}} for transaction {{tx_id}}.",
      html: "<p>Hi {{user_name}},</p><p>We captured your payment of <strong>{{amount}} {{currency}}</strong> for transaction {{tx_id}}.</p>",
      short: "Payment captured for tx {{tx_id}}: {{amount}} {{currency}}.",
    },
    "tx.signed": {
      subject: "Transaction {{tx_id}} signed",
      text: "Hi {{user_name}}, transaction {{tx_id}} was signed and is now queued for broadcast.",
      html: "<p>Hi {{user_name}},</p><p>Transaction {{tx_id}} was signed and is now queued for broadcast.</p>",
      short: "Tx {{tx_id}} signed and queued.",
    },
    "tx.confirmed": {
      subject: "Transaction {{tx_id}} confirmed",
      text: "Hi {{user_name}}, transaction {{tx_id}} is confirmed on {{chain}} with {{confirmations}} confirmations.",
      html: "<p>Hi {{user_name}},</p><p>Transaction {{tx_id}} is confirmed on {{chain}} with {{confirmations}} confirmations.</p>",
      short: "Tx {{tx_id}} confirmed on {{chain}} ({{confirmations}} conf).",
    },
    "tx.failed": {
      subject: "Transaction {{tx_id}} failed",
      text: "Hi {{user_name}}, transaction {{tx_id}} failed. Reason: {{reason}}.",
      html: "<p>Hi {{user_name}},</p><p>Transaction {{tx_id}} failed. Reason: {{reason}}.</p>",
      short: "Tx {{tx_id}} failed: {{reason}}.",
    },
    "tx.refunded": {
      subject: "Refund issued for {{tx_id}}",
      text: "Hi {{user_name}}, a refund of {{amount}} {{currency}} for transaction {{tx_id}} has been issued.",
      html: "<p>Hi {{user_name}},</p><p>A refund of <strong>{{amount}} {{currency}}</strong> for transaction {{tx_id}} has been issued.</p>",
      short: "Refund {{amount}} {{currency}} issued for tx {{tx_id}}.",
    },
    "chain.confirmed": {
      subject: "Chain confirmation for {{tx_id}}",
      text: "Hi {{user_name}}, transaction {{tx_id}} reached chain finality on {{chain}}.",
      html: "<p>Hi {{user_name}},</p><p>Transaction {{tx_id}} reached chain finality on {{chain}}.</p>",
      short: "Tx {{tx_id}} chain-confirmed on {{chain}}.",
    },
  };

  const channels: ChannelName[] = ["EMAIL", "SMS", "PUSH"];
  for (const event of ALL_EVENTS) {
    const b = bodies[event];
    for (const channel of channels) {
      if (channel === "EMAIL") {
        tpls.push(seedTemplate(event, channel, b.subject, b.text, b.html, b.short));
      } else {
        tpls.push(seedTemplate(event, channel, "", b.short, "", b.short));
      }
    }
  }
  return tpls;
}

export class Store {
  notifications = new Map<string, Notification>();
  templates: NotificationTemplate[] = templates();
  attempts: DeliveryAttempt[] = [];
  preferences = new Map<string, UserPreference>();
  webhooks = new Map<string, PartnerWebhook>();
  audit: AuditEvent[] = [];
  dedup = new Map<string, number>();
  webhookDeliveries = new Map<string, { attempt_no: number; status: string; at: string }[]>();

  reset(): void {
    this.notifications.clear();
    this.attempts = [];
    this.preferences.clear();
    this.webhooks.clear();
    this.audit = [];
    this.dedup.clear();
    this.webhookDeliveries.clear();
    this.templates = templates();
    inMemoryRedisClear();
  }

  getTemplate(
    eventType: EventType,
    channel: ChannelName,
    locale: Locale,
  ): NotificationTemplate | undefined {
    let t = this.templates.find(
      (x) => x.event_type === eventType && x.channel === channel && x.locale === locale,
    );
    if (!t) {
      t = this.templates.find(
        (x) => x.event_type === eventType && x.channel === channel && x.locale === "en",
      );
    }
    return t;
  }

  setPreference(p: UserPreference): void {
    this.preferences.set(p.user_id, p);
    if (pgEnabled()) void pgUpsertPreference(p);
  }

  getPreference(user_id: string): UserPreference | undefined {
    return this.preferences.get(user_id);
  }

  listPreferences(): UserPreference[] {
    return Array.from(this.preferences.values()).sort((a, b) =>
      a.user_id.localeCompare(b.user_id),
    );
  }

  addWebhook(w: PartnerWebhook): void {
    this.webhooks.set(w.id, w);
    if (pgEnabled()) void pgAddWebhook(w);
  }

  listWebhooks(): PartnerWebhook[] {
    return Array.from(this.webhooks.values());
  }

  getWebhook(id: string): PartnerWebhook | undefined {
    return this.webhooks.get(id);
  }

  addNotification(n: Notification): void {
    this.notifications.set(n.id, n);
    if (pgEnabled()) void pgAddNotification(n);
  }

  getNotification(id: string): Notification | undefined {
    return this.notifications.get(id);
  }

  listNotifications(): Notification[] {
    return Array.from(this.notifications.values()).sort((a, b) => {
      const ta = a.created_at ?? "";
      const tb = b.created_at ?? "";
      return tb.localeCompare(ta);
    });
  }

  addAttempt(a: DeliveryAttempt): void {
    this.attempts.push(a);
    if (pgEnabled()) void pgAddAttempt(a);
  }

  attemptsFor(notification_id: string): DeliveryAttempt[] {
    return this.attempts.filter((a) => a.notification_id === notification_id);
  }

  addAudit(a: AuditEvent): void {
    this.audit.push(a);
  }

  isDuplicate(event_id: string, channel: ChannelName, recipient: string): boolean {
    const key = `${event_id}|${channel}|${recipient}`;
    return this.dedup.has(key);
  }

  /**
   * Redis-backed dedup check. Uses `GET dedup:event_id|channel|recipient`.
   * Returns true if a dedup key already exists (idempotent send guard).
   */
  async isDuplicateRedis(
    event_id: string,
    channel: ChannelName,
    recipient: string,
  ): Promise<boolean> {
    const key = dedupKey(event_id, channel, recipient);
    const v = await getRedis().get(key);
    return v !== null;
  }

  /**
   * Record a dedup key in Redis with TTL via SETNX semantics so concurrent
   * producers cannot both win. Returns true if this caller won the race.
   */
  async markSentRedis(
    event_id: string,
    channel: ChannelName,
    recipient: string,
    ttlMs = 60_000,
  ): Promise<boolean> {
    const key = dedupKey(event_id, channel, recipient);
    const won = await getRedis().setNxTtl(key, "1", ttlMs);
    return won === 1;
  }

  markSent(event_id: string, channel: ChannelName, recipient: string, ttlMs = 60_000): void {
    const key = `${event_id}|${channel}|${recipient}`;
    const expires = Date.now() + ttlMs;
    this.dedup.set(key, expires);
    // Lightweight GC
    setTimeout(() => {
      const exp = this.dedup.get(key);
      if (exp === expires) this.dedup.delete(key);
    }, ttlMs).unref?.();
  }

  classify(eventType: EventType): TrafficClass {
    if (EVENTS_BY_CLASS.TRANSACTIONAL.includes(eventType)) return "TRANSACTIONAL";
    return "MARKETING";
  }
}

export const store = new Store();

/**
 * Generate a non-PK identifier (e.g. provider_message_id) with a human-readable
 * prefix. Primary keys use {@link uuidv7} instead.
 */
export function makeId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

/** Generate a UUIDv7 primary key (time-ordered, app-generated, DB-agnostic). */
export function newId(): string {
  return uuidv7();
}