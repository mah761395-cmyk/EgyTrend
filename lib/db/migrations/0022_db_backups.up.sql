-- Ledger of on-demand/cron database snapshot backups (schema copies created
-- with the same mechanism as pre-migration snapshots). One row per backup.
-- `verified` records whether the post-copy row-count comparison passed: a
-- backup that was never verified is never reported as "last successful".
CREATE TABLE IF NOT EXISTS db_backups (
  id serial PRIMARY KEY,
  schema_name text NOT NULL,
  table_count integer NOT NULL DEFAULT 0,
  kind text NOT NULL DEFAULT 'manual',
  created_by text,
  verified boolean NOT NULL DEFAULT false,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS db_backups_created_at_idx ON db_backups (created_at DESC);
