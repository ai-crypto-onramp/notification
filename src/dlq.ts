/**
 * DLQ: on final delivery failure, publish the failed notification + last
 * error to the notification.dlq Kafka topic. When Kafka isn't configured
 * (DEV_MODE) the failure is logged to stderr instead.
 */

export interface DlqEntry {
  event: { event_id: string; event_type: string; user_id: string; recipient: string; data?: Record<string, unknown> } | null;
  reason: string;
  notification_id?: string;
  channel?: string;
  last_error?: string;
  failed_at: string;
}

export interface DlqSink {
  send(entry: DlqEntry): Promise<void>;
}

const DLQ_TOPIC = process.env.DLQ_TOPIC ?? "notification.dlq";

let activeSink: DlqSink | null = null;

export function setDlqSink(sink: DlqSink | null): void {
  activeSink = sink;
}

/** Publish a failed delivery to the DLQ. Falls back to stderr if no sink. */
export async function publishToDlq(
  sink: DlqSink | null,
  payload: { event: DlqEntry["event"]; reason: string; notification_id?: string; channel?: string; last_error?: string },
): Promise<void> {
  const entry: DlqEntry = {
    event: payload.event,
    reason: payload.reason,
    notification_id: payload.notification_id,
    channel: payload.channel,
    last_error: payload.last_error,
    failed_at: new Date().toISOString(),
  };
  const target = sink ?? activeSink;
  if (target) {
    try {
      await target.send(entry);
      return;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`DLQ send failed (${DLQ_TOPIC}):`, (err as Error).message, entry);
    }
  } else {
    // eslint-disable-next-line no-console
    console.error(`[DLQ:${DLQ_TOPIC}]`, JSON.stringify(entry));
  }
}

/** Default Kafka-backed sink. Wraps a KafkaBus-like producer. */
export class KafkaDlqSink implements DlqSink {
  constructor(private bus: { _send(topic: string, value: Record<string, unknown>): Promise<void> }) {}
  async send(entry: DlqEntry): Promise<void> {
    await this.bus._send(DLQ_TOPIC, entry as unknown as Record<string, unknown>);
  }
}

export function dlqTopic(): string {
  return DLQ_TOPIC;
}