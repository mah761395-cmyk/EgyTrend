import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { MIGRATION_IDS } from "./db-migration-state";
import { migrationChecksum, plannedObjects, quoteIdent } from "./db-migration-plan";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, "../../../../lib/db/migrations");

function read(id: string, direction: "up" | "down"): string {
  return fs.readFileSync(path.join(migrationsDir, `${id}.${direction}.sql`), "utf8");
}

test("the migration order matches the reviewed SQL files on disk", () => {
  const files = fs
    .readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".up.sql"))
    .map((name) => name.replace(/\.up\.sql$/, ""))
    .sort();
  assert.deepEqual([...MIGRATION_IDS].sort(), files, "every up migration must be listed exactly once");
  assert.deepEqual([...MIGRATION_IDS], [...MIGRATION_IDS].sort(), "migrations must be applied in file order");
});

test("every up migration has a paired down migration", () => {
  for (const id of MIGRATION_IDS) {
    assert.ok(fs.existsSync(path.join(migrationsDir, `${id}.down.sql`)), `missing down migration for ${id}`);
    assert.ok(read(id, "down").trim().length > 0, `empty down migration for ${id}`);
  }
});

test("the boot runner reports the objects the drifted database is missing", () => {
  /* These are the app_users columns production lacked. Their absence is what
   * made POST /api/user/login fail: the API selects every schema column. */
  const broadcasts = plannedObjects(read("0008_admin_broadcasts", "up"));
  assert.ok(
    broadcasts.some((item) => item.kind === "column" && item.object === "app_users.marketing_email_opt_in"),
    "0008 must be understood as adding app_users.marketing_email_opt_in",
  );
  assert.ok(
    broadcasts.some((item) => item.kind === "table" && item.object === "broadcast_messages"),
    "0008 must be understood as creating broadcast_messages",
  );

  const trial = plannedObjects(read("0009_free_vip_trial", "up"));
  assert.ok(
    trial.some((item) => item.kind === "column" && item.object === "app_users.email_verified_at"),
    "0009 must be understood as adding app_users.email_verified_at",
  );

  const idempotency = plannedObjects(read("0012_payment_tx_idempotency", "up"));
  assert.ok(
    idempotency.some((item) => item.kind === "index" && item.object === "payment_requests_tx_normalized_uidx"),
    "0012 must be understood as creating the payment idempotency index",
  );
});

test("no reviewed migration is destructive", () => {
  for (const id of MIGRATION_IDS) {
    const sql = read(id, "up");
    assert.ok(!/\bDROP\s+TABLE\b/i.test(sql), `${id} must not drop a table`);
    assert.ok(!/\bTRUNCATE\b/i.test(sql), `${id} must not truncate`);
    assert.ok(!/\bDELETE\s+FROM\b/i.test(sql), `${id} must not delete rows`);
  }
});

test("checksums are stable, short, and identifier quoting is safe", () => {
  const sql = read("0008_admin_broadcasts", "up");
  assert.equal(migrationChecksum(sql), migrationChecksum(sql));
  assert.match(migrationChecksum(sql), /^[0-9a-f]{32}$/);
  assert.notEqual(migrationChecksum(sql), migrationChecksum(read("0009_free_vip_trial", "up")));
  assert.equal(quoteIdent("app_users"), '"app_users"');
  assert.equal(quoteIdent('we"ird'), '"we""ird"');
});
