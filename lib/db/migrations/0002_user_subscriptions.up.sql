-- Reversible, pending migration: do NOT apply to a shared or production
-- database without a verified backup and an approved maintenance plan.
--
-- `app_users.plan` / `vip_expires_at` remain temporarily as a compatibility
-- projection. Authorization moves to this table once it exists; the legacy
-- projection is retained solely so a rollback never deletes paid-state data.

CREATE TABLE IF NOT EXISTS user_subscriptions (
  id text PRIMARY KEY,
  user_id integer NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  plan_key text NOT NULL,
  plan_name_ar text NOT NULL,
  plan_duration_months integer NOT NULL,
  plan_features jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'active',
  starts_at timestamp NOT NULL,
  expires_at timestamp NOT NULL,
  payment_request_id text,
  source text NOT NULL DEFAULT 'payment',
  cancelled_at timestamp,
  created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT user_subscriptions_status_check CHECK (status IN ('active', 'cancelled', 'expired')),
  CONSTRAINT user_subscriptions_positive_duration_check CHECK (plan_duration_months >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS user_subscriptions_user_id_uidx
  ON user_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS user_subscriptions_active_expiry_idx
  ON user_subscriptions(status, expires_at);

-- Safe one-way compatibility backfill. Rows with no recorded expiry are NOT
-- fabricated: they stay on the documented temporary legacy path until an
-- operator verifies their original entitlement. This protects current users
-- without inventing a renewal date.
INSERT INTO user_subscriptions (
  id, user_id, plan_key, plan_name_ar, plan_duration_months, plan_features,
  status, starts_at, expires_at, source, created_at, updated_at
)
SELECT
  'legacy-vip-' || u.id::text,
  u.id,
  'legacy-vip',
  'اشتراك VIP سابق',
  0,
  '[]'::jsonb,
  'active',
  COALESCE(u.updated_at, u.created_at, CURRENT_TIMESTAMP),
  u.vip_expires_at,
  'legacy_backfill',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM app_users AS u
WHERE u.status = 'active'
  AND u.plan = 'vip'
  AND u.vip_expires_at IS NOT NULL
  AND u.vip_expires_at > CURRENT_TIMESTAMP
ON CONFLICT (user_id) DO NOTHING;
