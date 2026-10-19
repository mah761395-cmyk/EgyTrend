/**
 * EgyTrend — recreate + seed the SECURITY TEST database.
 *
 * Safety rules honoured here:
 *   • the database is named `egytrend_test` and is DROPPED/recreated locally
 *   • it refuses to run against a non-local host or a database whose name does
 *     not end in `_test`, so production can never be reached by this script
 *   • it is only ever run explicitly (never from the app's boot path)
 *
 * Usage: node artifacts/api-server/test/setup-test-db.mjs
 *
 * Uses the `pg` driver rather than the psql client: this machine's PostgreSQL
 * installation ships server binaries only (no psql.exe).
 */
import crypto from "node:crypto";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
/* Resolve `pg` from the workspace package that actually depends on it. */
const requireFromDb = createRequire(path.join(root, "lib", "db", "package.json"));
const pg = requireFromDb("pg");

export const TEST_DB = "egytrend_test";
const PGHOST = process.env.PGHOST || "localhost";
const PGPORT = Number(process.env.PGPORT || 5432);
const PGUSER = process.env.PGUSER || "postgres";
const PGPASSWORD = process.env.PGPASSWORD || "";

const localHosts = new Set(["localhost", "127.0.0.1", "::1"]);
if (!localHosts.has(PGHOST)) throw new Error(`refusing to run against non-local host: ${PGHOST}`);
if (!/_test$/.test(TEST_DB)) throw new Error(`refusing to touch database ${TEST_DB}`);

export const TEST_DATABASE_URL = `postgres://${PGUSER}:${PGPASSWORD}@${PGHOST}:${PGPORT}/${TEST_DB}`;

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(pw, salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

export const TEST_USERS = {
  free: { phone: "01000000001", name: "Test Free", password: "Test12345!" },
  vip: { phone: "01000000002", name: "Test VIP", password: "Test12345!" },
};
export const TEST_ADMIN_PASSWORD = "TestAdmin123!";
export const VIP_DAILY_LIMIT = 2; // deliberately low: 2 seeded calls exhaust it

const baseSchema = fs.readFileSync(path.join(root, "scripts", "local-schema.sql"), "utf8");
const extraSchema = `
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS email text;
/* Keep the test database faithful to the drizzle schema: scripts/local-schema.sql
 * lagged behind (these columns were added to the real table by migrations), and
 * a stale column made the admin payments tab answer 500 with a SQL error. */
ALTER TABLE payment_requests ADD COLUMN IF NOT EXISTS proof_image text;
ALTER TABLE payment_requests ADD COLUMN IF NOT EXISTS proof_name text;
ALTER TABLE payment_requests ADD COLUMN IF NOT EXISTS decided_at timestamp;
CREATE TABLE IF NOT EXISTS password_resets (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  expires_at timestamp NOT NULL,
  used_at timestamp,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS user_notifications (
  id text PRIMARY KEY,
  phone text NOT NULL,
  kind text NOT NULL DEFAULT 'info',
  title text NOT NULL,
  body text NOT NULL,
  read_at timestamp,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS app_settings (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamp NOT NULL DEFAULT now()
);
`;
const seed = `
TRUNCATE app_users, employees, ai_config, ai_usage, payment_requests, audit_logs RESTART IDENTITY CASCADE;
INSERT INTO app_users (phone, name, password_hash, plan, vip_expires_at, status)
VALUES
  ('${TEST_USERS.free.phone}', '${TEST_USERS.free.name}', '${hashPassword(TEST_USERS.free.password)}', 'free', NULL, 'active'),
  ('${TEST_USERS.vip.phone}',  '${TEST_USERS.vip.name}',  '${hashPassword(TEST_USERS.vip.password)}',  'vip',  now() + interval '30 days', 'active');
INSERT INTO ai_config (analyzer_enabled, summary_enabled, rewriter_enabled, daily_request_limit)
VALUES (true, true, true, ${VIP_DAILY_LIMIT});
INSERT INTO ai_usage (user_id, request_type, tokens_estimate, created_at) VALUES
  ('${TEST_USERS.vip.phone}', 'chat', 120, now() - interval '1 hour'),
  ('${TEST_USERS.vip.phone}', 'chat', 130, now() - interval '2 hours');
`;

async function main() {
  const admin = new pg.Client({ host: PGHOST, port: PGPORT, user: PGUSER, password: PGPASSWORD, database: "postgres" });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE);`);
  await admin.query(`CREATE DATABASE ${TEST_DB};`);
  await admin.end();

  const db = new pg.Client({ host: PGHOST, port: PGPORT, user: PGUSER, password: PGPASSWORD, database: TEST_DB });
  await db.connect();
  await db.query(baseSchema);
  await db.query(extraSchema);
  await db.query(seed);
  const { rows } = await db.query("select phone, plan from app_users order by id;");
  await db.end();

  console.log(`✔ ${TEST_DB} recreated — ${rows.length} users: ${rows.map((r) => `${r.phone}/${r.plan}`).join(", ")}`);
  console.log(`  admin password: env ADMIN_PASSWORD | vip limit ${VIP_DAILY_LIMIT} (already exhausted)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
