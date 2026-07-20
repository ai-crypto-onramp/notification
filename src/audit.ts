import type { AuditEvent } from "./types.js";
import { store } from "./store.js";
import { createHash, randomUUID } from "node:crypto";

import { Kafka, type Producer } from "kafkajs";

const AUDIT_TOPIC = "audit.v1";

/**
 * Stage 9: audit emission to Kafka topic `audit.v1`.
 *
 * Every notification lifecycle transition (requested / delivered / failed /
 * suppressed) is recorded locally via `store.addAudit` AND emitted to the
 * `audit.v1` Kafka topic in the canonical envelope (see
 * .github/contracts/asyncapi/audit/v1/asyncapi.yaml) when `KAFKA_BROKERS` is
 * configured. Tests use the `RecordingAuditEmitter` fake so no external
 * Kafka is required.
 */

export interface AuditEmitter {
  emit(event: AuditEvent): Promise<void>;
}

/** Emitter that records events in memory (tests / local dev). */
export class RecordingAuditEmitter implements AuditEmitter {
  recorded: AuditEvent[] = [];
  async emit(event: AuditEvent): Promise<void> {
    this.recorded.push(event);
  }
  reset(): void {
    this.recorded = [];
  }
}

/**
 * Kafka emitter publishing the canonical audit.v1 envelope (see
 * .github/contracts/asyncapi/audit/v1/asyncapi.yaml) to the `audit.v1` topic.
 * Failures are swallowed but logged so a Kafka outage never blocks the
 * send pipeline.
 */
export class KafkaAuditEmitter implements AuditEmitter {
  private producer: Producer;

  constructor(brokers: string[]) {
    const kafka = new Kafka({ brokers });
    this.producer = kafka.producer();
  }

  async start(): Promise<void> {
    await this.producer.connect();
  }

  async emit(event: AuditEvent): Promise<void> {
    try {
      const payload = JSON.stringify(event);
      const payloadHash = "sha256:" + createHash("sha256").update(payload).digest("hex");
      const id = event.id || randomUUID();
      const envelope = {
        schema_version: "1",
        id,
        ts: event.created_at,
        source_service: "notification",
        actor_id: "notification",
        action: event.type,
        target_type: "notification",
        target_id: event.notification_id ?? id,
        payload_hash: payloadHash,
        payload: event,
      };
      await this.producer.send({
        topic: AUDIT_TOPIC,
        messages: [{ key: id, value: JSON.stringify(envelope) }],
      });
    } catch (err) {
      console.warn(`audit emit failed: ${(err as Error).message}`);
    }
  }

  async stop(): Promise<void> {
    try {
      await this.producer.disconnect();
    } catch {
      // ignore
    }
  }
}

let activeEmitter: AuditEmitter = new RecordingAuditEmitter();
let activeKafka: KafkaAuditEmitter | null = null;

export function getAuditEmitter(): AuditEmitter {
  return activeEmitter;
}

export function setAuditEmitter(emitter: AuditEmitter): void {
  activeEmitter = emitter;
}

/**
 * Initialize the audit emitter from env. When `KAFKA_BROKERS` is set, use
 * the Kafka emitter; otherwise use the recording fake. When `KAFKA_BROKERS`
 * is unset and DEV_MODE is not `1`, fatally exit.
 */
export function initAuditEmitterFromEnv(): AuditEmitter {
  const brokers = process.env.KAFKA_BROKERS;
  const devMode = process.env.DEV_MODE === "1";
  if (brokers) {
    const kafka = new KafkaAuditEmitter(brokers.split(",").map((s) => s.trim()).filter(Boolean));
    activeKafka = kafka;
    activeEmitter = kafka;
    void kafka.start().catch((err) => {
      console.warn(`audit kafka producer connect failed: ${(err as Error).message}`);
    });
  } else if (devMode) {
    console.warn("KAFKA_BROKERS unset and DEV_MODE=1; audit events recorded in-memory only");
    activeEmitter = new RecordingAuditEmitter();
  } else {
    console.error("KAFKA_BROKERS unset and DEV_MODE not set; cannot start audit producer");
    process.exit(1);
  }
  return activeEmitter;
}

export async function stopAuditEmitter(): Promise<void> {
  if (activeKafka) {
    await activeKafka.stop();
    activeKafka = null;
  }
}

/**
 * Record an audit event locally AND emit it to the active emitter.
 * Used by the send pipeline for every lifecycle transition.
 */
export async function recordAudit(event: AuditEvent): Promise<void> {
  store.addAudit(event);
  await activeEmitter.emit(event);
}