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

const rateLimiter = new RateLimiter();
rateLimiter.configure("email", envRps("RATE_LIMIT_EMAIL_RPS", 10));
rateLimiter.configure("sms", envRps("RATE_LIMIT_SMS_RPS", 5));
rateLimiter.configure("push", envRps("RATE_LIMIT_PUSH_RPS", 20));

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

export class EmailChannel implements Channel {
  name: ChannelName = "email";
  async send(message: NotificationMessage): Promise<DeliveryResult> {
    await rateLimiter.consume("email");
    const provider = "ses-stub";
    const provider_message_id = `email_${makeId("msg")}`;
    const result: DeliveryResult = {
      provider,
      provider_message_id,
      status: "delivered",
      error: null,
    };
    recordAttempt(message.notification_id, this.name, provider, result);
    return result;
  }
  verifyPreference(pref: UserPreference): boolean {
    return pref.channels.email === true;
  }
}

export class SmsChannel implements Channel {
  name: ChannelName = "sms";
  async send(message: NotificationMessage): Promise<DeliveryResult> {
    await rateLimiter.consume("sms");
    const provider = "sns-stub";
    const provider_message_id = `sms_${makeId("msg")}`;
    const result: DeliveryResult = {
      provider,
      provider_message_id,
      status: "delivered",
      error: null,
    };
    recordAttempt(message.notification_id, this.name, provider, result);
    return result;
  }
  verifyPreference(pref: UserPreference): boolean {
    return pref.channels.sms === true;
  }
}

export class PushChannel implements Channel {
  name: ChannelName = "push";
  async send(message: NotificationMessage): Promise<DeliveryResult> {
    await rateLimiter.consume("push");
    const provider = "fcm-stub";
    const provider_message_id = `push_${makeId("msg")}`;
    const result: DeliveryResult = {
      provider,
      provider_message_id,
      status: "delivered",
      error: null,
    };
    recordAttempt(message.notification_id, this.name, provider, result);
    return result;
  }
  verifyPreference(pref: UserPreference): boolean {
    return pref.channels.push === true;
  }
}

export interface WebhookSendOptions {
  webhookId?: string;
  url?: string;
  secret?: string;
}

export class WebhookChannel implements Channel {
  name: ChannelName = "webhook";
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
    const payload = JSON.stringify({
      event_type: message.event_type,
      notification_id: message.notification_id,
      subject: message.subject,
      text: message.text,
      short: message.short,
    });
    const { signature, timestamp } = signWebhookPayload(secret, payload);

    // Record delivery attempt without real HTTP for tests; deliver synchronously.
    const provider_message_id = `webhook_${makeId("msg")}`;
    const result: DeliveryResult = {
      provider,
      provider_message_id,
      status: "delivered",
      error: null,
    };
    recordAttempt(message.notification_id, this.name, provider, result, 1);

    // Track webhook delivery signature for verification in tests.
    const deliveryId = provider_message_id;
    store.webhookDeliveries.set(deliveryId, [
      {
        attempt_no: 1,
        status: "delivered",
        at: new Date().toISOString(),
      },
    ]);
    void url;
    void signature;
    void timestamp;
    return result;
  }
  verifyPreference(pref: UserPreference): boolean {
    return pref.channels.webhook === true;
  }
}

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