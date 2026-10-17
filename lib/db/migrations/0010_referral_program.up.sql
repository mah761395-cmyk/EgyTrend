-- Configurable referral program. Pending local migration only: apply after a
-- verified backup and an approved maintenance window. It creates durable rule
-- snapshots/ledger rows so campaign edits never rewrite past attribution.
BEGIN;

ALTER TABLE coupons
  ADD COLUMN IF NOT EXISTS owner_user_id integer,
  ADD COLUMN IF NOT EXISTS referral_reward_id text,
  ADD COLUMN IF NOT EXISTS first_subscription_only boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS renewal_only boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS auto_apply boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS coupons_referral_reward_idx ON coupons(referral_reward_id);
CREATE INDEX IF NOT EXISTS coupons_owner_auto_apply_idx ON coupons(owner_user_id, auto_apply, is_active);

ALTER TABLE payment_requests
  ADD COLUMN IF NOT EXISTS sender_phone text,
  ADD COLUMN IF NOT EXISTS proof_hash text,
  ADD COLUMN IF NOT EXISTS referral_reward_id text;
CREATE INDEX IF NOT EXISTS payment_requests_proof_hash_idx ON payment_requests(proof_hash);
CREATE INDEX IF NOT EXISTS payment_requests_referral_reward_idx ON payment_requests(referral_reward_id);

CREATE TABLE IF NOT EXISTS referral_program_settings (
  id text PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT false,
  attribution_cookie_days integer NOT NULL DEFAULT 30,
  terms_text text NOT NULL DEFAULT '',
  updated_by integer REFERENCES employees(id) ON DELETE SET NULL,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT referral_program_settings_cookie_days_check CHECK (attribution_cookie_days BETWEEN 1 AND 90)
);

