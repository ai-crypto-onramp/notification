import { beforeEach, describe, it, expect } from "vitest";
import { store } from "./store.js";
import { buildApp } from "./app.js";
import {
  signWebhookPayload,
  verifyWebhookSignature,
  registerWebhook,
  deliverWithBackoff,
  DEFAULT_BACKOFF_MS,
} from "./webhooks.js";

describe("Webhooks", () => {
  beforeEach(() => store.reset());

  it("signs and verifies HMAC payloads", () => {
    const secret = "topsecret";
    const raw = JSON.stringify({ event: "tx.confirmed", id: "1" });
    const { timestamp, signature } = signWebhookPayload(secret, raw);
    expect(verifyWebhookSignature(secret, raw, timestamp, signature)).toBe(true);
    expect(verifyWebhookSignature("wrong", raw, timestamp, signature)).toBe(false);
    expect(verifyWebhookSignature(secret, "other", timestamp, signature)).toBe(false);
  });

  it("rejects stale timestamps", () => {
    const secret = "s";
    const raw = "x";
    const oldTs = Math.floor(Date.now() / 1000 - 600).toString();
    const sig = signWebhookPayload(secret, raw).signature;
    expect(verifyWebhookSignature(secret, raw, oldTs, sig)).toBe(false);
  });

  it("registers a webhook via API", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/webhooks/partners",
      payload: { url: "https://partner.example/hook", secret: "abc" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toMatch(/^wh_/);
    expect(body.url).toBe("https://partner.example/hook");
  });

  it("lists webhooks via API", async () => {
    registerWebhook({ url: "https://p/h", secret: "s" });
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/v1/webhooks/partners" });
    expect(res.statusCode).toBe(200);
    expect(res.json().webhooks.length).toBe(1);
  });

  it("rejects registration without url/secret", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/webhooks/partners",
      payload: { url: "https://p/h" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("records backoff attempts on failure", async () => {
    const wh = registerWebhook({ url: "https://p/h", secret: "s" });
    const { delivered, attempts } = await deliverWithBackoff(
      wh,
      { event: "x" },
      true,
    );
    expect(delivered).toBe(false);
    expect(attempts.length).toBe(wh.retry_policy.max_attempts);
    expect(attempts[1].attempt_no).toBe(2);
  });

  it("delivers on first success", async () => {
    const wh = registerWebhook({ url: "https://p/h", secret: "s" });
    const { delivered, attempts } = await deliverWithBackoff(wh, { event: "x" });
    expect(delivered).toBe(true);
    expect(attempts.length).toBe(1);
  });

  it("uses default backoff schedule", () => {
    expect(DEFAULT_BACKOFF_MS).toEqual([1000, 5000, 30000, 120000, 600000]);
  });

  it("confirm endpoint updates notification status", async () => {
    const wh = registerWebhook({ url: "https://p/h", secret: "s" });
    const app = buildApp();
    // Create a notification via manual send
    await app.inject({
      method: "POST",
      url: "/v1/notifications/send",
      payload: {
        event_id: "wc1",
        channel: "webhook",
        recipient: "https://p/h",
        event_type: "tx.confirmed",
        data: { tx_id: "txw", chain: "eth", confirmations: 1 },
      },
    });
    const notif = Array.from(store.notifications.values()).find(
      (n) => n.channel === "webhook",
    )!;
    expect(notif).toBeTruthy();
    const res = await app.inject({
      method: "POST",
      url: `/v1/webhooks/partners/${wh.id}/confirm`,
      payload: { notification_id: notif.id, status: "delivered" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("delivered");
  });

  it("confirm endpoint returns 404 for unknown webhook", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/webhooks/partners/wh_missing/confirm",
      payload: { notification_id: "x", status: "delivered" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("verify endpoint verifies signature", async () => {
    const secret = "s";
    const raw = '{"a":1}';
    const { timestamp, signature } = signWebhookPayload(secret, raw);
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/webhooks/verify",
      payload: { secret, raw_body: raw, timestamp, signature },
    });
    expect(res.json().valid).toBe(true);
  });
});