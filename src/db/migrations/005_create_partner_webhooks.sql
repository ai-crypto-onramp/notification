CREATE TABLE IF NOT EXISTS partner_webhooks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id    TEXT NOT NULL,
  url           TEXT NOT NULL,
  secret        TEXT NOT NULL,
  event_filters JSONB NOT NULL DEFAULT '[]'::jsonb,
  retry_policy  JSONB NOT NULL DEFAULT '{}'::jsonb,
  batch_window  INTEGER NOT NULL DEFAULT 1000,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (partner_id, url)
);