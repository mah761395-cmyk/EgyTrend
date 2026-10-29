-- Rollback for 0022: drop the backup ledger.
-- The backup schema copies themselves are separate schemas (never dropped
-- here) — this only removes the bookkeeping table.

BEGIN;

DROP INDEX IF EXISTS db_backups_created_at_idx;
DROP TABLE IF EXISTS db_backups;

COMMIT;
