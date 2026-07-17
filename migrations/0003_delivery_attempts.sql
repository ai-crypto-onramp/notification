-- Stage 1: delivery_attempts table
-- Conventions: UUID PKs (app-generated UUIDv7, no DB default), UPPER_CASE enum
-- TEXT (no CHECK), created_at + updated_at on every table, no DB triggers.
CREATE TABLE IF NOT EXISTS delivery_attempts (
  id                  UUID PRIMARY KEY,
  notification_id     UUID NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  channel             TEXT NOT NULL,
  provider            TEXT NOT NULL,
  provider_message_id TEXT,
  status              TEXT NOT NULL DEFAULT 'PENDING',
  attempt_no          INTEGER NOT NULL DEFAULT 1,
  error               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_attempts_notif_attempt
  ON delivery_attempts (notification_id, attempt_no);
CREATE INDEX IF NOT EXISTS idx_attempts_notif_id ON delivery_attempts (notification_id);