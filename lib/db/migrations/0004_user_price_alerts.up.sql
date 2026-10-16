-- Pending, reversible migration for server-evaluated user price alerts.
-- Do NOT apply without the approved Preview/Test database backup workflow.

CREATE TABLE IF NOT EXISTS user_price_alerts (
  id text PRIMARY KEY,
  user_id integer NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  instrument_id text NOT NULL,
  symbol text NOT NULL,
  condition text NOT NULL,
  target_value numeric(18, 6) NOT NULL,
  email_enabled boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active',
  last_evaluated_at timestamp,
  triggered_at timestamp,
  trigger_value numeric(18, 6),
  trigger_source text,
  trigger_as_of timestamp,
  email_status text NOT NULL DEFAULT 'not_requested',
  email_sent_at timestamp,
  archived_at timestamp,
  created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT user_price_alerts_condition_check CHECK (condition IN ('price_above', 'price_below', 'change_percent_above', 'change_percent_below')),
  CONSTRAINT user_price_alerts_target_check CHECK (target_value <> 0),
  CONSTRAINT user_price_alerts_status_check CHECK (status IN ('active', 'triggered', 'archived')),
  CONSTRAINT user_price_alerts_email_status_check CHECK (email_status IN ('not_requested', 'pending', 'sent', 'failed', 'unavailable'))
);

CREATE UNIQUE INDEX IF NOT EXISTS user_price_alerts_active_rule_uidx
  ON user_price_alerts(user_id, symbol, condition, target_value);
CREATE INDEX IF NOT EXISTS user_price_alerts_status_idx
  ON user_price_alerts(status, updated_at);
CREATE INDEX IF NOT EXISTS user_price_alerts_user_status_idx
  ON user_price_alerts(user_id, status);
