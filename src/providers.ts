import { envRps } from "./ratelimit.js";
import type { DeliveryResult } from "./types.js";

/**
 * Stage 5 / 6: provider interfaces + config loaders + error mapping.
 *
 * Each external provider (SES, SNS, Twilio, FCM, APNS) is abstracted behind a
 * small interface so the runtime can wire the real SDK clients while tests use
 * the in-memory stub implementations. `mapProviderError` normalizes provider
 * failures into a `DeliveryResult` with an attempt status.
 */

// ---------------------------------------------------------------------------
// Email — Amazon SES
// ---------------------------------------------------------------------------

export interface SesConfig {
  region: string;
  from: string;
}

export interface SesSendInput {
  to: string;
  subject: string;
  text: string;
  html: string;
  notificationId: string;
}

export interface SesProvider {
  send(input: SesSendInput): Promise<DeliveryResult>;
}

export function loadSesConfig(): SesConfig {
  return {
    region: process.env.SES_REGION ?? "us-east-1",
    from: process.env.SES_FROM ?? "no-reply@onramp.example",
  };
}

/** Stub SES provider used in tests and as the default fallback. */
export class StubSesProvider implements SesProvider {
  sent: SesSendInput[] = [];
  fail = false;
  async send(input: SesSendInput): Promise<DeliveryResult> {
    this.sent.push(input);
    if (this.fail) return mapProviderError("ses", new Error("SES throttled"));
    return {
      provider: "ses",
      provider_message_id: `email_${input.notificationId}_${this.sent.length}`,
      status: "DELIVERED",
      error: null,
    };
  }
}

// ---------------------------------------------------------------------------
// SMS — Amazon SNS (US) / Twilio (international)
// ---------------------------------------------------------------------------

export interface SmsConfig {
  snsRegion: string;
  twilioSid: string;
  twilioToken: string;
  twilioFrom: string;
}

export interface SmsSendInput {
  to: string;
  body: string;
  notificationId: string;
}

export interface SnsProvider {
  send(input: SmsSendInput): Promise<DeliveryResult>;
}
export interface TwilioProvider {
  send(input: SmsSendInput): Promise<DeliveryResult>;
}

export function loadSmsConfig(): SmsConfig {
  return {
    snsRegion: process.env.SNS_REGION ?? "us-east-1",
    twilioSid: process.env.TWILIO_SID ?? "",
    twilioToken: process.env.TWILIO_TOKEN ?? "",
    twilioFrom: process.env.TWILIO_FROM ?? "",
  };
}

/** US (+1) numbers route through SNS; international through Twilio. */
export function isUsNumber(to: string): boolean {
  return /^\+1\d{10}$/.test(to.trim());
}

export class StubSnsProvider implements SnsProvider {
  sent: SmsSendInput[] = [];
  async send(input: SmsSendInput): Promise<DeliveryResult> {
    this.sent.push(input);
    return {
      provider: "sns",
      provider_message_id: `sms_${input.notificationId}_${this.sent.length}`,
      status: "DELIVERED",
      error: null,
    };
  }
}

export class StubTwilioProvider implements TwilioProvider {
  sent: SmsSendInput[] = [];
  async send(input: SmsSendInput): Promise<DeliveryResult> {
    this.sent.push(input);
    return {
      provider: "twilio",
      provider_message_id: `sms_${input.notificationId}_${this.sent.length}`,
      status: "DELIVERED",
      error: null,
    };
  }
}

// ---------------------------------------------------------------------------
// Push — FCM (Android) / APNS (iOS)
// ---------------------------------------------------------------------------

export interface FcmConfig {
  key: string;
}
export interface ApnsConfig {
  teamId: string;
  keyId: string;
  privateKeyPath: string;
  bundleId: string;
}

export type PushPlatform = "android" | "ios";

export interface PushSendInput {
  token: string;
  platform: PushPlatform;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  notificationId: string;
}

export interface FcmProvider {
  send(input: PushSendInput): Promise<DeliveryResult>;
}
export interface ApnsProvider {
  send(input: PushSendInput): Promise<DeliveryResult>;
}

