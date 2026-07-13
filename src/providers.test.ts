import { beforeEach, describe, it, expect, vi } from "vitest";
import {
  StubSesProvider,
  StubSnsProvider,
  StubTwilioProvider,
  StubFcmProvider,
  StubApnsProvider,
  loadSesConfig,
  loadSmsConfig,
  loadFcmConfig,
  loadApnsConfig,
  isUsNumber,
  platformForToken,
  buildPushPayload,
  mapProviderError,
  loadRateLimitConfig,
  loadWebhookDefaults,
} from "./providers.js";
import { emailChannel, smsChannel, pushChannel } from "./channels.js";
import { store } from "./store.js";
import { templateService } from "./templates.js";

describe("provider config loaders", () => {
  it("loads SES config with defaults", () => {
    const c = loadSesConfig();
    expect(c.region).toBe("us-east-1");
    expect(c.from).toBeTruthy();
  });
  it("loads SMS config with defaults", () => {
    const c = loadSmsConfig();
    expect(c.snsRegion).toBe("us-east-1");
  });
  it("loads FCM/APNS config with defaults", () => {
    expect(loadFcmConfig().key).toBe("");
    expect(loadApnsConfig().bundleId).toBe("com.example.onramp");
  });
  it("loadRateLimitConfig reads env defaults", () => {
    const c = loadRateLimitConfig();
    expect(c.email).toBeGreaterThan(0);
    expect(c.webhookMaxAttempts).toBe(5);
  });
  it("loadWebhookDefaults reads env defaults", () => {
    const c = loadWebhookDefaults();
    expect(c.batchWindowMs).toBe(1000);
    expect(c.maxAttempts).toBe(5);
  });
});

describe("isUsNumber", () => {
  it("matches US numbers", () => {
    expect(isUsNumber("+15555550100")).toBe(true);
    expect(isUsNumber("+447700900123")).toBe(false);
    expect(isUsNumber("+1")).toBe(false);
  });
});

describe("platformForToken + buildPushPayload", () => {
  it("detects iOS 64-hex tokens", () => {
    expect(platformForToken("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")).toBe("ios");
    expect(platformForToken("a-long-fcm-token-string-xyz")).toBe("android");
  });
  it("builds an FCM notification+data envelope", () => {
    const p = buildPushPayload({
      token: "fcm-token",
      platform: "android",
      title: "T",
      body: "B",
      data: { x: 1 },
      notificationId: "n1",
    });
    expect((p.message as Record<string, unknown>).token).toBe("fcm-token");
    const notif = (p.message as Record<string, unknown>).notification as Record<string, unknown>;
    expect(notif.title).toBe("T");
    const data = (p.message as Record<string, unknown>).data as Record<string, unknown>;
    expect(data.notification_id).toBe("n1");
  });
  it("builds an APNS aps envelope", () => {
    const p = buildPushPayload({
      token: "ios-token",
      platform: "ios",
      title: "T",
      body: "B",
      notificationId: "n2",
    });
    const aps = (p.aps as Record<string, unknown>).alert as Record<string, unknown>;
    expect(aps.title).toBe("T");
    expect((p.aps as Record<string, unknown>).sound).toBe("default");
  });
});

describe("mapProviderError", () => {
  it("maps throttled errors to throttled status", () => {
    const r = mapProviderError("ses", new Error("Throttling: rate exceeded"));
    expect(r.status).toBe("throttled");
    expect(r.provider).toBe("ses");
  });
  it("maps unregistered token to bounced", () => {
    const r = mapProviderError("fcm", new Error("NotRegistered"));
    expect(r.status).toBe("bounced");
  });
  it("maps unknown errors to failed", () => {
    const r = mapProviderError("sns", new Error("something broke"));
    expect(r.status).toBe("failed");
    expect(r.error).toBe("something broke");
  });
});

