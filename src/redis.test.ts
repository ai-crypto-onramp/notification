import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { InMemoryRedis, getRedis, setRedis, dedupKey, inMemoryRedis } from "./redis.js";

describe("InMemoryRedis", () => {
  let r: InMemoryRedis;

  beforeEach(() => {
    r = new InMemoryRedis();
  });

  it("set/get round-trip", async () => {
    await r.set("k", "v", 60_000);
    expect(await r.get("k")).toBe("v");
  });
  it("get returns null for missing", async () => {
    expect(await r.get("missing")).toBeNull();
  });
  it("setNxTtl returns 1 on first set and 0 on second", async () => {
    expect(await r.setNxTtl("k", "1", 60_000)).toBe(1);
    expect(await r.setNxTtl("k", "1", 60_000)).toBe(0);
  });
  it("expires keys after TTL", async () => {
    vi.useFakeTimers();
    await r.set("k", "v", 100);
    vi.advanceTimersByTime(200);
    expect(await r.get("k")).toBeNull();
    vi.useRealTimers();
  });
  it("del removes keys", async () => {
    await r.set("k", "v", 60_000);
    expect(await r.del("k")).toBe(1);
    expect(await r.get("k")).toBeNull();
  });
  it("ping returns PONG", async () => {
    expect(await r.ping()).toBe("PONG");
  });
});

describe("redis client singleton", () => {
  afterEach(() => setRedis(inMemoryRedis));

  it("getRedis returns the active client", () => {
    expect(getRedis()).toBe(inMemoryRedis);
  });
  it("setRedis swaps the active client", () => {
    const custom = new InMemoryRedis();
    setRedis(custom);
    expect(getRedis()).toBe(custom);
  });
  it("dedupKey formats the key", () => {
    expect(dedupKey("e1", "EMAIL", "u@x.com")).toBe("dedup:e1|EMAIL|u@x.com");
  });
});