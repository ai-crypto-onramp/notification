import { beforeEach, describe, it, expect } from "vitest";
import { store } from "./store.js";
import { channelRouter, inQuietHours, defaultPreference } from "./router.js";
import { upsertPreferences } from "./preferences.js";
import { _resetQueue } from "./pipeline.js";

describe("ChannelRouter", () => {
  beforeEach(() => {
    store.reset();
    _resetQueue();
  });

  it("fans out email+push for tx.confirmed", () => {
    const routes = channelRouter.resolve(
      "tx.confirmed",
      "u@x.com",
      "user1",
      { tx_id: "t1", chain: "eth", confirmations: 12 },
    );
    const channels = routes.map((r) => r.notification.channel);
    expect(channels).toEqual(["email", "push"]);
    expect(routes.every((r) => !r.suppressed)).toBe(true);
  });

  it("routes email+sms for tx.created", () => {
    const routes = channelRouter.resolve(
      "tx.created",
      "u@x.com",
      "user1",
      { tx_id: "t1" },
    );
    expect(routes.map((r) => r.notification.channel)).toEqual(["email", "sms"]);
  });

  it("filters opted-out channels", () => {
    upsertPreferences("user1", {
      channels: { email: true, sms: false, push: false, webhook: false },
      locale: "en",
    });
    const routes = channelRouter.resolve(
      "tx.created",
      "u@x.com",
      "user1",
      { tx_id: "t1" },
    );
    const suppressed = routes.find((r) => r.notification.channel === "sms");
    expect(suppressed?.suppressed).toBe(true);
    expect(suppressed?.reason).toBe("opted_out");
    expect(suppressed?.notification.status).toBe("suppressed");
    const email = routes.find((r) => r.notification.channel === "email");
    expect(email?.suppressed).toBe(false);
  });

  it("suppresses marketing during quiet hours", () => {
    upsertPreferences("user1", {
      channels: { email: true, sms: true, push: true, webhook: true },
      locale: "en",
      quiet_hours: { start: "00:00", end: "23:59" },
    });
    const routes = channelRouter.resolve(
      "tx.created" as never,
      "u@x.com",
      "user1",
      { tx_id: "t1", traffic_class: "marketing" },
    );
    expect(routes.every((r) => r.suppressed)).toBe(true);
    expect(routes[0].reason).toBe("quiet_hours");
  });

  it("lets transactional events bypass quiet hours", () => {
    upsertPreferences("user1", {
      channels: { email: true, sms: true, push: true, webhook: true },
      locale: "en",
      quiet_hours: { start: "00:00", end: "23:59" },
    });
    const routes = channelRouter.resolve(
      "tx.confirmed",
      "u@x.com",
      "user1",
      { tx_id: "t1", chain: "eth", confirmations: 12 },
    );
    expect(routes.every((r) => !r.suppressed)).toBe(true);
  });

  it("tags tx.* as transactional by default", () => {
    const routes = channelRouter.resolve("tx.created", "u@x.com", "u", { tx_id: "t" });
    expect(routes[0].notification.traffic_class).toBe("transactional");
  });

  it("uses default preference when none set", () => {
    const pref = defaultPreference("u");
    expect(pref.channels.email).toBe(true);
  });

  it("detects quiet hours window", () => {
    const pref = {
      user_id: "u",
      channels: { email: true, sms: true, push: true, webhook: true },
      locale: "en",
      quiet_hours: { start: "22:00", end: "06:00" },
    };
    const at = (h: number) => new Date(2024, 0, 1, h, 0);
    expect(inQuietHours(pref, at(23))).toBe(true);
    expect(inQuietHours(pref, at(2))).toBe(true);
    expect(inQuietHours(pref, at(10))).toBe(false);
  });
});