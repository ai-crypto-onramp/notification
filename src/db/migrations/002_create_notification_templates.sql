CREATE TABLE IF NOT EXISTS notification_templates (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type  TEXT NOT NULL,
  channel     TEXT NOT NULL CHECK (channel IN ('email', 'sms', 'push', 'webhook')),
  locale      TEXT NOT NULL DEFAULT 'en',
  subject     TEXT,
  text_body   TEXT,
  html_body   TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_type, channel, locale)
);