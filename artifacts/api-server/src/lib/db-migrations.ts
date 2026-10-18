import { pool } from "@workspace/db";
import { logger } from "./logger";
import { sqlStateOf } from "./dbErrors";
import { migrationChecksum, plannedObjects, quoteIdent } from "./db-migration-plan";
import {
  MIGRATION_IDS,
  autoMigrateEnabled,
  emptyMigrationReport,
  setMigrationReport,
  type AppliedMigration,
  type DriftedObject,
  type MigrationReport,
} from "./db-migration-state";

/* The reviewed, paired SQL migrations under lib/db/migrations are inlined at
 * bundle time (esbuild `text` loader) so the deployed function carries the
 * exact SQL that was reviewed in the repository — no runtime file access. */
import up0001 from "../../../../lib/db/migrations/0001_market_daily_ohlc.up.sql";
import up0002 from "../../../../lib/db/migrations/0002_user_subscriptions.up.sql";
import up0003 from "../../../../lib/db/migrations/0003_portfolio_positions.up.sql";
import up0004 from "../../../../lib/db/migrations/0004_user_price_alerts.up.sql";
import up0005 from "../../../../lib/db/migrations/0005_subscription_plan_pricing.up.sql";
import up0006 from "../../../../lib/db/migrations/0006_user_calculator_scenarios.up.sql";
import up0007 from "../../../../lib/db/migrations/0007_subscription_lifecycle.up.sql";
import up0008 from "../../../../lib/db/migrations/0008_admin_broadcasts.up.sql";
import up0009 from "../../../../lib/db/migrations/0009_free_vip_trial.up.sql";
import up0010 from "../../../../lib/db/migrations/0010_referral_program.up.sql";
import up0011 from "../../../../lib/db/migrations/0011_user_onboarding.up.sql";
import up0012 from "../../../../lib/db/migrations/0012_payment_tx_idempotency.up.sql";

export type SqlMigration = { id: string; sql: string };

const SQL_BY_ID: Record<string, string> = {
  "0001_market_daily_ohlc": up0001,
  "0002_user_subscriptions": up0002,
  "0003_portfolio_positions": up0003,
  "0004_user_price_alerts": up0004,
  "0005_subscription_plan_pricing": up0005,
  "0006_user_calculator_scenarios": up0006,
  "0007_subscription_lifecycle": up0007,
  "0008_admin_broadcasts": up0008,
  "0009_free_vip_trial": up0009,
  "0010_referral_program": up0010,
  "0011_user_onboarding": up0011,
  "0012_payment_tx_idempotency": up0012,
};

export const SQL_MIGRATIONS: readonly SqlMigration[] = MIGRATION_IDS.map((id) => {
  const sql = SQL_BY_ID[id];
  if (!sql) throw new Error(`missing inlined SQL for migration ${id}`);
  return { id, sql };
});

/** Ledger shared with scripts/run-db-migration.mjs so a manual run and an
 * automatic run never disagree about what has already been applied. */
export const MIGRATION_LEDGER = "_egytrend_schema_migrations";
const MIGRATION_LOCK_ID = 843912608;
const SNAPSHOT_PREFIX = "egytrend_backup_";

type Queryable = { query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> };

type LedgerRow = {
  migration_id: string;
  applied_at: Date | string;
  applied_by: string;
  backup_schema: string | null;
  missing_before: DriftedObject[] | null;
};

function errorParts(error: unknown): { code: string; message: string } {
  if (!error || typeof error !== "object") return { code: "unknown", message: "unknown migration error" };
  const candidate = error as { code?: unknown; message?: unknown };
  return {
    code: sqlStateOf(error) ?? (typeof candidate.code === "string" ? candidate.code : "unknown"),
    /* The SQL comes from a reviewed file in this repository, so its diagnostic
     * message (object or constraint names) is safe and useful to report. */
    message: typeof candidate.message === "string" ? candidate.message.slice(0, 300) : "unknown migration error",
  };
}

async function ledgerExists(client: Queryable): Promise<boolean> {
  const result = await client.query(`SELECT to_regclass($1) IS NOT NULL AS present`, [`public.${MIGRATION_LEDGER}`]);
  return Boolean(result.rows[0]?.present);
}

