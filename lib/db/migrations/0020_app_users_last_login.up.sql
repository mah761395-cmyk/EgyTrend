-- 0020: record each app user's last successful login.
--
-- Gives the admin user table a real "last login" value without touching any
-- existing row or behavior. The column is nullable: users who never logged in
-- (or who predate this migration) simply have no value — nothing is invented.
--
-- Additive only — no DROP, no ALTER of existing objects.

BEGIN;

ALTER TABLE app_users ADD COLUMN IF NOT EXISTS last_login_at timestamptz;

COMMIT;
