-- Stage 1: delivery_attempts table
CREATE TABLE IF NOT EXISTS delivery_attempts (
  id                  SERIAL PRIMARY KEY,
  notification_id     TEXT NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  channel             TEXT NOT NULL CHECK (channel IN ('email','sms','push','webhook')),
  provider            TEXT NOT NULL,
  provider_message_id TEXT,
  status              TEXT NOT NULL
                      CHECK (status IN ('pending','sent','delivered','failed','bounced','suppressed','throttled')),
  attempt_no          INTEGER NOT NULL DEFAULT 1,
  error               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_attempts_notif_attempt
  ON delivery_attempts (notification_id, attempt_no);
CREATE INDEX IF NOT EXISTS idx_attempts_notif_id ON delivery_attempts (notification_id);