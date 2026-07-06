CREATE TABLE IF NOT EXISTS notifications (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id     TEXT NOT NULL,
  channel      TEXT NOT NULL CHECK (channel IN ('email', 'sms', 'push', 'webhook')),
  recipient    TEXT NOT NULL,
  template_id  UUID NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'delivered', 'failed', 'bounced')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS notifications_event_channel_recipient_idx
  ON notifications (event_id, channel, recipient);