async function ensureLedger(client: Queryable): Promise<void> {
  await client.query(`CREATE TABLE IF NOT EXISTS ${MIGRATION_LEDGER} (
    migration_id text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now(),
    applied_by text NOT NULL DEFAULT 'api-boot'
  )`);
  /* Rows written by scripts/run-db-migration.mjs stay valid: the evidence
   * columns are additive and nullable. */
  await client.query(`ALTER TABLE ${MIGRATION_LEDGER} ADD COLUMN IF NOT EXISTS backup_schema text`);
  await client.query(`ALTER TABLE ${MIGRATION_LEDGER} ADD COLUMN IF NOT EXISTS missing_before jsonb`);
  await client.query(`ALTER TABLE ${MIGRATION_LEDGER} ADD COLUMN IF NOT EXISTS checksum text`);
}

async function readLedger(client: Queryable): Promise<LedgerRow[]> {
  const result = await client.query(
    `SELECT migration_id, applied_at, applied_by, backup_schema, missing_before
       FROM ${MIGRATION_LEDGER} ORDER BY migration_id`,
  );
  return result.rows as unknown as LedgerRow[];
}

function toApplied(row: LedgerRow): AppliedMigration {
  return {
    id: row.migration_id,
    appliedAt: row.applied_at instanceof Date ? row.applied_at.toISOString() : String(row.applied_at),
    appliedBy: row.applied_by,
    backupSchema: row.backup_schema ?? null,
    missingBefore: Array.isArray(row.missing_before) ? row.missing_before : [],
  };
}

/** Objects required by a migration that the database does not have yet. */
async function currentDrift(client: Queryable, migration: SqlMigration): Promise<DriftedObject[]> {
  const planned = plannedObjects(migration.sql);
  if (!planned.length) return [];

  const tables = await client.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`);
  const columns = await client.query(
    `SELECT table_name || '.' || column_name AS name FROM information_schema.columns WHERE table_schema = 'public'`,
  );
  const indexes = await client.query(`SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`);
  const present: Record<DriftedObject["kind"], Set<string>> = {
    table: new Set(tables.rows.map((row) => String(row.tablename))),
    column: new Set(columns.rows.map((row) => String(row.name))),
    index: new Set(indexes.rows.map((row) => String(row.indexname))),
  };
  return planned.filter((item) => !present[item.kind].has(item.object));
}

/**
 * Copy every public table (structure + data) into a dated snapshot schema and
 * record the drift that is about to be repaired. Cheap for this workload
 * (hundreds of rows per table) and restorable row-for-row with
 * INSERT INTO public.<table> SELECT * FROM <snapshot>.<table>.
 */
async function snapshotPublicTables(client: Queryable, drift: DriftedObject[]): Promise<string> {
  const schema = `${SNAPSHOT_PREFIX}${new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "")}`;
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schema)}`);

  const tables = await client.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`);
  let copied = 0;
  for (const row of tables.rows) {
    const name = String(row.tablename);
    if (name === MIGRATION_LEDGER) continue;
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${quoteIdent(schema)}.${quoteIdent(name)} AS SELECT * FROM public.${quoteIdent(name)}`,
    );
    copied += 1;
  }
  await client.query(
    `CREATE TABLE IF NOT EXISTS ${quoteIdent(schema)}._pre_migration_drift (recorded_at timestamptz NOT NULL DEFAULT now(), missing jsonb NOT NULL)`,
  );
  await client.query(`INSERT INTO ${quoteIdent(schema)}._pre_migration_drift (missing) VALUES ($1::jsonb)`, [
    JSON.stringify(drift),
  ]);
  logger.info({ schema, tables: copied }, "pre-migration snapshot created");
  return schema;
}

/**
 * Bring the database up to the schema the running code requires.
 *
 * The repository ships schema changes as reviewed, paired SQL files rather
 * than a `drizzle-kit push`. A database that never ran them leaves the API
 * querying columns and tables that do not exist, which surfaces as an
 * unhandled SQL error (HTTP 500) on /api/user/login.
 *
 * Safety properties:
 *   • additive reviewed SQL only — never a schema push, never a DROP;
 *   • a full snapshot of the public schema is taken before the first change;
 *   • every applied migration is recorded in the shared ledger together with
 *     the exact objects it had to create, so drift stays provable;
 *   • one advisory lock stops concurrent instances from racing;
 *   • a failing migration is recorded and never prevents the API from booting;
 *   • DB_AUTO_MIGRATE=off makes the runner a read-only reporter.
 */
