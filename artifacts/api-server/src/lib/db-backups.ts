/**
 * On-demand + cron database backups for this deployment (Vercel/Neon).
 *
 * Mechanism: the same in-database snapshot used before migrations — every
 * public table (structure + data) is copied into a dated schema
 * (`egytrend_backup_<timestamp>`, see snapshotPublicTablesTo). No external
 * binaries (pg_dump is unavailable in serverless), no file storage, and the
 * copy is restorable row-for-row with
 *   INSERT INTO public.<table> SELECT * FROM <schema>.<table>
 * (the manual, confirmed CLI: scripts/restore-from-backup.mjs).
 *
 * Honesty rules (TASK L):
 *  • a ledger row is written only after the schema copy succeeded;
 *  • `verified` is true only when the post-copy row-count comparison passed —
 *    an unverified (or schema-missing) backup is never reported as the last
 *    successful one;
 *  • environments without a real PostgreSQL pool (in-memory test databases)
 *    throw BackupUnavailableError: the API then answers 503 and records
 *    nothing — no fake "backup ok" state;
 *  • restore and deletion of production data are never exposed to the panel;
 *    they exist only as explicit CLI confirmations.
 */
import { db, pool } from "@workspace/db";
import { dbBackupsTable } from "@workspace/db/schema";
import { desc } from "drizzle-orm";
import { logger } from "./logger";
import { SNAPSHOT_PREFIX, snapshotPublicTablesTo, type Queryable } from "./db-snapshot";
import { quoteIdent } from "./db-migration-plan";

export const BACKUP_SCHEMA_PREFIX = SNAPSHOT_PREFIX;
export const BACKUP_RETENTION_DAYS = 14;
export const BACKUP_MIN_INTERVAL_MS = 20 * 60 * 60 * 1000;

export class BackupUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupUnavailableError";
  }
}

function baseBackupSchemaName(now = new Date()): string {
  return `${SNAPSHOT_PREFIX}${now.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "")}`;
}

/** Two backups in the same second would otherwise collide on the schema name. */
async function uniqueBackupSchema(client: Queryable, base: string): Promise<string> {
  let name = base;
  let suffix = 2;
  for (;;) {
    const r = await client.query(`SELECT 1 FROM pg_namespace WHERE nspname = $1`, [name]);
    if (!r.rows.length) return name;
    name = `${base}_${suffix}`;
    suffix += 1;
  }
}

/**
 * Restorability check that never touches live data: every snapshot table must
 * hold exactly the rows the live table held at copy time. A row-for-row
 * restore itself is a manual, confirmed CLI action.
 */
export async function verifySnapshotCounts(
  client: Queryable,
  schema: string,
  tables: string[],
): Promise<{ verified: boolean; mismatches: Array<{ table: string; live: number; backup: number }> }> {
  const mismatches: Array<{ table: string; live: number; backup: number }> = [];
  for (const t of tables) {
    const liveRow = await client.query(`SELECT count(*) AS c FROM public.${quoteIdent(t)}`);
    const snapRow = await client.query(`SELECT count(*) AS c FROM ${quoteIdent(schema)}.${quoteIdent(t)}`);
    const live = Number(liveRow.rows[0]?.c ?? -1);
    const backup = Number(snapRow.rows[0]?.c ?? -1);
    if (live !== backup) mismatches.push({ table: t, live, backup });
  }
  return { verified: mismatches.length === 0, mismatches };
}

export type BackupResult = {
  schema: string;
  tableCount: number;
  verified: boolean;
  note: string | null;
};

/** Create one dated schema snapshot, verify its row counts, record it in the
 *  db_backups ledger, then prune schemas older than the retention window. */
