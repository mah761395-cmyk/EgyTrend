/**
 * Migration ledger I/O.
 *
 * Deliberately free of migration SQL imports: the health route and tests can
 * read schema status without pulling the inlined migration files into their
 * module graph (tsx-based tests cannot load `*.sql`).
 */
import { pool } from "@workspace/db";
import { MIGRATION_IDS, emptyMigrationReport, type AppliedMigration, type MigrationReport } from "./db-migration-state";

/** Ledger shared with scripts/run-db-migration.mjs so a manual run and an
 * automatic run never disagree about what has already been applied. */
export const MIGRATION_LEDGER = "_egytrend_schema_migrations";

export type Queryable = { query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> };

export type LedgerRow = {
  migration_id: string;
  applied_at: Date | string;
  applied_by: string;
  backup_schema: string | null;
  missing_before: unknown[] | null;
};

export async function ledgerExists(client: Queryable): Promise<boolean> {
  const result = await client.query(`SELECT to_regclass($1) IS NOT NULL AS present`, [`public.${MIGRATION_LEDGER}`]);
  return Boolean(result.rows[0]?.present);
}

export async function ensureLedger(client: Queryable): Promise<void> {
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

export async function readLedger(client: Queryable): Promise<LedgerRow[]> {
  const result = await client.query(
    `SELECT migration_id, applied_at, applied_by, backup_schema, missing_before
       FROM ${MIGRATION_LEDGER} ORDER BY migration_id`,
  );
  return result.rows as unknown as LedgerRow[];
}

export function toApplied(row: LedgerRow): AppliedMigration {
  return {
    id: row.migration_id,
    appliedAt: row.applied_at instanceof Date ? row.applied_at.toISOString() : String(row.applied_at),
    appliedBy: row.applied_by,
    backupSchema: row.backup_schema ?? null,
    missingBefore: Array.isArray(row.missing_before) ? (row.missing_before as AppliedMigration["missingBefore"]) : [],
  };
}

export function reportFromLedger(rows: LedgerRow[]): MigrationReport {
  const report = emptyMigrationReport();
  report.checkedAt = new Date().toISOString();
  report.applied = rows.map(toApplied);
  report.backupSchema = [...report.applied].reverse().find((row) => row.backupSchema)?.backupSchema ?? null;
  const recorded = new Set(report.applied.map((row) => row.id));
  report.pending = MIGRATION_IDS.filter((id) => !recorded.has(id));
  report.ready = report.pending.length === 0;
  return report;
}

/**
 * Live ledger read for GET /api/health/db.
 *
 * The boot report is a per-instance snapshot taken once; a warm serverless
 * instance would otherwise keep repeating it long after another instance
 * finished the migration. Reading the ledger on demand answers the current
 * question ("is this database current?") with the current truth.
 */
export async function readMigrationStatus(): Promise<MigrationReport | null> {
  if (!pool) return null;
  const client = await pool.connect();
  try {
    const rows = (await ledgerExists(client)) ? await readLedger(client) : [];
    return { ...reportFromLedger(rows), live: true };
  } finally {
    client.release();
  }
}
