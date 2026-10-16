-- Non-destructive rollback for 0003_portfolio_positions.up.sql.
-- Portfolio records are personal financial inputs: archive the table rather
-- than deleting them. Restore only after investigation and a verified backup.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.portfolio_positions') IS NOT NULL
     AND to_regclass('public.portfolio_positions_rollback_archive') IS NULL THEN
    ALTER TABLE portfolio_positions RENAME TO portfolio_positions_rollback_archive;
    ALTER INDEX IF EXISTS portfolio_positions_user_symbol_uidx
      RENAME TO portfolio_positions_rollback_archive_user_symbol_uidx;
    ALTER INDEX IF EXISTS portfolio_positions_user_status_idx
      RENAME TO portfolio_positions_rollback_archive_user_status_idx;
  END IF;
END $$;

COMMIT;
