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
  /** Session id, so a single logout can be revoked server-side. */
  jti?: string;
  /** Issued-at (seconds), set by jsonwebtoken. */
  iat?: number;
  /** Expiry (seconds), set by jsonwebtoken; used for sliding refresh. */
  exp?: number;
};

/* Read lazily: the value arrives from the environment (Vercel, .env loaded at
 * boot, or a test that sets it before exercising the helpers), so capturing it
 * at module load made the helpers order-dependent and untestable. */
function secretOrNull(): string | null {
  return process.env["SESSION_SECRET"] || null;
}

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
  const value = secretOrNull();
  if (!value) throw new Error("SESSION_SECRET is not configured");
  return value;
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
   * change revokes everything issued before it. jsonwebtoken takes the issued-at
   * from the payload and has no `timestamp` option, so a replacement session is
   * placed one whole second after the revocation it just wrote — `iat` only has
   * second resolution, and a token minted in the same second would itself be
   * revoked. */
  const { jti: _jti, iat: _iat, ...payload } = claims;
  const body: Record<string, unknown> = payload;
  if (options.issuedAfterMs !== undefined) {
    body["iat"] = Math.ceil(options.issuedAfterMs / 1000) + 1;
  }
  return jwt.sign(body, secret(), { expiresIn: "7d", jwtid: crypto.randomUUID() });
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

export function bearerToken(req: Request): string {
  return (req.header("authorization") || "").replace(/^Bearer\s+/i, "").trim();
}

export function currentUser(req: Request): UserClaims | null {
  return verifyUserToken(readSessionCookie(req, USER_SESSION_COOKIE) || bearerToken(req));
}

export const STAFF_ROLES = ["super_admin", "admin", "editor", "analyst", "support", "marketing"] as const;
export type StaffRole = typeof STAFF_ROLES[number];

/**
 * Administrative claims are only a short-lived session hint. Every protected
 * operation resolves a positive staff ID against the current employee row so
 * disabling an account or changing its role takes effect immediately instead
 * of waiting for a previously issued JWT to expire.
 *
 * `break_glass` is intentionally explicit and exists only for the configured
 * password-only bootstrap login. A raw static ADMIN_TOKEN is never accepted.
 */
export type AdminClaims = {
  sub: number;
  name: string;
  role: StaffRole;
  email: string;
  authSource?: "break_glass";
  /** Session id, so a panel logout can be revoked server-side. */
  jti?: string;
  /** Issued-at (seconds), set by jsonwebtoken. */
  iat?: number;
};

function isStaffRole(value: unknown): value is StaffRole {
  return typeof value === "string" && (STAFF_ROLES as readonly string[]).includes(value);
}

export function adminSessionToken(req: Request): string {
  return readSessionCookie(req, ADMIN_SESSION_COOKIE) || bearerToken(req);
}

/** Expire a session cookie (name: USER_SESSION_COOKIE or ADMIN_SESSION_COOKIE). */
export function clearSessionCookie(res: Response, name: string): void {
  const { maxAge: _maxAge, ...options } = sessionCookieOptions();
  res.clearCookie(name, options);
}

