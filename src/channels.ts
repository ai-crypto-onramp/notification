import type {
  Channel,
  ChannelName,
  DeliveryResult,
  NotificationMessage,
  UserPreference,
} from "./types.js";
import { store, makeId } from "./store.js";
import { RateLimiter, envRps } from "./ratelimit.js";
import { signWebhookPayload } from "./webhooks.js";
import {
  type SesProvider,
  type SnsProvider,
  type TwilioProvider,
  type FcmProvider,
  type ApnsProvider,
  StubSesProvider,
  StubSnsProvider,
  StubTwilioProvider,
  StubFcmProvider,
  StubApnsProvider,
  loadSesConfig,
  loadSmsConfig,
  loadFcmConfig,
  loadApnsConfig,
  isUsNumber,
  platformForToken,
  buildPushPayload,
  mapProviderError,
} from "./providers.js";

const rateLimiter = new RateLimiter();
rateLimiter.configure("email", envRps("RATE_LIMIT_EMAIL_RPS", 14));
rateLimiter.configure("sms", envRps("RATE_LIMIT_SMS_RPS", 10));
rateLimiter.configure("push", envRps("RATE_LIMIT_PUSH_RPS", 50));

export function getRateLimiter(): RateLimiter {
  return rateLimiter;
}

function recordAttempt(
  notificationId: string,
  channel: ChannelName,
  provider: string,
  result: DeliveryResult,
  attemptNo = 1,
  error: string | null = null,
): void {
  const now = new Date().toISOString();
  store.addAttempt({
    notification_id: notificationId,
    channel,
    provider,
    provider_message_id: result.provider_message_id,
    status: result.status,
    attempt_no: attemptNo,
    error: error ?? result.error,
    created_at: now,
    updated_at: now,
  });
}

// ---------------------------------------------------------------------------
// Email — SES
// ---------------------------------------------------------------------------

export class EmailChannel implements Channel {
  name: ChannelName = "email";
  private sesConfig = loadSesConfig();

  constructor(private provider: SesProvider = new StubSesProvider()) {}

  setProvider(p: SesProvider): void {
    this.provider = p;
  }

  async send(message: NotificationMessage): Promise<DeliveryResult> {
    await rateLimiter.consume("email");
    let result: DeliveryResult;
    try {
      result = await this.provider.send({
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
        notificationId: message.notification_id,
      });
      if (!result.provider) result.provider = "ses";
    } catch (err) {
      result = mapProviderError("ses", err);
    }
    recordAttempt(message.notification_id, this.name, result.provider, result);
    return result;
  }
  verifyPreference(pref: UserPreference): boolean {
    return pref.channels.email === true;
  }

  fromAddress(): string {
    return this.sesConfig.from;
  }
}

// ---------------------------------------------------------------------------
// SMS — SNS (US) / Twilio (international)
// ---------------------------------------------------------------------------

export class SmsChannel implements Channel {
  name: ChannelName = "sms";
  private smsConfig = loadSmsConfig();

  constructor(
    private sns: SnsProvider = new StubSnsProvider(),
    private twilio: TwilioProvider = new StubTwilioProvider(),
  ) {}

  setProviders(sns: SnsProvider, twilio: TwilioProvider): void {
    this.sns = sns;
    this.twilio = twilio;
  }

  async send(message: NotificationMessage): Promise<DeliveryResult> {
    await rateLimiter.consume("sms");
    const us = isUsNumber(message.to);
    let result: DeliveryResult;
    try {
      result = us
        ? await this.sns.send({
            to: message.to,
            body: message.short,
            notificationId: message.notification_id,
          })
        : await this.twilio.send({
            to: message.to,
            body: message.short,
            notificationId: message.notification_id,
          });
      if (!result.provider) result.provider = us ? "sns" : "twilio";
    } catch (err) {
      result = mapProviderError(us ? "sns" : "twilio", err);
    }
    recordAttempt(message.notification_id, this.name, result.provider, result);
    return result;
  }
  verifyPreference(pref: UserPreference): boolean {
    return pref.channels.sms === true;
  }

