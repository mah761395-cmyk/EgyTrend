import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

type EgyTrendDatabase = NodePgDatabase<typeof schema>;

declare global {
  /**
   * Test-only dependency injection point. It is intentionally honored only
   * when NODE_ENV=test, so a deployment can never replace its PostgreSQL
   * connection with an in-memory database through an environment variable.
   */
  // eslint-disable-next-line no-var
  var __egytrendTestDatabase: EgyTrendDatabase | undefined;
}

const injectedTestDatabase =
  process.env.NODE_ENV === "test" ? globalThis.__egytrendTestDatabase : undefined;

if (!injectedTestDatabase && !process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

/* Do not construct a network pool during isolated tests. Production and
 * preview always use the real PostgreSQL pool below. */
export const pool = injectedTestDatabase
  ? null
  : new Pool({
      connectionString: process.env.DATABASE_URL,
      /* Bounded pool: the pg default grows unbounded, which can exhaust the
       * database's connection limit under bursty traffic. */
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });

export const db: EgyTrendDatabase = injectedTestDatabase
  ?? drizzle(pool!, { schema });

export * from "./schema";
