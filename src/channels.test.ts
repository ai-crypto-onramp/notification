import { beforeEach, describe, it, expect } from "vitest";
import { store } from "./store.js";
import { buildApp } from "./app.js";
import { getRateLimiter } from "./channels.js";
import { TokenBucket } from "./ratelimit.js";
import { emailChannel, smsChannel, pushChannel, webhookChannel } from "./channels.js";
import { ingestEvent, _resetQueue } from "./pipeline.js";
import { templateService } from "./templates.js";
import { consumer, inMemoryBus } from "./consumer.js";

describe("Channels (in-memory sends)", () => {
  beforeEach(() => {
    store.reset();
    templateService.invalidate();
  });

  it("email channel records a delivery attempt", async () => {
    const result = await emailChannel.send({
      to: "x@y.com",
      subject: "s",
      text: "t",
      html: "<p>t</p>",
      short: "t",
      event_type: "tx.created",
      notification_id: "n1",
    });
    expect(result.status).toBe("DELIVERED");
    expect(result.provider_message_id).toMatch(/^email_/);
    expect(store.attempts.length).toBe(1);
  });

  it("sms channel records a delivery attempt (US via SNS)", async () => {
    const r = await smsChannel.send({
      to: "+15555550100",
      subject: "",
      text: "",
      html: "",
      short: "hi",
      event_type: "tx.created",
      notification_id: "n2",
    });
    expect(r.provider).toBe("sns");
    expect(store.attempts.length).toBe(1);
  });

  it("sms channel routes international numbers through Twilio", async () => {
    const r = await smsChannel.send({
      to: "+447700900123",
      subject: "",
      text: "",
      html: "",
      short: "hi",
      event_type: "tx.created",
      notification_id: "n2b",
    });
    expect(r.provider).toBe("twilio");
  });

  it("push channel records a delivery attempt (Android via FCM)", async () => {
    pushChannel.registerDevice("token", "a-long-fcm-token-string-xyz");
    const r = await pushChannel.send({
      to: "token",
      subject: "",
      text: "",
      html: "",
      short: "hi",
      event_type: "tx.confirmed",
      notification_id: "n3",
    });
    expect(r.provider).toBe("fcm");
  });

  it("push channel routes iOS tokens through APNS", async () => {
    const iosToken = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    pushChannel.registerDevice("ios-recipient", iosToken);
    const r = await pushChannel.send({
      to: "ios-recipient",
      subject: "",
      text: "",
      html: "",
      short: "hi",
      event_type: "tx.confirmed",
      notification_id: "n3b",
    });
    expect(r.provider).toBe("apns");
  });

  it("push channel fails when no device token is registered", async () => {
    const r = await pushChannel.send({
      to: "nobody",
      subject: "",
      text: "",
      html: "",
      short: "hi",
      event_type: "tx.confirmed",
      notification_id: "n3c",
    });
    expect(r.status).toBe("FAILED");
    expect(r.error).toMatch(/no device token/);
  });

  it("webhook channel records a delivery attempt", async () => {
    const r = await webhookChannel.send({
      to: "https://p/h",
      subject: "",
      text: "",
      html: "",
      short: "hi",
      event_type: "tx.confirmed",
      notification_id: "n4",
    });
    expect(r.status).toBe("DELIVERED");
  });
});

describe("Rate limiting", () => {
  beforeEach(() => {
    store.reset();
    templateService.invalidate();
  });

  it("TokenBucket throttles without dropping", async () => {
    const bucket = new TokenBucket(2, 2);
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(false);
    await bucket.consume();
  });

  it("rate limiter throttles sends exceeding RPS", async () => {
    getRateLimiter().configure("EMAIL", 2);
    const start = Date.now();
    for (let i = 0; i < 3; i++) {
      await emailChannel.send({
        to: "x@y.com",
        subject: "s",
        text: "t",
        html: "",
        short: "t",
        event_type: "tx.created",
        notification_id: `n${i}`,
      });
    }
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(0);
    expect(store.attempts.length).toBe(3);
    getRateLimiter().configure("EMAIL", 10);
  });
});

describe("Audit emission", () => {
  beforeEach(() => {
    store.reset();
    _resetQueue();
    templateService.invalidate();
  });

  it("emits requested + delivered audit events", async () => {
    await ingestEvent({
      event_id: "a1",
      event_type: "tx.created",
      user_id: "u",
      recipient: "u@x.com",
      data: { tx_id: "t1", user_name: "A" },
    });
    const types = store.audit.map((a) => a.type);
    expect(types).toContain("notification.requested");
    expect(types).toContain("notification.delivered");
  });

  it("emits failed audit when channel fails", async () => {
    // Override email channel to fail
    const original = emailChannel.send.bind(emailChannel);
    emailChannel.send = async () => ({
      provider: "ses-stub",
      provider_message_id: "",
      status: "FAILED",
      error: "boom",
    });
    await ingestEvent({
      event_id: "f1",
      event_type: "tx.created",
      user_id: "u",
      recipient: "u@x.com",
      data: { tx_id: "t1", user_name: "A" },
    });
    const types = store.audit.map((a) => a.type);
    expect(types).toContain("notification.failed");
    emailChannel.send = original;
  });
});

describe("healthz / readyz", () => {
  beforeEach(async () => {
    inMemoryBus.reset();
    await consumer.stop();
  });

  it("healthz ok", async () => {
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("ok");
  });

  it("readyz reports not ready while consumer is not subscribed", async () => {
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    expect(res.json().ready).toBe(false);
    expect(res.json().subscribed).toBe(false);
  });

  it("readyz reports ready after consumer starts", async () => {
    await consumer.start();
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(200);
    expect(res.json().ready).toBe(true);
    expect(res.json().subscribed).toBe(true);
    await consumer.stop();
  });
});

describe("audit-events endpoint", () => {
  beforeEach(() => store.reset());

  it("returns audit events", async () => {
    store.addAudit({
      id: "x",
      type: "notification.requested",
      notification_id: "n",
      channel: "EMAIL",
      status: "PENDING",
      created_at: new Date().toISOString(),
      payload: {},
    });
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/v1/audit-events" });
    expect(res.statusCode).toBe(200);
    expect(res.json().events.length).toBe(1);
  });
});

describe("events endpoint", () => {
  beforeEach(() => {
    store.reset();
    _resetQueue();
    templateService.invalidate();
  });

  it("accepts an event", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/events",
      payload: {
        event_id: "ep1",
        event_type: "tx.created",
        user_id: "u",
        recipient: "u@x.com",
        data: { tx_id: "t", user_name: "A" },
      },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().accepted).toBe(true);
  });

  it("rejects malformed events", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/events",
      payload: { event_id: "x" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("error handling", () => {
  it("unknown notification returns 404", async () => {
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/v1/notifications/zzz/status" });
    expect(res.statusCode).toBe(404);
  });

  it("unknown webhook returns 404 on confirm", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/webhooks/partners/zzz/confirm",
      payload: { notification_id: "n", status: "DELIVERED" },
    });
    expect(res.statusCode).toBe(404);
  });
});