-- Admin broadcasts / announcements.
-- PENDING: do not run on a shared or production database without an approved,
-- verified backup and a maintenance window. This migration is additive and
-- does not send e-mail, publish content, or alter any existing entitlement.

BEGIN;

ALTER TABLE app_users
  ADD COLUMN IF NOT EXISTS marketing_email_opt_in boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS marketing_email_opted_in_at timestamptz,
  ADD COLUMN IF NOT EXISTS marketing_email_unsubscribed_at timestamptz;

CREATE TABLE IF NOT EXISTS broadcast_media (
  id text PRIMARY KEY,
  mime_type text NOT NULL,
  data_url text NOT NULL,
  size_bytes integer NOT NULL,
  created_by integer NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  archived_at timestamptz,
  CONSTRAINT broadcast_media_mime_check CHECK (mime_type IN ('image/png', 'image/jpeg', 'image/webp')),
  CONSTRAINT broadcast_media_size_check CHECK (size_bytes > 0 AND size_bytes <= 180000)
);
CREATE INDEX IF NOT EXISTS broadcast_media_created_idx ON broadcast_media(created_at);

CREATE TABLE IF NOT EXISTS broadcast_messages (
  id text PRIMARY KEY,
  title text NOT NULL,
  content jsonb NOT NULL,
  message_type text NOT NULL,
  audience text NOT NULL DEFAULT 'all',
  priority integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'draft',
  starts_at timestamptz,
  ends_at timestamptz,
  image_media_id text REFERENCES broadcast_media(id) ON DELETE SET NULL,
  action jsonb NOT NULL DEFAULT '{"kind":"none"}'::jsonb,
  variable_plan_key text,
  marketing_email_requested boolean NOT NULL DEFAULT false,
  marketing_email_confirmed_at timestamptz,
  created_by integer NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  updated_by integer REFERENCES employees(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  archived_at timestamptz,
  CONSTRAINT broadcast_messages_type_check CHECK (message_type IN ('offer', 'greeting', 'new_feature', 'maintenance', 'important')),
  CONSTRAINT broadcast_messages_audience_check CHECK (audience IN ('all', 'guests', 'free', 'vip', 'expiring', 'new_users')),
  CONSTRAINT broadcast_messages_status_check CHECK (status IN ('draft', 'published', 'paused', 'archived')),
  CONSTRAINT broadcast_messages_priority_check CHECK (priority BETWEEN -1000 AND 1000),
  CONSTRAINT broadcast_messages_window_check CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS broadcast_messages_schedule_idx ON broadcast_messages(status, starts_at, ends_at);
CREATE INDEX IF NOT EXISTS broadcast_messages_audience_idx ON broadcast_messages(audience, status);
CREATE INDEX IF NOT EXISTS broadcast_messages_created_idx ON broadcast_messages(created_at);

CREATE TABLE IF NOT EXISTS broadcast_message_user_states (
  id text PRIMARY KEY,
  message_id text NOT NULL REFERENCES broadcast_messages(id) ON DELETE RESTRICT,
  user_id integer NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  seen_at timestamptz NOT NULL,
  closed_at timestamptz,
  do_not_show_again_at timestamptz,
  cta_clicked_at timestamptz,
  coupon_copied_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS broadcast_message_user_states_message_user_uidx
  ON broadcast_message_user_states(message_id, user_id);
CREATE INDEX IF NOT EXISTS broadcast_message_user_states_message_idx
  ON broadcast_message_user_states(message_id, seen_at);
CREATE INDEX IF NOT EXISTS broadcast_message_user_states_user_idx
  ON broadcast_message_user_states(user_id, seen_at);

CREATE TABLE IF NOT EXISTS broadcast_test_deliveries (
  id text PRIMARY KEY,
  message_id text NOT NULL REFERENCES broadcast_messages(id) ON DELETE RESTRICT,
  employee_id integer NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS broadcast_test_deliveries_message_idx
  ON broadcast_test_deliveries(message_id, created_at);

COMMIT;
