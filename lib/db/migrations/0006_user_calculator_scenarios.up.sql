-- Additive, server-owned persistence for VIP investor calculators.
-- Do not run this against a production database without the approved backup and
-- migration window. The current code-only change intentionally does not apply it.

CREATE TABLE IF NOT EXISTS user_calculator_scenarios (
  id text PRIMARY KEY,
  user_id integer NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  calculator_key text NOT NULL,
  name text NOT NULL,
  inputs jsonb NOT NULL,
  result jsonb NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  archived_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CHECK (char_length(name) BETWEEN 1 AND 80)
);

CREATE INDEX IF NOT EXISTS user_calculator_scenarios_user_updated_idx
  ON user_calculator_scenarios (user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS user_calculator_scenarios_user_status_idx
  ON user_calculator_scenarios (user_id, status);

CREATE TABLE IF NOT EXISTS user_calculator_activity (
  id text PRIMARY KEY,
  user_id integer NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  calculator_key text NOT NULL,
  action text NOT NULL CHECK (action IN ('saved', 'copied', 'exported', 'calculated')),
  inputs jsonb NOT NULL,
  result jsonb NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  archived_at timestamp,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS user_calculator_activity_user_created_idx
  ON user_calculator_activity (user_id, created_at DESC);
