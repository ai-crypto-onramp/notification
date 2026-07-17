import { beforeEach, describe, it, expect } from "vitest";
import { store } from "./store.js";
import { ingestEvent, manualSend, _resetQueue } from "./pipeline.js";
import { buildApp } from "./app.js";
import { templateService } from "./templates.js";

const sampleEvent = {
  event_id: "e1",
  event_type: "tx.created" as const,
  user_id: "user1",
  recipient: "user@example.com",
  data: { tx_id: "tx1", amount: "10", currency: "USDC", user_name: "Alice" },
};

describe("Event ingestion", () => {
  beforeEach(() => {
    store.reset();
    _resetQueue();
    templateService.invalidate();
  });

  it("creates notifications and delivery attempts", async () => {
    const sent = await ingestEvent(sampleEvent);
    expect(sent.length).toBeGreaterThan(0);
    expect(store.notifications.size).toBeGreaterThanOrEqual(2);
    const attempts = store.attempts;
    expect(attempts.length).toBeGreaterThanOrEqual(2);
    expect(attempts.every((a) => a.status === "DELIVERED")).toBe(true);
  });

  it("dedups on event_id+channel+recipient", async () => {
    await ingestEvent(sampleEvent);
    const before = store.notifications.size;
    await ingestEvent(sampleEvent);
    expect(store.notifications.size).toBe(before);
    const dupAudits = store.audit.filter((a) =>
      a.payload && (a.payload as Record<string, unknown>).reason === "duplicate",
    );
    expect(dupAudits.length).toBeGreaterThan(0);
  });

  it("records audit events for requested/delivered", async () => {
    await ingestEvent(sampleEvent);
    const types = store.audit.map((a) => a.type);
    expect(types).toContain("notification.requested");
    expect(types).toContain("notification.delivered");
  });
});

describe("Manual send", () => {
  beforeEach(() => {
    store.reset();
    templateService.invalidate();
  });

  it("sends a notification via manual send", () => {
    const n = manualSend({
      event_id: "m1",
      channel: "EMAIL",
      recipient: "x@example.com",
      event_type: "tx.created",
      data: { tx_id: "t2", user_name: "Bob" },
    });
    expect(n.channel).toBe("EMAIL");
    expect(n.recipient).toBe("x@example.com");
  });

  it("rejects duplicate manual sends", () => {
    manualSend({
      event_id: "m2",
      channel: "EMAIL",
      recipient: "x@example.com",
      event_type: "tx.created",
      data: { tx_id: "t3" },
    });
    expect(() =>
      manualSend({
        event_id: "m2",
        channel: "EMAIL",
        recipient: "x@example.com",
        event_type: "tx.created",
        data: { tx_id: "t3" },
      }),
    ).toThrow();
  });
});

describe("Notification status endpoints", () => {
  beforeEach(() => {
    store.reset();
    templateService.invalidate();
  });

  it("GET /v1/notifications/:id returns 404 for unknown", async () => {
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/v1/notifications/nope" });
    expect(res.statusCode).toBe(404);
  });

  it("GET /v1/notifications/:id/status returns aggregated status", async () => {
    await ingestEvent(sampleEvent);
    const id = Array.from(store.notifications.values())[0].id;
    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/v1/notifications/${id}/status`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.notification_id).toBe(id);
    expect(body.channels).toBeDefined();
  });

  it("POST /v1/notifications/send creates a notification", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/notifications/send",
      payload: {
        event_id: "s1",
        channel: "EMAIL",
        recipient: "u@x.com",
        event_type: "tx.created",
        data: { tx_id: "tx9", user_name: "Sam" },
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().channel).toBe("EMAIL");
  });

  it("POST /v1/notifications/send rejects duplicates with 400", async () => {
    const app = buildApp();
    const payload = {
      event_id: "s2",
      channel: "EMAIL",
      recipient: "u@x.com",
      event_type: "tx.created",
      data: { tx_id: "tx10" },
    };
    await app.inject({ method: "POST", url: "/v1/notifications/send", payload });
    const res = await app.inject({ method: "POST", url: "/v1/notifications/send", payload });
    expect(res.statusCode).toBe(400);
  });
});