export async function createSchemaBackup(
  kind: "manual" | "cron",
  createdBy: string | null,
): Promise<BackupResult> {
  if (!pool) {
    throw new BackupUnavailableError(
      "schema snapshots require a real PostgreSQL pool; this environment cannot hold them",
    );
  }
  const client = await pool.connect();
  let schema = "";
  try {
    schema = await uniqueBackupSchema(client, baseBackupSchemaName());
    const tables = await snapshotPublicTablesTo(client, schema);
    const { verified, mismatches } = await verifySnapshotCounts(client, schema, tables);
    const note = verified
      ? null
      : `row-count mismatch: ${mismatches.map((m) => `${m.table} live=${m.live} backup=${m.backup}`).join("; ")}`;
    try {
      await db.insert(dbBackupsTable).values({
        schemaName: schema,
        tableCount: tables.length,
        kind,
        createdBy,
        verified,
        note,
      });
    } catch (e) {
      /* An unrecorded schema copy is worse than no backup: roll it back. */
      await client.query(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)}`).catch(() => {});
      throw e;
    }
    await pruneOldBackups(client).catch((e) =>
      logger.warn({ err: e }, "backup retention pruning failed"),
    );
    logger.info({ schema, tables: tables.length, verified }, "database snapshot backup created");
    return { schema, tableCount: tables.length, verified, note };
  } finally {
    client.release();
  }
}

/** Drop backup schemas older than the retention window (never public data,
 *  never pre-migration drift schemas younger than the window). */
export async function pruneOldBackups(client: Queryable, retentionDays = BACKUP_RETENTION_DAYS): Promise<number> {
  const rows = await client.query(`SELECT nspname FROM pg_namespace WHERE nspname LIKE $1`, [
    `${SNAPSHOT_PREFIX}%`,
  ]);
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  let dropped = 0;
  for (const r of rows.rows) {
    const name = String(r.nspname);
    const ts = parseBackupTimestamp(name);
    if (ts && ts.getTime() < cutoff) {
      await client.query(`DROP SCHEMA IF EXISTS ${quoteIdent(name)}`);
      dropped += 1;
    }
  }
  if (dropped) logger.info({ dropped }, "old backup schemas pruned");
  return dropped;
}

/** egytrend_backup_20261029T012006[_n] → Date (UTC). Null when unparseable. */
export function parseBackupTimestamp(schemaName: string): Date | null {
  const m = /^egytrend_backup_(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(?:\d{3})?(?:_.*)?$/.exec(schemaName);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  return Number.isNaN(d.getTime()) ? null : d;
}

export type BackupViewRow = {
  id: number;
  schemaName: string;
  tableCount: number;
  kind: string;
  createdBy: string | null;
  verified: boolean;
  note: string | null;
  createdAt: Date;
  /** Live check: the schema still exists in this database. */
  schemaPresent: boolean;
};

/** A backup is "the last successful one" only if it was verified AND its
 *  schema still exists. Pure function so the rule is unit-testable. */
export function pickLastVerifiedBackup<T extends { verified: boolean; schemaPresent: boolean }>(
  rows: T[],
): T | null {
  for (const r of rows) if (r.verified && r.schemaPresent) return r;
  return null;
}

export async function listBackups(limit = 30): Promise<{ rows: BackupViewRow[]; lastVerifiedBackup: BackupViewRow | null }> {
  const ledger = await db
    .select()
    .from(dbBackupsTable)
    .orderBy(desc(dbBackupsTable.createdAt))
    .limit(Math.min(100, Math.max(1, limit)));

  let present = new Set<string>();
  if (pool && ledger.length) {
    const r = await pool
      .connect()
      .then(async (client) => {
        try {
          return await client.query(`SELECT nspname FROM pg_namespace WHERE nspname = ANY($1)`, [
            ledger.map((row) => row.schemaName),
          ]);
        } finally {
          client.release();
        }
      })
      .catch(() => null);
    if (r) present = new Set(r.rows.map((row: { nspname: string }) => row.nspname));
  }

  const rows: BackupViewRow[] = ledger.map((row) => ({
    id: row.id,
    schemaName: row.schemaName,
    tableCount: row.tableCount,
    kind: row.kind,
    createdBy: row.createdBy,
    verified: row.verified,
    note: row.note,
    createdAt: row.createdAt,
    schemaPresent: present.has(row.schemaName),
  }));
  return { rows, lastVerifiedBackup: pickLastVerifiedBackup(rows) };
}

/** Cron guard: skip while a backup of any kind is younger than the minimum
 *  interval (schedule drift must never double-spend a snapshot). */
export async function shouldSkipBackup(minIntervalMs = BACKUP_MIN_INTERVAL_MS): Promise<{ skip: boolean; reason: string | null }> {
  const [last] = await db
    .select({ createdAt: dbBackupsTable.createdAt })
    .from(dbBackupsTable)
    .orderBy(desc(dbBackupsTable.createdAt))
    .limit(1);
  if (last && Date.now() - last.createdAt.getTime() < minIntervalMs) {
    return { skip: true, reason: `backup younger than ${Math.round(minIntervalMs / 3600000)}h` };
  }
  return { skip: false, reason: null };
}
