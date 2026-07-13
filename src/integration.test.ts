import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { store } from "./store.js";
import { _resetQueue } from "./pipeline.js";
import { templateService } from "./templates.js";
import { EventBusConsumer, InMemoryEventBus, type RawBusEvent } from "./consumer.js";
import { setAuditEmitter, RecordingAuditEmitter } from "./audit.js";
import { inMemoryRedis } from "./redis.js";
import { emailChannel, smsChannel, pushChannel } from "./channels.js";
import { StubSesProvider, StubSnsProvider, StubTwilioProvider, StubFcmProvider, StubApnsProvider } from "./providers.js";
import { registerWebhook, signWebhookPayload, verifyWebhookSignature } from "./webhooks.js";

/**
 * Stage 10: integration test covering the full
 * consumer → render → send → audit pipeline with stub providers, plus a
 * contract test that recomputes the webhook signature the way a partner would.
 */
describe("integration: consumer → render → send → audit", () => {
  let bus: InMemoryEventBus;
  let consumer: EventBusConsumer;
  let audit: RecordingAuditEmitter;
  let ses: StubSesProvider;
  let sns: StubSnsProvider;
  let twilio: StubTwilioProvider;
  let fcm: StubFcmProvider;
  let apns: StubApnsProvider;

  beforeEach(async () => {
    store.reset();
    _resetQueue();
    templateService.invalidate();
    inMemoryRedis.clear();
    audit = new RecordingAuditEmitter();
    setAuditEmitter(audit);
    bus = new InMemoryEventBus();
    consumer = new EventBusConsumer(bus);
    ses = new StubSesProvider();
    sns = new StubSnsProvider();
    twilio = new StubTwilioProvider();
    fcm = new StubFcmProvider();
    apns = new StubApnsProvider();
    emailChannel.setProvider(ses);
    smsChannel.setProviders(sns, twilio);
    pushChannel.setProviders(fcm, apns);
    await consumer.start();
  });

  afterEach(async () => {
    await consumer.stop();
    setAuditEmitter(new RecordingAuditEmitter());
  });

  it("processes a tx.created end-to-end across email+sms", async () => {
    const event: RawBusEvent = {
      event_id: "int1",
      event_type: "tx.created",
      user_id: "alice",
      recipient: "alice@x.com",
      data: { tx_id: "tx-int", amount: "5", currency: "USDC", user_name: "Alice" },
    };
    await bus.publish(event);
    await new Promise((r) => setImmediate(r));
    // Two notifications (email + sms).
    expect(store.notifications.size).toBe(2);
    expect(ses.sent.length).toBe(1);
    // Non-US recipient routes through Twilio.
    expect(twilio.sent.length).toBe(1);
    expect(sns.sent.length).toBe(0);
    // Delivery attempts recorded.
    expect(store.attempts.length).toBe(2);
    expect(store.attempts.every((a) => a.status === "delivered")).toBe(true);
    // Audit events requested + delivered.
    const types = audit.recorded.map((a) => a.type);
    expect(types).toContain("notification.requested");
    expect(types).toContain("notification.delivered");
  });

  it("processes a tx.confirmed end-to-end across email+push", async () => {
    pushChannel.registerDevice("bob-device", "fcm-token-bob");
    await bus.publish({
      event_id: "int2",
      event_type: "tx.confirmed",
      user_id: "bob",
      recipient: "bob-device",
      data: { tx_id: "tx2", chain: "eth", confirmations: 12, user_name: "Bob" },
    });
    await new Promise((r) => setImmediate(r));
    expect(store.notifications.size).toBe(2);
    expect(fcm.sent.length).toBe(1);
    const channels = Array.from(store.notifications.values()).map((n) => n.channel);
    expect(channels).toContain("email");
    expect(channels).toContain("push");
  });

  it("dedups a redelivered event so no duplicate outbound is produced", async () => {
    const event: RawBusEvent = {
      event_id: "int3",
      event_type: "tx.created",
      user_id: "u",
      recipient: "u@x.com",
      data: { tx_id: "tx3", user_name: "A" },
    };
    await bus.publish(event);
    await new Promise((r) => setImmediate(r));
    const before = store.notifications.size;
    await bus.publish(event);
    await new Promise((r) => setImmediate(r));
    expect(store.notifications.size).toBe(before);
    expect(audit.recorded.filter((a) => a.type === "notification.suppressed").length).toBeGreaterThan(0);
  });

  it("emits notification.failed when a provider fails", async () => {
    emailChannel.setProvider({
      async send() {
        return { provider: "ses", provider_message_id: "", status: "failed", error: "boom" };
      },
    });
    await bus.publish({
      event_id: "int4",
      event_type: "tx.created",
      user_id: "u",
      recipient: "u@x.com",
      data: { tx_id: "tx4", user_name: "A" },
    });
    await new Promise((r) => setImmediate(r));
    expect(audit.recorded.filter((a) => a.type === "notification.failed").length).toBeGreaterThan(0);
  });
});

describe("contract: partner webhook signature verification", () => {
  const secret = "partner-shared-secret";

  it("partner recomputes HMAC and verifies timestamp within ±5 min", async () => {
    // Service side: sign a payload for a registered partner.
    const wh = registerWebhook({ url: "https://partner/hook", secret });
    const payload = {
      event_type: "tx.confirmed",
      notifications: [{ notification_id: "n-contract", subject: "s", text: "t", short: "sh" }],
    };
    const rawBody = JSON.stringify(payload);
    const { timestamp, signature } = signWebhookPayload(wh.secret, rawBody);

    // Partner side: recompute and verify.
    expect(verifyWebhookSignature(secret, rawBody, timestamp, signature)).toBe(true);
    expect(verifyWebhookSignature("wrong-secret", rawBody, timestamp, signature)).toBe(false);
    expect(verifyWebhookSignature(secret, "tampered", timestamp, signature)).toBe(false);

    // Reject replay older than 5 minutes.
    const staleTs = Math.floor(Date.now() / 1000 - 600).toString();
    const staleSig = signWebhookPayload(secret, rawBody).signature;
    expect(verifyWebhookSignature(secret, rawBody, staleTs, staleSig)).toBe(false);
  });
});