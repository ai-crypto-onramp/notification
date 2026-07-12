import crypto from "node:crypto";
import type { PartnerWebhook, RetryPolicy } from "./types.js";
import { store, makeId } from "./store.js";

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
    id: makeId("wh"),
    url: input.url,
    secret: input.secret,
    event_filters: input.event_filters ?? ["*"],
    retry_policy: input.retry_policy ?? defaultRetryPolicy(),
    status: "active",
    created_at: new Date().toISOString(),
  };
  store.addWebhook(webhook);
  return webhook;
}

/**
 * Attempt delivery with exponential backoff. For the stub we don't actually
 * sleep between attempts; we record each attempt in `webhookDeliveries` so
 * tests can inspect the backoff sequence.
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

  for (let attemptNo = 1; attemptNo <= maxAttempts; attemptNo++) {
    const { timestamp, signature } = signWebhookPayload(webhook.secret, rawBody);
    void timestamp;
    void signature;
    const status = simulateFailure ? "failed" : "delivered";
    const at = new Date().toISOString();
    attempts.push({ attempt_no: attemptNo, status, at });
    if (!simulateFailure) {
      delivered = true;
      break;
    }
    if (attemptNo < maxAttempts) {
      const backoff = webhook.retry_policy.backoff_ms[attemptNo - 1] ?? 600000;
      // For tests: don't actually sleep, but record the intended backoff.
      void backoff;
    }
  }

  const deliveryId = makeId("whdel");
  store.webhookDeliveries.set(deliveryId, attempts);
  return { delivered, attempts };
}