-- Stage 1: partner_webhooks table
CREATE TABLE IF NOT EXISTS partner_webhooks (
  id            TEXT PRIMARY KEY,
  url           TEXT NOT NULL,
  secret        TEXT NOT NULL,
  event_filters JSONB NOT NULL DEFAULT '["*"]'::jsonb,
  retry_policy  JSONB NOT NULL,
  batch_window  INTEGER NOT NULL DEFAULT 1000,
  status        TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','disabled')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_partner_webhooks_status ON partner_webhooks (status);
CREATE INDEX IF NOT EXISTS idx_partner_webhooks_url ON partner_webhooks (url);