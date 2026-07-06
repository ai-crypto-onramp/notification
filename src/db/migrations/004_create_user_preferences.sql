CREATE TABLE IF NOT EXISTS user_preferences (
  user_id           TEXT PRIMARY KEY,
  email_opt_in      BOOLEAN NOT NULL DEFAULT true,
  sms_opt_in        BOOLEAN NOT NULL DEFAULT true,
  push_opt_in       BOOLEAN NOT NULL DEFAULT true,
  webhook_opt_in    BOOLEAN NOT NULL DEFAULT true,
  locale            TEXT NOT NULL DEFAULT 'en',
  quiet_hours_start TIME,
  quiet_hours_end   TIME,
  timezone          TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);