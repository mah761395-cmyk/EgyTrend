-- 0012_payment_tx_idempotency.down.sql
-- Reverses only the concurrency/idempotency guard. It does not delete payment
-- requests, proof metadata, price snapshots, or audit evidence.

DROP INDEX IF EXISTS payment_requests_tx_normalized_uidx;
