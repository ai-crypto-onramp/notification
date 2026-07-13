import type { InboundEvent, EventType } from "./types.js";
import { enqueueEvent } from "./pipeline.js";

/**
 * Stage 2: event bus consumer.
 *
 * Subscribes to `tx.*` and `chain.confirmed` events from the event bus with a
 * dedicated consumer group (`EVENT_CONSUMER_GROUP`) and dispatches each event
 * to the processing pipeline. The consumer talks to the broker through the
 * `EventBusClient` interface so the runtime can wire `kafkajs`/`nats` while
 * tests use `InMemoryEventBus`.
 *
 * Health/readiness is tied to consumer lag: `/readyz` reports `ready: false`
 * while the consumer is not subscribed or while the backlog exceeds the
 * configured lag threshold.
 */

export const SUBSCRIBED_EVENTS: EventType[] = [
  "tx.created",
  "payment.captured",
  "tx.signed",
  "tx.confirmed",
  "tx.failed",
  "tx.refunded",
  "chain.confirmed",
];

export interface RawBusEvent {
  event_id: string;
  event_type: string;
  user_id: string;
  recipient: string;
  data?: Record<string, unknown>;
}

export interface EventBusClient {
  /** Join the consumer group and begin emitting events via the handler. */
  subscribe(
    group: string,
    events: EventType[],
    handler: (event: RawBusEvent) => Promise<void>,
  ): Promise<void>;
  /** Stop consuming and leave the group. */
  unsubscribe(): Promise<void>;
  /** Number of events received but not yet acknowledged. */
  lag(): number;
  /** Whether the consumer is currently subscribed. */
  subscribed(): boolean;
  /** Human-readable broker description for health output. */
  describe(): string;
}

export class InMemoryEventBus implements EventBusClient {
  private handler?: (e: RawBusEvent) => Promise<void>;
  private _subscribed = false;
  private group = "";
  private _lag = 0;
  private deadLetter: { event: RawBusEvent; reason: string }[] = [];

  async subscribe(
    group: string,
    _events: EventType[],
    handler: (e: RawBusEvent) => Promise<void>,
  ): Promise<void> {
    this.group = group;
    this.handler = handler;
    this._subscribed = true;
  }
  async unsubscribe(): Promise<void> {
    this._subscribed = false;
    this.handler = undefined;
  }
  lag(): number {
    return this._lag;
  }
  subscribed(): boolean {
    return this._subscribed;
  }
  describe(): string {
    return `in-memory://bus?group=${this.group || "none"}`;
  }

  /** Test helper: inject a raw event into the bus as if delivered by a broker. */
  async publish(event: RawBusEvent): Promise<void> {
    if (!this._subscribed || !this.handler) return;
    this._lag += 1;
    try {
      await this.handler(event);
      this._lag -= 1;
    } catch (err) {
      // Dead-letter malformed events without crashing the consumer.
      this._lag -= 1;
      this.deadLetter.push({ event, reason: (err as Error).message });
    }
  }

  deadLettered(): { event: RawBusEvent; reason: string }[] {
    return this.deadLetter;
  }

  reset(): void {
    this._subscribed = false;
    this.handler = undefined;
    this._lag = 0;
    this.deadLetter = [];
  }
}

export interface ConsumerOptions {
  group?: string;
  busUrl?: string;
  lagThreshold?: number;
}

export interface ReadinessReport {
  ready: boolean;
  subscribed: boolean;
  lag: number;
  lagThreshold: number;
  broker: string;
}

export class EventBusConsumer {
  readonly group: string;
  readonly busUrl: string;
  readonly lagThreshold: number;
  private started = false;

  constructor(
    private bus: EventBusClient,
    opts: ConsumerOptions = {},
  ) {
    this.group = opts.group ?? process.env.EVENT_CONSUMER_GROUP ?? "notification";
    this.busUrl = opts.busUrl ?? process.env.EVENT_BUS_URL ?? "nats://broker:4222";
    this.lagThreshold = opts.lagThreshold ?? Number(process.env.CONSUMER_LAG_THRESHOLD ?? 100);
  }

  async start(): Promise<void> {
    if (this.started) return;
    await this.bus.subscribe(this.group, SUBSCRIBED_EVENTS, this.onEvent);
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    await this.bus.unsubscribe();
    this.started = false;
  }

  isSubscribed(): boolean {
    return this.bus.subscribed();
  }

  lag(): number {
    return this.bus.lag();
  }

  readiness(): ReadinessReport {
    const lag = this.lag();
    const subscribed = this.isSubscribed();
    return {
      ready: subscribed && lag <= this.lagThreshold,
      subscribed,
      lag,
      lagThreshold: this.lagThreshold,
      broker: this.bus.describe(),
    };
  }

  /** Normalize a raw bus event into the internal InboundEvent shape. */
  normalize(raw: RawBusEvent): InboundEvent {
    if (!raw || typeof raw !== "object") throw new ConsumerError("event required");
    if (!raw.event_id) throw new ConsumerError("event_id required");
    if (!raw.event_type) throw new ConsumerError("event_type required");
    if (!SUBSCRIBED_EVENTS.includes(raw.event_type as EventType)) {
      throw new ConsumerError(`unsupported event_type: ${raw.event_type}`);
    }
    if (!raw.user_id) throw new ConsumerError("user_id required");
    if (!raw.recipient) throw new ConsumerError("recipient required");
    return {
      event_id: raw.event_id,
      event_type: raw.event_type as EventType,
      user_id: raw.user_id,
      recipient: raw.recipient,
      data: raw.data ?? {},
    };
  }

  private onEvent = async (raw: RawBusEvent): Promise<void> => {
    const event = this.normalize(raw);
    enqueueEvent(event);
  };
}

export class ConsumerError extends Error {}

/** Singleton consumer bound to an in-memory bus for tests/dev runtime. */
export const inMemoryBus = new InMemoryEventBus();
export const consumer = new EventBusConsumer(inMemoryBus);