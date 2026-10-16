import crypto from "crypto";
import jwt from "jsonwebtoken";
import type { Request, Response, NextFunction } from "express";

export type UserClaims = {
  sub: number;
  phone: string;
  name: string;
  role: "user";
  plan: string;
  vipExpiresAt?: string;
};

const JWT_SECRET = process.env["SESSION_SECRET"];

/* Browser sessions are HttpOnly cookies, not JavaScript-readable bearer
 * tokens. The bearer/header paths remain only for approved non-browser
 * clients during the compatibility window. */
export const USER_SESSION_COOKIE = "et_user_session";
export const ADMIN_SESSION_COOKIE = "et_admin_session";

type CookieRequest = Request & { cookies?: Record<string, unknown> };

export function readSessionCookie(req: Request, name: string): string {
  const value = (req as CookieRequest).cookies?.[name];
  return typeof value === "string" ? value.trim() : "";
}

export function sessionCookieOptions(maxAge?: number) {
  return {
    httpOnly: true,
    secure: process.env["NODE_ENV"] === "production" || process.env["VERCEL"] === "1",
    sameSite: "lax" as const,
    path: "/",
    ...(maxAge === undefined ? {} : { maxAge }),
  };
}

function secret(): string {
  if (!JWT_SECRET) throw new Error("SESSION_SECRET is not configured");
  return JWT_SECRET;
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

export function signUserToken(claims: UserClaims): string {
  return jwt.sign(claims, secret(), { expiresIn: "7d" });
}

export function verifyUserToken(token: string): UserClaims | null {
  if (!JWT_SECRET || !token) return null;
  try {
    const value = jwt.verify(token, JWT_SECRET);
    if (!value || typeof value === "string" || (value as { role?: string }).role !== "user") return null;
    return value as unknown as UserClaims;
  } catch {
    return null;
  }
}

export function bearerToken(req: Request): string {
  return (req.header("authorization") || "").replace(/^Bearer\s+/i, "").trim();
}

export function currentUser(req: Request): UserClaims | null {
  return verifyUserToken(readSessionCookie(req, USER_SESSION_COOKIE) || bearerToken(req));
}

export function isAdminToken(req: Request): boolean {
  const token = readSessionCookie(req, ADMIN_SESSION_COOKIE)
    || (req.header("x-admin-token") || "").trim()
    || bearerToken(req);
  if (!token || !JWT_SECRET) return false;
  try {
    const value = jwt.verify(token, JWT_SECRET);
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