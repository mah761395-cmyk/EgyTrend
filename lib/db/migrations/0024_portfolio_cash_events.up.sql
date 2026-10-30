-- 0024: portfolio cash events (deposits, withdrawals, dividends).
--
-- The ledger (0019) derives cash from trades only, plus a one-time
-- `starting_cash` setting. Real portfolios also receive cash from outside
-- the trade flow (deposits, dividends) and send cash out (withdrawals). This
-- migration records those events as an auditable ledger of their own, which
-- the API folds into the same cash computation server-side:
--
--   cash = starting_cash + Σ(deposits + dividends) − Σ(withdrawals)
--          + Σ(sell proceeds − fees) − Σ(buy costs + fees)
--
-- Every event is user-scoped, dated and soft-archived (archived_at) exactly
-- like trades — nothing is ever hard-deleted.
--
-- Additive only — no DROP, no ALTER of existing objects.

BEGIN;

CREATE TABLE IF NOT EXISTS portfolio_cash_events (
  id text PRIMARY KEY,
  user_id integer NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  -- 'deposit' (cash in), 'withdrawal' (cash out), 'dividend' (cash in from
  -- a held asset; instrument_id/symbol identify the paying asset when known).
  kind text NOT NULL,
  amount numeric(18,6) NOT NULL,
  instrument_id text,
  symbol text,
  trade_date date NOT NULL,
  note text,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (kind IN ('deposit', 'withdrawal', 'dividend')),
  CHECK (amount > 0)
);

CREATE INDEX IF NOT EXISTS portfolio_cash_events_user_date_idx
  ON portfolio_cash_events (user_id, trade_date);

COMMIT;
