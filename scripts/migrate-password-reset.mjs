// One-off schema migration: app_users.email + password_resets table.
// Idempotent (IF NOT EXISTS everywhere) — safe to re-run.
import fs from "fs";
import path from "path";
import { createRequire } from "module";
const { Client } = createRequire(path.resolve(import.meta.dir, "../lib/db/package.json"))("pg");

const DATABASE_URL = process.env.DATABASE_URL || "postgres://postgres@localhost:5432/egytrend";

const client = new Client({ connectionString: DATABASE_URL });
await client.connect();
await client.query(`
  ALTER TABLE app_users ADD COLUMN IF NOT EXISTS email text;
  CREATE INDEX IF NOT EXISTS idx_app_users_email ON app_users(email) WHERE email IS NOT NULL;
  CREATE TABLE IF NOT EXISTS password_resets (
    id serial PRIMARY KEY,
    user_id integer NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    token_hash text NOT NULL,
    expires_at timestamp NOT NULL,
    used_at timestamp,
    created_at timestamp DEFAULT now() NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_password_resets_token ON password_resets(token_hash);
`);
const { rows } = await client.query(
  `SELECT column_name FROM information_schema.columns WHERE table_name='app_users' AND column_name='email'`,
);
console.log("MIGRATION_OK — app_users.email:", rows.length ? "present" : "MISSING");
await client.end();
