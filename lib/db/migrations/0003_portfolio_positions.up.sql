-- Pending, reversible migration for server-backed user portfolio positions.
-- Do NOT apply without the approved Preview/Test database backup workflow.

CREATE TABLE IF NOT EXISTS portfolio_positions (
  id text PRIMARY KEY,
  user_id integer NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  instrument_id text NOT NULL,
  symbol text NOT NULL,
  quantity integer NOT NULL,
  average_cost numeric(18, 6) NOT NULL,
  currency text NOT NULL DEFAULT 'EGP',
  status text NOT NULL DEFAULT 'active',
  archived_at timestamp,
  created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT portfolio_positions_quantity_check CHECK (quantity > 0),
  CONSTRAINT portfolio_positions_average_cost_check CHECK (average_cost > 0),
  CONSTRAINT portfolio_positions_status_check CHECK (status IN ('active', 'archived'))
);

-- One aggregated active/archive record per user and canonical symbol. An
-- archive is deliberately retained and can be restored by an explicit update;
-- a portfolio row is never deleted by application code.
CREATE UNIQUE INDEX IF NOT EXISTS portfolio_positions_user_symbol_uidx
  ON portfolio_positions(user_id, symbol);
CREATE INDEX IF NOT EXISTS portfolio_positions_user_status_idx
  ON portfolio_positions(user_id, status);
