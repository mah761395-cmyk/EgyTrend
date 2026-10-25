-- Subscription lifecycle and renewal reminders.
--
-- PENDING / DO NOT APPLY to production or a shared database until a verified
-- backup exists and the owner approves the maintenance window. This migration
-- is additive apart from normalising existing subscription instants to UTC.
-- It never deletes subscription, notification, wallet, list, or scenario data.

BEGIN;

-- Existing columns were originally `timestamp without time zone`. They have
-- always been written as UTC by the API; make that contract explicit before
-- lifecycle comparisons and DST-aware display code depend on it.
ALTER TABLE user_subscriptions
  ALTER COLUMN starts_at TYPE timestamptz USING starts_at AT TIME ZONE 'UTC',
  ALTER COLUMN expires_at TYPE timestamptz USING expires_at AT TIME ZONE 'UTC';

ALTER TABLE user_subscriptions
  ADD COLUMN IF NOT EXISTS cycle_id text,
  ADD COLUMN IF NOT EXISTS grace_ends_at timestamptz;

-- Every existing entitlement receives its own immutable legacy cycle. New
-- approved terms always replace this value with a fresh server-generated id.
UPDATE user_subscriptions
SET cycle_id = 'legacy-cycle-' || id
WHERE cycle_id IS NULL OR btrim(cycle_id) = '';

ALTER TABLE user_subscriptions
  ALTER COLUMN cycle_id SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS user_subscriptions_cycle_id_uidx
  ON user_subscriptions(cycle_id);

ALTER TABLE user_subscriptions
  DROP CONSTRAINT IF EXISTS user_subscriptions_status_check;
ALTER TABLE user_subscriptions
  ADD CONSTRAINT user_subscriptions_status_check
  CHECK (status IN ('active', 'grace', 'cancelled', 'expired'));

ALTER TABLE user_notifications
  ADD COLUMN IF NOT EXISTS action_url text,
  ADD COLUMN IF NOT EXISTS action_label text;

CREATE TABLE IF NOT EXISTS reminders_sent (
  id text PRIMARY KEY,
  subscription_id text NOT NULL REFERENCES user_subscriptions(id) ON DELETE RESTRICT,
  subscription_cycle_id text NOT NULL,
  user_id integer NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  reminder_type text NOT NULL,
  reminder_class text NOT NULL DEFAULT 'transactional',
  target_ends_at timestamptz NOT NULL,
  delivery_status text NOT NULL DEFAULT 'queued',
  content jsonb NOT NULL,
  in_app_notification_id text,
  in_app_sent_at timestamptz,
  email_status text NOT NULL DEFAULT 'pending',
  email_attempts integer NOT NULL DEFAULT 0,
  email_next_attempt_at timestamptz,
  email_claim_token text,
  email_claimed_at timestamptz,
  email_sent_at timestamptz,
  email_last_error text,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT subscription_reminders_sent_type_check CHECK (
    reminder_type IN (
      'monthly_7d', 'monthly_3d', 'monthly_1d',
      'annual_30d', 'annual_14d', 'annual_7d', 'annual_1d',
      'expiry', 'winback_3d', 'manual'
    )
  ),
  CONSTRAINT subscription_reminders_sent_class_check CHECK (reminder_class IN ('transactional', 'marketing')),
  CONSTRAINT subscription_reminders_sent_delivery_check CHECK (delivery_status IN ('queued', 'delivered', 'suppressed', 'cancelled')),
  CONSTRAINT subscription_reminders_sent_email_check CHECK (email_status IN ('pending', 'sending', 'sent', 'failed', 'unavailable', 'suppressed', 'cancelled')),
  CONSTRAINT subscription_reminders_sent_attempts_check CHECK (email_attempts >= 0 AND email_attempts <= 3)
);

-- The current subscription row is overwritten upon renewal, so subscription_id
-- alone is not an idempotency key. The cycle protects every paid term.
CREATE UNIQUE INDEX IF NOT EXISTS subscription_reminders_sent_cycle_type_uidx
  ON reminders_sent(subscription_cycle_id, reminder_type);
CREATE INDEX IF NOT EXISTS subscription_reminders_sent_delivery_idx
  ON reminders_sent(delivery_status, target_ends_at);
CREATE INDEX IF NOT EXISTS subscription_reminders_sent_email_idx
  ON reminders_sent(email_status, email_next_attempt_at);
CREATE INDEX IF NOT EXISTS subscription_reminders_sent_user_idx
  ON reminders_sent(user_id, created_at);

CREATE TABLE IF NOT EXISTS subscription_lifecycle_events (
  id text PRIMARY KEY,
  user_id integer NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  subscription_id text NOT NULL REFERENCES user_subscriptions(id) ON DELETE RESTRICT,
  subscription_cycle_id text NOT NULL,
  event_type text NOT NULL,
  related_cycle_id text,
  plan_key text NOT NULL,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT subscription_lifecycle_events_type_check CHECK (event_type IN ('activated', 'renewed', 'grace_started', 'expired', 'cancelled'))
);

CREATE UNIQUE INDEX IF NOT EXISTS subscription_lifecycle_events_cycle_type_uidx
  ON subscription_lifecycle_events(subscription_cycle_id, event_type);
CREATE INDEX IF NOT EXISTS subscription_lifecycle_events_type_at_idx
  ON subscription_lifecycle_events(event_type, occurred_at);
CREATE INDEX IF NOT EXISTS subscription_lifecycle_events_user_idx
  ON subscription_lifecycle_events(user_id, occurred_at);

COMMIT;
