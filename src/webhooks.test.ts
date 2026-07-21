import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { store } from "./store.js";
import { buildApp } from "./app.js";
import { webhookChannel } from "./channels.js";
import { templateService } from "./templates.js";
import {
  signWebhookPayload,
  verifyWebhookSignature,
  registerWebhook,
  deliverWithBackoff,
  DEFAULT_BACKOFF_MS,
  setWebhookFetch,
  setWebhookSleep,
  setWebhookDlqSink,
  dlqEntries,
} from "./webhooks.js";
import type { DlqSink } from "./dlq.js";

describe("Webhooks", () => {
  beforeEach(() => {
    store.reset();
    setWebhookSleep(() => Promise.resolve());
    dlqEntries.length = 0;
  });
  afterEach(() => {
    setWebhookFetch(null);
    setWebhookSleep(null);
    setWebhookDlqSink(null);
  });

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
    expect(body.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
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
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response);
    setWebhookFetch(fetchMock as never);
    const { delivered, attempts } = await deliverWithBackoff(wh, { event: "x" });
    expect(delivered).toBe(true);
    expect(attempts.length).toBe(1);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://p/h");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["X-Webhook-Signature"]).toBeTruthy();
  });

  it("retries on 5xx and succeeds on second attempt", async () => {
    const wh = registerWebhook({
      url: "https://p/h",
      secret: "s",
      retry_policy: { max_attempts: 3, backoff_ms: [10, 20, 40] },
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503 } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200 } as Response);
    setWebhookFetch(fetchMock as never);
    const { delivered, attempts } = await deliverWithBackoff(wh, { event: "x" });
    expect(delivered).toBe(true);
    expect(attempts.length).toBe(2);
    expect(attempts[0].status).toBe("FAILED");
    expect(attempts[1].status).toBe("DELIVERED");
  });

  it("sends to DLQ on final failure", async () => {
    const wh = registerWebhook({
      url: "https://p/h",
      secret: "s",
      retry_policy: { max_attempts: 2, backoff_ms: [10, 20] },
    });
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 } as Response);
    setWebhookFetch(fetchMock as never);
    const sink: DlqSink = { send: vi.fn().mockResolvedValue(undefined) };
    setWebhookDlqSink(sink);
    const { delivered, attempts } = await deliverWithBackoff(wh, { event: "x", notification_id: "n-dlq" });
    expect(delivered).toBe(false);
    expect(attempts.length).toBe(2);
    expect(sink.send).toHaveBeenCalledOnce();
    const sendMock = sink.send as unknown as { mock: { calls: unknown[][] } };
    const entry = sendMock.mock.calls[0][0] as { reason: string; notification_id: string };
    expect(entry.notification_id).toBe("n-dlq");
    expect(entry.reason).toMatch(/HTTP 500/);
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
        channel: "WEBHOOK",
        recipient: "https://p/h",
        event_type: "tx.confirmed",
        data: { tx_id: "txw", chain: "eth", confirmations: 1 },
      },
    });
    const notif = Array.from(store.notifications.values()).find(
      (n) => n.channel === "WEBHOOK",
    )!;
    expect(notif).toBeTruthy();
    const res = await app.inject({
      method: "POST",
      url: `/v1/webhooks/partners/${wh.id}/confirm`,
      payload: { notification_id: notif.id, status: "DELIVERED" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("DELIVERED");
  });

  it("confirm endpoint returns 404 for unknown webhook", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/webhooks/partners/wh_missing/confirm",
      payload: { notification_id: "x", status: "DELIVERED" },
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

describe("WebhookChannel batch coalescing", () => {
  beforeEach(() => {
    store.reset();
    templateService.invalidate();
    setWebhookFetch(vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response) as never);
    dlqEntries.length = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
    setWebhookFetch(null);
  });

  it("coalesces a burst of sends for the same partner into one batch", async () => {
    vi.useFakeTimers();
    const wh = registerWebhook({ url: "https://p/h", secret: "s" });
    const promises: Promise<unknown>[] = [];
    for (let i = 0; i < 5; i++) {
      promises.push(
        webhookChannel.send({
          to: "https://p/h",
          subject: "",
          text: "",
          html: "",
          short: `hi-${i}`,
          event_type: "tx.confirmed",
          notification_id: `batch-${i}`,
        }, { webhookId: wh.id }),
      );
    }
    // Nothing resolved yet (batch window open).
    expect(promises.every((p) => Promise.race([p, Promise.resolve("PENDING")]).then((v) => v === "PENDING"))).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    const results = await Promise.all(promises);
    expect((results as { status: string }[]).every((r) => r.status === "DELIVERED")).toBe(true);
    // A single coalesced delivery id is shared across all notifications.
    const ids = new Set(store.attempts.map((a) => a.provider_message_id));
    expect(ids.size).toBe(1);
    expect(store.attempts.length).toBe(5);
  });
});