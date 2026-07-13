-- Stage 1: user_preferences table
CREATE TABLE IF NOT EXISTS user_preferences (
  user_id      TEXT PRIMARY KEY,
  email        BOOLEAN NOT NULL DEFAULT TRUE,
  sms          BOOLEAN NOT NULL DEFAULT TRUE,
  push         BOOLEAN NOT NULL DEFAULT TRUE,
  webhook      BOOLEAN NOT NULL DEFAULT TRUE,
  locale       TEXT NOT NULL DEFAULT 'en',
  quiet_start  TEXT,
  quiet_end    TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT quiet_hours_format CHECK (
    quiet_start IS NULL OR (quiet_start ~ '^\d{2}:\d{2}$')
  ),
  CONSTRAINT quiet_hours_end_format CHECK (
    quiet_end IS NULL OR (quiet_end ~ '^\d{2}:\d{2}$')
  )
);

CREATE INDEX IF NOT EXISTS idx_preferences_user_id ON user_preferences (user_id);