#!/usr/bin/env node
/**
 * Restores a dated database snapshot (egytrend_backup_<timestamp> schema —
 * the on-demand/cron backup produced by POST /api/admin/backups and the
 * /api/backups/cron job, plus pre-migration snapshots).
 *
 * Safety model (TASK L: no restore of production data without explicit
 * permission — the permission is THIS explicit, confirmed CLI invocation):
 *
 *   • the target schema MUST start with `egytrend_backup_` — no other
 *     schema can ever be touched;
 *   • `--dry-run` (the default for any analysis) reads only: it prints the
 *     live vs backup row counts and the plan, changes nothing;
 *   • `--confirm-restore` performs the restore, and FIRST takes a fresh
 *     safety snapshot of the current public schema
 *     (`egytrend_prestore_<timestamp>`), so the restore itself is
 *     reversible the same way;
 *   • per table: DELETE FROM public.<t> then INSERT ... SELECT * FROM
 *     <schema>.<t> (row-for-row, exactly what the snapshot mechanism
 *     documents as restorable), followed by a row-count verification.
 *
 * Credentials come from DATABASE_URL only — never from arguments, and they
 * are redacted from every log line.
 *
 * Commands:
 *   DATABASE_URL=... node scripts/restore-from-backup.mjs --list
 *   DATABASE_URL=... node scripts/restore-from-backup.mjs --schema <name> --dry-run
 *   DATABASE_URL=... node scripts/restore-from-backup.mjs --schema <name> --confirm-restore
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(ROOT, "lib", "db", "package.json"));
const { Client } = require("pg");

const BACKUP_PREFIX = "egytrend_backup_";
const PRESTORE_PREFIX = "egytrend_prestore_";

function usage() {
  console.log(`Usage:
  DATABASE_URL=postgresql://... node scripts/restore-from-backup.mjs --list
  DATABASE_URL=postgresql://... node scripts/restore-from-backup.mjs --schema egytrend_backup_20261029T012006 --dry-run
  DATABASE_URL=postgresql://... node scripts/restore-from-backup.mjs --schema egytrend_backup_20261029T012006 --confirm-restore

  --list             Show the backup ledger and all backup schemas (read-only).
  --dry-run          Print the restore plan (read-only, the safe default).
  --confirm-restore  Perform the restore (takes a fresh pre-restore snapshot first).`);
}

function redact(message) {
  return String(message)
    .replace(/(?:postgres(?:ql)?:\/\/)[^\s'"]+/gi, "<database-url-redacted>")
    .replace(/password\s*=\s*[^\s,;]+/gi, "password=<redacted>")
    .trim()
    .slice(0, 1200);
}

function q(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function timestampSlug() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "");
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h") || !args.length) {
    usage();
    if (!args.length) process.exitCode = 1;
    return;
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is required; refusing to guess a target database.");
    process.exitCode = 1;
    return;
  }

  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 15_000 });
  await client.connect();

  try {
    const listIdx = args.indexOf("--list");
    const schemaIdx = args.indexOf("--schema");
    const confirm = args.includes("--confirm-restore");

    if (listIdx !== -1) {
      await listBackups(client);
      return;
    }
    if (schemaIdx === -1) {
      usage();
      process.exitCode = 1;
      return;
    }
    const schema = String(args[schemaIdx + 1] || "");
    if (!schema.startsWith(BACKUP_PREFIX)) {
      throw new Error(`refusing to operate on schema ${JSON.stringify(schema)}: only ${BACKUP_PREFIX}* snapshot schemas are allowed`);
    }

    const schemaExists = (await client.query(`SELECT 1 FROM pg_namespace WHERE nspname = $1`, [schema])).rows.length > 0;
    if (!schemaExists) {
      throw new Error(`snapshot schema does not exist in this database: ${schema}`);
    }

    const tablesRes = await client.query(
      `SELECT tablename FROM pg_tables WHERE schemaname = $1 AND tablename <> '_pre_migration_drift' ORDER BY tablename`,
      [schema],
    );
    const tables = tablesRes.rows.map((r) => String(r.tablename));
    if (!tables.length) throw new Error(`snapshot schema ${schema} contains no tables`);

    const plan = [];
    for (const t of tables) {
      const live = Number((await client.query(`SELECT count(*)::int AS c FROM public.${q(t)}`)).rows[0]?.c ?? -1);
      const backup = Number((await client.query(`SELECT count(*)::int AS c FROM ${q(schema)}.${q(t)}`)).rows[0]?.c ?? -1);
      plan.push({ table: t, live, backup, match: live === backup });
    }

    const mismatches = plan.filter((p) => !p.match);
    console.log(`Snapshot: ${schema} (${tables.length} tables)`);
    for (const p of plan) {
      console.log(`  ${p.table}: live=${p.live} backup=${p.backup}${p.match ? "" : "  MISMATCH"}`);
    }

    if (!confirm) {
      console.log("\nDRY RUN — nothing was changed.");
      console.log("To perform the restore, re-run with --confirm-restore. The restore");
      console.log("will FIRST snapshot the current public schema as");
      console.log(`${PRESTORE_PREFIX}<timestamp> so this operation stays reversible.`);
      if (mismatches.length) {
        console.log(`\nWARNING: ${mismatches.length} table(s) differ in row count (normal if data changed after the snapshot); the restore replaces live rows with the snapshot rows for ALL listed tables.`);
      }
      return;
    }

    /* ── Confirmed restore ─────────────────────────────────────────────── */
    const prestore = `${PRESTORE_PREFIX}${timestampSlug()}`;
    console.log(`\nTaking pre-restore safety snapshot: ${prestore}`);
    await client.query(`CREATE SCHEMA ${q(prestore)}`);
    const publicTables = (await client.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`)).rows.map((r) => String(r.tablename));
    for (const t of publicTables) {
      await client.query(`CREATE TABLE ${q(prestore)}.${q(t)} AS SELECT * FROM public.${q(t)}`);
    }

    console.log(`Restoring ${tables.length} table(s) from ${schema} ...`);
    for (const p of plan) {
      await client.query(`DELETE FROM public.${q(p.table)}`);
      await client.query(`INSERT INTO public.${q(p.table)} SELECT * FROM ${q(schema)}.${q(p.table)}`);
    }

    console.log("\nVerifying row counts after restore:");
    let failed = 0;
    for (const p of plan) {
      const live = Number((await client.query(`SELECT count(*)::int AS c FROM public.${q(p.table)}`)).rows[0]?.c ?? -1);
      const ok = live === p.backup;
      if (!ok) failed += 1;
      console.log(`  ${p.table}: now=${live} expected=${p.backup} ${ok ? "OK" : "FAILED"}`);
    }

    if (failed) {
      console.error(`\nFAILED: ${failed} table(s) did not match. Roll back with the pre-restore snapshot: ${prestore}`);
      process.exitCode = 1;
      return;
    }
    console.log(`\nOK: restore complete and verified. Pre-restore snapshot kept at ${prestore} (drop it manually once the restore is confirmed healthy).`);
  } catch (error) {
    console.error(`FATAL ${redact(error?.message || error)}`);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

async function listBackups(client) {
  const ledger = (await client.query(`SELECT * FROM db_backups ORDER BY created_at DESC LIMIT 20`)).rows;
  const schemas = (await client.query(`SELECT nspname FROM pg_namespace WHERE nspname LIKE 'egytrend_backup_%' ORDER BY nspname DESC`)).rows.map((r) => String(r.nspname));
  console.log("Backup schemas present in the database:");
  if (!schemas.length) console.log("  (none)");
  for (const s of schemas) {
    const count = Number((await client.query(`SELECT count(*)::int AS c FROM pg_tables WHERE schemaname = $1 AND tablename <> '_pre_migration_drift'`, [s])).rows[0]?.c ?? 0);
    console.log(`  ${s} (${count} tables)`);
  }
  console.log("\nBackup ledger (newest first):");
  if (!ledger.length) console.log("  (empty)");
  for (const row of ledger) {
    console.log(`  ${row.created_at}  ${row.schema_name}  tables=${row.table_count} kind=${row.kind} verified=${row.verified}${row.note ? ` note=${row.note}` : ""}`);
  }
}

main().catch((error) => {
  console.error(`FATAL ${redact(error?.message || error)}`);
  process.exitCode = 1;
});
