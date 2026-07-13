-- Stage 1: notifications table
CREATE TABLE IF NOT EXISTS notifications (
  id            TEXT PRIMARY KEY,
  event_id      TEXT NOT NULL,
  event_type    TEXT NOT NULL,
  channel       TEXT NOT NULL CHECK (channel IN ('email','sms','push','webhook')),
  recipient     TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  template_id   TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','sent','delivered','failed','bounced','suppressed')),
  traffic_class TEXT NOT NULL DEFAULT 'transactional'
                CHECK (traffic_class IN ('transactional','marketing')),
  locale        TEXT NOT NULL DEFAULT 'en',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_notifications_event_channel_recipient
  ON notifications (event_id, channel, recipient);
CREATE INDEX IF NOT EXISTS idx_notifications_event_id ON notifications (event_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications (user_id);