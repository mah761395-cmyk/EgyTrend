/**
 * The Postgres half of the auth hardening, executed against a real PostgreSQL
 * engine (PGlite — PostgreSQL compiled to WASM, no server needed):
 *
 *   • migration 0012 applies cleanly and is idempotent
 *   • the shared attempt counter blocks, rolls its window and survives
 *     concurrent increments
 *   • revocation by session id and by timestamp behaves exactly like the
 *     in-memory store the unit tests cover
 *   • the down migration removes only these two tables
 *
 * The migration file is the one that ships in lib/db/migrations, so this also
 * verifies the SQL an operator would run on staging.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

const MIGRATION_DIR = path.resolve(__dirname, "../../../../lib/db/migrations");

type Sql = (sql: string, params: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

type Pglite = {
  exec(sql: string): Promise<unknown>;
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  close(): Promise<void>;
};

let makeDb: null | (() => Promise<Pglite>) = null;
try {
  const mod = await import("@electric-sql/pglite");
  makeDb = () => new mod.PGlite() as unknown as Promise<Pglite>;
} catch {
  /* Without PGlite the suite is skipped rather than failing the build. */
}
const maybe = makeDb ? test : test.skip;

function sqlFrom(db: Pglite): Sql {
  return async (sql, params) => {
    const result = await db.query(sql, params);
    return { rows: result.rows };
  };
}

const UP = fs.readFileSync(path.join(MIGRATION_DIR, "0012_auth_hardening.up.sql"), "utf8");
const DOWN = fs.readFileSync(path.join(MIGRATION_DIR, "0012_auth_hardening.down.sql"), "utf8");

async function freshDb() {
  const db = await makeDb!();
  await db.exec(UP);
  return db;
}

maybe("migration 0012 applies and can be re-applied without error", async () => {
  const db = await makeDb!();
  await db.exec(UP);
  await db.exec(UP); // idempotent
  const tables = await db.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name LIKE 'auth_%'
      ORDER BY table_name`,
  );
  const names = (tables.rows as { table_name: string }[]).map((r) => r.table_name);
  assert.deepEqual(names, ["auth_rate_limits", "auth_session_revocations"]);
  await db.close();
});

maybe("the down migration removes only the auth tables", async () => {
  const db = await makeDb!();
  await db.exec(`CREATE TABLE IF NOT EXISTS app_users (id serial PRIMARY KEY, phone text)`);
  await db.exec(`INSERT INTO app_users (phone) VALUES ('01000000000')`);
  await db.exec(UP);
  await db.exec(DOWN);
  const tables = await db.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' ORDER BY table_name`,
  );
  const names = (tables.rows as { table_name: string }[]).map((r) => r.table_name);
  assert.ok(names.includes("app_users"), "user data must survive a rollback");
  assert.ok(!names.includes("auth_rate_limits"));
  assert.ok(!names.includes("auth_session_revocations"));
  const users = await db.query(`SELECT count(*)::int AS n FROM app_users`);
  assert.equal(Number((users.rows as { n: number }[])[0].n), 1);
  await db.close();
});

maybe("the shared limiter blocks exactly at the limit and reports Retry-After", async () => {
  const { createPostgresAttemptStore } = await import("./rate-limit");
  const db = await freshDb();
  const store = createPostgresAttemptStore(sqlFrom(db));
  const bucket = "login:phone:01012345678";
  const windowMs = 15 * 60 * 1000;

  for (let i = 0; i < 4; i += 1) {
    assert.equal((await store.isBlocked(bucket, 5, windowMs)).blocked, false, `attempt ${i + 1}`);
    await store.recordFailure(bucket, 5, windowMs);
  }
  assert.equal((await store.isBlocked(bucket, 5, windowMs)).blocked, false, "5th attempt still runs");
  await store.recordFailure(bucket, 5, windowMs);

  const state = await store.isBlocked(bucket, 5, windowMs);
  assert.equal(state.blocked, true);
  assert.ok(state.retryAfterSec > 800 && state.retryAfterSec <= 900, `retryAfter=${state.retryAfterSec}`);

  await store.clear(bucket);
  assert.equal((await store.isBlocked(bucket, 5, windowMs)).blocked, false);
  await db.close();
});

maybe("concurrent failures are counted atomically (no lost updates)", async () => {
  const { createPostgresAttemptStore } = await import("./rate-limit");
  const db = await freshDb();
  const store = createPostgresAttemptStore(sqlFrom(db));
  const bucket = "login:ip:1.2.3.4";
  await Promise.all(Array.from({ length: 10 }, () => store.recordFailure(bucket, 10, 60_000)));
  const { rows } = await db.query(`SELECT hits FROM auth_rate_limits WHERE bucket = $1`, [bucket]);
  assert.equal(Number((rows as { hits: number }[])[0].hits), 10);
  await db.close();
});

