import type {
  EventType,
  ChannelName,
  Locale,
  NotificationTemplate,
  NotificationMessage,
} from "./types.js";
import { store } from "./store.js";

function renderString(tpl: string, data: Record<string, unknown>): string {
  return tpl.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, key: string) => {
    const value = key
      .split(".")
      .reduce<unknown>((acc, k) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[k] : undefined), data);
    return value === undefined || value === null ? "" : String(value);
  });
}

export interface CompiledTemplate {
  template: NotificationTemplate;
  subject: string;
  text_body: string;
  html_body: string;
  short_body: string;
}

const cache = new Map<string, CompiledTemplate>();

function keyFor(eventType: EventType, channel: ChannelName, locale: Locale): string {
  return `${eventType}|${channel}|${locale}`;
}

export interface TemplateService {
  resolve(
    eventType: EventType,
    channel: ChannelName,
    locale: Locale,
    data: Record<string, unknown>,
  ): CompiledTemplate;
  invalidate(): void;
}

function compile(template: NotificationTemplate, data: Record<string, unknown>): CompiledTemplate {
  return {
    template,
    subject: renderString(template.subject, data),
    text_body: renderString(template.text_body, data),
    html_body: renderString(template.html_body, data),
    short_body: renderString(template.short_body, data),
  };
}

export const templateService: TemplateService = {
  resolve(eventType, channel, locale, data) {
    const k = keyFor(eventType, channel, locale);
    let compiled = cache.get(k);
    if (!compiled) {
      const template = store.getTemplate(eventType, channel, locale);
      if (!template) {
        throw new Error(`No template for ${eventType}/${channel}/${locale}`);
      }
      compiled = compile(template, {});
      cache.set(k, compiled);
    }
    return compile(compiled.template, data);
  },
  invalidate() {
    cache.clear();
  },
};

export function buildMessage(
  eventType: EventType,
  channel: ChannelName,
  locale: Locale,
  recipient: string,
  data: Record<string, unknown>,
  notificationId: string,
): NotificationMessage {
  const compiled = templateService.resolve(eventType, channel, locale, data);
  return {
    to: recipient,
    subject: compiled.subject,
    text: compiled.text_body,
    html: compiled.html_body,
    short: compiled.short_body,
    event_type: eventType,
    notification_id: notificationId,
  };
}

export const __renderString = renderString;