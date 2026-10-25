#!/usr/bin/env node
/**
 * Deliberate, Preview/Test-only runner for one paired SQL migration.
 *
 * It never accepts a production environment, requires a verified pg_dump
 * backup file outside the build artifact, requires the matching down script,
 * and records only successfully applied up migrations in a small ledger.
 * Production changes remain an approved operator action after a documented
 * backup, maintenance window, and rollback review.
 *
 * Example (Preview/Test only):
 *   DATABASE_URL=... node scripts/run-db-migration.mjs \
 *     --environment preview --migration 0001_market_daily_ohlc \
 *     --direction up --backup /secure/path/egytrend.sql.gz --yes-apply
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const MIGRATIONS_DIR = path.join(ROOT, "lib", "db", "migrations");
const require = createRequire(path.join(ROOT, "lib", "db", "package.json"));
const { Client } = require("pg");

function fail(message) {
  console.error(`Refusing database migration: ${message}`);
  process.exitCode = 1;
}

function readFlag(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || "").trim() : "";
}

const environment = readFlag("--environment").toLowerCase();
const migration = readFlag("--migration");
const direction = readFlag("--direction").toLowerCase();
const backup = readFlag("--backup");
const confirmed = process.argv.includes("--yes-apply");

if (!process.env.DATABASE_URL) fail("DATABASE_URL is required and is intentionally never printed.");
else if (process.env.NODE_ENV === "production" || environment === "production") fail("the built-in runner is Preview/Test-only; production needs an approved operator runbook.");
else if (!['preview', 'test'].includes(environment)) fail("pass --environment preview or --environment test.");
else if (!/^\d{4}_[a-z0-9_]+$/i.test(migration)) fail("pass an exact migration ID such as 0001_market_daily_ohlc.");
else if (!['up', 'down'].includes(direction)) fail("pass --direction up or --direction down.");
else if (!backup || !path.isAbsolute(backup)) fail("pass an absolute --backup path created outside this repository/artifact.");
else if (!confirmed) fail("review the paired SQL then repeat with --yes-apply.");
else {
  const backupPath = path.resolve(backup);
  const upPath = path.join(MIGRATIONS_DIR, `${migration}.up.sql`);
  const downPath = path.join(MIGRATIONS_DIR, `${migration}.down.sql`);
  const sqlPath = direction === "up" ? upPath : downPath;
  try {
    if (!fs.statSync(backupPath).isFile() || fs.statSync(backupPath).size < 64) throw new Error("backup file is missing or implausibly small");
    if (!fs.statSync(upPath).isFile() || !fs.statSync(downPath).isFile()) throw new Error("both .up.sql and .down.sql must exist");
    const verify = spawnSync(process.execPath, [path.join(HERE, "backup-db.mjs"), "--verify", backupPath], {
      cwd: ROOT,
      stdio: "inherit",
      env: process.env,
    });
    if (verify.status !== 0) throw new Error("backup verification failed");
    const sql = fs.readFileSync(sqlPath, "utf8");
    if (!sql.trim()) throw new Error("selected SQL file is empty");

    const client = new Client({ connectionString: process.env.DATABASE_URL, application_name: "egytrend-safe-migration-runner" });
    try {
      await client.connect();
      await client.query("SELECT pg_advisory_lock(843912608)");
      await client.query(`
        CREATE TABLE IF NOT EXISTS _egytrend_schema_migrations (
          migration_id text PRIMARY KEY,
          applied_at timestamptz NOT NULL DEFAULT now(),
          applied_by text NOT NULL DEFAULT 'safe-preview-runner'
        )
      `);
      const existing = await client.query("SELECT migration_id FROM _egytrend_schema_migrations WHERE migration_id = $1", [migration]);
      if (direction === "up" && existing.rowCount) throw new Error("migration is already recorded as applied");
      if (direction === "down" && !existing.rowCount) throw new Error("migration is not recorded as applied; refuse an untracked rollback");

      // Reviewed migration files own their BEGIN/COMMIT boundaries. Do not wrap
      // them in a second transaction; execution stops on the first SQL error.
      await client.query(sql);
      if (direction === "up") {
        await client.query("INSERT INTO _egytrend_schema_migrations (migration_id) VALUES ($1)", [migration]);
      } else {
        await client.query("DELETE FROM _egytrend_schema_migrations WHERE migration_id = $1", [migration]);
      }
      console.log(`Migration ${migration} ${direction} completed on the declared ${environment} database.`);
    } finally {
      try { await client.query("SELECT pg_advisory_unlock(843912608)"); } catch { /* connection may already be closed */ }
      await client.end();
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : "unknown migration error");
  }
}
