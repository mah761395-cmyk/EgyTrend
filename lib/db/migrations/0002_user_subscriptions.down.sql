-- Non-destructive rollback for 0002_user_subscriptions.up.sql (NOT auto-applied).
-- Keep historical entitlement rows as an archive; never delete paid-state data
-- as part of a rollback. Restore only after investigation and a verified backup.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.user_subscriptions') IS NOT NULL
     AND to_regclass('public.user_subscriptions_rollback_archive') IS NULL THEN
    ALTER TABLE user_subscriptions RENAME TO user_subscriptions_rollback_archive;
    -- Free the original index names so a later approved re-apply can build
    -- indexes for the newly-created live table rather than silently reusing
    -- archive names.
    ALTER INDEX IF EXISTS user_subscriptions_user_id_uidx
      RENAME TO user_subscriptions_rollback_archive_user_id_uidx;
    ALTER INDEX IF EXISTS user_subscriptions_active_expiry_idx
      RENAME TO user_subscriptions_rollback_archive_active_expiry_idx;
  END IF;
END $$;

COMMIT;
