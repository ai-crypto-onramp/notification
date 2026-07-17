-- Stage 1: notifications table
-- Conventions: UUID PKs (app-generated UUIDv7, no DB default), UPPER_CASE enum
-- TEXT (no CHECK), created_at + updated_at on every table, no DB triggers.
CREATE TABLE IF NOT EXISTS notifications (
  id            UUID PRIMARY KEY,
  event_id      TEXT NOT NULL,
  event_type    TEXT NOT NULL,
  channel       TEXT NOT NULL,
  recipient     TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  template_id   TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'PENDING',
  traffic_class TEXT NOT NULL DEFAULT 'TRANSACTIONAL',
  locale        TEXT NOT NULL DEFAULT 'en',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_notifications_event_channel_recipient
  ON notifications (event_id, channel, recipient);
CREATE INDEX IF NOT EXISTS idx_notifications_event_id ON notifications (event_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications (user_id);