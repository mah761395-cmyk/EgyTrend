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
  return verifyUserToken(bearerToken(req));
}

export function isAdminToken(req: Request): boolean {
  const token = (req.header("x-admin-token") || "").trim();
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
 * Falls back to claims when the DB is unreachable so AI features don't break
 * on a transient DB hiccup (fail-open matches the pre-existing behavior). */
export async function isVipActive(claims: UserClaims | null): Promise<boolean> {
  if (!isVipClaims(claims)) return false;
  try {
    const { db } = await import("@workspace/db");
    const { appUsersTable } = await import("@workspace/db/schema");
    const { and, eq } = await import("drizzle-orm");
    const [row] = await db
      .select({ plan: appUsersTable.plan, status: appUsersTable.status, vipExpiresAt: appUsersTable.vipExpiresAt })
      .from(appUsersTable)
      .where(and(eq(appUsersTable.id, claims!.sub), eq(appUsersTable.status, "active")))
      .limit(1);
    if (!row) return false; // user deleted or banned
    if (row.plan !== "vip") return false; // downgraded
    return !row.vipExpiresAt || row.vipExpiresAt.getTime() > Date.now();
  } catch {
    return true; // claims already validated; only a DB failure lands here
  }
}

export function requireVipUser(req: Request, res: Response, next: NextFunction): void {
  const claims = currentUser(req);
  if (!claims) {
    res.status(401).json({ status: "error", message: "login required" });
    return;
  }
  if (!isVipClaims(claims)) {
    res.status(403).json({ status: "error", message: "VIP subscription required" });
    return;
  }
  next();
}