  config(): SmsConfigView {
    return {
      snsRegion: this.smsConfig.snsRegion,
      twilioFrom: this.smsConfig.twilioFrom,
    };
  }
}

export interface SmsConfigView {
  snsRegion: string;
  twilioFrom: string;
}

// ---------------------------------------------------------------------------
// Push — FCM (Android) / APNS (iOS)
// ---------------------------------------------------------------------------

export class PushChannel implements Channel {
  name: ChannelName = "push";
  private fcmConfig = loadFcmConfig();
  private apnsConfig = loadApnsConfig();

  // token registry: user_id -> device tokens (tests can populate this).
  private devices = new Map<string, { token: string; platform: "android" | "ios" }[]>();

  constructor(
    private fcm: FcmProvider = new StubFcmProvider(),
    private apns: ApnsProvider = new StubApnsProvider(),
  ) {}

  setProviders(fcm: FcmProvider, apns: ApnsProvider): void {
    this.fcm = fcm;
    this.apns = apns;
  }

  /** Register a device token for a recipient (user id or device id). */
  registerDevice(recipient: string, token: string): void {
    const platform = platformForToken(token);
    const list = this.devices.get(recipient) ?? [];
    if (!list.some((d) => d.token === token)) list.push({ token, platform });
    this.devices.set(recipient, list);
  }

  resolveTokens(recipient: string): { token: string; platform: "android" | "ios" }[] {
    return this.devices.get(recipient) ?? [];
  }

  async send(message: NotificationMessage): Promise<DeliveryResult> {
    await rateLimiter.consume("push");
    const devices = this.resolveTokens(message.to);
    if (devices.length === 0) {
      const result: DeliveryResult = {
        provider: "fcm",
        provider_message_id: "",
        status: "failed",
        error: "no device token for recipient",
      };
      recordAttempt(message.notification_id, this.name, "fcm", result);
      return result;
    }
    let last: DeliveryResult | null = null;
    for (const device of devices) {
      const input = {
        token: device.token,
        platform: device.platform,
        title: message.subject || message.event_type,
        body: message.short,
        data: { event_type: message.event_type },
        notificationId: message.notification_id,
      };
      void buildPushPayload(input);
      let result: DeliveryResult;
      try {
        result =
          device.platform === "ios"
            ? await this.apns.send(input)
            : await this.fcm.send(input);
        if (!result.provider) result.provider = device.platform === "ios" ? "apns" : "fcm";
      } catch (err) {
        result = mapProviderError(device.platform === "ios" ? "apns" : "fcm", err);
      }
      recordAttempt(message.notification_id, this.name, result.provider, result);
      last = result;
    }
    return last!;
  }
  verifyPreference(pref: UserPreference): boolean {
    return pref.channels.push === true;
  }

  fcmKey(): string {
    return this.fcmConfig.key;
  }
  apnsBundle(): string {
    return this.apnsConfig.bundleId;
  }
}

// ---------------------------------------------------------------------------
// Webhook — signed HTTP POST with batch coalescing (Stage 7)
// ---------------------------------------------------------------------------

export interface WebhookSendOptions {
  webhookId?: string;
  url?: string;
  secret?: string;
  simulateFailure?: boolean;
}

const BATCH_WINDOW_MS = Number(process.env.WEBHOOK_BATCH_WINDOW_MS ?? 1000);

interface PendingBatch {
  timer: NodeJS.Timeout | null;
  items: { message: NotificationMessage; resolve: (r: DeliveryResult) => void }[];
}

export class WebhookChannel implements Channel {
  name: ChannelName = "webhook";
  private batches = new Map<string, PendingBatch>();

