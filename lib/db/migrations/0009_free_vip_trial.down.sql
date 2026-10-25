-- Non-destructive rollback for 0009.
-- Evidence and editable sequence content are archived rather than deleted.
-- Additive user_subscriptions/reminders/app_users columns remain harmless to
-- previous application code and retaining them avoids destroying entitlement
-- or engagement history during a rollback.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.free_trial_message_steps') IS NOT NULL
     AND to_regclass('public.free_trial_message_steps_archive_0009') IS NULL THEN
    ALTER TABLE free_trial_message_steps RENAME TO free_trial_message_steps_archive_0009;
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.trial_claims') IS NOT NULL
     AND to_regclass('public.trial_claims_archive_0009') IS NULL THEN
    ALTER TABLE trial_claims RENAME TO trial_claims_archive_0009;
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.email_verification_tokens') IS NOT NULL
     AND to_regclass('public.email_verification_tokens_archive_0009') IS NULL THEN
    ALTER TABLE email_verification_tokens RENAME TO email_verification_tokens_archive_0009;
  END IF;
END $$;

-- Keep expanded audience/event constraints: reducing them could make retained
-- historical rows invalid. Previous code ignores the additional values.

COMMIT;
