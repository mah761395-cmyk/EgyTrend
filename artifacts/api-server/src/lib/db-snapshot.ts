/**
 * In-database snapshot primitives shared by the migration runner and the
 * backup system.
 *
 * Kept in its own module on purpose: it must NOT import the `*.sql` migration
 * files (tsx-based tests cannot load them; only the prod build inlines them
 * with a `text` loader). See db-migration-ledger for the same constraint.
 */
import { MIGRATION_LEDGER, type Queryable } from "./db-migration-ledger";
import { quoteIdent } from "./db-migration-plan";

export type { Queryable };
export const SNAPSHOT_PREFIX = "egytrend_backup_";

/**
 * Copy every public table (structure + data) into a snapshot schema.
 * Cheap for this workload (hundreds of rows per table) and restorable
 * row-for-row with INSERT INTO public.<table> SELECT * FROM <schema>.<table>.
 * Returns the copied table names (the migration ledger is excluded).
 */
export async function snapshotPublicTablesTo(client: Queryable, schema: string): Promise<string[]> {
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schema)}`);

  const tables = await client.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`);
  const copied: string[] = [];
  for (const row of tables.rows) {
    const name = String(row.tablename);
    if (name === MIGRATION_LEDGER) continue;
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${quoteIdent(schema)}.${quoteIdent(name)} AS SELECT * FROM public.${quoteIdent(name)}`,
    );
    copied.push(name);
  }
  return copied;
}
