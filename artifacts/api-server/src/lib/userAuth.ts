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

export type VipEntitlement = {
  /** `true` only after a server-side user + entitlement check. */
  active: boolean;
  /** subscription is the post-migration source of truth; legacy is temporary compatibility only. */
  source: "subscription" | "legacy" | "none";
  planKey: string | null;
  planNameAr: string | null;
  planFeatures: string[];
  status: "active" | "grace" | "cancelled" | "expired" | "none";
  expiresAt: Date | null;
  graceEndsAt: Date | null;
};

const NO_VIP: VipEntitlement = {
  active: false,
  source: "none",
  planKey: null,
  planNameAr: null,
  planFeatures: [],
  status: "none",
  expiresAt: null,
  graceEndsAt: null,
};

function legacyEntitlement(row: { plan: string; vipExpiresAt: Date | null }, now = new Date()): VipEntitlement {
  if (row.plan !== "vip") return NO_VIP;
  /* Compatibility bridge for users that predate 0002. It is deliberately
   * server-side, never based on the JWT, and will disappear only after every
   * legacy record has been reconciled. A missing historic expiry is preserved
   * rather than silently inventing an expiry or breaking a paid user. */
  const active = !row.vipExpiresAt || row.vipExpiresAt.getTime() > now.getTime();
  return {
    active,
    source: "legacy",
    planKey: "legacy-vip",
    planNameAr: "اشتراك VIP سابق",
    planFeatures: [],
    status: active ? "active" : "expired",
    expiresAt: row.vipExpiresAt,
    graceEndsAt: null,
  };
}

function subscriptionTableMissing(error: unknown): boolean {
  const e = error as { code?: unknown; cause?: { code?: unknown }; message?: unknown } | null;
  const code = String(e?.code || e?.cause?.code || "");
  const message = String(e?.message || "");
  return code === "42P01" || /user_subscriptions.+(?:does not exist|undefined)/i.test(message);
}

/**
 * Resolves the single server-side VIP entitlement. New approvals always write
 * `user_subscriptions`; the legacy projection is read only as a temporary,
 * documented migration bridge for accounts that have not been backfilled.
 * JWT `plan` / browser state never grants access.
 */
export async function getVipEntitlement(claims: Pick<UserClaims, "sub"> | null, now = new Date()): Promise<VipEntitlement> {
  if (!claims || !Number.isInteger(claims.sub) || claims.sub <= 0) return NO_VIP;
  if (!Number.isFinite(now.getTime())) return NO_VIP;
  const { db } = await import("@workspace/db");
  const { appUsersTable, userSubscriptionsTable } = await import("@workspace/db/schema");
  const { and, eq } = await import("drizzle-orm");

  const [user] = await db
    .select({ plan: appUsersTable.plan, status: appUsersTable.status, vipExpiresAt: appUsersTable.vipExpiresAt })
    .from(appUsersTable)
    .where(and(eq(appUsersTable.id, claims.sub), eq(appUsersTable.status, "active")))
    .limit(1);
  if (!user) return NO_VIP;

  try {
    const [subscription] = await db
      .select({
        planKey: userSubscriptionsTable.planKey,
        planNameAr: userSubscriptionsTable.planNameAr,
        planFeatures: userSubscriptionsTable.planFeatures,
        status: userSubscriptionsTable.status,
        expiresAt: userSubscriptionsTable.expiresAt,
        graceEndsAt: userSubscriptionsTable.graceEndsAt,
      })
      .from(userSubscriptionsTable)
      .where(eq(userSubscriptionsTable.userId, claims.sub))
      .limit(1);

    if (subscription) {
      const expiresAt = subscription.expiresAt;
      const paidActive = subscription.status === "active" && expiresAt.getTime() > now.getTime();
      const graceActive = (subscription.status === "active" || subscription.status === "grace")
        && expiresAt.getTime() <= now.getTime()
        && Boolean(subscription.graceEndsAt && subscription.graceEndsAt.getTime() > now.getTime());
      const active = paidActive || graceActive;
      return {
        active,
        source: "subscription",
        planKey: subscription.planKey,
        planNameAr: subscription.planNameAr,
        planFeatures: Array.isArray(subscription.planFeatures) ? subscription.planFeatures : [],
        status: paidActive ? "active" : graceActive ? "grace" : subscription.status === "cancelled" ? "cancelled" : "expired",
        expiresAt,
        graceEndsAt: subscription.graceEndsAt,
      };
    }
  } catch (error) {
    /* A deployment must run 0002 before application code. The narrow fallback
     * makes rollback/old Preview environments safe without treating any other
     * database failure as a VIP grant. */
    if (!subscriptionTableMissing(error)) throw error;
    return legacyEntitlement(user, now);
  }

  return legacyEntitlement(user, now);
}

/** The one authorization predicate used by every paid API/content gate. */
export async function hasVip(claims: Pick<UserClaims, "sub"> | null): Promise<boolean> {
  try {
    return (await getVipEntitlement(claims)).active;
  } catch {
    /* Authorization always fails closed on an unavailable/corrupt database. */
    return false;
  }
}

export async function requireVipUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  const claims = currentUser(req);
  if (!claims) {
    res.status(401).json({ status: "error", message: "login required" });
    return;
  }
  if (!(await hasVip(claims))) {
    res.status(403).json({ status: "error", message: "VIP subscription required" });
    return;
  }
  next();
}

