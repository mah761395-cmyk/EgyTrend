-- EgyTrend market-history migration (NOT auto-applied).
-- Preconditions for any real environment:
--   1. Verify DATABASE_URL belongs to an isolated Preview/Test database first.
--   2. Take and verify a portable backup with scripts/backup-db.mjs.
--   3. Run this file through the approved migration runner in a maintenance window.
--
-- This contains no user-data mutation and creates a new table only.

BEGIN;

CREATE TABLE IF NOT EXISTS market_daily_ohlc (
  id text PRIMARY KEY,
  instrument_id text NOT NULL,
  source_id text NOT NULL,
  source_name text NOT NULL,
  trading_date date NOT NULL,
  open double precision NOT NULL,
  high double precision NOT NULL,
  low double precision NOT NULL,
  close double precision NOT NULL,
  volume double precision,
  currency text,
  delayed_minutes integer,
  as_of timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS market_daily_ohlc_source_instrument_day_uq
  ON market_daily_ohlc (source_id, instrument_id, trading_date);
CREATE INDEX IF NOT EXISTS market_daily_ohlc_instrument_day_idx
  ON market_daily_ohlc (instrument_id, trading_date);

COMMIT;
