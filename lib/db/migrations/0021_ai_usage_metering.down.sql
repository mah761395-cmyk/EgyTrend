-- Rollback for 0021: drop the metering columns added to ai_usage.
-- Legacy rows lose their metering data (costs are estimates anyway); the
-- table itself and its pre-0021 columns stay intact.

BEGIN;

DROP INDEX IF EXISTS ai_usage_provider_created_idx;
DROP INDEX IF EXISTS ai_usage_created_at_idx;

ALTER TABLE ai_usage DROP COLUMN IF EXISTS cost_source;
ALTER TABLE ai_usage DROP COLUMN IF EXISTS cost_est_usd;
ALTER TABLE ai_usage DROP COLUMN IF EXISTS status;
ALTER TABLE ai_usage DROP COLUMN IF EXISTS tokens_out;
ALTER TABLE ai_usage DROP COLUMN IF EXISTS tokens_in;
ALTER TABLE ai_usage DROP COLUMN IF EXISTS model;
ALTER TABLE ai_usage DROP COLUMN IF EXISTS provider;

COMMIT;
