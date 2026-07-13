import Handlebars from "handlebars";
import type {
  EventType,
  ChannelName,
  Locale,
  NotificationTemplate,
  NotificationMessage,
} from "./types.js";
import { store } from "./store.js";

// Safe helper set: no raw HTML injection in SMS/push. Handlebars escapes HTML
// for `{{var}}` by default; `{{{var}}}` (raw) is reserved for email HTML bodies
// authored by trusted templates only.
Handlebars.registerHelper("uppercase", (v: unknown) =>
  typeof v === "string" ? v.toUpperCase() : String(v ?? ""),
);
Handlebars.registerHelper("truncate", (v: unknown, len: number) => {
  const s = v == null ? "" : String(v);
  return s.length > len ? `${s.slice(0, len)}…` : s;
});

export interface CompiledTemplate {
  template: NotificationTemplate;
  subject: string;
  text_body: string;
  html_body: string;
  short_body: string;
}

interface CompiledCache {
  template: NotificationTemplate;
  subject: Handlebars.TemplateDelegate;
  text: Handlebars.TemplateDelegate;
  html: Handlebars.TemplateDelegate;
  short: Handlebars.TemplateDelegate;
}

const cache = new Map<string, CompiledCache>();

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
  invalidate(eventType: EventType, channel: ChannelName, locale?: Locale): void;
}
function compileAll(t: NotificationTemplate): CompiledCache {
  return {
    template: t,
    subject: Handlebars.compile(t.subject, { noEscape: false, strict: false }),
    text: Handlebars.compile(t.text_body, { noEscape: false, strict: false }),
    html: Handlebars.compile(t.html_body, { noEscape: false, strict: false }),
    short: Handlebars.compile(t.short_body, { noEscape: false, strict: false }),
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
      compiled = compileAll(template);
      cache.set(k, compiled);
    }
    const d = data ?? {};
    return {
      template: compiled.template,
      subject: compiled.subject(d),
      text_body: compiled.text(d),
      html_body: compiled.html(d),
      short_body: compiled.short(d),
    };
  },
  invalidate(eventType?: EventType, channel?: ChannelName, locale?: Locale): void {
    if (eventType === undefined) {
      cache.clear();
      return;
    }
    if (channel === undefined) {
      cache.clear();
      return;
    }
    if (locale) {
      cache.delete(keyFor(eventType, channel, locale));
    } else {
      for (const key of Array.from(cache.keys())) {
        if (key.startsWith(`${eventType}|${channel}|`)) cache.delete(key);
      }
    }
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

// Back-compat for existing tests that exercise the renderer directly.
export function renderString(tpl: string, data: Record<string, unknown>): string {
  return Handlebars.compile(tpl, { noEscape: false, strict: false })(data ?? {});
}

// Back-compat alias used by templates.test.ts.
export const __renderString = renderString;