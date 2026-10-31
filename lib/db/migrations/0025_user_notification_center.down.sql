-- Roll back the notification center tables (user-owned rows only; the shared
-- user_notifications table is untouched by this migration).
DROP INDEX IF EXISTS user_follows_phone_idx;
DROP TABLE IF EXISTS user_follows;
DROP TABLE IF EXISTS user_notification_prefs;
