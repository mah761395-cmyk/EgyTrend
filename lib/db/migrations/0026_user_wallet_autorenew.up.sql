-- 0026_user_wallet_autorenew.up.sql
-- Pending, reversible migration: user wallet (stored value) + auto-renewal.
--
-- Three NEW tables. No existing table is altered, no existing data is read,
-- rewritten or deleted:
--   * user_wallets          — one stored-value balance per user (EGP integer)
--   * wallet_transactions   — append-only financial ledger (every credit and
--                             debit, with the resulting balance). The
--                             (ref_kind, ref_id) unique index is the
--                             authoritative double-operation guard: the same
--                             top-up or renewal slot can never post twice,
--                             even across concurrent server instances.
--   * subscription_renewals — the user's explicit auto-renewal consent and its
--                             state machine (active | disabled | expired).
--                             Disabling only stops future debits; the current
--                             paid term always runs to its stored end.
--
-- Balances are integers in the same unit as plan prices (EGP). No balance may
-- ever go negative: debits happen only inside a transaction that locks the
-- wallet row and checks the balance first. The wallet is only credited by an
-- explicit, admin-approved top-up request — never automatically from any
-- external payment method.
-- Do NOT apply without the approved Preview/Test database backup workflow.

CREATE TABLE IF NOT EXISTS user_wallets (
  user_id integer NOT NULL PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
  phone text NOT NULL,
  balance integer NOT NULL DEFAULT 0,
  created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT user_wallets_balance_nonnegative CHECK (balance >= 0)
);

CREATE TABLE IF NOT EXISTS wallet_transactions (
  id text NOT NULL PRIMARY KEY,
  user_id integer NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  phone text NOT NULL,
  -- topup | renewal_debit. Debits are the only balance-reducing kind.
  kind text NOT NULL,
  -- Positive absolute amount in EGP (direction is implied by `kind`).
  amount integer NOT NULL,
  -- The wallet balance immediately after this posting; auditable chain.
  balance_after integer NOT NULL,
  -- Which durable operation this posting belongs to.
  ref_kind text NOT NULL,
  ref_id text NOT NULL,
  note text,
  created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT wallet_transactions_kind_check CHECK (kind IN ('topup', 'renewal_debit')),
  CONSTRAINT wallet_transactions_amount_positive CHECK (amount > 0)
);

-- One posting per (ref_kind, ref_id): a top-up is credited exactly once and a
-- renewal slot is debited exactly once, whatever the retry or race.
CREATE UNIQUE INDEX IF NOT EXISTS wallet_transactions_ref_uidx
  ON wallet_transactions (ref_kind, ref_id);
CREATE INDEX IF NOT EXISTS wallet_transactions_user_idx
  ON wallet_transactions (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS subscription_renewals (
  id text NOT NULL PRIMARY KEY,
  user_id integer NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  phone text NOT NULL,
  plan_key text NOT NULL,
  plan_name_ar text NOT NULL,
  plan_duration_months integer NOT NULL,
  -- Display snapshot of the plan price when consent was (re)recorded. The
  -- actual debit amount is always the plan's current server price at renewal
  -- time, never this stored value.
  last_known_price integer NOT NULL DEFAULT 0,
  -- active | disabled | expired. Only `active` rows are ever debited.
  status text NOT NULL DEFAULT 'active',
  next_renewal_at timestamp with time zone,
  last_renewed_at timestamp with time zone,
  last_renewal_ref text,
  last_attempt_at timestamp with time zone,
  last_attempt_result text,
  -- Explicit consent capture.
  consent_at timestamp NOT NULL,
  -- checkout | settings
  consent_source text NOT NULL,
  disabled_at timestamp with time zone,
  created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT subscription_renewals_status_check CHECK (status IN ('active', 'disabled', 'expired')),
  CONSTRAINT subscription_renewals_consent_source_check CHECK (consent_source IN ('checkout', 'settings'))
);

CREATE UNIQUE INDEX IF NOT EXISTS subscription_renewals_user_uidx
  ON subscription_renewals (user_id);
