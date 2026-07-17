import type { InboundEvent, ChannelName, Notification, AuditEvent } from "./types.js";
import { store } from "./store.js";
import { channelRouter, sendRoute, resolveChannelSet } from "./router.js";
import { getAuditEmitter } from "./audit.js";
import { newId } from "./store.js";

const queue: InboundEvent[] = [];
let processing = false;

export function enqueueEvent(event: InboundEvent): number {
  validateEvent(event);
  queue.push(event);
  void processQueue();
  return queue.length;
}

export function validateEvent(event: InboundEvent): void {
  if (!event || typeof event !== "object") throw new ValidationError("event required");
  if (!event.event_id) throw new ValidationError("event_id required");
  if (!event.event_type) throw new ValidationError("event_type required");
  if (!event.user_id) throw new ValidationError("user_id required");
  if (!event.recipient) throw new ValidationError("recipient required");
}

export async function processQueue(): Promise<void> {
  if (processing) return;
  processing = true;
  try {
    while (queue.length > 0) {
      const event = queue.shift()!;
      await ingestEvent(event);
    }
  } finally {
    processing = false;
  }
}

export async function ingestEvent(event: InboundEvent): Promise<Notification[]> {
  validateEvent(event);
  const data = { ...event.data, event_id: event.event_id };
  const candidateChannels = resolveChannelSet(event.event_type);
  const targetChannels: ChannelName[] = [];
  for (const ch of candidateChannels) {
    if (store.isDuplicate(event.event_id, ch, event.recipient)) {
      const evt: AuditEvent = {
        id: newId(),
        type: "notification.suppressed",
        notification_id: null,
        channel: ch,
        status: "SUPPRESSED",
        created_at: new Date().toISOString(),
        payload: { reason: "duplicate", event_id: event.event_id, recipient: event.recipient },
      };
      store.addAudit(evt);
      void getAuditEmitter().emit(evt);
    } else {
      store.markSent(event.event_id, ch, event.recipient);
      targetChannels.push(ch);
    }
  }
  if (targetChannels.length === 0) return [];

  const routes = channelRouter.resolve(
    event.event_type,
    event.recipient,
    event.user_id,
    data,
  );
  const sent: Notification[] = [];
  for (const route of routes) {
    if (!targetChannels.includes(route.notification.channel)) continue;
    await sendRoute(route);
    sent.push(route.notification);
  }
  return sent;
}

export function manualSend(input: {
  event_id: string;
  channel: ChannelName;
  recipient: string;
  event_type: InboundEvent["event_type"];
  user_id?: string;
  data?: Record<string, unknown>;
}): Notification {
  if (!input.event_id) throw new ValidationError("event_id required");
  if (!input.channel) throw new ValidationError("channel required");
  if (!input.recipient) throw new ValidationError("recipient required");
  if (!input.event_type) throw new ValidationError("event_type required");

  if (store.isDuplicate(input.event_id, input.channel, input.recipient)) {
    throw new ValidationError("duplicate send");
  }
  store.markSent(input.event_id, input.channel, input.recipient);

  const userId = input.user_id ?? "manual";
  const data = { ...(input.data ?? {}), event_id: input.event_id };
  const routes = channelRouter.resolve(
    input.event_type,
    input.recipient,
    userId,
    data,
    input.channel,
  );
  const route = routes[0];
  if (!route) throw new ValidationError("no route resolved");
  void sendRoute(route);
  return route.notification;
}

export class ValidationError extends Error {
  status = 400;
}

export function _resetQueue(): void {
  queue.length = 0;
  processing = false;
}