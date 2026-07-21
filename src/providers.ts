import { envRps } from "./ratelimit.js";
import type { DeliveryResult } from "./types.js";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import twilio from "twilio";
import * as admin from "firebase-admin";
import { getMessaging } from "firebase-admin/messaging";
import apn from "@parse/node-apn";
import { readFileSync } from "node:fs";

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

/** Real SES provider backed by @aws-sdk/client-ses. */
export class RealSesProvider implements SesProvider {
  private client: SESClient;
  constructor(cfg: SesConfig) {
    this.client = new SESClient({ region: cfg.region });
  }
  async send(input: SesSendInput): Promise<DeliveryResult> {
    try {
      const cmd = new SendEmailCommand({
        Source: loadSesConfig().from,
        Destination: { ToAddresses: [input.to] },
        Message: {
          Subject: { Data: input.subject },
          Body: {
            Text: { Data: input.text },
            Html: { Data: input.html },
          },
        },
      });
      const res = await this.client.send(cmd);
      return {
        provider: "ses",
        provider_message_id: res.MessageId ?? "",
        status: "DELIVERED",
        error: null,
      };
    } catch (err) {
      return mapProviderError("ses", err);
    }
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

/** Real SNS SMS provider backed by @aws-sdk/client-sns. */
export class RealSnsProvider implements SnsProvider {
  private client: SNSClient;
  constructor(region: string) {
    this.client = new SNSClient({ region });
  }
  async send(input: SmsSendInput): Promise<DeliveryResult> {
    try {
      const cmd = new PublishCommand({
        PhoneNumber: input.to,
        Message: input.body,
      });
      const res = await this.client.send(cmd);
      return {
        provider: "sns",
        provider_message_id: res.MessageId ?? "",
        status: "DELIVERED",
        error: null,
      };
    } catch (err) {
      return mapProviderError("sns", err);
    }
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

/** Real Twilio SMS provider. */
export class RealTwilioProvider implements TwilioProvider {
  private client: twilio.Twilio;
  private from: string;
  constructor(cfg: SmsConfig) {
    this.client = twilio(cfg.twilioSid, cfg.twilioToken);
    this.from = cfg.twilioFrom;
  }
  async send(input: SmsSendInput): Promise<DeliveryResult> {
    try {
      const res = await this.client.messages.create({
        to: input.to,
        from: this.from,
        body: input.body,
      });
      return {
        provider: "twilio",
        provider_message_id: res.sid ?? "",
        status: "DELIVERED",
        error: null,
      };
    } catch (err) {
      return mapProviderError("twilio", err);
    }
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

/** Real FCM provider backed by firebase-admin. */
export class RealFcmProvider implements FcmProvider {
  private app: admin.App;
  constructor(cfg: FcmConfig) {
    if (process.env.FCM_KEY_PATH) {
      const raw = readFileSync(process.env.FCM_KEY_PATH, "utf8");
      this.app = admin.initializeApp({ credential: admin.cert(JSON.parse(raw)) });
    } else {
      this.app = admin.initializeApp({ credential: admin.cert(JSON.parse(cfg.key)) });
    }
  }
  async send(input: PushSendInput): Promise<DeliveryResult> {
    try {
      const res = await getMessaging(this.app).send({
        notification: { title: input.title, body: input.body },
        token: input.token,
        data: { notification_id: input.notificationId },
      });
      return {
        provider: "fcm",
        provider_message_id: res,
        status: "DELIVERED",
        error: null,
      };
    } catch (err) {
      return mapProviderError("fcm", err);
    }
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

/** Real APNS provider backed by @parse/node-apn. */
export class RealApnsProvider implements ApnsProvider {
  private provider: apn.Provider;
  private bundleId: string;
  constructor(cfg: ApnsConfig) {
    this.provider = new apn.Provider({
      token: {
        key: readFileSync(cfg.privateKeyPath),
        keyId: cfg.keyId,
        teamId: cfg.teamId,
      },
    });
    this.bundleId = cfg.bundleId;
  }
  async send(input: PushSendInput): Promise<DeliveryResult> {
    try {
      const notification = new apn.Notification();
      notification.topic = this.bundleId;
      notification.alert = { title: input.title, body: input.body };
      notification.payload = input.data ?? {};
      const res = await this.provider.send(notification, input.token);
      if (res.failed && res.failed.length > 0) {
        const f = res.failed[0];
        return mapProviderError("apns", new Error(f.status ? String(f.status) : "apns failed"));
      }
      return {
        provider: "apns",
        provider_message_id: input.token.slice(0, 8),
        status: "DELIVERED",
        error: null,
      };
    } catch (err) {
      return mapProviderError("apns", err);
    }
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
    kafkaBrokers: process.env.KAFKA_BROKERS ?? "",
  };
}

// ---------------------------------------------------------------------------
// Provider factory: real SDK clients when env vars are set, stubs in DEV_MODE,
// fatal at startup otherwise. Mirrors the Phase 0 convention.
// ---------------------------------------------------------------------------

export interface ProviderLogger {
  warn(msg: string): void;
  error(msg: string): void;
  info(msg: string): void;
}

export interface ProviderBundle {
  ses: SesProvider;
  sns: SnsProvider;
  twilio: TwilioProvider;
  fcm: FcmProvider;
  apns: ApnsProvider;
}

export interface ProviderFactoryOptions {
  devMode?: boolean;
  logger?: ProviderLogger;
  /** Override env reads (for tests). */
  env?: Record<string, string | undefined>;
}

function envOr(opt: ProviderFactoryOptions, key: string): string | undefined {
  if (opt.env) return opt.env[key];
  return process.env[key];
}

function fatalMissing(opt: ProviderFactoryOptions, name: string, envs: string[]): never {
  const msg = `Missing ${name} configuration (${envs.join(", ")}); refusing to start in production mode. Set DEV_MODE=1 to use stubs.`;
  if (opt.logger) opt.logger.error(msg);
  else console.error(msg);
  process.exit(1);
}

/** Build the provider bundle from env. */
export function createProviders(opt: ProviderFactoryOptions = {}): ProviderBundle {
  const devMode = opt.devMode ?? process.env.DEV_MODE === "1";
  const log = opt.logger ?? console;

  // SES: needs SES_FROM (region defaults).
  const sesFrom = envOr(opt, "SES_FROM");
  if (sesFrom) {
    const region = envOr(opt, "SES_REGION") ?? "us-east-1";
    log.info?.(`SES provider: real (region=${region})`);
  } else if (devMode) {
    log.warn("DEV_MODE=1: SES_FROM unset — using StubSesProvider (NOT FOR PRODUCTION)");
  } else {
    fatalMissing(opt, "SES", ["SES_FROM"]);
  }
  const ses: SesProvider = sesFrom ? new RealSesProvider({ region: envOr(opt, "SES_REGION") ?? "us-east-1", from: sesFrom }) : new StubSesProvider();

  // SNS: uses SNS_REGION (defaults), always available when AWS creds are present.
  // We treat SNS as available when SNS_REGION is explicitly set OR devMode.
  const snsRegion = envOr(opt, "SNS_REGION");
  const sns: SnsProvider = snsRegion
    ? new RealSnsProvider(snsRegion)
    : (devMode ? new StubSnsProvider() : fatalMissing(opt, "SNS", ["SNS_REGION"]));

  // Twilio: needs TWILIO_SID + TWILIO_TOKEN + TWILIO_FROM.
  const twilioSid = envOr(opt, "TWILIO_SID");
  const twilioToken = envOr(opt, "TWILIO_TOKEN");
  const twilioFrom = envOr(opt, "TWILIO_FROM");
  const twilio: TwilioProvider = (twilioSid && twilioToken && twilioFrom)
    ? new RealTwilioProvider({
        twilioSid,
        twilioToken,
        twilioFrom,
        snsRegion: snsRegion ?? "us-east-1",
      })
    : (devMode ? new StubTwilioProvider() : fatalMissing(opt, "Twilio", ["TWILIO_SID", "TWILIO_TOKEN", "TWILIO_FROM"]));

  // FCM: needs FCM_KEY or FCM_KEY_PATH.
  const fcmKey = envOr(opt, "FCM_KEY");
  const fcmKeyPath = envOr(opt, "FCM_KEY_PATH");
  const fcm: FcmProvider = (fcmKey || fcmKeyPath)
    ? new RealFcmProvider({ key: fcmKey ?? "" })
    : (devMode ? new StubFcmProvider() : fatalMissing(opt, "FCM", ["FCM_KEY", "FCM_KEY_PATH"]));

  // APNS: needs APNS_TEAM_ID + APNS_KEY_ID + APNS_PRIVATE_KEY_PATH (bundle defaults).
  const apnsTeamId = envOr(opt, "APNS_TEAM_ID");
  const apnsKeyId = envOr(opt, "APNS_KEY_ID");
  const apnsKeyPath = envOr(opt, "APNS_PRIVATE_KEY_PATH");
  const apns: ApnsProvider = (apnsTeamId && apnsKeyId && apnsKeyPath)
    ? new RealApnsProvider({
        teamId: apnsTeamId,
        keyId: apnsKeyId,
        privateKeyPath: apnsKeyPath,
        bundleId: envOr(opt, "APNS_BUNDLE_ID") ?? "com.example.onramp",
      })
    : (devMode ? new StubApnsProvider() : fatalMissing(opt, "APNS", ["APNS_TEAM_ID", "APNS_KEY_ID", "APNS_PRIVATE_KEY_PATH"]));

  return { ses, sns, twilio, fcm, apns };
}