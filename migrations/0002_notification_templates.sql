-- Stage 1: notification_templates table keyed by event_type + channel + locale
-- Conventions: UUID PKs (app-generated UUIDv7, no DB default), UPPER_CASE enum
-- TEXT (no CHECK), created_at + updated_at on every table, no DB triggers.
CREATE TABLE IF NOT EXISTS notification_templates (
  id          UUID PRIMARY KEY,
  event_type  TEXT NOT NULL,
  channel     TEXT NOT NULL,
  locale      TEXT NOT NULL DEFAULT 'en',
  subject     TEXT NOT NULL DEFAULT '',
  text_body   TEXT NOT NULL DEFAULT '',
  html_body   TEXT NOT NULL DEFAULT '',
  short_body  TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_type, channel, locale)
);

CREATE INDEX IF NOT EXISTS idx_templates_lookup
  ON notification_templates (event_type, channel, locale);