describe("stub providers", () => {
  it("StubSesProvider returns delivered and records id", async () => {
    const p = new StubSesProvider();
    const r = await p.send({ to: "a@b.com", subject: "s", text: "t", html: "", notificationId: "n1" });
    expect(r.status).toBe("delivered");
    expect(r.provider).toBe("ses");
    expect(p.sent.length).toBe(1);
  });
  it("StubSesProvider surfaces failure when fail=true", async () => {
    const p = new StubSesProvider();
    p.fail = true;
    const r = await p.send({ to: "a@b.com", subject: "s", text: "t", html: "", notificationId: "n2" });
    expect(r.status).toBe("throttled");
  });
  it("StubSnsProvider + StubTwilioProvider return delivered", async () => {
    expect((await new StubSnsProvider().send({ to: "+1", body: "b", notificationId: "n" })).provider).toBe("sns");
    expect((await new StubTwilioProvider().send({ to: "+44", body: "b", notificationId: "n" })).provider).toBe("twilio");
  });
  it("StubFcmProvider + StubApnsProvider return delivered", async () => {
    expect((await new StubFcmProvider().send({ token: "t", platform: "android", title: "T", body: "B", notificationId: "n" })).provider).toBe("fcm");
    expect((await new StubApnsProvider().send({ token: "t", platform: "ios", title: "T", body: "B", notificationId: "n" })).provider).toBe("apns");
  });
});

describe("EmailChannel provider injection", () => {
  beforeEach(() => {
    store.reset();
    templateService.invalidate();
  });
  it("uses an injected provider and maps its error on throw", async () => {
    const failing = { send: vi.fn().mockRejectedValue(new Error("SES throttled")) };
    emailChannel.setProvider(failing as never);
    const r = await emailChannel.send({
      to: "x@y.com", subject: "s", text: "t", html: "", short: "t",
      event_type: "tx.created", notification_id: "err1",
    });
    expect(r.status).toBe("throttled");
    expect(store.attempts[0].error).toBe("SES throttled");
  });
  it("uses fromAddress from config", () => {
    expect(emailChannel.fromAddress()).toBeTruthy();
  });
});

describe("SmsChannel provider injection + routing", () => {
  beforeEach(() => {
    store.reset();
    templateService.invalidate();
  });
  it("routes US through SNS and intl through Twilio when injected", async () => {
    const sns = new StubSnsProvider();
    const twilio = new StubTwilioProvider();
    smsChannel.setProviders(sns, twilio);
    await smsChannel.send({ to: "+15555550100", subject: "", text: "", html: "", short: "hi", event_type: "tx.created", notification_id: "us1" });
    expect(sns.sent.length).toBe(1);
    await smsChannel.send({ to: "+447700900123", subject: "", text: "", html: "", short: "hi", event_type: "tx.created", notification_id: "intl1" });
    expect(twilio.sent.length).toBe(1);
  });
});

describe("PushChannel device resolution + payload shapes", () => {
  beforeEach(() => {
    store.reset();
    templateService.invalidate();
  });
  it("registers and resolves device tokens", () => {
    pushChannel.registerDevice("u1", "fcm-token-1");
    pushChannel.registerDevice("u1", "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
    const tokens = pushChannel.resolveTokens("u1");
    expect(tokens.length).toBe(2);
    expect(tokens[0].platform).toBe("android");
    expect(tokens[1].platform).toBe("ios");
  });
  it("delivers to both android and iOS devices for a recipient", async () => {
    const fcm = new StubFcmProvider();
    const apns = new StubApnsProvider();
    pushChannel.setProviders(fcm, apns);
    pushChannel.registerDevice("u2", "fcm-token");
    pushChannel.registerDevice("u2", "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
    const r = await pushChannel.send({
      to: "u2", subject: "T", text: "", html: "", short: "B",
      event_type: "tx.confirmed", notification_id: "p1",
    });
    expect(fcm.sent.length).toBe(1);
    expect(apns.sent.length).toBe(1);
    expect(r.provider).toBe("apns");
  });
  it("maps invalid-token errors to bounced", async () => {
    const failing = { send: vi.fn().mockRejectedValue(new Error("NotRegistered")) };
    pushChannel.setProviders(failing as never, new StubApnsProvider());
    pushChannel.registerDevice("u3", "fcm-token");
    const r = await pushChannel.send({
      to: "u3", subject: "T", text: "", html: "", short: "B",
      event_type: "tx.confirmed", notification_id: "p2",
    });
    expect(r.status).toBe("bounced");
  });
});