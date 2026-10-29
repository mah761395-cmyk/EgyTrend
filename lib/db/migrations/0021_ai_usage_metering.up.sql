-- AI usage metering: per-call provider/model/tokens/status/estimated cost.
-- Additive + idempotent. Legacy rows keep NULLs and are shown as unmetered;
-- nothing is backfilled, so no cost figure is ever fabricated.
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS provider text;
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS model text;
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS tokens_in integer;
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS tokens_out integer;
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'reserved';
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS cost_est_usd double precision;
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS cost_source text;

CREATE INDEX IF NOT EXISTS ai_usage_created_at_idx ON ai_usage (created_at DESC);
CREATE INDEX IF NOT EXISTS ai_usage_provider_created_idx ON ai_usage (provider, created_at DESC);