  async send(
    message: NotificationMessage,
    opts: WebhookSendOptions = {},
  ): Promise<DeliveryResult> {
    const webhook =
      (opts.webhookId && store.getWebhook(opts.webhookId)) ||
      store.listWebhooks()[0];
    const url = opts.url ?? webhook?.url ?? "memory://webhook";
    const secret = opts.secret ?? webhook?.secret ?? "stub-secret";
    const provider = "webhook-stub";
    const batchKey = webhook?.id ?? url;

    // When batching is disabled (window <= 0) send immediately.
    if (BATCH_WINDOW_MS <= 0) {
      return this.deliverOne(message, provider, url, secret, opts.simulateFailure);
    }

    return new Promise<DeliveryResult>((resolve) => {
      let batch = this.batches.get(batchKey);
      if (!batch) {
        batch = { timer: null, items: [] };
        this.batches.set(batchKey, batch);
      }
      batch.items.push({ message, resolve });
      if (batch.timer) return;
      batch.timer = setTimeout(() => {
        const b = this.batches.get(batchKey);
        if (!b) return;
        this.batches.delete(batchKey);
        b.timer = null;
        void this.flushBatch(batchKey, b, provider, url, secret, opts);
      }, BATCH_WINDOW_MS);
    });
  }

  private async flushBatch(
    batchKey: string,
    batch: PendingBatch,
    provider: string,
    url: string,
    secret: string,
    opts: WebhookSendOptions,
  ): Promise<void> {
    const items = batch.items;
    // Coalesce: build a single payload containing all notifications.
    const coalesced = {
      event_type: items[0].message.event_type,
      notifications: items.map((i) => ({
        notification_id: i.message.notification_id,
        subject: i.message.subject,
        text: i.message.text,
        short: i.message.short,
      })),
    };
    const rawBody = JSON.stringify(coalesced);
    const { signature, timestamp } = signWebhookPayload(secret, rawBody);
    void url;
    void signature;
    void timestamp;
    const provider_message_id = `webhook_${makeId("msg")}`;
    const status: DeliveryResult["status"] = opts.simulateFailure ? "failed" : "delivered";
    // Record a single delivery attempt for the batch (per partner window).
    store.webhookDeliveries.set(provider_message_id, [
      { attempt_no: 1, status, at: new Date().toISOString() },
    ]);
    for (const item of items) {
      const result: DeliveryResult = {
        provider,
        provider_message_id,
        status,
        error: opts.simulateFailure ? "batch failed" : null,
      };
      recordAttempt(item.message.notification_id, this.name, provider, result, 1);
      item.resolve(result);
    }
    void batchKey;
  }

  private async deliverOne(
    message: NotificationMessage,
    provider: string,
    url: string,
    secret: string,
    simulateFailure?: boolean,
  ): Promise<DeliveryResult> {
    const payload = JSON.stringify({
      event_type: message.event_type,
      notification_id: message.notification_id,
      subject: message.subject,
      text: message.text,
      short: message.short,
    });
    const { signature, timestamp } = signWebhookPayload(secret, payload);
    void url;
    void signature;
    void timestamp;
    const provider_message_id = `webhook_${makeId("msg")}`;
    const result: DeliveryResult = {
      provider,
      provider_message_id,
      status: simulateFailure ? "failed" : "delivered",
      error: simulateFailure ? "failed" : null,
    };
    recordAttempt(message.notification_id, this.name, provider, result, 1);
    store.webhookDeliveries.set(provider_message_id, [
      { attempt_no: 1, status: result.status, at: new Date().toISOString() },
    ]);
    return result;
  }

  verifyPreference(pref: UserPreference): boolean {
    return pref.channels.webhook === true;
  }
}

// ---------------------------------------------------------------------------
// Singletons + lookup
// ---------------------------------------------------------------------------

export const emailChannel = new EmailChannel();
export const smsChannel = new SmsChannel();
export const pushChannel = new PushChannel();
export const webhookChannel = new WebhookChannel();

export function channelByName(name: ChannelName): Channel {
  switch (name) {
    case "email":
      return emailChannel;
    case "sms":
      return smsChannel;
    case "push":
      return pushChannel;
    case "webhook":
      return webhookChannel;
  }
}