export async function runStartupMigrations(): Promise<MigrationReport> {
  const report = emptyMigrationReport();
  report.checkedAt = new Date().toISOString();

  if (!pool) {
    /* Isolated test process: the injected in-memory database owns its schema. */
    report.ready = true;
    setMigrationReport(report);
    return report;
  }

  const client = await pool.connect();
  try {
    const applied = (await ledgerExists(client)) ? await readLedger(client) : [];
    report.applied = applied.map(toApplied);
    report.backupSchema = [...report.applied].reverse().find((row) => row.backupSchema)?.backupSchema ?? null;
    const recorded = new Set(applied.map((row) => row.migration_id));
    report.pending = MIGRATION_IDS.filter((id) => !recorded.has(id));

    if (!report.pending.length) {
      report.ready = true;
      setMigrationReport(report);
      return report;
    }

    if (!autoMigrateEnabled()) {
      logger.warn({ pending: report.pending }, "database schema is behind and DB_AUTO_MIGRATE=off");
      setMigrationReport(report);
      return report;
    }

    const lock = await client.query(`SELECT pg_try_advisory_lock($1) AS acquired`, [MIGRATION_LOCK_ID]);
    if (!lock.rows[0]?.acquired) {
      report.error = "another instance is applying migrations";
      logger.warn({ pending: report.pending }, "database migration lock is held by another instance");
      setMigrationReport(report);
      return report;
    }

    try {
      await ensureLedger(client);
      await client.query(`SET lock_timeout = '15s'`);
      await client.query(`SET statement_timeout = '120s'`);

      /* Re-read under the lock: another instance may have finished meanwhile. */
      const recordedNow = new Set((await readLedger(client)).map((row) => row.migration_id));
      const remaining = SQL_MIGRATIONS.filter((migration) => !recordedNow.has(migration.id));
      if (!remaining.length) {
        report.ready = true;
        report.pending = [];
        setMigrationReport(report);
        return report;
      }

      const drift = (await Promise.all(remaining.map((migration) => currentDrift(client, migration)))).flat();
      const backupSchema = await snapshotPublicTables(client, drift);

      for (const migration of remaining) {
        const missingBefore = await currentDrift(client, migration);
        try {
          /* The reviewed file owns its own BEGIN/COMMIT boundaries. */
          await client.query(migration.sql);
          await client.query(
            `INSERT INTO ${MIGRATION_LEDGER} (migration_id, applied_by, backup_schema, missing_before, checksum)
             VALUES ($1, 'api-boot', $2, $3::jsonb, $4)
             ON CONFLICT (migration_id) DO NOTHING`,
            [migration.id, backupSchema, JSON.stringify(missingBefore), migrationChecksum(migration.sql)],
          );
          report.applied.push({
            id: migration.id,
            appliedAt: new Date().toISOString(),
            appliedBy: "api-boot",
            backupSchema,
            missingBefore,
          });
          logger.info({ migration: migration.id, created: missingBefore.length }, "database migration applied");
        } catch (error) {
          const parts = errorParts(error);
          report.failed.push({ id: migration.id, ...parts });
          logger.error({ migration: migration.id, code: parts.code }, "database migration failed");
        }
      }

      report.backupSchema = backupSchema;
      const done = new Set([...recordedNow, ...report.applied.map((row) => row.id)]);
      report.pending = MIGRATION_IDS.filter((id) => !done.has(id));
      report.ready = report.pending.length === 0;
    } finally {
      try {
        await client.query(`SELECT pg_advisory_unlock($1)`, [MIGRATION_LOCK_ID]);
      } catch {
        /* the connection is already gone; the lock dies with it */
      }
    }
  } catch (error) {
    const parts = errorParts(error);
    report.error = `${parts.code}: ${parts.message}`;
    logger.error({ code: parts.code }, "database migration boot check failed");
  } finally {
    client.release();
  }

  setMigrationReport(report);
  return report;
}
