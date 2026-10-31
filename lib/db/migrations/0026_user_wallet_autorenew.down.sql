-- 0026_user_wallet_autorenew.down.sql
-- Roll back the wallet + auto-renewal tables. These are the only objects this
-- migration created; nothing else in the schema references them, so the drop
-- order is: renewal state, ledger, then balances.
DROP TABLE IF EXISTS subscription_renewals;
DROP TABLE IF EXISTS wallet_transactions;
DROP TABLE IF EXISTS user_wallets;
