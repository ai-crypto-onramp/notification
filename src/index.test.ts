import { afterEach, describe, it, expect, vi } from "vitest";
import app, { start } from "./index.js";

describe("GET /healthz", () => {
  it("returns status ok", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("returns 404 for unknown routes", async () => {
    const res = await app.inject({ method: "GET", url: "/nope" });
    expect(res.statusCode).toBe(404);
  });
});

describe("start", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.PORT;
  });

  it("listens on the port from the PORT env var", async () => {
    process.env.PORT = "3456";
    const listenSpy = vi
      .spyOn(app, "listen")
      .mockResolvedValue(undefined as never);
    await start();
    expect(listenSpy).toHaveBeenCalledWith({ port: 3456, host: "0.0.0.0" });
  });

  it("defaults to port 8080 when PORT is not set", async () => {
    const listenSpy = vi
      .spyOn(app, "listen")
      .mockResolvedValue(undefined as never);
    await start();
    expect(listenSpy).toHaveBeenCalledWith({ port: 8080, host: "0.0.0.0" });
  });

  it("logs the error and exits with code 1 when listen fails", async () => {
    const err = new Error("boom");
    vi.spyOn(app, "listen").mockRejectedValue(err);
    const errorSpy = vi
      .spyOn(app.log, "error")
      .mockImplementation(() => undefined);
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    await start();
    expect(errorSpy).toHaveBeenCalledWith(err);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
