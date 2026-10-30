-- Rollback for 0020: drop the last-login timestamp column.
-- Nothing else is affected.

BEGIN;

ALTER TABLE app_users DROP COLUMN IF EXISTS last_login_at;

COMMIT;
