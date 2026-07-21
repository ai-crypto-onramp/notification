import { Kafka, type Consumer, type Producer } from "kafkajs";
import type { EventBusClient, RawBusEvent } from "./consumer.js";
import type { EventType } from "./types.js";
import { KafkaDlqSink, publishToDlq } from "./dlq.js";

/**
 * kafkajs-backed EventBusClient. Subscribes to the notification.v1 topic
 * (or EVENT_BUS_TOPIC) with the configured consumer group and emits each
 * parsed JSON message to the handler. Production failures are sent to the
 * notification.dlq topic via the shared kafkajs producer.
 */
export interface KafkaBusOptions {
  brokers: string[];
  topic?: string;
  clientId?: string;
}

export class KafkaBus implements EventBusClient {
  private kafka: Kafka;
  private consumer?: Consumer;
  private producer?: Producer;
  private topic: string;
  private clientId: string;
  private _subscribed = false;
  private _lag = 0;
  private handler?: (e: RawBusEvent) => Promise<void>;
  private group = "";
  private brokers: string[];
  private dlqSink: KafkaDlqSink;

  constructor(opts: KafkaBusOptions) {
    this.brokers = opts.brokers;
    this.kafka = new Kafka({
      brokers: opts.brokers,
      clientId: opts.clientId ?? process.env.KAFKA_CLIENT_ID ?? "notification",
    });
    this.topic = opts.topic ?? process.env.EVENT_BUS_TOPIC ?? "notification.v1";
    this.clientId = opts.clientId ?? "notification";
    this.dlqSink = new KafkaDlqSink(this);
  }

  async subscribe(
    group: string,
    events: EventType[],
    handler: (e: RawBusEvent) => Promise<void>,
  ): Promise<void> {
    this.group = group;
    this.handler = handler;
    this.consumer = this.kafka.consumer({ groupId: group });
    this.producer = this.kafka.producer();
    await this.producer.connect();
    await this.consumer.connect();
    await this.consumer.subscribe({ topic: this.topic, fromBeginning: true });
    this._subscribed = true;
    void this.consumer.run({
      eachMessage: async ({ message }) => {
        if (!message.value) return;
        let raw: RawBusEvent;
        try {
          raw = JSON.parse(message.value.toString()) as RawBusEvent;
        } catch (err) {
          await publishToDlq(this.dlqSink, { event: null, reason: `json parse: ${(err as Error).message}` });
          return;
        }
        if (events.length && !events.includes(raw.event_type as EventType)) return;
        this._lag += 1;
        try {
          await handler(raw);
        } catch (err) {
          await publishToDlq(this.dlqSink, { event: raw, reason: (err as Error).message });
        } finally {
          this._lag -= 1;
        }
      },
    });
  }

  async unsubscribe(): Promise<void> {
    this._subscribed = false;
    try {
      await this.consumer?.disconnect();
    } catch { /* ignore */ }
    try {
      await this.producer?.disconnect();
    } catch { /* ignore */ }
    this.handler = undefined;
  }

  lag(): number {
    return this._lag;
  }

  subscribed(): boolean {
    return this._subscribed;
  }

  describe(): string {
    return `kafka://${this.brokers.join(",")}/${this.topic}?group=${this.group || "none"}`;
  }

  /** Internal: send a raw payload to a topic (used by dlq.ts). */
  async _send(topic: string, value: Record<string, unknown>): Promise<void> {
    if (!this.producer) {
      this.producer = this.kafka.producer();
      await this.producer.connect();
    }
    await this.producer.send({
      topic,
      messages: [{ value: JSON.stringify(value) }],
    });
  }
}