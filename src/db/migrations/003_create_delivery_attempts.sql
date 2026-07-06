CREATE TABLE IF NOT EXISTS delivery_attempts (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id       UUID NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  channel               TEXT NOT NULL CHECK (channel IN ('email', 'sms', 'push', 'webhook')),
  provider              TEXT NOT NULL,
  provider_message_id   TEXT,
  status                TEXT NOT NULL CHECK (status IN ('sent', 'delivered', 'failed', 'bounced')),
  attempt_no            INTEGER NOT NULL CHECK (attempt_no > 0),
  error                 TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS delivery_attempts_notification_attempt_idx
  ON delivery_attempts (notification_id, attempt_no);