import { describe, it, expect } from "vitest";
import app from "./index.js";

describe("GET /healthz", () => {
  it("returns status ok", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });
});