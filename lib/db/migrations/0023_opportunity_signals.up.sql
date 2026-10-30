-- 0023: structured opportunity signals (TASK M).
--
-- The legacy `opportunities` table keeps serving the descriptive cards it was
-- built for; the new columns carry the explainable signal payload so a card
-- can carry its price, factors, levels and result without changing its
-- existing contract. Everything is additive and nullable: rows created
-- before this migration keep working, and no historical row is touched.
--
-- `result` is the honest outcome vocabulary:
--   target_hit   — the live price reached target 1 (status: realized)
--   stop_hit     — the live price broke the stop loss (status: expired)
--   expired_by_time — the observation window closed without a result
-- Rows are never deleted by lifecycle: history and results are kept.

ALTER TABLE opportunities
  ADD COLUMN IF NOT EXISTS instrument_id text,
  ADD COLUMN IF NOT EXISTS signal jsonb,
  ADD COLUMN IF NOT EXISTS first_price double precision,
  ADD COLUMN IF NOT EXISTS result text,
  ADD COLUMN IF NOT EXISTS realized_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_opportunities_instrument_status
  ON opportunities (instrument_id, status);
