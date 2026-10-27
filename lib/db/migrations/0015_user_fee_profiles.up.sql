-- Additive: user-owned fee schedules for the fee-based trade calculator, and
-- the admin-managed fee item catalog seeded ONCE into app_settings. The seed
-- uses ON CONFLICT DO NOTHING, so an admin edit always wins. Do not run this
-- against a production database without the approved backup and migration
-- window.

CREATE TABLE IF NOT EXISTS user_fee_profiles (
  id text PRIMARY KEY,
  user_id integer NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  name text NOT NULL,
  items jsonb NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CHECK (char_length(name) BETWEEN 1 AND 60)
);

CREATE UNIQUE INDEX IF NOT EXISTS user_fee_profiles_user_name_uidx
  ON user_fee_profiles (user_id, name);
CREATE INDEX IF NOT EXISTS user_fee_profiles_user_status_idx
  ON user_fee_profiles (user_id, status);

-- Fee item catalog (names only — no rates): admins edit this row to change
-- which fee lines the calculator offers. Values are never defaulted here.
INSERT INTO app_settings (key, value, updated_at) VALUES (
  'calculator_fee_items',
  '[{"key":"broker_commission","labelAr":"عمولة الوساطة"},{"key":"exchange_fee","labelAr":"رسوم البورصة"},{"key":"cma_fee","labelAr":"رسوم الرقابة المالية"},{"key":"clearing_fee","labelAr":"رسوم مصر للمقاصة"},{"key":"stamp_duty","labelAr":"ضريبة الدمغة"}]',
  now()
) ON CONFLICT (key) DO NOTHING;
