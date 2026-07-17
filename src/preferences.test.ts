import { beforeEach, describe, it, expect } from "vitest";
import { store } from "./store.js";
import { upsertPreferences, getPreferences } from "./preferences.js";
import { buildApp } from "./app.js";

describe("Preferences", () => {
  beforeEach(() => store.reset());

  it("upserts and reads preferences", () => {
    const pref = upsertPreferences("u1", {
      channels: { EMAIL: true, SMS: false, PUSH: true, WEBHOOK: false },
      locale: "fr",
      quiet_hours: { start: "22:00", end: "07:00" },
    });
    expect(pref.channels.SMS).toBe(false);
    expect(pref.locale).toBe("fr");
    expect(getPreferences("u1")).toEqual(pref);
  });

  it("validates channels", () => {
    expect(() =>
      upsertPreferences("u1", {
        channels: { fax: true } as never,
      }),
    ).toThrow();
  });

  it("validates quiet hours format", () => {
    expect(() =>
      upsertPreferences("u1", {
        channels: { EMAIL: true, SMS: true, PUSH: true, WEBHOOK: true },
        quiet_hours: { start: "bad", end: "07:00" },
      }),
    ).toThrow();
  });

  it("returns 404 for unknown user via API", async () => {
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/v1/preferences/nope" });
    expect(res.statusCode).toBe(404);
  });

  it("returns 400 on invalid body via API", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/preferences/u1",
      payload: { channels: { fax: true } as never },
    });
    expect(res.statusCode).toBe(400);
  });

  it("creates preferences via API", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/preferences/u1",
      payload: {
        channels: { EMAIL: true, SMS: false, PUSH: true, WEBHOOK: false },
        locale: "en",
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().user_id).toBe("u1");
  });
});