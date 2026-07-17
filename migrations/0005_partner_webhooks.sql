-- Stage 1: partner_webhooks table
-- Conventions: UUID PKs (app-generated UUIDv7, no DB default), UPPER_CASE enum
-- TEXT (no CHECK), created_at + updated_at on every table, no DB triggers.
CREATE TABLE IF NOT EXISTS partner_webhooks (
  id            UUID PRIMARY KEY,
  url           TEXT NOT NULL,
  secret        TEXT NOT NULL,
  event_filters JSONB NOT NULL DEFAULT '["*"]'::jsonb,
  retry_policy  JSONB NOT NULL,
  batch_window  INTEGER NOT NULL DEFAULT 1000,
  status        TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_partner_webhooks_status ON partner_webhooks (status);
CREATE INDEX IF NOT EXISTS idx_partner_webhooks_url ON partner_webhooks (url);