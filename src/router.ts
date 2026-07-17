import type {
  Channel,
  ChannelName,
  EventType,
  Notification,
  NotificationMessage,
  UserPreference,
  AuditEvent,
  TrafficClass,
} from "./types.js";
import { store, newId } from "./store.js";
import { buildMessage } from "./templates.js";
import { channelByName } from "./channels.js";
import { getAuditEmitter } from "./audit.js";

function defaultPreference(user_id: string): UserPreference {
  return {
    user_id,
    channels: { EMAIL: true, SMS: true, PUSH: true, WEBHOOK: true },
    locale: "en",
    quiet_hours: null,
  };
}

function inQuietHours(pref: UserPreference, now = new Date()): boolean {
  if (!pref.quiet_hours) return false;
  const cur = now.getHours() * 60 + now.getMinutes();
  const [sh, sm] = pref.quiet_hours.start.split(":").map(Number);
  const [eh, em] = pref.quiet_hours.end.split(":").map(Number);
  const start = sh * 60 + sm;
  const end = eh * 60 + em;
  if (start === end) return false;
  if (start < end) return cur >= start && cur < end;
  return cur >= start || cur < end;
}

export interface RouteResult {
  channel: Channel;
  message: NotificationMessage;
  notification: Notification;
  suppressed: boolean;
  reason?: string;
}

export class ChannelRouter {
  resolve(
    eventType: EventType,
    recipient: string,
    userId: string,
    data: Record<string, unknown>,
    explicitChannel?: ChannelName,
  ): RouteResult[] {
    const pref = store.getPreference(userId) ?? defaultPreference(userId);
    const trafficClass: TrafficClass =
      (data.traffic_class as TrafficClass) ?? store.classify(eventType);

    const channelSet: ChannelName[] = explicitChannel
      ? [explicitChannel]
      : this.channelSetFor(eventType);

    const results: RouteResult[] = [];
    for (const channelName of channelSet) {
      const channel = channelByName(channelName);
      const optedIn = channel.verifyPreference(pref);
      const locale = (data.locale as string) ?? pref.locale ?? "en";
      const id = newId();
      const notification: Notification = {
        id,
        event_id: String(data.event_id ?? ""),
        event_type: eventType,
        channel: channelName,
        recipient,
        user_id: userId,
        template_id: `${eventType}/${channelName}/${locale}`,
        status: "PENDING",
        traffic_class: trafficClass,
        locale,
        created_at: new Date().toISOString(),
        sent_at: null,
      };

      if (!optedIn) {
        notification.status = "SUPPRESSED";
        store.addNotification(notification);
        emitAudit("notification.suppressed", id, channelName, "SUPPRESSED", {
          reason: "opted_out",
          user_id: userId,
        });
        results.push({
          channel,
          message: buildMessage(eventType, channelName, locale, recipient, data, id),
          notification,
          suppressed: true,
          reason: "opted_out",
        });
        continue;
      }

      if (trafficClass === "MARKETING" && inQuietHours(pref)) {
        notification.status = "SUPPRESSED";
        store.addNotification(notification);
        emitAudit("notification.suppressed", id, channelName, "SUPPRESSED", {
          reason: "quiet_hours",
          user_id: userId,
        });
        results.push({
          channel,
          message: buildMessage(eventType, channelName, locale, recipient, data, id),
          notification,
          suppressed: true,
          reason: "quiet_hours",
        });
        continue;
      }

      store.addNotification(notification);
      emitAudit("notification.requested", id, channelName, "PENDING", {
        event_type: eventType,
        user_id: userId,
        traffic_class: trafficClass,
      });
      results.push({
        channel,
        message: buildMessage(eventType, channelName, locale, recipient, data, id),
        notification,
        suppressed: false,
      });
    }
    return results;
  }

  channelSetFor(eventType: EventType): ChannelName[] {
    // Fan-out: tx.confirmed → EMAIL + PUSH; others → EMAIL + SMS by default.
    if (eventType === "tx.confirmed") return ["EMAIL", "PUSH"];
    if (eventType === "chain.confirmed") return ["EMAIL", "PUSH"];
    return ["EMAIL", "SMS"];
  }
}

export function resolveChannelSet(eventType: EventType): ChannelName[] {
  return channelRouter.channelSetFor(eventType);
}

function emitAudit(
  type: AuditEvent["type"],
  notificationId: string,
  channel: ChannelName | null,
  status: AuditEvent["status"],
  payload: Record<string, unknown>,
): void {
  const event: AuditEvent = {
    id: newId(),
    type,
    notification_id: notificationId,
    channel,
    status,
    created_at: new Date().toISOString(),
    payload,
  };
  store.addAudit(event);
  // Fire-and-forget the external emit so a downstream outage never blocks sends.
  void getAuditEmitter().emit(event);
}

export const channelRouter = new ChannelRouter();

export async function sendRoute(route: RouteResult): Promise<void> {
  if (route.suppressed) return;
  const result = await route.channel.send(route.message);
  const notif = route.notification;
  // "THROTTLED" is a transient attempt state; the notification stays pending
  // so a retry can re-enter. Map to a NotificationStatus for persistence.
  notif.status = result.status === "THROTTLED" ? "PENDING" : result.status;
  notif.sent_at = new Date().toISOString();
  emitAudit(
    result.status === "DELIVERED" ? "notification.delivered" : "notification.failed",
    notif.id,
    notif.channel,
    result.status === "THROTTLED" ? "PENDING" : result.status,
    { provider: result.provider, provider_message_id: result.provider_message_id },
  );
}

export { inQuietHours, defaultPreference };