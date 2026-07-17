export type ChannelName = "EMAIL" | "SMS" | "PUSH" | "WEBHOOK";

export type EventType =
  | "tx.created"
  | "payment.captured"
  | "tx.signed"
  | "tx.confirmed"
  | "tx.failed"
  | "tx.refunded"
  | "chain.confirmed";

export type NotificationStatus =
  | "PENDING"
  | "SENT"
  | "DELIVERED"
  | "FAILED"
  | "BOUNCED"
  | "SUPPRESSED";

export type TrafficClass = "TRANSACTIONAL" | "MARKETING";

export type Locale = string;

export interface NotificationTemplate {
  event_type: EventType;
  channel: ChannelName;
  locale: Locale;
  subject: string;
  text_body: string;
  html_body: string;
  short_body: string;
}

export interface Notification {
  id: string;
  event_id: string;
  event_type: EventType;
  channel: ChannelName;
  recipient: string;
  user_id: string;
  template_id: string;
  status: NotificationStatus;
  traffic_class: TrafficClass;
  locale: Locale;
  created_at: string;
  sent_at: string | null;
}

export interface DeliveryAttempt {
  notification_id: string;
  channel: ChannelName;
  provider: string;
  provider_message_id: string | null;
  status: NotificationStatus | "THROTTLED";
  attempt_no: number;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface QuietHours {
  start: string;
  end: string;
}

export interface UserPreference {
  user_id: string;
  channels: Record<ChannelName, boolean>;
  locale: Locale;
  quiet_hours: QuietHours | null;
}

export interface RetryPolicy {
  max_attempts: number;
  backoff_ms: number[];
}

export interface PartnerWebhook {
  id: string;
  url: string;
  secret: string;
  event_filters: EventType[] | ["*"];
  retry_policy: RetryPolicy;
  status: "ACTIVE" | "DISABLED";
  created_at: string;
}

export interface InboundEvent {
  event_id: string;
  event_type: EventType;
  user_id: string;
  recipient: string;
  data: Record<string, unknown> & {
    traffic_class?: TrafficClass;
    locale?: Locale;
  };
}

export interface AuditEvent {
  id: string;
  type:
    | "notification.requested"
    | "notification.delivered"
    | "notification.failed"
    | "notification.suppressed";
  notification_id: string | null;
  channel: ChannelName | null;
  status: NotificationStatus | null;
  created_at: string;
  payload: Record<string, unknown>;
}

export interface NotificationMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  short: string;
  event_type: EventType;
  notification_id: string;
}

export interface Channel {
  name: ChannelName;
  send(message: NotificationMessage): Promise<DeliveryResult>;
  verifyPreference(pref: UserPreference): boolean;
}

export interface DeliveryResult {
  provider: string;
  provider_message_id: string;
  status: NotificationStatus | "THROTTLED";
  error: string | null;
}