import type { ChannelName, QuietHours, UserPreference } from "./types.js";
import { store } from "./store.js";

const VALID_CHANNELS: ChannelName[] = ["email", "sms", "push", "webhook"];

export interface UpsertPreferencesInput {
  channels: Record<ChannelName, boolean>;
  locale?: string;
  quiet_hours?: QuietHours | null;
}

export function upsertPreferences(
  userId: string,
  input: UpsertPreferencesInput,
): UserPreference {
  if (!userId) throw new ValidationError("user_id is required");
  if (!input.channels || typeof input.channels !== "object") {
    throw new ValidationError("channels object is required");
  }
  for (const key of Object.keys(input.channels)) {
    if (!VALID_CHANNELS.includes(key as ChannelName)) {
      throw new ValidationError(`invalid channel: ${key}`);
    }
  }
  const pref: UserPreference = {
    user_id: userId,
    channels: {
      email: !!input.channels.email,
      sms: !!input.channels.sms,
      push: !!input.channels.push,
      webhook: !!input.channels.webhook,
    },
    locale: input.locale ?? "en",
    quiet_hours: input.quiet_hours ?? null,
  };
  if (pref.quiet_hours) {
    validateQuietHours(pref.quiet_hours);
  }
  store.setPreference(pref);
  return pref;
}

export function getPreferences(userId: string): UserPreference {
  const pref = store.getPreference(userId);
  if (!pref) throw new NotFoundError(`preferences for ${userId} not found`);
  return pref;
}

function validateQuietHours(qh: QuietHours): void {
  const re = /^\d{2}:\d{2}$/;
  if (!re.test(qh.start) || !re.test(qh.end)) {
    throw new ValidationError("quiet_hours.start and end must be HH:MM");
  }
}

export class ValidationError extends Error {
  status = 400;
}
export class NotFoundError extends Error {
  status = 404;
}