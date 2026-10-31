import { pool } from "@workspace/db";
import { logger } from "./logger";
import { sqlStateOf } from "./dbErrors";
import { migrationChecksum, plannedObjects, quoteIdent } from "./db-migration-plan";
import {
  MIGRATION_LEDGER,
  ensureLedger,
  ledgerExists,
  readLedger,
  reportFromLedger,
  type Queryable,
} from "./db-migration-ledger";
import { SNAPSHOT_PREFIX, snapshotPublicTablesTo } from "./db-snapshot";

export type { Queryable };
export { SNAPSHOT_PREFIX, snapshotPublicTablesTo };
import {
  MIGRATION_IDS,
  autoMigrateEnabled,
  emptyMigrationReport,
  setMigrationReport,
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
import up0013 from "../../../../lib/db/migrations/0013_vip_onboarding_tour.up.sql";
import up0014 from "../../../../lib/db/migrations/0014_auth_hardening.up.sql";
import up0015 from "../../../../lib/db/migrations/0015_user_fee_profiles.up.sql";
import up0017 from "../../../../lib/db/migrations/0017_data_quality_events.up.sql";
import up0018 from "../../../../lib/db/migrations/0018_user_onboarding_tour_replayed.up.sql";
import up0019 from "../../../../lib/db/migrations/0019_portfolio_transactions.up.sql";
import up0020 from "../../../../lib/db/migrations/0020_app_users_last_login.up.sql";
import up0021 from "../../../../lib/db/migrations/0021_ai_usage_metering.up.sql";
import up0022 from "../../../../lib/db/migrations/0022_db_backups.up.sql";
import up0023 from "../../../../lib/db/migrations/0023_opportunity_signals.up.sql";
import up0024 from "../../../../lib/db/migrations/0024_portfolio_cash_events.up.sql";
import up0025 from "../../../../lib/db/migrations/0025_user_notification_center.up.sql";
import up0026 from "../../../../lib/db/migrations/0026_user_wallet_autorenew.up.sql";

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
  "0013_vip_onboarding_tour": up0013,
  "0014_auth_hardening": up0014,
  "0015_user_fee_profiles": up0015,
  "0017_data_quality_events": up0017,
  "0018_user_onboarding_tour_replayed": up0018,
  "0019_portfolio_transactions": up0019,
  "0020_app_users_last_login": up0020,
  "0021_ai_usage_metering": up0021,
  "0022_db_backups": up0022,
  "0023_opportunity_signals": up0023,
  "0024_portfolio_cash_events": up0024,
  "0025_user_notification_center": up0025,
  "0026_user_wallet_autorenew": up0026,
};

export const SQL_MIGRATIONS: readonly SqlMigration[] = MIGRATION_IDS.map((id) => {
  const sql = SQL_BY_ID[id];
  if (!sql) throw new Error(`missing inlined SQL for migration ${id}`);
  return { id, sql };
});

const MIGRATION_LOCK_ID = 843912608;
/** How long a boot waits for another instance that is migrating right now. */
const LOCK_ATTEMPTS = 4;
const LOCK_RETRY_MS = 3000;

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

/** Pre-migration snapshot: dated schema copy plus the drift that is about
 * to be repaired. (The copy itself lives in db-snapshot.ts so it can be
 * reused by the backup system without pulling *.sql into the module graph.) */
async function snapshotPublicTables(client: Queryable, drift: DriftedObject[]): Promise<string> {
  const schema = `${SNAPSHOT_PREFIX}${new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "")}`;
  const copied = await snapshotPublicTablesTo(client, schema);
  await client.query(
    `CREATE TABLE IF NOT EXISTS ${quoteIdent(schema)}._pre_migration_drift (recorded_at timestamptz NOT NULL DEFAULT now(), missing jsonb NOT NULL)`,
  );
  await client.query(`INSERT INTO ${quoteIdent(schema)}._pre_migration_drift (missing) VALUES ($1::jsonb)`, [
    JSON.stringify(drift),
  ]);
  logger.info({ schema, tables: copied.length }, "pre-migration snapshot created");
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
 *   • one advisory lock stops concurrent instances from racing, and a boot
 *     waits briefly for a sibling that is already migrating;
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
    const rows = (await ledgerExists(client)) ? await readLedger(client) : [];
    Object.assign(report, reportFromLedger(rows), { checkedAt: report.checkedAt, live: false });

    if (!report.pending.length) {
      setMigrationReport(report);
      return report;
    }

    if (!autoMigrateEnabled()) {
      logger.warn({ pending: report.pending }, "database schema is behind and DB_AUTO_MIGRATE=off");
      setMigrationReport(report);
      return report;
    }

    /* Wait briefly for another instance that is migrating right now: it is
     * normal for several instances to boot together on a fresh deployment, and
     * the winner usually finishes in seconds. */
    let acquired = false;
    for (let attempt = 0; attempt < LOCK_ATTEMPTS && !acquired; attempt += 1) {
      const lock = await client.query(`SELECT pg_try_advisory_lock($1) AS acquired`, [MIGRATION_LOCK_ID]);
      acquired = Boolean(lock.rows[0]?.acquired);
      if (acquired) break;
      if (await ledgerExists(client)) {
        const meanwhile = reportFromLedger(await readLedger(client));
        if (meanwhile.ready) {
          Object.assign(report, meanwhile);
          setMigrationReport(report);
          return report;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
    if (!acquired) {
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
        report.pending = [];
        report.ready = true;
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
