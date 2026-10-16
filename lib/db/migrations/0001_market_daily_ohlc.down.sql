-- Non-destructive rollback for 0001_market_daily_ohlc.up.sql (NOT auto-applied).
-- It archives the new table rather than dropping data. Restore by renaming the
-- archived table back after investigating; do not delete it without a backup.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.market_daily_ohlc') IS NOT NULL
     AND to_regclass('public.market_daily_ohlc_rollback_archive') IS NULL THEN
    ALTER TABLE market_daily_ohlc RENAME TO market_daily_ohlc_rollback_archive;
  END IF;
END $$;

COMMIT;