CREATE TABLE IF NOT EXISTS referral_campaigns (
  id text PRIMARY KEY,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'paused',
  priority integer NOT NULL DEFAULT 0,
  starts_at timestamp with time zone,
  ends_at timestamp with time zone,
  qualification_event text NOT NULL DEFAULT 'first_paid',
  hold_days integer NOT NULL DEFAULT 7,
  referrer_reward_type text NOT NULL,
  referrer_reward_value integer NOT NULL,
  referrer_reward_cost integer,
  invitee_reward_type text NOT NULL DEFAULT 'first_subscription_percent',
  invitee_reward_value integer NOT NULL DEFAULT 0,
  invitee_reward_cost integer,
  max_referrer_monthly integer,
  max_referrer_total integer,
  created_by integer REFERENCES employees(id) ON DELETE SET NULL,
  updated_by integer REFERENCES employees(id) ON DELETE SET NULL,
  archived_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT referral_campaigns_status_check CHECK (status IN ('active', 'paused', 'archived')),
  CONSTRAINT referral_campaigns_event_check CHECK (qualification_event IN ('email_verified', 'trial_started', 'first_paid')),
  CONSTRAINT referral_campaigns_hold_check CHECK (hold_days BETWEEN 0 AND 90),
  CONSTRAINT referral_campaigns_priority_check CHECK (priority BETWEEN -1000 AND 1000),
  CONSTRAINT referral_campaigns_referrer_value_check CHECK (referrer_reward_value > 0),
  CONSTRAINT referral_campaigns_invitee_value_check CHECK (invitee_reward_value >= 0),
  CONSTRAINT referral_campaigns_schedule_check CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS referral_campaigns_schedule_idx ON referral_campaigns(status, starts_at, ends_at, priority);

CREATE TABLE IF NOT EXISTS referral_tiers (
  id text PRIMARY KEY,
  campaign_id text NOT NULL REFERENCES referral_campaigns(id) ON DELETE RESTRICT,
  threshold integer NOT NULL,
  reward_type text NOT NULL,
  reward_value integer NOT NULL,
  reward_cost integer,
  status text NOT NULL DEFAULT 'active',
  created_by integer REFERENCES employees(id) ON DELETE SET NULL,
  updated_by integer REFERENCES employees(id) ON DELETE SET NULL,
  archived_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT referral_tiers_threshold_check CHECK (threshold > 0),
  CONSTRAINT referral_tiers_value_check CHECK (reward_value > 0),
  CONSTRAINT referral_tiers_status_check CHECK (status IN ('active', 'paused', 'archived')),
  CONSTRAINT referral_tiers_campaign_threshold_uidx UNIQUE (campaign_id, threshold)
);
CREATE INDEX IF NOT EXISTS referral_tiers_campaign_status_idx ON referral_tiers(campaign_id, status);

CREATE TABLE IF NOT EXISTS referral_codes (
  id text PRIMARY KEY,
  code text NOT NULL,
  kind text NOT NULL DEFAULT 'user',
  owner_user_id integer REFERENCES app_users(id) ON DELETE SET NULL,
  campaign_id text REFERENCES referral_campaigns(id) ON DELETE SET NULL,
  rule_override jsonb,
  label text,
  status text NOT NULL DEFAULT 'active',
  expires_at timestamp with time zone,
  commission_due integer NOT NULL DEFAULT 0,
  commission_notes text,
  created_by integer REFERENCES employees(id) ON DELETE SET NULL,
  updated_by integer REFERENCES employees(id) ON DELETE SET NULL,
  disabled_at timestamp with time zone,
  archived_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT referral_codes_code_uidx UNIQUE (code),
  CONSTRAINT referral_codes_kind_check CHECK (kind IN ('user', 'special')),
  CONSTRAINT referral_codes_status_check CHECK (status IN ('active', 'disabled', 'archived')),
  CONSTRAINT referral_codes_commission_check CHECK (commission_due >= 0)
);
CREATE INDEX IF NOT EXISTS referral_codes_campaign_status_idx ON referral_codes(campaign_id, status, expires_at);
CREATE INDEX IF NOT EXISTS referral_codes_owner_user_idx ON referral_codes(owner_user_id);
-- Allows a user-owned ordinary code plus any number of partner codes/history,
-- while making concurrent normal-code allocation unable to create two active links.
CREATE UNIQUE INDEX IF NOT EXISTS referral_codes_active_user_owner_uidx
  ON referral_codes(owner_user_id)
  WHERE kind = 'user' AND status = 'active' AND archived_at IS NULL;

CREATE TABLE IF NOT EXISTS referral_attributions (
  id text PRIMARY KEY,
  invited_user_id integer NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  referrer_user_id integer REFERENCES app_users(id) ON DELETE SET NULL,
  code_id text NOT NULL REFERENCES referral_codes(id) ON DELETE RESTRICT,
  campaign_id text NOT NULL REFERENCES referral_campaigns(id) ON DELETE RESTRICT,
  code_snapshot text NOT NULL,
  rule_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'registered',
  review_status text NOT NULL DEFAULT 'not_required',
  email_verified_at timestamp with time zone,
  trial_started_at timestamp with time zone,
  first_paid_at timestamp with time zone,
  payment_request_id text,
  ip_signal_hash text,
  device_signal_hash text,
  suspicious boolean NOT NULL DEFAULT false,
  blocked_reason text,
  review_reason text,
  reviewed_by integer REFERENCES employees(id) ON DELETE SET NULL,
  reviewed_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT referral_attributions_invited_user_uidx UNIQUE (invited_user_id),
  CONSTRAINT referral_attributions_status_check CHECK (status IN ('registered', 'qualified', 'review', 'blocked', 'cancelled')),
  CONSTRAINT referral_attributions_review_check CHECK (review_status IN ('not_required', 'pending', 'approved', 'rejected'))
);
CREATE INDEX IF NOT EXISTS referral_attributions_referrer_idx ON referral_attributions(referrer_user_id, created_at);
CREATE INDEX IF NOT EXISTS referral_attributions_review_idx ON referral_attributions(review_status, created_at);
CREATE INDEX IF NOT EXISTS referral_attributions_code_idx ON referral_attributions(code_id, created_at);

CREATE TABLE IF NOT EXISTS referral_review_signals (
  id text PRIMARY KEY,
  attribution_id text NOT NULL REFERENCES referral_attributions(id) ON DELETE CASCADE,
  signal_type text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT referral_review_signals_attribution_type_uidx UNIQUE (attribution_id, signal_type)
);
CREATE INDEX IF NOT EXISTS referral_review_signals_type_idx ON referral_review_signals(signal_type, created_at);

CREATE TABLE IF NOT EXISTS referral_rewards (
  id text PRIMARY KEY,
  attribution_id text REFERENCES referral_attributions(id) ON DELETE RESTRICT,
  campaign_id text NOT NULL REFERENCES referral_campaigns(id) ON DELETE RESTRICT,
  tier_id text REFERENCES referral_tiers(id) ON DELETE RESTRICT,
  recipient_user_id integer NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  recipient_role text NOT NULL,
  reward_type text NOT NULL,
  reward_value integer NOT NULL,
  estimated_cost integer,
  status text NOT NULL DEFAULT 'pending',
  qualification_event text NOT NULL,
  hold_until timestamp with time zone,
  payment_request_id text,
  coupon_id integer REFERENCES coupons(id) ON DELETE SET NULL,
  idempotency_key text NOT NULL,
  rule_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  grant_snapshot jsonb,
  reason text,
  granted_by integer REFERENCES employees(id) ON DELETE SET NULL,
  granted_at timestamp with time zone,
  cancelled_by integer REFERENCES employees(id) ON DELETE SET NULL,
  cancelled_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT referral_rewards_idempotency_uidx UNIQUE (idempotency_key),
  CONSTRAINT referral_rewards_status_check CHECK (status IN ('pending', 'eligible', 'granted', 'cancelled', 'withdrawn')),
  CONSTRAINT referral_rewards_value_check CHECK (reward_value >= 0)
);
CREATE INDEX IF NOT EXISTS referral_rewards_status_hold_idx ON referral_rewards(status, hold_until);
CREATE INDEX IF NOT EXISTS referral_rewards_recipient_idx ON referral_rewards(recipient_user_id, created_at);
CREATE INDEX IF NOT EXISTS referral_rewards_attribution_idx ON referral_rewards(attribution_id, created_at);

CREATE TABLE IF NOT EXISTS referral_reward_ledger (
  id text PRIMARY KEY,
  reward_id text NOT NULL REFERENCES referral_rewards(id) ON DELETE RESTRICT,
  action text NOT NULL,
  reason text,
  actor_employee_id integer REFERENCES employees(id) ON DELETE SET NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS referral_reward_ledger_reward_idx ON referral_reward_ledger(reward_id, created_at);

CREATE TABLE IF NOT EXISTS referral_message_templates (
  id text PRIMARY KEY,
  event_key text NOT NULL,
  channels jsonb NOT NULL DEFAULT '["in_app"]'::jsonb,
  title_template text NOT NULL,
  body_template text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  version integer NOT NULL DEFAULT 1,
  updated_by integer REFERENCES employees(id) ON DELETE SET NULL,
  archived_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT referral_message_templates_event_uidx UNIQUE (event_key),
  CONSTRAINT referral_message_templates_status_check CHECK (status IN ('active', 'paused', 'archived'))
);

CREATE TABLE IF NOT EXISTS referral_message_deliveries (
  id text PRIMARY KEY,
  delivery_key text NOT NULL,
  recipient_user_id integer NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  template_id text REFERENCES referral_message_templates(id) ON DELETE SET NULL,
  event_key text NOT NULL,
  notification_id text,
  email_status text NOT NULL DEFAULT 'not_requested',
  content_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT referral_message_deliveries_key_uidx UNIQUE (delivery_key)
);
CREATE INDEX IF NOT EXISTS referral_message_deliveries_recipient_idx ON referral_message_deliveries(recipient_user_id, created_at);

CREATE TABLE IF NOT EXISTS referral_click_events (
  id text PRIMARY KEY,
  code_id text NOT NULL REFERENCES referral_codes(id) ON DELETE RESTRICT,
  campaign_id text REFERENCES referral_campaigns(id) ON DELETE SET NULL,
  visitor_signal_hash text,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS referral_click_events_campaign_idx ON referral_click_events(campaign_id, created_at);
CREATE INDEX IF NOT EXISTS referral_click_events_code_idx ON referral_click_events(code_id, created_at);

COMMIT;
