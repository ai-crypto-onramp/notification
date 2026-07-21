import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { store } from "./store.js";
import {
  EventBusConsumer,
  InMemoryEventBus,
  SUBSCRIBED_EVENTS,
  consumer,
  inMemoryBus,
  type RawBusEvent,
} from "./consumer.js";
import { _resetQueue } from "./pipeline.js";
import { templateService } from "./templates.js";
import { InMemoryRedis, inMemoryRedis, setRedis } from "./redis.js";

const goodEvent: RawBusEvent = {
  event_id: "e1",
  event_type: "tx.created",
  user_id: "u",
  recipient: "u@x.com",
  data: { tx_id: "t1", user_name: "A" },
};

describe("EventBusConsumer", () => {
  let bus: InMemoryEventBus;
  let c: EventBusConsumer;

  beforeEach(() => {
    store.reset();
    _resetQueue();
    templateService.invalidate();
    bus = new InMemoryEventBus();
    c = new EventBusConsumer(bus, { group: "notification", busUrl: "test://bus" });
  });

  afterEach(async () => {
    await c.stop();
  });

  it("subscribes to the 7 lifecycle events", async () => {
    await c.start();
    expect(c.isSubscribed()).toBe(true);
    expect(SUBSCRIBED_EVENTS).toEqual([
      "tx.created",
      "payment.captured",
      "tx.signed",
      "tx.confirmed",
      "tx.failed",
      "tx.refunded",
      "chain.confirmed",
    ]);
  });

  it("replays events through the processing pipeline", async () => {
    await c.start();
    await bus.publish(goodEvent);
    // Allow the queue to flush.
    await new Promise((r) => setImmediate(r));
    expect(store.notifications.size).toBeGreaterThanOrEqual(2);
  });

  it("dead-letters malformed events without crashing", async () => {
    await c.start();
    await bus.publish({ ...goodEvent, event_type: "tx.created", user_id: "" });
    await bus.publish({ ...goodEvent, event_type: "unknown.event" });
    expect(bus.deadLettered().length).toBe(2);
    expect(store.notifications.size).toBe(0);
  });

  it("readiness fails when not subscribed", () => {
    const r = c.readiness();
    expect(r.ready).toBe(false);
    expect(r.subscribed).toBe(false);
  });

  it("readiness is ready when subscribed and lag low", async () => {
    await c.start();
    const r = c.readiness();
    expect(r.ready).toBe(true);
    expect(r.subscribed).toBe(true);
    expect(r.lag).toBe(0);
  });

  it("readiness fails when lag exceeds threshold", async () => {
    const bigBus = new InMemoryEventBus();
    const laggy = new EventBusConsumer(bigBus, { lagThreshold: 5 });
    // simulate backlog by pushing lag directly
    await bigBus.subscribe("g", SUBSCRIBED_EVENTS, async () => {});
    (bigBus as unknown as { _lag: number })._lag = 10;
    expect(laggy.readiness().ready).toBe(false);
    expect(laggy.readiness().lag).toBe(10);
  });

  it("normalizes raw events into InboundEvent", () => {
    const n = c.normalize(goodEvent);
    expect(n.event_type).toBe("tx.created");
    expect(n.data).toEqual({ tx_id: "t1", user_name: "A" });
  });

  it("rejects unsupported event types", () => {
    expect(() => c.normalize({ ...goodEvent, event_type: "tx.wat" })).toThrow();
  });

  it("uses EVENT_CONSUMER_GROUP env var", () => {
    process.env.EVENT_CONSUMER_GROUP = "custom-group";
    const cc = new EventBusConsumer(new InMemoryEventBus());
    expect(cc.group).toBe("custom-group");
    delete process.env.EVENT_CONSUMER_GROUP;
  });

  it("singleton consumer + inMemoryBus roundtrip", async () => {
    inMemoryBus.reset();
    await consumer.stop();
    await consumer.start();
    expect(consumer.isSubscribed()).toBe(true);
    await inMemoryBus.publish(goodEvent);
    await new Promise((r) => setImmediate(r));
    expect(store.notifications.size).toBeGreaterThanOrEqual(2);
    await consumer.stop();
    expect(consumer.isSubscribed()).toBe(false);
  });

  it("skips duplicate event_ids (Redis dedup)", async () => {
    const dedupRedis = new InMemoryRedis();
    setRedis(dedupRedis);
    try {
      bus = new InMemoryEventBus();
      c = new EventBusConsumer(bus, { group: "notification", busUrl: "test://bus" });
      await c.start();
      await bus.publish(goodEvent);
      await new Promise((r) => setImmediate(r));
      const firstCount = store.notifications.size;
      expect(firstCount).toBeGreaterThanOrEqual(2);
      // Publish the same event_id again; should be dedup'd.
      await bus.publish(goodEvent);
      await new Promise((r) => setImmediate(r));
      expect(store.notifications.size).toBe(firstCount);
    } finally {
      setRedis(inMemoryRedis);
    }
  });
});