import type { AuditEvent } from "./types.js";
import { store } from "./store.js";

/**
 * Stage 9: audit emission to `AUDIT_EVENT_LOG_URL`.
 *
 * Every notification lifecycle transition (requested / delivered / failed /
 * suppressed) is recorded locally via `store.addAudit` AND emitted to the
 * audit-event-log when `AUDIT_EVENT_LOG_URL` is configured. Tests use the
 * `RecordingAuditEmitter` fake so no external HTTP is required.
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
 * HTTP emitter that POSTs each audit event to AUDIT_EVENT_LOG_URL.
 * Uses the global `fetch` (Node 18+). Failures are swallowed but logged so a
 * downstream outage never blocks the send pipeline.
 */
export class HttpAuditEmitter implements AuditEmitter {
  constructor(private url: string, private fetchImpl: typeof fetch = fetch) {}

  async emit(event: AuditEvent): Promise<void> {
    try {
      const res = await this.fetchImpl(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(event),
      });
      if (!res.ok) {
        console.warn(
          `audit emit non-OK ${res.status} for event ${event.id}`,
        );
      }
    } catch (err) {
      console.warn(`audit emit failed: ${(err as Error).message}`);
    }
  }
}

let activeEmitter: AuditEmitter = new RecordingAuditEmitter();

export function getAuditEmitter(): AuditEmitter {
  return activeEmitter;
}

export function setAuditEmitter(emitter: AuditEmitter): void {
  activeEmitter = emitter;
}

/**
 * Initialize the audit emitter from env. When `AUDIT_EVENT_LOG_URL` is set,
 * use the HTTP emitter; otherwise use the recording fake.
 */
export function initAuditEmitterFromEnv(): AuditEmitter {
  const url = process.env.AUDIT_EVENT_LOG_URL;
  if (url) {
    activeEmitter = new HttpAuditEmitter(url);
  } else {
    activeEmitter = new RecordingAuditEmitter();
  }
  return activeEmitter;
}

/**
 * Record an audit event locally AND emit it to the active emitter.
 * Used by the send pipeline for every lifecycle transition.
 */
export async function recordAudit(event: AuditEvent): Promise<void> {
  store.addAudit(event);
  await activeEmitter.emit(event);
}