/** Verifies the signed administrative session without trusting its stale role. */
export function currentAdminClaims(req: Request): AdminClaims | null {
  const token = adminSessionToken(req);
  const key = secretOrNull();
  if (!token || !key) return null;
  try {
    const value = jwt.verify(token, key);
    if (!value || typeof value === "string") return null;
    const raw = value as Partial<AdminClaims>;
    const sub = Number(raw.sub);
    if (!Number.isSafeInteger(sub) || sub < 0 || !isStaffRole(raw.role)) return null;
    if (sub === 0 && raw.authSource !== "break_glass") return null;
    const iat = Number((raw as { iat?: unknown }).iat);
    return {
      sub,
      name: typeof raw.name === "string" ? raw.name : "",
      role: raw.role,
      email: typeof raw.email === "string" ? raw.email : "",
      ...(raw.authSource === "break_glass" ? { authSource: "break_glass" as const } : {}),
      ...(typeof (raw as { jti?: unknown }).jti === "string"
        ? { jti: (raw as { jti: string }).jti }
        : {}),
      ...(Number.isFinite(iat) ? { iat } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Returns a server-current staff identity, failing closed on DB failure,
 * deletion, suspension, role changes, or malformed legacy tokens. The
 * break-glass session remains explicit and is never a header/API key.
 */
export async function currentActiveAdmin(req: Request): Promise<AdminClaims | null> {
  const claims = currentAdminClaims(req);
  if (!claims) return null;
  try {
    const { db } = await import("@workspace/db");
    const { employeesTable } = await import("@workspace/db/schema");
    const { and, eq } = await import("drizzle-orm");
    /* Break-glass is an emergency bootstrap path, not a permanent parallel
     * super-admin account. Once the staff directory contains an active
     * super_admin, both new and already-issued break-glass sessions stop
     * working immediately. A DB failure is also a deny, never a fallback. */
    if (claims.sub === 0) {
      if (claims.authSource !== "break_glass") return null;
      const [staffSuperAdmin] = await db.select({ id: employeesTable.id })
        .from(employeesTable)
        .where(and(eq(employeesTable.role, "super_admin"), eq(employeesTable.status, "active")))
        .limit(1);
      return staffSuperAdmin ? null : claims;
    }
    const [staff] = await db.select({
      id: employeesTable.id,
      name: employeesTable.name,
      email: employeesTable.email,
      role: employeesTable.role,
      status: employeesTable.status,
    }).from(employeesTable).where(eq(employeesTable.id, claims.sub)).limit(1);
    if (!staff || staff.status !== "active" || !isStaffRole(staff.role)) return null;
    return { sub: staff.id, name: staff.name, email: staff.email, role: staff.role };
  } catch {
    return null;
  }
}

/** Paid-feature bypasses are reserved for active administrator roles only. */
export async function isActivePrivilegedAdmin(req: Request): Promise<boolean> {
  const admin = await currentActiveAdmin(req);
  return admin?.role === "admin" || admin?.role === "super_admin";
}

/* ═══ Staff → app identity bridge (admin login = full VIP, safely) ═══════
 * A verified, active, privileged staff session (admin / super_admin) maps to
 * a stable, dedicated app_users row (phone "staff-<employeeId>") so its
 * user-scoped data (fee profiles, scenarios, portfolio, alerts) has an owner
 * without ever touching a real customer account.
 *
 * Safety properties:
 *  - The staff phone contains non-digits, so normalizeUserPhone() reduces it
 *    to "" — it can never be found by phone login, SMS, or referral matching.
 *  - The password hash is a random unusable value; user password login can
 *    never succeed against it.
 *  - currentActiveAdmin() re-checks the live employee row on every call, so a
 *    suspended/deleted staff member loses app VIP immediately (fail closed).
 *  - An archived/banned staff row is a kill switch: the bridge refuses to map
 *    (401 on data and entitlement gates) until the row is active again.
 * ══════════════════════════════════════════════════════════════════════ */
export const STAFF_PHONE_PREFIX = "staff-";
export function staffPhoneFor(employeeId: number): string {
  return `${STAFF_PHONE_PREFIX}${employeeId}`;
}
export function isStaffLinkedPhone(phone: unknown): boolean {
  return typeof phone === "string" && phone.startsWith(STAFF_PHONE_PREFIX);
}

export type AppOwner = {
  /** The app_users.id that owns all user-scoped data for this request. */
  sub: number;
  /** true when the owner is the staff-linked row (not a customer account). */
  staff: boolean;
};

async function ensureStaffUserRow(admin: AdminClaims): Promise<number | null> {
  const { db } = await import("@workspace/db");
  const { appUsersTable } = await import("@workspace/db/schema");
  const { eq } = await import("drizzle-orm");
  const { isDuplicateKeyError } = await import("./dbErrors");
  const phone = staffPhoneFor(admin.sub);
  const [row] = await db.select({ id: appUsersTable.id, status: appUsersTable.status })
    .from(appUsersTable).where(eq(appUsersTable.phone, phone)).limit(1);
  if (row) return row.status === "active" ? row.id : null;
  const now = new Date();
  try {
    const [created] = await db.insert(appUsersTable).values({
      phone,
      name: `موظف — ${admin.name}`.slice(0, 120),
      /* Unusable by construction: user login looks accounts up by a
       * digit-normalized phone, which can never match this namespace. */
      passwordHash: `staff-unusable$${crypto.randomBytes(24).toString("hex")}`,
      plan: "vip",
      status: "active",
      createdAt: now,
      updatedAt: now,
    }).returning({ id: appUsersTable.id });
    return created?.id ?? null;
  } catch (error) {
    if (!isDuplicateKeyError(error)) return null;
    const [again] = await db.select({ id: appUsersTable.id, status: appUsersTable.status })
      .from(appUsersTable).where(eq(appUsersTable.phone, phone)).limit(1);
    return again && again.status === "active" ? again.id : null;
  }
}

/**
 * The app data owner for a request: the customer's user session when present
 * (behavior unchanged), else a verified, active, privileged staff session
 * mapped to its dedicated staff-linked user row.
 */
export async function currentAppOwner(req: Request): Promise<AppOwner | null> {
  const user = currentUser(req);
  if (user) return { sub: user.sub, staff: false };
  const admin = await currentActiveAdmin(req);
  if (!admin || (admin.role !== "admin" && admin.role !== "super_admin")) return null;
  try {
    const sub = await ensureStaffUserRow(admin);
    return sub ? { sub, staff: true } : null;
  } catch {
    return null;
  }
}

export type VipEntitlement = {
  /** `true` only after a server-side user + entitlement check. */
  active: boolean;
  /** subscription is the post-migration source of truth; legacy is temporary compatibility only. */
  source: "subscription" | "legacy" | "none";
  subscriptionType: "paid" | "trial" | "legacy" | "none";
  planKey: string | null;
  planNameAr: string | null;
  planFeatures: string[];
  /** A selected-scope trial still has VIP, but individual server gates consult this scope. */
  trialFeatureScope: string[] | "all" | null;
  trialAiDailyLimit: number | null;
  trialStartedAt: Date | null;
  trialEndsAt: Date | null;
  trialEndedAt: Date | null;
  trialConvertedAt: Date | null;
  status: "active" | "grace" | "cancelled" | "expired" | "none";
  expiresAt: Date | null;
  graceEndsAt: Date | null;
};

const NO_VIP: VipEntitlement = {
  active: false,
  source: "none",
  subscriptionType: "none",
  planKey: null,
  planNameAr: null,
  planFeatures: [],
  trialFeatureScope: null,
  trialAiDailyLimit: null,
  trialStartedAt: null,
  trialEndsAt: null,
  trialEndedAt: null,
  trialConvertedAt: null,
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
    subscriptionType: "legacy",
    planKey: "legacy-vip",
    planNameAr: "اشتراك VIP سابق",
    planFeatures: [],
    trialFeatureScope: null,
    trialAiDailyLimit: null,
    trialStartedAt: null,
    trialEndsAt: null,
    trialEndedAt: null,
    trialConvertedAt: null,
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
        subscriptionType: userSubscriptionsTable.subscriptionType,
        trialFeatureScope: userSubscriptionsTable.trialFeatureScope,
        trialAiDailyLimit: userSubscriptionsTable.trialAiDailyLimit,
        trialStartedAt: userSubscriptionsTable.trialStartedAt,
        trialEndsAt: userSubscriptionsTable.trialEndsAt,
        trialEndedAt: userSubscriptionsTable.trialEndedAt,
        trialConvertedAt: userSubscriptionsTable.trialConvertedAt,
        startsAt: userSubscriptionsTable.startsAt,
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
      /* A payment approved mid-trial has a future paid startsAt. The current
       * row is paid for billing/lifecycle purposes, but the retained trial
       * feature snapshot remains authoritative until that date. */
      const trialWindowBeforePaidStart = subscription.subscriptionType === "paid"
        && subscription.startsAt.getTime() > now.getTime()
        && !!subscription.trialEndsAt && subscription.trialEndsAt.getTime() > now.getTime()
        && (subscription.trialFeatureScope === "all" || Array.isArray(subscription.trialFeatureScope));
      return {
        active,
        source: "subscription",
        subscriptionType: subscription.subscriptionType === "trial" || trialWindowBeforePaidStart ? "trial" : "paid",
        planKey: subscription.planKey,
        planNameAr: subscription.planNameAr,
        planFeatures: Array.isArray(subscription.planFeatures) ? subscription.planFeatures : [],
        trialFeatureScope: (subscription.subscriptionType === "trial" || trialWindowBeforePaidStart)
          ? (subscription.trialFeatureScope === "all" || Array.isArray(subscription.trialFeatureScope) ? subscription.trialFeatureScope : "all")
          : null,
        trialAiDailyLimit: (subscription.subscriptionType === "trial" || trialWindowBeforePaidStart) && Number.isInteger(subscription.trialAiDailyLimit)
          ? Number(subscription.trialAiDailyLimit) : null,
        trialStartedAt: subscription.trialStartedAt,
        trialEndsAt: subscription.trialEndsAt,
        trialEndedAt: subscription.trialEndedAt,
        trialConvertedAt: subscription.trialConvertedAt,
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

/**
 * Resolves VIP for an optional feature WITHOUT hiding database failures.
 * Gates must still fail closed on `error: true`, but with an honest 503 so
 * the client can offer a retry instead of telling a valid VIP that their
 * subscription is over.
 */
export interface VipFeatureCheck {
  /** True when the entitlement was readable AND covers the requested feature. */
  vip: boolean;
  /** The entitlement row when readable, otherwise null. */
  entitlement: VipEntitlement | null;
  /** True when the entitlement store itself could not be read. */
  error: boolean;
}

export async function resolveVipFeature(
  claims: Pick<UserClaims, "sub"> | null,
  feature?: string,
): Promise<VipFeatureCheck> {
  try {
    const entitlement = await getVipEntitlement(claims);
    let vip = entitlement.active;
    if (vip && feature !== undefined && entitlement.subscriptionType === "trial") {
      vip =
        entitlement.trialFeatureScope === "all" ||
        (Array.isArray(entitlement.trialFeatureScope) && entitlement.trialFeatureScope.includes(feature));
    }
    return { vip, entitlement, error: false };
  } catch {
    return { vip: false, entitlement: null, error: true };
  }
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

/** A trial may be configured for a selected feature subset. `hasVip()` stays
 * true for its whole active period, while every feature-specific server gate
 * calls this predicate so a browser can never expand the chosen scope. */
export async function hasVipFeature(claims: Pick<UserClaims, "sub"> | null, feature: string): Promise<boolean> {
  try {
    const entitlement = await getVipEntitlement(claims);
    if (!entitlement.active) return false;
    if (entitlement.subscriptionType !== "trial") return true;
    return entitlement.trialFeatureScope === "all"
      || (Array.isArray(entitlement.trialFeatureScope) && entitlement.trialFeatureScope.includes(feature));
  } catch {
    return false;
  }
}

/* Status-code contract shared by every paid gate, so the client can tell the
 * three failure modes apart instead of showing one generic message:
 *   401 — no (valid) session at all            -> "log in"
 *   403 — signed in, entitlement not active    -> "subscription over / renew"
 *   503 — entitlement store unreachable        -> "server hiccup, retry"
 * All three DENY access (fail closed); they only differ in the truth told. */
const SERVER_ERROR_BODY = { status: "error", message: "server_error", detail: "تعذر التحقق من اشتراكك الآن — أعد المحاولة" } as const;

/* A customer session always wins (same priority the client boot uses). Only
 * when no user session exists does a verified, active, privileged staff
 * session unlock the paid features — the same bypass the AI and markets
 * routes already grant. */
async function staffVipBypass(req: Request): Promise<boolean> {
  return currentUser(req) === null && (await isActivePrivilegedAdmin(req));
}

export async function requireVipUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  const claims = currentUser(req);
  if (!claims) {
    if (await staffVipBypass(req)) { next(); return; }
    res.status(401).json({ status: "error", message: "login required" });
    return;
  }
  const check = await resolveVipFeature(claims);
  if (check.error) {
    res.status(503).json(SERVER_ERROR_BODY);
    return;
  }
  if (!check.vip) {
    res.status(403).json({ status: "error", message: "VIP subscription required" });
    return;
  }
  next();
}

export function requireVipFeature(feature: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const claims = currentUser(req);
    if (!claims) {
      if (await staffVipBypass(req)) { next(); return; }
      res.status(401).json({ status: "error", message: "login required" });
      return;
    }
    const check = await resolveVipFeature(claims, feature);
    if (check.error) {
      res.status(503).json(SERVER_ERROR_BODY);
      return;
    }
    if (!check.vip) {
      res.status(403).json({ status: "error", message: "هذه الميزة غير متاحة ضمن اشتراكك الحالي" });
      return;
    }
    next();
  };
}
