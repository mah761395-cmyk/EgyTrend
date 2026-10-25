-- 0012_auth_hardening (down)
--
-- Removes only the two tables this migration created. No user, employee,
-- payment, subscription or content data is touched.
--
-- After a rollback the running API simply recreates them on the next login
-- attempt (CREATE TABLE IF NOT EXISTS), so run this migration only when you
-- are intentionally removing the shared limiter/revocation state.
BEGIN;

DROP TABLE IF EXISTS auth_session_revocations;
DROP TABLE IF EXISTS auth_rate_limits;

COMMIT;
