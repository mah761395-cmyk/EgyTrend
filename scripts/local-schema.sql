-- TEST-ONLY schema mirror (used by artifacts/api-server/test/setup-test-db.mjs).
-- PROVISIONING MUST NOT USE THIS FILE: the source of truth is lib/db/src/schema
-- plus the reviewed paired SQL files under lib/db/migrations (see
-- lib/db/migrations/README.md after a verified backup). It exists only to
-- recreate the throwaway `egytrend_test` database for the security tests.
-- EgyTrend schema (mirrors lib/db/src/schema/*)
CREATE TABLE IF NOT EXISTS app_users (
  id serial PRIMARY KEY,
  phone text NOT NULL UNIQUE,
  name text NOT NULL,
  password_hash text NOT NULL,
  plan text NOT NULL DEFAULT 'free',
  vip_expires_at timestamp,
  status text NOT NULL DEFAULT 'active',
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS employees (
  id serial PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  role text NOT NULL DEFAULT 'editor',
  status text NOT NULL DEFAULT 'active',
  password_hash text NOT NULL,
  permissions jsonb DEFAULT '[]',
  last_login timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS subscription_plans (
  id serial PRIMARY KEY,
  key text NOT NULL UNIQUE,
  name_ar text NOT NULL,
  price integer NOT NULL,
  duration_months integer NOT NULL,
  features jsonb DEFAULT '[]',
  is_active boolean DEFAULT true,
  badge text,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS coupons (
  id serial PRIMARY KEY,
  code text NOT NULL UNIQUE,
  discount_type text NOT NULL DEFAULT 'percent',
  discount_value integer NOT NULL,
  max_uses integer,
  used_count integer DEFAULT 0,
  is_active boolean DEFAULT true,
  starts_at timestamp,
  expires_at timestamp,
  created_by integer,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id serial PRIMARY KEY,
  action text NOT NULL,
  actor_id integer,
  actor_name text,
  actor_role text,
  target text,
  detail jsonb DEFAULT '{}',
  ip text,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_config (
  id serial PRIMARY KEY,
  analyzer_enabled boolean DEFAULT true,
  summary_enabled boolean DEFAULT true,
  rewriter_enabled boolean DEFAULT true,
  daily_request_limit integer DEFAULT 1000,
  updated_at timestamp NOT NULL DEFAULT now(),
  updated_by text
);

CREATE TABLE IF NOT EXISTS ai_usage (
  id serial PRIMARY KEY,
  user_id text,
  request_type text NOT NULL,
  tokens_estimate integer DEFAULT 0,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS opportunities (
  id varchar(50) PRIMARY KEY,
  title text NOT NULL,
  summary text NOT NULL,
  details text,
  type varchar(50) NOT NULL,
  market varchar(50) NOT NULL,
  expected_return varchar(100),
  risk_level integer NOT NULL DEFAULT 3,
  sector varchar(100),
  duration varchar(100),
  deadline varchar(100),
  status varchar(30) NOT NULL DEFAULT 'active',
  featured boolean NOT NULL DEFAULT false,
  vip_only boolean NOT NULL DEFAULT false,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payment_requests (
  id text PRIMARY KEY,
  phone text NOT NULL,
  name text NOT NULL,
  plan_key text NOT NULL,
  pay_method text NOT NULL DEFAULT '',
  price integer NOT NULL DEFAULT 0,
  tx text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  notes text,
  -- Payment proof (data URL + original name) and the admin decision time.
  -- These three columns were missing from this mirror, so a database created
  -- from it returned 500 on the admin payments tab (column does not exist).
  proof_image text,
  proof_name text,
  decided_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
