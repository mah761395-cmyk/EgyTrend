-- Non-destructive rollback for 0004_user_price_alerts.up.sql.
-- Alert preferences/history are retained as an archive, never deleted.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.user_price_alerts') IS NOT NULL
     AND to_regclass('public.user_price_alerts_rollback_archive') IS NULL THEN
    ALTER TABLE user_price_alerts RENAME TO user_price_alerts_rollback_archive;
    ALTER INDEX IF EXISTS user_price_alerts_active_rule_uidx
      RENAME TO user_price_alerts_rollback_archive_active_rule_uidx;
    ALTER INDEX IF EXISTS user_price_alerts_status_idx
      RENAME TO user_price_alerts_rollback_archive_status_idx;
    ALTER INDEX IF EXISTS user_price_alerts_user_status_idx
      RENAME TO user_price_alerts_rollback_archive_user_status_idx;
  END IF;
END $$;

COMMIT;
