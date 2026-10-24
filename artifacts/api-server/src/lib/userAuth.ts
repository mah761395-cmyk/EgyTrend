import crypto from "crypto";
import jwt from "jsonwebtoken";
import type { Request, Response, NextFunction } from "express";
import { ADMIN_COOKIE, SESSION_COOKIE } from "./security";

export type UserClaims = {
  sub: number;
  phone: string;
  name: string;
  role: "user";
  plan: string;
  vipExpiresAt?: string;
  /** Session id, so a single logout can be revoked server-side. */
  jti?: string;
  /** Issued-at (seconds), set by jsonwebtoken. */
  iat?: number;
};

/* Read lazily: the value arrives from the environment (Vercel, .env loaded at
 * boot, or a test that sets it before exercising the helpers), so capturing it
 * at module load made the helpers untestable and order-dependent. */
function secret(): string {
  const value = process.env["SESSION_SECRET"];
  if (!value) throw new Error("SESSION_SECRET is not configured");
  return value;
}

function secretOrNull(): string | null {
  return process.env["SESSION_SECRET"] || null;
}

export function normalizeUserPhone(value: unknown): string {
  return String(value || "").replace(/\D/g, "").slice(0, 15);
}

export function hashUserPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

export function checkUserPassword(password: string, encoded: string): boolean {
  const [, salt, expected] = encoded.split("$");
  if (!salt || !expected) return false;
  try {
    const actual = crypto.scryptSync(password, salt, 64);
    const expectedBuffer = Buffer.from(expected, "hex");
    return expectedBuffer.length === actual.length && crypto.timingSafeEqual(actual, expectedBuffer);
  } catch {
    return false;
  }
}

export function signUserToken(claims: UserClaims, options: { issuedAfterMs?: number } = {}): string {
  /* `jti` identifies this one session: logout revokes that id, while a password
   * change revokes everything issued before it. `issuedAfterMs` lets a route
   * mint the replacement session with an `iat` strictly after the revocation
   * it just wrote — without it, a token created in the same second as the
   * revocation would be revoked as well (iat has one-second resolution). */
  const { jti: _jti, iat: _iat, ...payload } = claims;
  /* jsonwebtoken takes the issued-at from the payload and has no `timestamp`
   * option (an unknown option is rejected), so the replacement session's `iat`
   * is set here: one whole second after the revocation, because `iat` only has
   * second resolution and a token minted in the same second would itself be
   * revoked. */
  const body: Record<string, unknown> = payload;
  if (options.issuedAfterMs !== undefined) {
    body["iat"] = Math.ceil(options.issuedAfterMs / 1000) + 1;
  }
  return jwt.sign(body, secret(), {
    expiresIn: "7d",
    jwtid: crypto.randomUUID(),
  });
}

export function verifyUserToken(token: string): UserClaims | null {
  const key = secretOrNull();
  if (!key || !token) return null;
  try {
    const value = jwt.verify(token, key);
    if (!value || typeof value === "string" || (value as { role?: string }).role !== "user") return null;
    return value as unknown as UserClaims;
  } catch {
    return null;
  }
}

/* Session token for app users: httpOnly cookie first (the SPA no longer keeps
 * tokens in localStorage), then the Authorization header for non-browser
 * clients that legitimately hold a token. */
export function bearerToken(req: Request): string {
  const cookieToken = (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE];
  if (cookieToken) return String(cookieToken).trim();
  return (req.header("authorization") || "").replace(/^Bearer\s+/i, "").trim();
}

/* Admin/staff session: httpOnly cookie first, header second (kept so existing
 * non-browser tooling that already holds a token keeps working). */
export function adminToken(req: Request): string {
  const cookieToken = (req.cookies as Record<string, string> | undefined)?.[ADMIN_COOKIE];
  if (cookieToken) return String(cookieToken).trim();
  return (req.header("x-admin-token") || req.header("authorization") || "")
    .replace(/^Bearer\s+/i, "")
    .trim();
}

export function currentUser(req: Request): UserClaims | null {
  return verifyUserToken(bearerToken(req));
}

export function isAdminToken(req: Request): boolean {
  const token = adminToken(req);
  const key = secretOrNull();
  if (!token || !key) return false;
  try {
    const value = jwt.verify(token, key);
    const role = value && typeof value !== "string" ? (value as { role?: string }).role : undefined;
    return role === "admin" || role === "super_admin";
  } catch {
    return false;
  }
}

export function isVipClaims(claims: UserClaims | null): boolean {
  if (!claims || claims.plan !== "vip") return false;
  return !claims.vipExpiresAt || new Date(claims.vipExpiresAt).getTime() > Date.now();
}

/* DB-backed VIP check: the JWT embeds the plan for up to 7 days, so without
 * this a banned or downgraded user would keep VIP access until token expiry.
 * Also the reverse: a user upgraded AFTER login carries a stale non-VIP
 * claim — the DB is the source of truth, so re-verify before rejecting.
 * Fail-open only applies when the claims themselves said VIP (pre-existing
 * behavior for transient DB hiccups); a non-VIP claim never fails open. */
async function dbVipCheck(userId: number): Promise<boolean> {
  const { db } = await import("@workspace/db");
  const { appUsersTable } = await import("@workspace/db/schema");
  const { and, eq } = await import("drizzle-orm");
  const [row] = await db
    .select({ plan: appUsersTable.plan, status: appUsersTable.status, vipExpiresAt: appUsersTable.vipExpiresAt })
    .from(appUsersTable)
    .where(and(eq(appUsersTable.id, userId), eq(appUsersTable.status, "active")))
    .limit(1);
  if (!row) return false; // user deleted or banned
  if (row.plan !== "vip") return false; // downgraded or not yet VIP
  return !row.vipExpiresAt || row.vipExpiresAt.getTime() > Date.now();
}

export async function isVipActive(claims: UserClaims | null): Promise<boolean> {
  if (!claims) return false;
  if (isVipClaims(claims)) {
    try {
      return await dbVipCheck(claims.sub);
    } catch {
      return true; // claims already validated; only a DB failure lands here
    }
  }
  // Claims say non-VIP — could be a stale token (VIP granted after login).
  // Verify against the DB, but fail CLOSED on DB errors (never grant VIP
  // from a failed check).
  try {
    return await dbVipCheck(claims.sub);
  } catch {
    return false;
  }
}

export async function requireVipUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  const claims = currentUser(req);
  if (!claims) {
    res.status(401).json({ status: "error", message: "login required" });
    return;
  }
  // DB-backed (handles stale claims both ways: revoked VIP → 403 even with
  // an old vip token; freshly-granted VIP → allowed even with an old free token).
  if (!(await isVipActive(claims))) {
    res.status(403).json({ status: "error", message: "VIP subscription required" });
    return;
  }
  next();
}