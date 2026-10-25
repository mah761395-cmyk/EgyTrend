-- Free VIP trial: pending migration. Apply only after a verified backup and
-- approved maintenance window; do not run it against a shared/production DB
-- from a preview or test environment.
--
-- The current entitlement remains one row per user in user_subscriptions.
-- Trial-history / canonical-email anti-abuse evidence lives separately so a
-- later paid conversion cannot erase it.

BEGIN;

ALTER TABLE app_users
  ADD COLUMN IF NOT EXISTS email_verified_at timestamp;

ALTER TABLE user_subscriptions
  ADD COLUMN IF NOT EXISTS subscription_type text NOT NULL DEFAULT 'paid',
  ADD COLUMN IF NOT EXISTS trial_feature_scope jsonb,
  ADD COLUMN IF NOT EXISTS trial_ai_daily_limit integer,
  ADD COLUMN IF NOT EXISTS trial_started_at timestamp,
  ADD COLUMN IF NOT EXISTS trial_ends_at timestamp,
  ADD COLUMN IF NOT EXISTS trial_ended_at timestamp,
  ADD COLUMN IF NOT EXISTS trial_converted_at timestamp;

ALTER TABLE user_subscriptions DROP CONSTRAINT IF EXISTS user_subscriptions_type_check;
ALTER TABLE user_subscriptions
  ADD CONSTRAINT user_subscriptions_type_check CHECK (subscription_type IN ('paid', 'trial'));
ALTER TABLE user_subscriptions DROP CONSTRAINT IF EXISTS user_subscriptions_trial_ai_limit_check;
ALTER TABLE user_subscriptions
  ADD CONSTRAINT user_subscriptions_trial_ai_limit_check CHECK (trial_ai_daily_limit IS NULL OR (trial_ai_daily_limit >= 0 AND trial_ai_daily_limit <= 100));

ALTER TABLE reminders_sent
  ADD COLUMN IF NOT EXISTS trial_message_step_id text,
  ADD COLUMN IF NOT EXISTS opened_at timestamp,
  ADD COLUMN IF NOT EXISTS clicked_at timestamp;
ALTER TABLE reminders_sent DROP CONSTRAINT IF EXISTS subscription_reminders_sent_type_check;
ALTER TABLE reminders_sent
  ADD CONSTRAINT subscription_reminders_sent_type_check CHECK (
    reminder_type IN ('monthly_7d', 'monthly_3d', 'monthly_1d', 'annual_30d', 'annual_14d', 'annual_7d', 'annual_1d', 'expiry', 'winback_3d', 'manual')
    OR reminder_type LIKE 'trial:%'
  );
CREATE INDEX IF NOT EXISTS subscription_reminders_sent_trial_step_idx
  ON reminders_sent(trial_message_step_id, created_at);

-- The paid lifecycle event table is intentionally reused for trial starts,
-- expiry, extensions and conversion evidence.
ALTER TABLE subscription_lifecycle_events DROP CONSTRAINT IF EXISTS subscription_lifecycle_events_type_check;
ALTER TABLE subscription_lifecycle_events
  ADD CONSTRAINT subscription_lifecycle_events_type_check CHECK (
    event_type IN (
      'activated', 'renewed', 'grace_started', 'expired', 'cancelled',
      'trial_started', 'trial_expired', 'trial_extended', 'trial_ended', 'trial_converted', 'trial_granted'
    )
  );

CREATE TABLE IF NOT EXISTS email_verification_tokens (
  id text PRIMARY KEY,
  user_id integer NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  expires_at timestamp NOT NULL,
  used_at timestamp,
  created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS email_verification_tokens_hash_idx ON email_verification_tokens(token_hash);
CREATE INDEX IF NOT EXISTS email_verification_tokens_user_idx ON email_verification_tokens(user_id, created_at);

CREATE TABLE IF NOT EXISTS trial_claims (
  id text PRIMARY KEY,
  user_id integer NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  canonical_email text NOT NULL,
  trial_subscription_id text NOT NULL REFERENCES user_subscriptions(id) ON DELETE RESTRICT,
  started_at timestamp NOT NULL,
  converted_at timestamp,
  paid_starts_at timestamp,
  ip_signal_hash text,
  device_signal_hash text,
  manual_override boolean NOT NULL DEFAULT false,
  created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT trial_claims_user_uidx UNIQUE (user_id),
  CONSTRAINT trial_claims_canonical_email_uidx UNIQUE (canonical_email)
);
CREATE INDEX IF NOT EXISTS trial_claims_started_idx ON trial_claims(started_at);
CREATE INDEX IF NOT EXISTS trial_claims_converted_idx ON trial_claims(converted_at);

CREATE TABLE IF NOT EXISTS free_trial_message_steps (
  id text PRIMARY KEY,
  timing text NOT NULL,
  offset_days integer NOT NULL DEFAULT 0,
  channels jsonb NOT NULL DEFAULT '[]'::jsonb,
  title_template text NOT NULL,
  body_template text NOT NULL,
  message_type text NOT NULL DEFAULT 'important',
  action_label text,
  action_plan_key text,
  coupon_code text,
  email_marketing boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active',
  version integer NOT NULL DEFAULT 1,
  created_by integer REFERENCES employees(id) ON DELETE SET NULL,
  updated_by integer REFERENCES employees(id) ON DELETE SET NULL,
  created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  archived_at timestamp,
  CONSTRAINT free_trial_message_steps_timing_check CHECK (timing IN ('after_start', 'before_end', 'at_end', 'after_end')),
  CONSTRAINT free_trial_message_steps_offset_check CHECK (offset_days >= 0 AND offset_days <= 90),
  CONSTRAINT free_trial_message_steps_status_check CHECK (status IN ('active', 'paused', 'archived')),
  CONSTRAINT free_trial_message_steps_version_check CHECK (version >= 1)
);
CREATE INDEX IF NOT EXISTS free_trial_message_steps_status_idx
  ON free_trial_message_steps(status, timing, offset_days);

-- Broadcast and price audiences can now target an active trial or a recently
-- ended trial. The configurable N-day window is server-owned trial settings.
ALTER TABLE broadcast_messages DROP CONSTRAINT IF EXISTS broadcast_messages_audience_check;
ALTER TABLE broadcast_messages
  ADD CONSTRAINT broadcast_messages_audience_check CHECK (
    audience IN ('all', 'guests', 'free', 'vip', 'expiring', 'new_users', 'trial', 'trial_expired_recently')
  );

COMMIT;
