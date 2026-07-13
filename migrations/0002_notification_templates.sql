-- Stage 1: notification_templates table keyed by event_type + channel + locale
CREATE TABLE IF NOT EXISTS notification_templates (
  id          SERIAL PRIMARY KEY,
  event_type  TEXT NOT NULL,
  channel     TEXT NOT NULL CHECK (channel IN ('email','sms','push','webhook')),
  locale      TEXT NOT NULL DEFAULT 'en',
  subject     TEXT NOT NULL DEFAULT '',
  text_body   TEXT NOT NULL DEFAULT '',
  html_body   TEXT NOT NULL DEFAULT '',
  short_body  TEXT NOT NULL DEFAULT '',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_type, channel, locale)
);

CREATE INDEX IF NOT EXISTS idx_templates_lookup
  ON notification_templates (event_type, channel, locale);