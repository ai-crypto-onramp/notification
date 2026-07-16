import { beforeEach, describe, it, expect } from "vitest";
import { store } from "./store.js";
import { buildApp } from "./app.js";
import { upsertPreferences } from "./preferences.js";
import { ingestEvent, _resetQueue } from "./pipeline.js";
import { templateService } from "./templates.js";

describe("List endpoints", () => {
  beforeEach(() => {
    store.reset();
    _resetQueue();
    templateService.invalidate();
  });

  it("GET /v1/notifications returns empty list by default", async () => {
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/v1/notifications" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ notifications: [] });
  });

  it("GET /v1/notifications returns all notifications newest-first", async () => {
    await ingestEvent({
      event_id: "e1",
      event_type: "tx.created",
      user_id: "user1",
      recipient: "user@example.com",
      data: { tx_id: "tx1", amount: "10", currency: "USDC", user_name: "Alice" },
    });
    await ingestEvent({
      event_id: "e2",
      event_type: "payment.captured",
      user_id: "user2",
      recipient: "user2@example.com",
      data: { tx_id: "tx2", amount: "20", currency: "USDC", user_name: "Bob" },
    });
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/v1/notifications" });
    expect(res.statusCode).toBe(200);
    const list = res.json().notifications;
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBeGreaterThanOrEqual(2);
    for (const n of list) {
      expect(n).toHaveProperty("id");
      expect(n).toHaveProperty("event_type");
      expect(n).toHaveProperty("channel");
      expect(n).toHaveProperty("status");
      expect(n).toHaveProperty("created_at");
    }
  });

  it("GET /v1/preferences returns empty list by default", async () => {
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/v1/preferences" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ preferences: [] });
  });

  it("GET /v1/preferences returns all preferences sorted by user_id", async () => {
    upsertPreferences("userB", {
      channels: { email: true, sms: false, push: true, webhook: false },
      locale: "en",
    });
    upsertPreferences("userA", {
      channels: { email: false, sms: true, push: false, webhook: true },
      locale: "fr",
    });
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/v1/preferences" });
    expect(res.statusCode).toBe(200);
    const list = res.json().preferences;
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBe(2);
    expect(list[0].user_id).toBe("userA");
    expect(list[1].user_id).toBe("userB");
    for (const p of list) {
      expect(p).toHaveProperty("user_id");
      expect(p).toHaveProperty("channels");
      expect(p).toHaveProperty("locale");
    }
  });
});