export function loadFcmConfig(): FcmConfig {
  return { key: process.env.FCM_KEY ?? "" };
}
export function loadApnsConfig(): ApnsConfig {
  return {
    teamId: process.env.APNS_TEAM_ID ?? "",
    keyId: process.env.APNS_KEY_ID ?? "",
    privateKeyPath: process.env.APNS_PRIVATE_KEY_PATH ?? "",
    bundleId: process.env.APNS_BUNDLE_ID ?? "com.example.onramp",
  };
}

/** Resolve the platform from a device token heuristically. */
export function platformForToken(token: string): PushPlatform {
  // APNS tokens are 64 hex chars; FCM tokens are longer and varied.
  return /^[0-9a-fA-F]{64}$/.test(token) ? "ios" : "android";
}

/**
 * Build the platform-specific payload. FCM uses a `notification`/`data`
 * envelope; APNS uses an `aps` envelope.
 */
export function buildPushPayload(
  input: PushSendInput,
): Record<string, unknown> {
  if (input.platform === "ios") {
    return {
      aps: { alert: { title: input.title, body: input.body }, sound: "default" },
      data: input.data ?? {},
      notification_id: input.notificationId,
    };
  }
  return {
    message: {
      token: input.token,
      notification: { title: input.title, body: input.body },
      data: { ...(input.data ?? {}), notification_id: input.notificationId },
    },
  };
}

export class StubFcmProvider implements FcmProvider {
  sent: PushSendInput[] = [];
  async send(input: PushSendInput): Promise<DeliveryResult> {
    this.sent.push(input);
    return {
      provider: "fcm",
      provider_message_id: `push_${input.notificationId}_${this.sent.length}`,
      status: "DELIVERED",
      error: null,
    };
  }
}

export class StubApnsProvider implements ApnsProvider {
  sent: PushSendInput[] = [];
  async send(input: PushSendInput): Promise<DeliveryResult> {
    this.sent.push(input);
    return {
      provider: "apns",
      provider_message_id: `push_${input.notificationId}_${this.sent.length}`,
      status: "DELIVERED",
      error: null,
    };
  }
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

const ERROR_STATUS_MAP: Record<string, DeliveryResult["status"]> = {
  // SES / SNS / Twilio
  throttled: "THROTTLED",
  throttling: "THROTTLED",
  "throttling.rate": "THROTTLED",
  "account.throttled": "THROTTLED",
  invalid: "BOUNCED",
  "invalid.parameter": "BOUNCED",
  "invalid.parameter.value": "BOUNCED",
  // Push
  "invalid registration": "BOUNCED",
  "notregistered": "BOUNCED",
  unregistered: "BOUNCED",
  "invalid-token": "BOUNCED",
};

export function mapProviderError(
  provider: string,
  err: unknown,
): DeliveryResult {
  const message = (err as Error).message ?? String(err);
  const lower = message.toLowerCase();
  let status: DeliveryResult["status"] = "FAILED";
  for (const key of Object.keys(ERROR_STATUS_MAP)) {
    if (lower.includes(key.toLowerCase())) {
      status = ERROR_STATUS_MAP[key];
      break;
    }
  }
  return {
    provider,
    provider_message_id: "",
    status,
    error: message,
  };
}

// ---------------------------------------------------------------------------
// Config summary (for /healthz output and tests)
// ---------------------------------------------------------------------------

export interface RateLimitConfig {
  email: number;
  sms: number;
  push: number;
  webhookMaxAttempts: number;
}

export function loadRateLimitConfig(): RateLimitConfig {
  return {
    email: envRps("RATE_LIMIT_EMAIL_RPS", 14),
    sms: envRps("RATE_LIMIT_SMS_RPS", 10),
    push: envRps("RATE_LIMIT_PUSH_RPS", 50),
    webhookMaxAttempts: Number(process.env.WEBHOOK_MAX_ATTEMPTS ?? 5),
  };
}

export function loadWebhookDefaults() {
  return {
    maxAttempts: Number(process.env.WEBHOOK_MAX_ATTEMPTS ?? 5),
    batchWindowMs: Number(process.env.WEBHOOK_BATCH_WINDOW_MS ?? 1000),
    defaultSecret: process.env.PARTNER_WEBHOOK_SECRET ?? "",
    auditUrl: process.env.AUDIT_EVENT_LOG_URL ?? "",
  };
}