maybe("an expired window is not blocking any more", async () => {
  const { createPostgresAttemptStore } = await import("./rate-limit");
  const db = await freshDb();
  const store = createPostgresAttemptStore(sqlFrom(db));
  const bucket = "login:phone:expired";
  await db.query(
    `INSERT INTO auth_rate_limits (bucket, hits, window_start)
       VALUES ($1, 99, now() - interval '2 hours')`,
    [bucket],
  );
  assert.equal((await store.isBlocked(bucket, 5, 15 * 60 * 1000)).blocked, false);
  await store.recordFailure(bucket, 5, 15 * 60 * 1000);
  const { rows } = await db.query(`SELECT hits FROM auth_rate_limits WHERE bucket = $1`, [bucket]);
  assert.equal(Number((rows as { hits: number }[])[0].hits), 1, "the old count must not carry over");
  await db.close();
});

maybe("hit() allows exactly the limit and refuses the next attempt", async () => {
  const { createPostgresAttemptStore } = await import("./rate-limit");
  const db = await freshDb();
  const store = createPostgresAttemptStore(sqlFrom(db));
  const bucket = "fp-em:user@example.com";
  assert.equal((await store.hit(bucket, 3, 60_000)).blocked, false);
  assert.equal((await store.hit(bucket, 3, 60_000)).blocked, false);
  assert.equal((await store.hit(bucket, 3, 60_000)).blocked, false);
  assert.equal((await store.hit(bucket, 3, 60_000)).blocked, true);
  await db.close();
});

maybe("revoking one session leaves the account's other sessions usable", async () => {
  const { createPostgresRevocationStore } = await import("./session-revocation");
  const db = await freshDb();
  const store = createPostgresRevocationStore(sqlFrom(db));
  await store.revokeOne("user", 42, "session-a");
  assert.equal(await store.isRevoked("user", 42, "session-a", Date.now()), true);
  assert.equal(await store.isRevoked("user", 42, "session-b", Date.now()), false);
  /* Scoped: another account and the staff scope are untouched. */
  assert.equal(await store.isRevoked("user", 43, "session-a", Date.now()), false);
  assert.equal(await store.isRevoked("admin", 42, "session-a", Date.now()), false);
  await db.close();
});

maybe("revoke-all invalidates older sessions but not a replacement minted after it", async () => {
  const { createPostgresRevocationStore } = await import("./session-revocation");
  const db = await freshDb();
  const store = createPostgresRevocationStore(sqlFrom(db));
  const before = Date.now() - 60_000;
  await store.revokeAll("user", 42);
  assert.equal(await store.isRevoked("user", 42, "old", before), true);
  /* The replacement session is minted with iat = revocation + 1s. */
  assert.equal(await store.isRevoked("user", 42, "fresh", Date.now() + 2_000), false);
  await db.close();
});

maybe("revoke-all is repeatable and keeps the latest timestamp", async () => {
  const { createPostgresRevocationStore } = await import("./session-revocation");
  const db = await freshDb();
  const store = createPostgresRevocationStore(sqlFrom(db));
  await store.revokeAll("admin", 7);
  await store.revokeAll("admin", 7);
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM auth_session_revocations WHERE scope = 'admin' AND subject = 7`,
  );
  assert.equal(Number((rows as { n: number }[])[0].n), 1, "one row per subject, not one per call");
  assert.equal(await store.isRevoked("admin", 7, "any", Date.now() - 1_000), true);
  await db.close();
});

maybe("createAttemptStore uses Postgres when DATABASE_URL is present", async () => {
  const { createAttemptStore } = await import("./rate-limit");
  const db = await freshDb();
  const store = createAttemptStore({
    env: { DATABASE_URL: "postgres://pglite" } as NodeJS.ProcessEnv,
    query: sqlFrom(db),
  });
  for (let i = 0; i < 3; i += 1) await store.recordFailure("shared", 3, 60_000);
  assert.equal((await store.isBlocked("shared", 3, 60_000)).blocked, true);
  const { rows } = await db.query(`SELECT hits FROM auth_rate_limits WHERE bucket = 'shared'`);
  assert.equal(Number((rows as { hits: number }[])[0].hits), 3, "the count must live in the database");
  await db.close();
});
