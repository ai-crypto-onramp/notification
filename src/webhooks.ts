import crypto from "node:crypto";
import type { PartnerWebhook, RetryPolicy } from "./types.js";
import { store, makeId, newId } from "./store.js";
import { publishToDlq, type DlqSink } from "./dlq.js";

export interface SignedPayload {
  timestamp: string;
  signature: string;
  rawBody: string;
}

export function signWebhookPayload(secret: string, rawBody: string): {
  timestamp: string;
  signature: string;
} {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const sigBase = `${timestamp}.${rawBody}`;
  const signature = crypto.createHmac("sha256", secret).update(sigBase).digest("hex");
  return { timestamp, signature };
}

export function verifyWebhookSignature(
  secret: string,
  rawBody: string,
  timestamp: string,
  signature: string,
  maxAgeSec = 300,
): boolean {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  const age = Math.abs(Date.now() / 1000 - ts);
  if (age > maxAgeSec) return false;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
  try {
    if (expected.length !== signature.length) return false;
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

export const DEFAULT_BACKOFF_MS = [1000, 5000, 30000, 120000, 600000];

export function defaultRetryPolicy(): RetryPolicy {
  return {
    max_attempts: Number(process.env.WEBHOOK_MAX_ATTEMPTS ?? 5),
    backoff_ms: DEFAULT_BACKOFF_MS,
  };
}

export function registerWebhook(input: {
  url: string;
  secret: string;
  event_filters?: PartnerWebhook["event_filters"];
  retry_policy?: RetryPolicy;
}): PartnerWebhook {
  const webhook: PartnerWebhook = {
    id: newId(),
    url: input.url,
    secret: input.secret,
    event_filters: input.event_filters ?? ["*"],
    retry_policy: input.retry_policy ?? defaultRetryPolicy(),
    status: "ACTIVE",
    created_at: new Date().toISOString(),
  };
  store.addWebhook(webhook);
  return webhook;
}

/** Injectable fetch override (tests use this to mock HTTP). */
export type FetchImpl = typeof fetch;
let activeFetch: FetchImpl | null = null;

export function setWebhookFetch(f: FetchImpl | null): void {
  activeFetch = f;
}

export function getWebhookFetch(): FetchImpl {
  return activeFetch ?? fetch;
}

/** Injectable sleep override (tests use fake timers). */
let activeSleep: ((ms: number) => Promise<void>) | null = null;

export function setWebhookSleep(s: ((ms: number) => Promise<void>) | null): void {
  activeSleep = s;
}

function sleep(ms: number): Promise<void> {
  if (activeSleep) return activeSleep(ms);
  return new Promise((r) => setTimeout(r, ms));
}

/** Injectable DLQ sink override (tests inspect DLQ entries). */
let activeDlqSink: DlqSink | null = null;

export function setWebhookDlqSink(s: DlqSink | null): void {
  activeDlqSink = s;
}

/** Tracks DLQ publishes in-process for tests when no real sink is configured. */
export const dlqEntries: Array<{ reason: string; payload: Record<string, unknown> }> = [];

/**
 * Attempt delivery with real HTTP POST + retry/backoff. Retries on 5xx,
 * network errors, and timeouts. On final failure the payload is sent to
 * the DLQ via {@link publishToDlq}.
 */
export async function deliverWithBackoff(
  webhook: PartnerWebhook,
  payload: Record<string, unknown>,
  simulateFailure = false,
): Promise<{ delivered: boolean; attempts: { attempt_no: number; status: string; at: string }[] }> {
  const rawBody = JSON.stringify(payload);
  const maxAttempts = webhook.retry_policy.max_attempts;
  const attempts: { attempt_no: number; status: string; at: string }[] = [];
  let delivered = false;
  let lastError: string | null = null;

  for (let attemptNo = 1; attemptNo <= maxAttempts; attemptNo++) {
    const { timestamp, signature } = signWebhookPayload(webhook.secret, rawBody);
    const at = new Date().toISOString();
    let status = "DELIVERED";
    let ok = false;
    if (simulateFailure) {
      status = "FAILED";
      lastError = "simulated failure";
    } else {
      try {
        const f = getWebhookFetch();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10_000);
        try {
          const resp = await f(webhook.url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Webhook-Timestamp": timestamp,
              "X-Webhook-Signature": signature,
            },
            body: rawBody,
            signal: controller.signal,
          });
          ok = resp.ok;
          status = resp.ok ? "DELIVERED" : "FAILED";
          if (!resp.ok) lastError = `HTTP ${resp.status}`;
        } finally {
          clearTimeout(timer);
        }
      } catch (err) {
        status = "FAILED";
        lastError = (err as Error).message;
      }
    }
    attempts.push({ attempt_no: attemptNo, status, at });
    if (ok && !simulateFailure) {
      delivered = true;
      break;
    }
    if (attemptNo < maxAttempts) {
      const backoff = webhook.retry_policy.backoff_ms[attemptNo - 1] ?? 600000;
      await sleep(backoff);
    }
  }

  const deliveryId = makeId("whdel");
  store.webhookDeliveries.set(deliveryId, attempts);

  if (!delivered) {
    dlqEntries.push({ reason: lastError ?? "webhook delivery failed", payload });
    await publishToDlq(activeDlqSink, {
      event: {
        event_id: String(payload.event_id ?? ""),
        event_type: String(payload.event_type ?? ""),
        user_id: "",
        recipient: webhook.url,
      },
      reason: lastError ?? "webhook delivery failed",
      notification_id: String(payload.notification_id ?? ""),
      channel: "WEBHOOK",
      last_error: lastError ?? undefined,
    });
  }

  return { delivered, attempts };
}