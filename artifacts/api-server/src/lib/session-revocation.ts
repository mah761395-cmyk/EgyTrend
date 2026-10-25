/**
 * Server-side session revocation.
 *
 * A signed JWT is valid until it expires, so logging out, changing a password
 * or disabling an account had no effect on tokens already handed out: clearing
 * the browser cookie left a working credential in any copy of it.
 *
 * Every session now carries a `jti`, and revocations are recorded:
 *   - one token   → logout on this device
 *   - all tokens  → password change / reset / account disabled / account banned
 *
 * Storage is Postgres (the database this app already requires), so a logout on
 * one Vercel instance is seen by the others. Checks are cached for a few
 * seconds per instance to keep one database read per token per instance rather
 * than per request; revocation is therefore immediate on the instance that
 * performed it and bounded by CACHE_MS everywhere else.
 */
import type { NextFunction, Request, Response } from "express";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import {
  ADMIN_SESSION_COOKIE,
  USER_SESSION_COOKIE,
  adminSessionToken,
  bearerToken,
  clearSessionCookie,
  readSessionCookie,
} from "./userAuth";

export type SessionScope = "user" | "admin";

export type RevocationStore = {
  revokeOne(scope: SessionScope, subject: number, jti: string): Promise<void>;
  revokeAll(scope: SessionScope, subject: number): Promise<void>;
  isRevoked(scope: SessionScope, subject: number, jti: string, issuedAtMs: number): Promise<boolean>;
};

/* ── In-memory store ─────────────────────────────────────────────────────── */

export function createMemoryRevocationStore(now: () => number = Date.now): RevocationStore {
  const single = new Map<string, number>(); // "scope:subject:jti" → revokedAt
  const all = new Map<string, number>(); // "scope:subject"     → revokedAt
  const MAX_KEYS = 20_000;

  function trim(): void {
    if (single.size <= MAX_KEYS) return;
    const cutoff = now() - 30 * 24 * 60 * 60 * 1000;
    for (const [key, at] of single) if (at < cutoff) single.delete(key);
    for (const [key, at] of all) if (at < cutoff) all.delete(key);
  }

  return {
    async revokeOne(scope, subject, jti) {
      single.set(`${scope}:${subject}:${jti}`, now());
      trim();
    },
    async revokeAll(scope, subject) {
      const key = `${scope}:${subject}`;
      const at = now();
      const prev = all.get(key) ?? 0;
      all.set(key, Math.max(prev, at));
    },
    async isRevoked(scope, subject, jti, issuedAtMs) {
      if (single.has(`${scope}:${subject}:${jti}`)) return true;
      const revokedAt = all.get(`${scope}:${subject}`);
      return revokedAt !== undefined && issuedAtMs <= revokedAt;
    },
    /* Boundary is `issuedAt <= revokedAt`: a token minted in the same second as
     * the revocation dies too. Routes that keep the current device signed in
     * must mint the replacement with a later `iat` (see signUserToken options). */
  };
}

/* ── Postgres store ──────────────────────────────────────────────────────── */

