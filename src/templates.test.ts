import { beforeEach, describe, it, expect } from "vitest";
import { store } from "./store.js";
import { templateService, __renderString } from "./templates.js";

const EVENTS = [
  "tx.created",
  "payment.captured",
  "tx.signed",
  "tx.confirmed",
  "tx.failed",
  "tx.refunded",
  "chain.confirmed",
] as const;

describe("renderString", () => {
  it("substitutes variables", () => {
    expect(__renderString("Hi {{name}}", { name: "Bob" })).toBe("Hi Bob");
  });
  it("replaces missing vars with empty", () => {
    expect(__renderString("Hi {{name}}", {})).toBe("Hi ");
  });
  it("handles dotted paths", () => {
    expect(__renderString("{{user.name}}", { user: { name: "Al" } })).toBe("Al");
  });
});

describe("TemplateService.resolve", () => {
  beforeEach(() => store.reset());

  it("renders all 6 lifecycle events for email", () => {
    const data = {
      user_name: "Alice",
      tx_id: "tx1",
      amount: "10",
      currency: "USDC",
      chain: "ethereum",
      confirmations: "12",
      reason: "insufficient fee",
    };
    for (const ev of EVENTS) {
      const compiled = templateService.resolve(ev, "EMAIL", "en", data);
      expect(compiled.subject).toContain("tx1");
      expect(compiled.text_body).toContain("Alice");
      expect(compiled.html_body).toContain("Alice");
    }
  });

  it("renders all 6 lifecycle events for sms and push", () => {
    const data = {
      user_name: "Alice",
      tx_id: "tx1",
      amount: "10",
      currency: "USDC",
      chain: "ethereum",
      confirmations: "12",
      reason: "insufficient fee",
    };
    for (const ev of EVENTS) {
      for (const ch of ["SMS", "PUSH"] as const) {
        const compiled = templateService.resolve(ev, ch, "en", data);
        expect(compiled.short_body).toContain("tx1");
        expect(compiled.short_body.length).toBeGreaterThan(0);
      }
    }
  });

  it("falls back to default locale", () => {
    const compiled = templateService.resolve("tx.created", "EMAIL", "fr", {
      tx_id: "x",
    });
    expect(compiled.template.locale).toBe("en");
    expect(compiled.subject).toContain("x");
  });

  it("throws on unknown template", () => {
    expect(() =>
      templateService.resolve("unknown.event" as never, "EMAIL", "en", {}),
    ).toThrow();
  });

  it("caches compiled templates", () => {
    templateService.resolve("tx.created", "EMAIL", "en", {});
    const before = templateService.resolve("tx.created", "EMAIL", "en", { tx_id: "z" });
    expect(before.subject).toContain("z");
  });
});