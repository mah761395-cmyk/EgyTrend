-- 0012_auth_hardening (up)
--
-- Login attempt limits and session revocation need state that survives a
-- serverless instance. Both live in this database so no extra service is
-- required. ADDITIVE ONLY: two new tables, no existing table or row is read,
-- altered or deleted.
--
-- The API also creates these tables itself with CREATE TABLE IF NOT EXISTS on
-- first use (see lib/rate-limit.ts / lib/session-revocation.ts), so a
-- deployment without this migration keeps working; running it explicitly just
-- makes the schema part of the migration history.
BEGIN;

CREATE TABLE IF NOT EXISTS auth_rate_limits (
  bucket       text        PRIMARY KEY,
  hits         integer     NOT NULL DEFAULT 0,
  window_start timestamptz NOT NULL DEFAULT now()
);

-- Cleanup of expired windows scans by time.
CREATE INDEX IF NOT EXISTS auth_rate_limits_window_idx
  ON auth_rate_limits (window_start);

CREATE TABLE IF NOT EXISTS auth_session_revocations (
  scope      text        NOT NULL,
  subject    integer     NOT NULL,
  jti        text        NOT NULL DEFAULT '',
  revoked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, subject, jti)
);

-- Cleanup of revocations older than the longest token lifetime.
CREATE INDEX IF NOT EXISTS auth_session_revocations_time_idx
  ON auth_session_revocations (revoked_at);

COMMIT;
