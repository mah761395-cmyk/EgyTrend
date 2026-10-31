-- Pending, reversible migration for the in-platform notification center.
-- Two user-owned tables: per-user delivery preferences (which ambient
-- notification families are wanted) and the followed EGX symbols that news
-- matching uses. Notification rows themselves reuse user_notifications
-- (created in the earlier payment-lifecycle work).
-- Do NOT apply without the approved Preview/Test database backup workflow.

CREATE TABLE IF NOT EXISTS user_notification_prefs (
  phone text NOT NULL,
  kind text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT user_notification_prefs_pk PRIMARY KEY (phone, kind),
  CONSTRAINT user_notification_prefs_kind_check CHECK (kind IN ('price', 'opps', 'news'))
);

CREATE TABLE IF NOT EXISTS user_follows (
  phone text NOT NULL,
  symbol text NOT NULL,
  created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT user_follows_pk PRIMARY KEY (phone, symbol)
);

CREATE INDEX IF NOT EXISTS user_follows_phone_idx ON user_follows(phone);
