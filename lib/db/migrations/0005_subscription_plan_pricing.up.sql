-- Pending, reversible migration for server-evaluated subscription pricing.
-- DO NOT apply to a shared or production database without the approved
-- Preview/Test backup workflow. See migrations/README.md.
--
-- Price changes are deliberately additive: existing plans and historical
-- payment requests remain intact. New requests receive their own immutable
-- price snapshot and configurable lock window.

BEGIN;

ALTER TABLE subscription_plans
  ADD COLUMN IF NOT EXISTS old_price integer,
  ADD COLUMN IF NOT EXISTS price_badge_mode text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS price_badge_text text;

DO $$
BEGIN
  /* NOT VALID preserves any legacy row for operator review while still
     enforcing a strictly positive amount on every new/updated plan row. */
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'subscription_plans_positive_price_check'
  ) THEN
    ALTER TABLE subscription_plans
      ADD CONSTRAINT subscription_plans_positive_price_check
      CHECK (price > 0) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'subscription_plans_old_price_check'
  ) THEN
    ALTER TABLE subscription_plans
      ADD CONSTRAINT subscription_plans_old_price_check
      CHECK (old_price IS NULL OR old_price > price);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'subscription_plans_price_badge_mode_check'
  ) THEN
    ALTER TABLE subscription_plans
      ADD CONSTRAINT subscription_plans_price_badge_mode_check
      CHECK (price_badge_mode IN ('none', 'auto', 'custom'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS plan_price_offers (
  id text PRIMARY KEY,
  plan_id integer NOT NULL REFERENCES subscription_plans(id) ON DELETE RESTRICT,
  audience text NOT NULL DEFAULT 'all',
  price integer NOT NULL,
  old_price integer,
  badge_mode text NOT NULL DEFAULT 'none',
  badge_text text,
  starts_at timestamptz,
  ends_at timestamptz,
  show_countdown boolean NOT NULL DEFAULT false,
  priority integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active',
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT plan_price_offers_positive_price_check CHECK (price > 0),
  CONSTRAINT plan_price_offers_old_price_check CHECK (old_price IS NULL OR old_price > price),
  CONSTRAINT plan_price_offers_badge_mode_check CHECK (badge_mode IN ('none', 'auto', 'custom')),
  CONSTRAINT plan_price_offers_schedule_check CHECK (starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at),
  CONSTRAINT plan_price_offers_status_check CHECK (status IN ('active', 'archived')),
  CONSTRAINT plan_price_offers_countdown_check CHECK (show_countdown = false OR ends_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS plan_price_offers_plan_status_idx
  ON plan_price_offers(plan_id, status, starts_at, ends_at);
CREATE INDEX IF NOT EXISTS plan_price_offers_audience_idx
  ON plan_price_offers(audience, status);

CREATE TABLE IF NOT EXISTS plan_price_change_logs (
  id text PRIMARY KEY,
  plan_id integer NOT NULL REFERENCES subscription_plans(id) ON DELETE RESTRICT,
  changed_by integer,
  changed_by_name text,
  changed_by_role text,
  change_type text NOT NULL DEFAULT 'pricing_update',
  before_state jsonb NOT NULL,
  after_state jsonb NOT NULL,
  reverted_at timestamptz,
  reverted_by integer,
  reverted_by_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE plan_price_change_logs
  ADD COLUMN IF NOT EXISTS changed_by_name text,
  ADD COLUMN IF NOT EXISTS reverted_by_name text;
CREATE INDEX IF NOT EXISTS plan_price_change_logs_plan_created_idx
  ON plan_price_change_logs(plan_id, created_at DESC);

ALTER TABLE payment_requests
  ADD COLUMN IF NOT EXISTS price_snapshot jsonb,
  ADD COLUMN IF NOT EXISTS price_locked_until timestamptz;
CREATE INDEX IF NOT EXISTS payment_requests_pending_price_lock_idx
  ON payment_requests(status, price_locked_until)
  WHERE status = 'pending';

COMMIT;
