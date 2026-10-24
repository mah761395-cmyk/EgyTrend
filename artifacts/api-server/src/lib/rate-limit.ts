/**
 * Attempt limiting for authentication endpoints.
 *
 * Why this is not a plain `Map`:
 *   On Vercel every request can land on a different instance, so an in-process
 *   counter would give an attacker `limit × instances` attempts. The
 *   authoritative counter therefore lives in Postgres — the database this app
 *   already requires — and the in-memory counter is only the per-instance fast
 *   path plus a degraded mode when the database is unreachable.
 *
 * Semantics: counters track FAILED attempts inside a fixed window and are
 * cleared on a successful login, so an attacker cannot lock a victim out by
 * spending the victim's allowance, while a shared IP (Egyptian mobile carriers
 * NAT aggressively) still recovers as soon as somebody authenticates from it.
 */

export type BlockState = { blocked: boolean; retryAfterSec: number };

export type AttemptStore = {
  /** True when this bucket already spent its allowance inside the window. */
  isBlocked(bucket: string, limit: number, windowMs: number): Promise<BlockState>;
  /** Count one failed attempt, rolling the window when it has expired. */
  recordFailure(bucket: string, limit: number, windowMs: number): Promise<void>;
  /** Count one attempt of any kind and report the resulting state (registration,
   *  password-recovery mail — where the attempt itself is what must be capped). */
  hit(bucket: string, limit: number, windowMs: number): Promise<BlockState>;
  /** Forget a bucket (successful login, password reset). */
  clear(bucket: string): Promise<void>;
};

export type WindowRow = { hits: number; windowStart: number };

/** Fixed-window arithmetic shared by both stores (and unit-tested). */
export function nextWindow(prev: WindowRow | null, now: number, windowMs: number): WindowRow {
  if (!prev || now - prev.windowStart >= windowMs) return { hits: 1, windowStart: now };
  return { hits: prev.hits + 1, windowStart: prev.windowStart };
}

export function blockState(
  prev: WindowRow | null,
  now: number,
  limit: number,
  windowMs: number,
): BlockState {
  if (!prev) return { blocked: false, retryAfterSec: 0 };
  const resetAt = prev.windowStart + windowMs;
  if (now >= resetAt || prev.hits < limit) return { blocked: false, retryAfterSec: 0 };
  return { blocked: true, retryAfterSec: Math.max(1, Math.ceil((resetAt - now) / 1000)) };
}

/** Same window, "blocked above the limit" reading used by `hit()`: the attempt
 *  that consumes the last allowed slot still runs. */
export function allowedAt(row: WindowRow, now: number, limit: number, windowMs: number): BlockState {
  const resetAt = row.windowStart + windowMs;
  if (now >= resetAt || row.hits <= limit) return { blocked: false, retryAfterSec: 0 };
  return { blocked: true, retryAfterSec: Math.max(1, Math.ceil((resetAt - now) / 1000)) };
}

/* ── In-memory store ─────────────────────────────────────────────────────── */

export function createMemoryAttemptStore(now: () => number = Date.now): AttemptStore {
  const rows = new Map<string, WindowRow>();
  const MAX_KEYS = 20_000;

  function prune(at: number, windowMs: number): void {
    if (rows.size <= MAX_KEYS) return;
    for (const [key, row] of rows) {
      if (at - row.windowStart >= windowMs) rows.delete(key);
    }
    if (rows.size > MAX_KEYS) rows.clear(); // last resort: never grow unbounded
  }

  return {
    async isBlocked(bucket, limit, windowMs) {
      return blockState(rows.get(bucket) ?? null, now(), limit, windowMs);
    },
    async recordFailure(bucket, _limit, windowMs) {
      const at = now();
      rows.set(bucket, nextWindow(rows.get(bucket) ?? null, at, windowMs));
      prune(at, windowMs);
    },
    async hit(bucket, limit, windowMs) {
      const at = now();
      const row = nextWindow(rows.get(bucket) ?? null, at, windowMs);
      rows.set(bucket, row);
      prune(at, windowMs);
      /* Counted first, then judged: `hit` allows exactly `limit` attempts and
       * refuses the one after it. */
      return allowedAt(row, at, limit, windowMs);
    },
    async clear(bucket) {
      rows.delete(bucket);
    },
  };
}

/* ── Postgres store (shared across instances) ────────────────────────────── */

