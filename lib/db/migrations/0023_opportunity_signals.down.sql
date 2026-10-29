-- 0023 down: drop the structured signal columns (additive migration).
DROP INDEX IF EXISTS idx_opportunities_instrument_status;

ALTER TABLE opportunities
  DROP COLUMN IF EXISTS realized_at,
  DROP COLUMN IF EXISTS result,
  DROP COLUMN IF EXISTS first_price,
  DROP COLUMN IF EXISTS signal,
  DROP COLUMN IF EXISTS instrument_id;
