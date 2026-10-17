-- Non-destructive rollback for 0008.
-- Preserve messages, image media, user display state, and audit-friendly test
-- records; prior application code ignores these additive tables/column.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.broadcast_test_deliveries') IS NOT NULL
     AND to_regclass('public.broadcast_test_deliveries_archive_0008') IS NULL THEN
    ALTER TABLE broadcast_test_deliveries RENAME TO broadcast_test_deliveries_archive_0008;
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.broadcast_message_user_states') IS NOT NULL
     AND to_regclass('public.broadcast_message_user_states_archive_0008') IS NULL THEN
    ALTER TABLE broadcast_message_user_states RENAME TO broadcast_message_user_states_archive_0008;
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.broadcast_messages') IS NOT NULL
     AND to_regclass('public.broadcast_messages_archive_0008') IS NULL THEN
    ALTER TABLE broadcast_messages RENAME TO broadcast_messages_archive_0008;
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.broadcast_media') IS NOT NULL
     AND to_regclass('public.broadcast_media_archive_0008') IS NULL THEN
    ALTER TABLE broadcast_media RENAME TO broadcast_media_archive_0008;
  END IF;
END $$;

-- Keep app_users marketing-email consent columns: deleting opt-in/opt-out
-- evidence during a rollback would be destructive and old code ignores them.

COMMIT;