export type SqlQuery = (sql: string, params: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

const TABLE = "auth_session_revocations";

const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS ${TABLE} (
  scope      text        NOT NULL,
  subject    integer     NOT NULL,
  jti        text        NOT NULL DEFAULT '',
  revoked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, subject, jti)
)`;

export function createPostgresRevocationStore(query: SqlQuery): RevocationStore {
  let ready: Promise<void> | null = null;
  let writes = 0;

  function ensure(): Promise<void> {
    /* Additive, idempotent DDL only. */
    if (!ready) ready = query(CREATE_SQL, []).then(() => undefined);
    return ready;
  }

  return {
    async revokeOne(scope, subject, jti) {
      await ensure();
      await query(
        `INSERT INTO ${TABLE} (scope, subject, jti, revoked_at)
           VALUES ($1, $2, $3, now())
         ON CONFLICT (scope, subject, jti) DO NOTHING`,
        [scope, subject, jti],
      );
    },

    async revokeAll(scope, subject) {
      await ensure();
      /* An empty jti means "every session issued at or before revoked_at". */
      await query(
        `INSERT INTO ${TABLE} AS r (scope, subject, jti, revoked_at)
           VALUES ($1, $2, '', now())
         ON CONFLICT (scope, subject, jti) DO UPDATE
           SET revoked_at = GREATEST(r.revoked_at, now())`,
        [scope, subject],
      );
      writes += 1;
      if (writes % 250 === 0) {
        await query(`DELETE FROM ${TABLE} WHERE revoked_at < now() - interval '30 days'`, []).catch(
          () => undefined,
        );
      }
    },

    async isRevoked(scope, subject, jti, issuedAtMs) {
      await ensure();
      /* Same boundary as the memory store: `>=` — tokens issued at or before
       * the revocation timestamp are dead. */
      const { rows } = await query(
        `SELECT 1 FROM ${TABLE}
          WHERE scope = $1 AND subject = $2
            AND (jti = $3 OR (jti = '' AND revoked_at >= to_timestamp($4 / 1000.0)))
          LIMIT 1`,
        [scope, subject, jti, issuedAtMs],
      );
      return rows.length > 0;
    },
  };
}

/* ── Store selection ─────────────────────────────────────────────────────── */

export type RevocationStoreOptions = {
  env?: NodeJS.ProcessEnv;
  query?: SqlQuery;
  memory?: RevocationStore;
  onFallback?: (err: unknown) => void;
};

export function createRevocationStore(options: RevocationStoreOptions = {}): RevocationStore {
  const env = options.env ?? process.env;
  const memory = options.memory ?? createMemoryRevocationStore();
  const useShared = env["AUTH_SHARED_SESSIONS"] !== "0" && Boolean(env["DATABASE_URL"]);
  if (!useShared) return memory;

  const query: SqlQuery =
    options.query ??
    (async (sql, params) => {
      const { pool } = await import("@workspace/db");
      if (!pool) throw new Error("DATABASE_URL is not configured");
      const result = await pool.query(sql, params as unknown[]);
      return { rows: result.rows as Record<string, unknown>[] };
    });

  const primary = createPostgresRevocationStore(query);
  const fallback = createMemoryRevocationStore();
  let warned = false;

  async function guard<T>(run: (store: RevocationStore) => Promise<T>): Promise<T> {
    try {
      return await run(primary);
    } catch (err) {
      if (!warned) {
        warned = true;
        options.onFallback?.(err);
      }
      return run(fallback);
    }
  }

  return {
    revokeOne: (scope, subject, jti) =>
      guard(async (store) => {
        await store.revokeOne(scope, subject, jti);
        /* The local mirror is what makes this instance see the logout at once. */
        await fallback.revokeOne(scope, subject, jti);
      }),
    revokeAll: (scope, subject) =>
      guard(async (store) => {
        await store.revokeAll(scope, subject);
        await fallback.revokeAll(scope, subject);
      }),
    isRevoked: async (scope, subject, jti, issuedAtMs) => {
      if (await fallback.isRevoked(scope, subject, jti, issuedAtMs)) return true;
      return guard((store) => store.isRevoked(scope, subject, jti, issuedAtMs));
    },
  };
}

let singleton: RevocationStore | null = null;

export function getRevocationStore(): RevocationStore {
  if (!singleton) {
    singleton = createRevocationStore({
      onFallback: () => {
        void import("./logger").then(({ logger }) =>
          logger.warn(
            "shared session revocation unavailable — only the current instance will honour new logouts",
          ),
        );
      },
    });
  }
  return singleton;
}

/* ── Token helpers ───────────────────────────────────────────────────────── */

/** Secrets are read lazily so tests can set SESSION_SECRET before first use. */
function secret(): string | null {
  return process.env["SESSION_SECRET"] || null;
}

export type SessionRef = { scope: SessionScope; subject: number; jti: string; issuedAtMs: number };

/** Decode a session token (signature checked) into what revocation needs. */
export function sessionRef(scope: SessionScope, token: string): SessionRef | null {
  const key = secret();
  if (!key || !token) return null;
  try {
    const value = jwt.verify(token, key);
    if (!value || typeof value === "string") return null;
    const payload = value as { sub?: unknown; jti?: unknown; iat?: unknown; role?: unknown };
    const subject = Number(payload.sub);
    if (!Number.isFinite(subject)) return null;
    if (scope === "user" && payload.role !== "user") return null;
    if (scope === "admin" && (payload.role !== "admin" && payload.role !== "super_admin")) {
      /* Staff roles beyond the two admin aliases are valid sessions too. */
      if (typeof payload.role !== "string" || !STAFF_ROLES.has(payload.role)) return null;
    }
    const jti = typeof payload.jti === "string" ? payload.jti : "";
    const iat = Number(payload.iat);
    return { scope, subject, jti, issuedAtMs: Number.isFinite(iat) ? iat * 1000 : 0 };
  } catch {
    return null;
  }
}

const STAFF_ROLES = new Set(["super_admin", "admin", "editor", "analyst", "support", "marketing"]);

/** Revoke the presented token. Tokens issued before `jti` existed revoke every
 *  session of that subject, which is the only safe reading of an old token. */
export async function revokePresentedSession(scope: SessionScope, token: string): Promise<boolean> {
  const ref = sessionRef(scope, token);
  if (!ref) return false;
  const store = getRevocationStore();
  if (ref.jti) await store.revokeOne(ref.scope, ref.subject, ref.jti);
  else await store.revokeAll(ref.scope, ref.subject);
  validCache.clear();
  return true;
}

export async function revokeAllSessions(scope: SessionScope, subject: number): Promise<void> {
  await getRevocationStore().revokeAll(scope, subject);
  validCache.clear();
}

export async function isSessionRevoked(ref: SessionRef): Promise<boolean> {
  return getRevocationStore().isRevoked(ref.scope, ref.subject, ref.jti, ref.issuedAtMs);
}

/* Negative results only: a revoked token is never cached, so revocation is
 * seen immediately, while the common case (valid token) costs one read per
 * instance per CACHE_MS instead of one per request. */
const CACHE_MS = 10_000;
const validCache = new Map<string, number>();

function cacheKey(ref: SessionRef): string {
  return `${ref.scope}:${ref.subject}:${ref.jti}:${ref.issuedAtMs}`;
}

async function isRevokedCached(ref: SessionRef): Promise<boolean> {
  const key = cacheKey(ref);
  const until = validCache.get(key);
  if (until && until > Date.now()) return false;
  const revoked = await isSessionRevoked(ref);
  if (!revoked) {
    if (validCache.size > 10_000) validCache.clear();
    validCache.set(key, Date.now() + CACHE_MS);
  } else {
    validCache.delete(key);
  }
  return revoked;
}

/**
 * Express middleware: strip credentials that are no longer valid.
 *
 * It never answers 401 itself — it removes the token from the request (and the
 * browser cookie) so every existing route behaves exactly as it does for an
 * anonymous visitor, and the response shapes stay unchanged.
 */
export async function sessionRevocationGuard(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const presented: { ref: SessionRef; cookie?: string; header?: string }[] = [];

    const userToken = readSessionCookie(req, USER_SESSION_COOKIE) || bearerToken(req);
    const userRef = userToken ? sessionRef("user", userToken) : null;
    if (userRef) presented.push({ ref: userRef, cookie: USER_SESSION_COOKIE });

    const staffToken = adminSessionToken(req);
    const staffRef = staffToken ? sessionRef("admin", staffToken) : null;
    if (staffRef) presented.push({ ref: staffRef, cookie: ADMIN_SESSION_COOKIE });

    for (const entry of presented) {
      if (!(await isRevokedCached(entry.ref))) continue;
      /* Revoked: make this request anonymous. Every carrier is removed — a
       * token could arrive in the cookie AND in a header, and leaving one of
       * them behind would keep the dead session authenticated. */
      const cookies = req.cookies as Record<string, string> | undefined;
      if (cookies && entry.cookie) delete cookies[entry.cookie];
      delete req.headers["authorization"];
      delete req.headers["x-admin-token"];
      if (entry.cookie) clearSessionCookie(res, entry.cookie);
    }
  } catch {
    /* Never block a request because the revocation check itself failed; the
     * authenticated route still enforces its own authorization. */
  }
  next();
}

/** Unique id for a new session (also exported for tests). */
export function newSessionId(): string {
  return crypto.randomUUID();
}
