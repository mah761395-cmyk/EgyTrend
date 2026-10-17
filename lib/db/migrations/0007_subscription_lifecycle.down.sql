-- Non-destructive rollback for 0007.
--
-- Do not delete lifecycle evidence, reminder delivery history, or action
-- metadata during a rollback. Older application code safely ignores the added
-- columns/tables. Renaming preserves the complete recovery/audit trail.
-- A future approved migration may import these archive tables again.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.reminders_sent') IS NOT NULL
     AND to_regclass('public.reminders_sent_archive_0007') IS NULL THEN
    ALTER TABLE reminders_sent RENAME TO reminders_sent_archive_0007;
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.subscription_lifecycle_events') IS NOT NULL
     AND to_regclass('public.subscription_lifecycle_events_archive_0007') IS NULL THEN
    ALTER TABLE subscription_lifecycle_events RENAME TO subscription_lifecycle_events_archive_0007;
  END IF;
END $$;

-- Deliberately retain `cycle_id`, `grace_ends_at`, notification CTA columns,
-- and timestamptz conversion: removing them would be destructive or could
-- reinterpret entitlement instants. The prior API ignores unknown columns.

COMMIT;
