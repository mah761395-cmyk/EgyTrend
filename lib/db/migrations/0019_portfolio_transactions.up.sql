-- 0019: per-trade portfolio ledger + user cash settings.
--
-- The legacy `portfolio_positions` table stores one aggregated row per
-- (user, symbol) with a user-typed average cost. It cannot express the
-- portfolio-management workflow: multiple buys/sells per symbol, per-trade
-- commissions, trade dates, realized P/L and cash liquidity. This migration
-- adds the transaction ledger and derives positions from it (moving-average
-- cost basis). The legacy table is intentionally left untouched so existing
-- user rows keep working; the API merges them as read-only legacy positions.
--
-- Additive only — no DROP, no ALTER of existing objects.

BEGIN;

CREATE TABLE IF NOT EXISTS portfolio_transactions (
  id text PRIMARY KEY,
  user_id integer NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  instrument_id text NOT NULL,
  symbol text NOT NULL,
  side text NOT NULL,
  quantity integer NOT NULL,
  price numeric(18,6) NOT NULL,
  fees numeric(18,6) NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'EGP',
  trade_date date NOT NULL,
  note text,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (side IN ('buy', 'sell')),
  CHECK (quantity > 0),
  CHECK (price > 0),
  CHECK (fees >= 0)
);

CREATE INDEX IF NOT EXISTS portfolio_transactions_user_date_idx
  ON portfolio_transactions (user_id, trade_date);

CREATE TABLE IF NOT EXISTS portfolio_settings (
  user_id integer PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
  starting_cash numeric(18,6) NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (starting_cash >= 0)
);

COMMIT;