export type SqlQuery = (sql: string, params: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

const TABLE = "auth_rate_limits";

const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS ${TABLE} (
  bucket       text PRIMARY KEY,
  hits         integer     NOT NULL DEFAULT 0,
  window_start timestamptz NOT NULL DEFAULT now()
)`;

export function createPostgresAttemptStore(query: SqlQuery): AttemptStore {
  let ready: Promise<void> | null = null;
  let writes = 0;

  function ensure(): Promise<void> {
    /* Additive, idempotent DDL only — no migration, no data touched. */
    if (!ready) ready = query(CREATE_SQL, []).then(() => undefined);
    return ready;
  }

  async function maybePrune(): Promise<void> {
    /* Occasional cleanup of windows nobody will read again. */
    writes += 1;
    if (writes % 250 !== 0) return;
    await query(`DELETE FROM ${TABLE} WHERE window_start < now() - interval '1 day'`, []).catch(
      () => undefined,
    );
  }

  return {
    async isBlocked(bucket, limit, windowMs) {
      await ensure();
      const { rows } = await query(
        `SELECT hits, (extract(epoch from window_start) * 1000)::bigint AS window_start_ms
           FROM ${TABLE} WHERE bucket = $1`,
        [bucket],
      );
      const row = rows[0];
      if (!row) return { blocked: false, retryAfterSec: 0 };
      return blockState(
        { hits: Number(row["hits"]), windowStart: Number(row["window_start_ms"]) },
        Date.now(),
        limit,
        windowMs,
      );
    },

    async recordFailure(bucket, _limit, windowMs) {
      await ensure();
      /* One atomic statement: the row lock on `bucket` serialises concurrent
       * instances, so two parallel guesses cannot both read the same count. */
      await query(
        `INSERT INTO ${TABLE} AS rl (bucket, hits, window_start)
           VALUES ($1, 1, now())
         ON CONFLICT (bucket) DO UPDATE SET
           hits = CASE
                    WHEN rl.window_start > now() - make_interval(secs => $2)
                    THEN rl.hits + 1 ELSE 1 END,
           window_start = CASE
                    WHEN rl.window_start > now() - make_interval(secs => $2)
                    THEN rl.window_start ELSE now() END`,
        [bucket, windowMs / 1000],
      );
      await maybePrune();
    },

    async hit(bucket, limit, windowMs) {
      await ensure();
      const { rows } = await query(
        `INSERT INTO ${TABLE} AS rl (bucket, hits, window_start)
           VALUES ($1, 1, now())
         ON CONFLICT (bucket) DO UPDATE SET
           hits = CASE
                    WHEN rl.window_start > now() - make_interval(secs => $2)
                    THEN rl.hits + 1 ELSE 1 END,
           window_start = CASE
                    WHEN rl.window_start > now() - make_interval(secs => $2)
                    THEN rl.window_start ELSE now() END
         RETURNING hits, (extract(epoch from window_start) * 1000)::bigint AS window_start_ms`,
        [bucket, windowMs / 1000],
      );
      await maybePrune();
      const row = rows[0];
      return allowedAt(
        { hits: Number(row["hits"]), windowStart: Number(row["window_start_ms"]) },
        Date.now(),
        limit,
        windowMs,
      );
    },

    async clear(bucket) {
      await ensure();
      await query(`DELETE FROM ${TABLE} WHERE bucket = $1`, [bucket]);
    },
  };
}

/* ── Store selection with an explicit degraded mode ──────────────────────── */

export type AttemptStoreOptions = {
  env?: NodeJS.ProcessEnv;
  query?: SqlQuery;
  memory?: AttemptStore;
  onFallback?: (err: unknown) => void;
};

/** Postgres when a database is configured, otherwise memory only. A database
 *  failure degrades to the in-process counter instead of failing the request —
 *  authentication still works, it is simply enforced per instance until the
 *  database recovers (the failure is logged once). */
export function createAttemptStore(options: AttemptStoreOptions = {}): AttemptStore {
  const env = options.env ?? process.env;
  const memory = options.memory ?? createMemoryAttemptStore();
  const useShared = env["AUTH_SHARED_LIMITS"] !== "0" && Boolean(env["DATABASE_URL"]);
  if (!useShared) return memory;

  const query: SqlQuery =
    options.query ??
    (async (sql, params) => {
      const { pool } = await import("@workspace/db");
      const result = await pool.query(sql, params as unknown[]);
      return { rows: result.rows as Record<string, unknown>[] };
    });

  const primary = createPostgresAttemptStore(query);
  let warned = false;

  async function guard<T>(run: () => Promise<T>, fallback: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      if (!warned) {
        warned = true;
        options.onFallback?.(err);
      }
      return fallback();
    }
  }

  return {
    isBlocked: (b, l, w) => guard(() => primary.isBlocked(b, l, w), () => memory.isBlocked(b, l, w)),
    recordFailure: (b, l, w) =>
      guard(() => primary.recordFailure(b, l, w), () => memory.recordFailure(b, l, w)),
    hit: (b, l, w) => guard(() => primary.hit(b, l, w), () => memory.hit(b, l, w)),
    clear: (b) => guard(() => primary.clear(b), () => memory.clear(b)),
  };
}

let singleton: AttemptStore | null = null;

export function getAttemptStore(): AttemptStore {
  if (!singleton) {
    singleton = createAttemptStore({
      onFallback: () => {
        /* Lazy import avoids a cycle with the logger at module load. */
        void import("./logger").then(({ logger }) =>
          logger.warn(
            "shared login limiter unavailable — counting attempts per instance until the database recovers",
          ),
        );
      },
    });
  }
  return singleton;
}

/** Buckets shared by the user and admin login routes. */
export const LIMITS = {
  userPhone: { limit: 20, windowMs: 30 * 60 * 1000 },
  userIp: { limit: 30, windowMs: 15 * 60 * 1000 },
  /* Egyptian mobile carriers NAT many subscribers behind one address, so the
   * per-IP registration ceiling is generous; the per-phone one is strict, and a
   * successful signup clears both. */
  registerIp: { limit: 20, windowMs: 60 * 60 * 1000 },
  registerPhone: { limit: 3, windowMs: 60 * 60 * 1000 },
  adminIp: { limit: 10, windowMs: 15 * 60 * 1000 },
  adminIdentity: { limit: 5, windowMs: 15 * 60 * 1000 },
  forgotIp: { limit: 20, windowMs: 15 * 60 * 1000 },
  forgotEmail: { limit: 3, windowMs: 15 * 60 * 1000 },
} as const;
