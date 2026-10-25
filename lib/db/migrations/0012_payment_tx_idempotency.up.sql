-- 0012_payment_tx_idempotency.up.sql
-- A payment-transfer reference is a server-side idempotency boundary. The
-- application performs a friendly pre-check, but only a unique database index
-- can close the concurrent-request race across server instances.
--
-- This migration intentionally refuses to guess which historic duplicate is
-- valid. Resolve/review duplicates in an approved maintenance window first;
-- then re-run from the verified backup/Preview procedure.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM payment_requests
    WHERE tx <> ''
    GROUP BY lower(tx)
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Cannot add payment transaction idempotency index: duplicate normalized tx references exist. Review them manually before migration.';
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS payment_requests_tx_normalized_uidx
  ON payment_requests (lower(tx))
  WHERE tx <> '';
