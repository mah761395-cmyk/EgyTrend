import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { logger } from "../lib/logger";
import {
  ADMIN_SESSION_COOKIE,
  adminSessionToken,
  currentUser,
  currentActiveAdmin,
  readSessionCookie,
  sessionCookieOptions,
} from "../lib/userAuth";
import {
  createPermissionChecker,
  normalizePermissions,
  permissionForAdminPath,
} from "../lib/admin-permissions";
import { revokeAllSessions, revokePresentedSession } from "../lib/session-revocation";
import { LIMITS, getAttemptStore } from "../lib/rate-limit";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import {
  listSources, listSourceInventory, upsertSource, deleteSource,
  listCustomArticles, upsertCustomArticle, deleteCustomArticle,
  type SourceMeta, type CustomArticle,
} from "../lib/dataStore";
import { db } from "@workspace/db";
import {
  employeesTable, subscriptionPlansTable, couponsTable, auditLogsTable, aiConfigTable, aiUsageTable, paymentRequestsTable, appUsersTable, userNotificationsTable,
  userSubscriptionsTable, appSettingsTable, planPriceOffersTable, planPriceChangeLogsTable,
  subscriptionLifecycleEventsTable, subscriptionRemindersSentTable, trialClaimsTable,
} from "@workspace/db";
import { eq, desc, and, gte, lte, like, or, sql, isNull, inArray } from "drizzle-orm";
import {
  getEffectivePrice,
  getPaymentPriceLockHours,
  invalidatePricingCache,
  PricingInputError,
  pricingCacheVersion,
  readPaymentPriceSnapshot,
  validatePaymentPriceLockHours,
  validatePriceOffer,
  validatePricePresentation,
  type ValidatedOfferInput,
} from "../lib/pricing";
import {
  calculateApprovedSubscriptionEnd,
  calculateSubscriptionGraceEnd,
  createSubscriptionCycleId,
  listExpiringSubscriptions,
  listSubscriptionEmailFailures,
  queueManualSubscriptionReminder,
  readSubscriptionLifecycleSettings,
  runSubscriptionLifecycle,
  saveSubscriptionLifecycleSettings,
  subscriptionAdminSummary,
  validateSubscriptionLifecycleSettings,
} from "../lib/subscription-lifecycle";
import { parseCairoDateTime } from "../lib/subscription-time";
import { isDuplicateKeyError } from "../lib/dbErrors";
import {
  archiveFreeTrialMessageStep,
  createFreeTrialMessageStep,
  endFreeTrialNow,
  extendFreeTrial,
  freeTrialStats,
  listAdminFreeTrialUsers,
  listFreeTrialMessageSteps,
  previewFreeTrialMessageStep,
  startFreeTrial,
  updateFreeTrialMessageStep,
} from "../lib/free-trials";
import { readFreeTrialSettings, saveFreeTrialSettings, validateFreeTrialSettings } from "../lib/trial-settings";
import { isSmtpConfigured, sendMail } from "../lib/mailer";
import {
  BROADCAST_TEMPLATES,
  archiveBroadcast,
  broadcastMediaById,
  createBroadcast,
  createBroadcastMedia,
  createBroadcastTestDelivery,
  duplicateBroadcast,
  listBroadcastsForAdmin,
  pauseBroadcast,
  previewBroadcastDraft,
  updateBroadcast,
  validateBroadcastDraft,
} from "../lib/broadcasts";
import {
  adminReferralDashboard,
  approveReferralReview,
  archiveReferralCampaign,
  archiveReferralTier,
  archiveSpecialReferralCode,
  cancelReferralReward,
  createReferralCampaign,
  createReferralTier,
  createSpecialReferralCode,
  grantManualReferralReward,
  rejectReferralReview,
  saveReferralSettings,
  saveReferralTemplate,
  setReferralUserProgramState,
  updateReferralCampaign,
  updateReferralTier,
  updateSpecialReferralCode,
  validateReferralCampaign,
  validateReferralTier,
  validateReferralSettings,
  withdrawReferralReward,
  onReferralPaymentApproved,
  onReferralPaymentCancelled,
} from "../lib/referrals";

const router: IRouter = Router();

/* ─── Secrets ─── */
const JWT_SECRET = process.env["SESSION_SECRET"];
const ADMIN_PASSWORD = process.env["ADMIN_PASSWORD"];

/* Operator recovery switch for the password-only break-glass session.
 *
 * Secure default: once a real active super_admin employee exists, the
 * password-only path stays closed so the staff account remains the single
 * authority. A locked-out operator (unknown staff password) can temporarily
 * set ADMIN_BREAK_GLASS=on, sign in with ADMIN_PASSWORD, reset the staff
 * password from the panel, and turn the flag off again. It is read from the
 * environment on every boot and is never a stored credential. */
const ADMIN_BREAK_GLASS =
  String(process.env["ADMIN_BREAK_GLASS"] ?? "off").trim().toLowerCase() === "on";

/* ─── Brute-force protection on /login ─── */
const loginAttempts = new Map<string, { count: number; until: number }>();
const MAX_LOGIN_ATTEMPTS = 10;
const LOGIN_LOCKOUT_MS   = 15 * 60 * 1000; // 15 min

function checkLoginBruteForce(ip: string): "ok" | "locked" {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry) return "ok";
  // Locked only after reaching max attempts within the window
  if (entry.count >= MAX_LOGIN_ATTEMPTS && now < entry.until) return "locked";
  // Reset if window expired
  if (now >= entry.until) { loginAttempts.delete(ip); }
  return "ok";
}
function recordLoginFailure(ip: string): void {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now >= entry.until) {
    // Start new window
    loginAttempts.set(ip, { count: 1, until: now + LOGIN_LOCKOUT_MS });
  } else {
    entry.count++;
  }
}
function clearLoginFailures(ip: string): void {
  loginAttempts.delete(ip);
}

/* ─── Rate limiting on payment requests (per phone, 3 per 10 min) ─── */
/* ─── Generic sliding-window rate limiter (per key: IP + optional identity) ─── */
const rlBuckets = new Map<string, number[]>();

function rateLimitHit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const arr = (rlBuckets.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) { rlBuckets.set(key, arr); return false; }
  arr.push(now);
  rlBuckets.set(key, arr);
  return true;
}

/* Periodic GC so long-lived processes don't accumulate stale buckets. */
setInterval(() => {
  const now = Date.now();
  for (const [k, arr] of rlBuckets) {
    const alive = arr.filter((t) => now - t < 30 * 60 * 1000);
    if (alive.length === 0) rlBuckets.delete(k); else rlBuckets.set(k, alive);
  }
  for (const [k, v] of loginAttempts) {
    if (now >= v.until) loginAttempts.delete(k);
  }
}, 10 * 60 * 1000).unref();

const payReqMap = new Map<string, number[]>();
const PAY_REQ_MAX    = 3;
const PAY_REQ_WINDOW = 10 * 60 * 1000; // 10 min

export function checkPayRateLimit(phone: string): "ok" | "limited" {
  const now  = Date.now();
  const hits = (payReqMap.get(phone) || []).filter(t => now - t < PAY_REQ_WINDOW);
  if (hits.length >= PAY_REQ_MAX) return "limited";
  hits.push(now);
  payReqMap.set(phone, hits);
  return "ok";
}

/* ─── Input sanitizer (strip HTML tags) ─── */
function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, "").replace(/[<>]/g, "");
}

/* ─── JWT helpers ─── */
interface JWTPayload { sub: number; name: string; role: string; email: string; authSource?: "break_glass"; }

function signToken(payload: JWTPayload, expiresIn: "24h" | "15m" = "24h"): string {
  if (!JWT_SECRET) throw new Error("SESSION_SECRET is not configured");
  /* `jti` = one session, so a panel logout revokes exactly that session instead
   * of leaving a copied token valid until it expires. */
  return jwt.sign(payload, JWT_SECRET, { expiresIn, jwtid: crypto.randomUUID() });
}

/* Rate limit for authenticated admin WRITE endpoints: 30 mutations / 5 min per IP+identity. */
const WRITE_RL_MAX = 30;
const WRITE_RL_WINDOW = 5 * 60 * 1000;
function requireWriteRate(req: AuthRequest, res: Response, next: NextFunction) {
  const who = req.actor?.sub ?? req.actor?.email ?? "anon";
  const key = `wr:${req.ip || "unknown"}:${who}`;
  if (!rateLimitHit(key, WRITE_RL_MAX, WRITE_RL_WINDOW)) {
    res.setHeader("Retry-After", "60");
    res.status(429).json({ status: "error", message: "too many admin actions — slow down" });
    return;
  }
  next();
}

/* ─── Password helpers ───
 * New hashes: scrypt with per-password salt ("scrypt$<salthex>$<hashhex>").
 * Legacy hashes (sha256(pw+secret)) are still verified for accounts created
 * before this change; they are re-hashed to scrypt on next successful login. */
const SCRYPT_KEYLEN = 64;

function hashPassword(pw: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(pw, salt, SCRYPT_KEYLEN).toString("hex");
  return `scrypt$${salt}$${hash}`;
}
function legacyHash(pw: string): string {
  return crypto.createHash("sha256").update(pw + JWT_SECRET).digest("hex");
}
function checkPassword(pw: string, encoded: string): boolean {
  if (encoded.startsWith("scrypt$")) {
    const [, salt, expected] = encoded.split("$");
    if (!salt || !expected) return false;
    try {
      const actual = crypto.scryptSync(pw, salt, SCRYPT_KEYLEN);
      const expectedBuf = Buffer.from(expected, "hex");
      return expectedBuf.length === actual.length && crypto.timingSafeEqual(actual, expectedBuf);
    } catch { return false; }
  }
  const candidate = legacyHash(pw);
  if (candidate.length !== encoded.length) return false;
  return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(encoded));
}

/* ─── Auth middleware ─── */
interface AuthRequest extends Request { actor?: JWTPayload; }

/**
 * Role/status are reloaded from the employee table on every protected request.
 * This revokes a disabled/archived employee immediately and prevents an old
 * JWT role claim from retaining privileges. The only zero-ID identity is the
 * explicitly signed break-glass password session; raw ADMIN_TOKEN/header
 * credentials are intentionally not supported.
 */
async function requireAuth(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  const actor = await currentActiveAdmin(req);
  if (!actor) {
    res.status(401).json({ status: "error", message: "invalid, expired, or inactive admin session" });
    return;
  }
  req.actor = actor;
  next();
}

/* Fine-grained permission check: the role allowlist is the outer gate, then the
 * employee's stored list narrows it further. super_admin always passes and an
 * employee with no stored list keeps the role-only behaviour. The list is read
 * from the live row, so revoking a permission applies on the next request;
 * a lookup failure answers 503 (fail closed) instead of granting. */
const permissions = createPermissionChecker(async (id) => {
  const [staff] = await db.select({ permissions: employeesTable.permissions })
    .from(employeesTable).where(eq(employeesTable.id, id)).limit(1);
  if (!staff) return null;
  return Array.isArray(staff.permissions)
    ? staff.permissions.map((p) => String(p).trim().toLowerCase())
    : [];
});

function requireRole(...roles: string[]) {
  return async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
    if (!req.actor || !roles.includes(req.actor.role)) {
      res.status(403).json({ status: "error", message: "insufficient permissions" });
      return;
    }
    const permission = permissionForAdminPath(req.path);
    if (permission) {
      const decision = await permissions.check(req.actor, permission);
      if (decision === "error") {
        res.status(503).json({ status: "error", message: "permission check unavailable" });
        return;
      }
      if (decision === "denied") {
        res.status(403).json({ status: "error", message: "insufficient permissions" });
        return;
      }
    }
    next();
  };
}

/* Subscription pricing is intentionally narrower than generic dashboard
 * access. A super admin is allowed; every other employee needs this explicit
 * server-checked permission in their current staff row, not in a browser/JWT. */
const PRICING_MANAGE_PERMISSION = "pricing.manage";
async function requirePricingAccess(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  if (req.actor?.authSource === "break_glass") { next(); return; }
  if (!req.actor || !Number.isInteger(req.actor.sub) || req.actor.sub <= 0) {
    res.status(403).json({ status: "error", message: "insufficient permissions" });
    return;
  }
  try {
    const [staff] = await db.select({
      role: employeesTable.role,
      status: employeesTable.status,
      permissions: employeesTable.permissions,
    }).from(employeesTable).where(eq(employeesTable.id, req.actor.sub)).limit(1);
    const allowed = staff?.status === "active"
      && (staff.role === "super_admin" || (Array.isArray(staff.permissions) && staff.permissions.includes(PRICING_MANAGE_PERMISSION)));
    if (!allowed) {
      res.status(403).json({ status: "error", message: "لا تملك صلاحية إدارة أسعار الباقات" });
      return;
    }
    next();
  } catch (error) {
    logger.error({ err: error }, "pricing permission check failed");
    res.status(503).json({ status: "error", message: "تعذر التحقق من صلاحية إدارة الأسعار" });
  }
}

/* Broadcasts are security-sensitive public content. Unlike older legacy-admin
 * endpoints, they require a current active employee row so every mutation has
 * a durable actor ID for its audit entry. */
interface BroadcastAuthRequest extends AuthRequest { broadcastActorId?: number; }
async function requireBroadcastAccess(req: BroadcastAuthRequest, res: Response, next: NextFunction): Promise<void> {
  if (!req.actor || !Number.isInteger(req.actor.sub) || req.actor.sub <= 0) {
    res.status(403).json({ status: "error", message: "يلزم حساب مدير فعّال لإدارة الرسائل العامة" });
    return;
  }
  try {
    const [staff] = await db.select({ id: employeesTable.id, role: employeesTable.role, status: employeesTable.status })
      .from(employeesTable).where(eq(employeesTable.id, req.actor.sub)).limit(1);
    if (!staff || staff.status !== "active" || !["super_admin", "admin"].includes(staff.role)) {
      res.status(403).json({ status: "error", message: "لا تملك صلاحية إدارة الرسائل العامة" });
      return;
    }
    req.broadcastActorId = staff.id;
    next();
  } catch (error) {
    logger.error({ err: error }, "broadcast permission check failed");
    res.status(503).json({ status: "error", message: "تعذر التحقق من صلاحية إدارة الرسائل" });
  }
}

function parseBroadcastDraftRequest(body: unknown): ReturnType<typeof validateBroadcastDraft> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "بيانات الرسالة غير صالحة." };
  const raw = body as Record<string, unknown>;
  const parseOptionalCairoDate = (value: unknown): { value: Date | null; error?: string } => {
    if (value === undefined || value === null || String(value).trim() === "") return { value: null };
    const date = parseCairoDateTime(String(value));
    return date ? { value: date } : { value: null, error: "وقت الجدولة غير صالح؛ استخدم توقيت القاهرة." };
  };
  const starts = parseOptionalCairoDate(raw.startsAt);
  const ends = parseOptionalCairoDate(raw.endsAt);
  if (starts.error || ends.error) return { error: starts.error || ends.error };
  return validateBroadcastDraft({ ...raw, startsAt: starts.value, endsAt: ends.value });
}

/* ─── Audit log helper ─── */
async function auditLog(
  action: string, actor: JWTPayload | undefined, target: string | undefined,
  detail: Record<string, unknown>, _ip?: string,
): Promise<void> {
  try {
    /* Audit rows must be useful without becoming a shadow store of personal
     * data. Retain staff ID/role and non-sensitive target identifiers only. */
    await db.insert(auditLogsTable).values({
      action,
      actorId: actor?.sub ?? null,
      actorName: actor ? `staff:${actor.sub}` : "legacy-admin",
      actorRole: actor?.role ?? "super_admin",
      target: target ?? null,
      detail,
      ip: null,
    });
  } catch (e) {
    logger.warn({ err: e }, "audit log write failed");
  }
}

/* ─── Ensure AI config row exists ─── */
async function ensureAiConfig(): Promise<void> {
  const existing = await db.select().from(aiConfigTable).limit(1);
  if (!existing.length) {
    await db.insert(aiConfigTable).values({});
  }
}

/* ─── Validation helpers ─── */
const ALLOWED_LANG = new Set(["ar", "en"]);
const ALLOWED_CAT = new Set(["egypt", "global", "stocks", "crypto"]);
const ID_RX = /^[a-z0-9_-]{2,40}$/i;
const EMPLOYEE_ROLES = new Set(["super_admin", "admin", "editor", "analyst", "support", "marketing"]);
const EMPLOYEE_STATUSES = new Set(["active", "disabled", "archived"]);

function validateSource(input: unknown): SourceMeta | { error: string } {
  if (!input || typeof input !== "object") return { error: "body required" };
  const s = input as Record<string, unknown>;
  const id = String(s["id"] || "").trim();
  const name = String(s["name"] || "").trim();
  const icon = String(s["icon"] || "📰").trim().slice(0, 6);
  const lang = String(s["lang"] || "").trim();
  const cat = String(s["cat"] || "").trim();
  const color = String(s["color"] || "#10b981").trim();
  const url = String(s["url"] || "").trim();
  if (!ID_RX.test(id)) return { error: "id must match /^[a-z0-9_-]{2,40}$/i" };
  if (!name) return { error: "name required" };
  if (!ALLOWED_LANG.has(lang)) return { error: "lang must be ar|en" };
  if (!ALLOWED_CAT.has(cat)) return { error: "cat must be egypt|global|stocks|crypto" };
  try { const u = new URL(url); if (!["http:", "https:"].includes(u.protocol)) return { error: "url must be http(s)" }; }
  catch { return { error: "url invalid" }; }
  if (!/^#[0-9a-f]{6}$/i.test(color)) return { error: "color must be #rrggbb" };
  return { id, name: name.slice(0, 60), icon, lang: lang as "ar" | "en", cat: cat as "egypt" | "global" | "stocks" | "crypto", color: color.toLowerCase(), url };
}

function validateArticle(input: unknown): CustomArticle | { error: string } {
  if (!input || typeof input !== "object") return { error: "body required" };
  const a = input as Record<string, unknown>;
  const id = typeof a["id"] === "string" && a["id"].trim() ? String(a["id"]).trim() : `adm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const title = String(a["title"] || "").trim();
  const description = String(a["description"] || "").trim();
  const content = typeof a["content"] === "string" ? String(a["content"]) : undefined;
  const link = String(a["link"] || "#").trim() || "#";
  const cat = String(a["cat"] || "egypt").trim();
  const thumbnail = typeof a["thumbnail"] === "string" && a["thumbnail"].trim() ? String(a["thumbnail"]).trim() : undefined;
  const scheduledAt = typeof a["scheduledAt"] === "string" && a["scheduledAt"].trim() ? String(a["scheduledAt"]).trim() : undefined;
  const pubDate = scheduledAt || (typeof a["pubDate"] === "string" && a["pubDate"].trim() ? String(a["pubDate"]).trim() : new Date().toISOString());
  const featured = Boolean(a["featured"]);
  if (title.length < 4) return { error: "title required (min 4 chars)" };
  if (!ALLOWED_CAT.has(cat)) return { error: "cat must be egypt|global|stocks|crypto" };
  if (link !== "#") { try { const u = new URL(link); if (!["http:", "https:"].includes(u.protocol)) return { error: "link must be http(s)" }; } catch { return { error: "link invalid" }; } }
  if (thumbnail) { try { const u = new URL(thumbnail); if (!["http:", "https:"].includes(u.protocol)) return { error: "thumbnail must be http(s)" }; } catch { return { error: "thumbnail invalid" }; } }
  return {
    id, title: title.slice(0, 300), description: description.slice(0, 1500), link, pubDate,
    cat: cat as CustomArticle["cat"], srcId: "admin", srcName: "تحرير المنصة",
    srcIcon: featured ? "⭐" : "✍️", srcColor: featured ? "#f59e0b" : "#a855f7", srcLang: "ar",
    ...(content ? { content: content.slice(0, 8000) } : {}),
    ...(thumbnail ? { thumbnail } : {}),
  };
}

/* ══════════════════════════════════════════════
   PUBLIC ENDPOINTS (no auth)
══════════════════════════════════════════════ */

router.get("/bootstrap", (_req, res: Response) => {
  res.json({
    status: "ok",
    sources: listSources().map(s => ({ id: s.id, name: s.name, icon: s.icon, lang: s.lang, cat: s.cat, color: s.color })),
    customArticles: listCustomArticles(),
  });
});

/* Employee login is the normal path. The password-only route below is a
 * short-lived emergency bootstrap session and is disabled once a staff
 * super_admin exists. */
router.post("/login", async (req: AuthRequest, res: Response) => {
  const ip = req.ip || "unknown";

  // Brute-force check
  if (checkLoginBruteForce(ip) === "locked") {
    res.status(429).json({ status: "error", message: "too many failed attempts — try again in 15 minutes" });
    return;
  }

  const password = String((req.body || {}).password || "");

  // Hard throttle on top of brute-force lockout: max 20 login attempts / 5 min per IP.
  if (!rateLimitHit(`login:${ip}`, 20, 5 * 60 * 1000)) {
    res.status(429).json({ status: "error", message: "عدد محاولات دخول كبير — حاول بعد 5 دقائق" });
    return;
  }

  /* Shared counter (Postgres) so the ceiling holds across serverless instances
   * instead of multiplying per instance. */
  const store = getAttemptStore();
  const email = String((req.body || {}).email || "").toLowerCase();
  const identityKey = `admin:who:${email || "password"}`;
  const [blockedIp, blockedWho] = await Promise.all([
    store.isBlocked(`admin:ip:${ip}`, LIMITS.adminIp.limit, LIMITS.adminIp.windowMs),
    store.isBlocked(identityKey, LIMITS.adminIdentity.limit, LIMITS.adminIdentity.windowMs),
  ]);
  if (blockedIp.blocked || blockedWho.blocked) {
    const retryAfterSec = Math.max(blockedIp.retryAfterSec, blockedWho.retryAfterSec, 1);
    res.setHeader("Retry-After", String(retryAfterSec));
    res.status(429).json({ status: "error", message: "too many login attempts — try again in a few minutes", retryAfter: retryAfterSec });
    return;
  }
  const countAdminFailure = async (): Promise<void> => {
    await Promise.all([
      store.recordFailure(`admin:ip:${ip}`, LIMITS.adminIp.limit, LIMITS.adminIp.windowMs),
      store.recordFailure(identityKey, LIMITS.adminIdentity.limit, LIMITS.adminIdentity.windowMs),
    ]);
  };

  // Check if this matches an employee email/password (new JWT flow)
  if (email) {
    const employees = await db.select().from(employeesTable).where(eq(employeesTable.email, email)).limit(1);
    if (employees.length && checkPassword(password, employees[0].passwordHash)) {
      const emp = employees[0];
      // Transparent upgrade: re-hash legacy sha256 passwords to scrypt.
      if (!emp.passwordHash.startsWith("scrypt$")) {
        await db.update(employeesTable)
          .set({ passwordHash: hashPassword(password), updatedAt: new Date() })
          .where(eq(employeesTable.id, emp.id));
      }
      if (emp.status !== "active") {
        res.status(403).json({ status: "error", message: "account disabled" });
        return;
      }
      clearLoginFailures(ip);
      await store.clear(identityKey);
      await db.update(employeesTable).set({ lastLogin: new Date() }).where(eq(employeesTable.id, emp.id));
      const token = signToken({ sub: emp.id, name: emp.name, role: emp.role, email: emp.email });
      await auditLog("login", { sub: emp.id, name: emp.name, role: emp.role, email: emp.email }, `staff:${emp.id}`, {}, req.ip);
      res.cookie(ADMIN_SESSION_COOKIE, token, sessionCookieOptions(24 * 60 * 60 * 1000));
      res.json({ status: "ok", employee: { id: emp.id, name: emp.name, role: emp.role, email: emp.email } });
      return;
    }
    recordLoginFailure(ip);
    await countAdminFailure();
    res.status(401).json({ status: "error", message: "invalid credentials" });
    return;
  }

  // Legacy password-only login
  if (!ADMIN_PASSWORD) {
    res.status(503).json({ status: "error", message: "admin password is not configured" });
    return;
  }
  const expected = Buffer.from(ADMIN_PASSWORD);
  const given = Buffer.from(password);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
    recordLoginFailure(ip);
    await countAdminFailure();
    res.status(401).json({ status: "error", message: "invalid password" });
    return;
  }
  let staffSuperAdmin: { id: number; name: string; role: string; email: string } | null = null;
  try {
    const [active] = await db.select({
      id: employeesTable.id,
      name: employeesTable.name,
      role: employeesTable.role,
      email: employeesTable.email,
    })
      .from(employeesTable)
      .where(and(eq(employeesTable.role, "super_admin"), eq(employeesTable.status, "active")))
      .limit(1);
    staffSuperAdmin = active ?? null;
  } catch (error) {
    logger.error({ err: error }, "break-glass availability check failed");
    res.status(503).json({ status: "error", message: "admin authentication is temporarily unavailable" });
    return;
  }
  if (staffSuperAdmin && !ADMIN_BREAK_GLASS) {
    /* Do not leave a second long-lived authority path after bootstrap. */
    recordLoginFailure(ip);
    await countAdminFailure();
    logger.warn(
      { staffId: staffSuperAdmin.id },
      "password-only admin login blocked because an active super_admin exists (set ADMIN_BREAK_GLASS=on for operator recovery)",
    );
    res.status(403).json({ status: "error", message: "use an active employee account" });
    return;
  }
  clearLoginFailures(ip);
  /* Recovery session. When a real super_admin row exists it IS the identity:
   * the authority and the audit trail come from that account, so recovery
   * never invents a parallel admin. Only during bootstrap (no staff row yet)
   * does the explicit zero-ID break-glass identity apply. */
  const identity: JWTPayload = staffSuperAdmin
    ? {
        sub: staffSuperAdmin.id,
        name: staffSuperAdmin.name,
        role: staffSuperAdmin.role,
        email: staffSuperAdmin.email,
        authSource: "break_glass",
      }
    : {
        sub: 0,
        name: "Super Admin",
        role: "super_admin",
        email: "admin@egytrend",
        authSource: "break_glass",
      };
  await store.clear(identityKey);
  await auditLog("login", identity, `break_glass:${identity.sub}`, { recovery: true }, req.ip);
  const token = signToken(identity, "15m");
  res.cookie(ADMIN_SESSION_COOKIE, token, sessionCookieOptions(15 * 60 * 1000));
  res.json({
    status: "ok",
    breakGlass: true,
    employee: { id: identity.sub, name: identity.name, role: identity.role, email: identity.email },
  });
});

/* Explicit logout: revoke THIS session server-side, then expire the cookie.
 * Clearing the cookie alone left a copied token valid for the rest of its day. */
router.post("/logout", async (req: Request, res: Response) => {
  const token = adminSessionToken(req);
  const actor = await currentActiveAdmin(req);
  if (actor) await auditLog("logout", actor, `staff:${actor.sub}`, {}, req.ip);
  await revokePresentedSession("admin", token);
  res.clearCookie(ADMIN_SESSION_COOKIE, sessionCookieOptions());
  res.status(204).end();
});

router.get("/session", requireAuth, async (req: AuthRequest, res: Response) => {
  const actor = req.actor;
  /* `permissions` is null for super_admin / role-only accounts, so the panel
   * knows whether the list is authoritative. */
  const effective = actor ? await permissions.effective(actor) : null;
  res.setHeader("Cache-Control", "no-store");
  res.json({
    status: "ok",
    employee: actor
      ? { id: actor.sub, name: actor.name, role: actor.role, email: actor.email, permissions: effective }
      : null,
  });
});

/* Public: check AI config (for frontend to know what's enabled) */
router.get("/ai-status", async (_req, res: Response) => {
  try {
    await ensureAiConfig();
    const [cfg] = await db.select().from(aiConfigTable).limit(1);
    res.json({ status: "ok", analyzerEnabled: cfg?.analyzerEnabled ?? true, summaryEnabled: cfg?.summaryEnabled ?? true, rewriterEnabled: cfg?.rewriterEnabled ?? true });
  } catch (e) {
    res.json({ status: "ok", analyzerEnabled: true, summaryEnabled: true, rewriterEnabled: true });
  }
});

/* Log AI usage — auth required (was open to anyone; this feeds admin stats) */
router.post("/ai-usage/log", requireAuth, requireWriteRate, async (req: AuthRequest, res: Response) => {
  try {
    const { requestType, tokensEstimate } = req.body || {};
    await db.insert(aiUsageTable).values({
      userId: req.actor ? `staff:${req.actor.sub}` : "staff",
      requestType: String(requestType || "unknown").slice(0, 40),
      tokensEstimate: Math.max(0, Math.min(1_000_000, Number(tokensEstimate) || 0)),
    });
    res.json({ status: "ok" });
  } catch (e) {
    logger.error({ err: e }, "admin AI usage log error");
    res.status(500).json({ status: "error", message: "server error" });
  }
});

/* ══════════════════════════════════════════════
   PROTECTED ENDPOINTS (auth required)
══════════════════════════════════════════════ */

/* ─── Stats Dashboard ─── */
router.get("/stats", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const [empCount] = await db.select({ count: sql<number>`count(*)` }).from(employeesTable);
    const [planCount] = await db.select({ count: sql<number>`count(*)` }).from(subscriptionPlansTable);
    const [couponCount] = await db.select({ count: sql<number>`count(*)` }).from(couponsTable);
    const [auditCount] = await db.select({ count: sql<number>`count(*)` }).from(auditLogsTable);

    // AI usage stats (last 30 days)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const [aiUsageCount] = await db.select({ count: sql<number>`count(*)` })
      .from(aiUsageTable).where(gte(aiUsageTable.createdAt, thirtyDaysAgo));

    // AI usage by day (last 7 days)
    const aiByDay = await db.execute(sql`
      SELECT DATE(created_at) as day, COUNT(*) as count, request_type
      FROM ai_usage
      WHERE created_at >= NOW() - INTERVAL '7 days'
      GROUP BY DATE(created_at), request_type
      ORDER BY day DESC
    `);

    // Recent audit logs
    const recentAudit = await db.select().from(auditLogsTable)
      .orderBy(desc(auditLogsTable.createdAt)).limit(5);

    res.json({
      status: "ok",
      stats: {
        employees: Number(empCount?.count ?? 0),
        plans: Number(planCount?.count ?? 0),
        coupons: Number(couponCount?.count ?? 0),
        auditLogs: Number(auditCount?.count ?? 0),
        aiUsage30d: Number(aiUsageCount?.count ?? 0),
      },
      aiByDay: aiByDay.rows,
      recentAudit,
    });
  } catch (e) {
    logger.error({ err: e }, "stats error");
    res.status(500).json({ status: "error", message: "server error" });
  }
});

function contentStorageUnavailable(res: Response, err: unknown): void {
  logger.error({ err }, "admin content storage unavailable");
  res.status(503).json({
    status: "error",
    message: "تعذّر حفظ المحتوى بشكل دائم حاليًا — لم يتم تطبيق التغيير",
  });
}

/* ─── Sources (existing, enhanced) ─── */
router.get("/sources", requireAuth, (_req, res: Response) => {
  // Editors need to see pending and archived entries to complete the legal
  // review, but public/news routes receive only approved active sources.
  res.json({ status: "ok", sources: listSourceInventory() });
});

router.post("/sources", requireAuth, requireWriteRate, requireRole("super_admin", "admin", "editor"), async (req: AuthRequest, res: Response) => {
  const v = validateSource(req.body);
  if ("error" in v) { res.status(400).json({ status: "error", message: v.error }); return; }
  try { await upsertSource(v); }
  catch (err) { contentStorageUnavailable(res, err); return; }
  await auditLog("upsert_source", req.actor, v.id, { name: v.name }, req.ip);
  logger.info({ id: v.id }, "admin: source upserted");
  res.json({ status: "ok", source: v });
});

router.delete("/sources/:id", requireAuth, requireWriteRate, requireRole("super_admin", "admin"), async (req: AuthRequest, res: Response) => {
  const id = String(req.params["id"] || "");
  let ok: boolean;
  try { ok = await deleteSource(id); }
  catch (err) { contentStorageUnavailable(res, err); return; }
  if (!ok) { res.status(404).json({ status: "error", message: "not found" }); return; }
  await auditLog("archive_source", req.actor, id, {}, req.ip);
  logger.info({ id }, "admin: source deleted");
  res.json({ status: "ok" });
});

/* ─── Articles (enhanced with audit) ─── */
router.get("/articles", requireAuth, (_req, res: Response) => {
  res.json({ status: "ok", articles: listCustomArticles() });
});

router.post("/articles", requireAuth, requireWriteRate, requireRole("super_admin", "admin", "editor"), async (req: AuthRequest, res: Response) => {
  const v = validateArticle(req.body);
  if ("error" in v) { res.status(400).json({ status: "error", message: v.error }); return; }
  try { await upsertCustomArticle(v); }
  catch (err) { contentStorageUnavailable(res, err); return; }
  await auditLog("upsert_article", req.actor, v.id, { title: v.title.slice(0, 60), scheduled: v.pubDate }, req.ip);
  logger.info({ id: v.id }, "admin: article upserted");
  res.json({ status: "ok", article: v });
});

router.delete("/articles/:id", requireAuth, requireWriteRate, requireRole("super_admin", "admin", "editor"), async (req: AuthRequest, res: Response) => {
  const id = String(req.params["id"] || "");
  let ok: boolean;
  try { ok = await deleteCustomArticle(id); }
  catch (err) { contentStorageUnavailable(res, err); return; }
  if (!ok) { res.status(404).json({ status: "error", message: "not found" }); return; }
  await auditLog("archive_article", req.actor, id, {}, req.ip);
  logger.info({ id }, "admin: article deleted");
  res.json({ status: "ok" });
});

/* ─── Employees ─── */
router.get("/employees", requireAuth, requireRole("super_admin", "admin"), async (_req, res: Response) => {
  const employees = await db.select({
    id: employeesTable.id, name: employeesTable.name, email: employeesTable.email,
    role: employeesTable.role, status: employeesTable.status,
    permissions: employeesTable.permissions, lastLogin: employeesTable.lastLogin,
    createdAt: employeesTable.createdAt,
  }).from(employeesTable).orderBy(desc(employeesTable.createdAt));
  res.json({ status: "ok", employees });
});

router.post("/employees", requireAuth, requireWriteRate, requireRole("super_admin", "admin"), async (req: AuthRequest, res: Response) => {
  const { name, email, role, password, permissions } = req.body || {};
  if (!name || !email || !role || !password) {
    res.status(400).json({ status: "error", message: "name, email, role, password required" });
    return;
  }
  if (!EMPLOYEE_ROLES.has(role)) {
    res.status(400).json({ status: "error", message: `role must be one of: ${[...EMPLOYEE_ROLES].join(", ")}` });
    return;
  }
  if (String(password).length < 8) {
    res.status(400).json({ status: "error", message: "password must be at least 8 characters" });
    return;
  }
  // Only super_admin can create super_admin/admin or grant business-critical
  // price-management capability to a selected employee.
  if (["super_admin", "admin"].includes(role) && req.actor?.role !== "super_admin") {
    res.status(403).json({ status: "error", message: "only super_admin can create admin roles" });
    return;
  }
  if (Array.isArray(permissions) && permissions.includes(PRICING_MANAGE_PERMISSION) && req.actor?.role !== "super_admin") {
    res.status(403).json({ status: "error", message: "only super_admin can grant pricing permission" });
    return;
  }
  try {
    const [emp] = await db.insert(employeesTable).values({
      name: String(name).slice(0, 100),
      email: String(email).toLowerCase().trim(),
      role: String(role),
      passwordHash: hashPassword(String(password)),
      permissions: normalizePermissions(permissions),
      status: "active",
    }).returning({ id: employeesTable.id, name: employeesTable.name, email: employeesTable.email, role: employeesTable.role });
    await auditLog("create_employee", req.actor, `staff:${emp.id}`, { role: emp.role }, req.ip);
    res.json({ status: "ok", employee: emp });
  } catch (e: unknown) {
    if (isDuplicateKeyError(e)) { res.status(409).json({ status: "error", message: "email already exists" }); return; }
    logger.error({ err: e }, "employee create error");
    res.status(500).json({ status: "error", message: "server error" });
  }
});

router.put("/employees/:id", requireAuth, requireWriteRate, requireRole("super_admin", "admin"), async (req: AuthRequest, res: Response) => {
  const id = Number(req.params["id"]);
  const { name, role, status, permissions, password } = req.body || {};
  if (!Number.isSafeInteger(id) || id <= 0) { res.status(400).json({ status: "error", message: "invalid id" }); return; }
  if (role !== undefined && !EMPLOYEE_ROLES.has(String(role))) {
    res.status(400).json({ status: "error", message: "invalid role" });
    return;
  }
  if (status !== undefined && !EMPLOYEE_STATUSES.has(String(status))) {
    res.status(400).json({ status: "error", message: "invalid employee status" });
    return;
  }
  try {
    const [target] = await db.select({ id: employeesTable.id, role: employeesTable.role, status: employeesTable.status })
      .from(employeesTable).where(eq(employeesTable.id, id)).limit(1);
    if (!target) { res.status(404).json({ status: "error", message: "employee not found" }); return; }

    /* An ordinary admin may manage operational staff but cannot edit a peer or
     * a super-admin account (including its password/status), preventing a
     * lateral account takeover or lock-out. */
    if (["super_admin", "admin"].includes(target.role) && req.actor?.role !== "super_admin") {
      res.status(403).json({ status: "error", message: "only super_admin can modify admin accounts" });
      return;
    }
    if (["super_admin", "admin"].includes(String(role)) && req.actor?.role !== "super_admin") {
      res.status(403).json({ status: "error", message: "only super_admin can set admin roles" });
      return;
    }
    if (id === req.actor?.sub && status !== undefined && String(status) !== "active") {
      res.status(400).json({ status: "error", message: "cannot disable or archive yourself" });
      return;
    }
    /* A narrowed account must not widen itself back: role and permission
     * changes on your own row need another super_admin. */
    if (id === req.actor?.sub && (role !== undefined || permissions !== undefined)) {
      res.status(400).json({ status: "error", message: "cannot change your own role or permissions" });
      return;
    }
    /* DELETE is archival, but role/status edits can also remove the final
     * recovery-capable employee. Apply the same invariant before any demotion,
     * disable, or archive of a currently active super_admin. */
    const removesActiveSuperAdmin = target.role === "super_admin" && target.status === "active"
      && ((role !== undefined && String(role) !== "super_admin") || (status !== undefined && String(status) !== "active"));
    if (removesActiveSuperAdmin) {
      const activeSuperAdmins = await db.select({ count: sql<number>`count(*)` }).from(employeesTable)
        .where(and(eq(employeesTable.role, "super_admin"), eq(employeesTable.status, "active")));
      if (Number(activeSuperAdmins[0]?.count || 0) <= 1) {
        res.status(409).json({ status: "error", message: "cannot remove the last active super_admin" });
        return;
      }
    }
    if (Array.isArray(permissions) && permissions.includes(PRICING_MANAGE_PERMISSION) && req.actor?.role !== "super_admin") {
      res.status(403).json({ status: "error", message: "only super_admin can grant pricing permission" });
      return;
    }

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (name !== undefined) {
      const normalizedName = String(name).trim();
      if (!normalizedName) { res.status(400).json({ status: "error", message: "name cannot be empty" }); return; }
      updates["name"] = normalizedName.slice(0, 100);
    }
    if (role !== undefined) updates["role"] = String(role);
    if (status !== undefined) updates["status"] = String(status);
    /* Only known permission names are stored; unknown input is dropped. */
    if (permissions !== undefined) updates["permissions"] = normalizePermissions(permissions);
    if (password !== undefined) {
      if (String(password).length < 8) { res.status(400).json({ status: "error", message: "password min 8 chars" }); return; }
      updates["passwordHash"] = hashPassword(String(password));
    }
    await db.update(employeesTable).set(updates as any).where(eq(employeesTable.id, id));
    /* Disabling, archiving, demoting or resetting the password of an employee
     * ends every session already open for that account. */
    if (status !== undefined || role !== undefined || password !== undefined) {
      await revokeAllSessions("admin", id);
    }
    await auditLog("update_employee", req.actor, `staff:${id}`, { role: role ?? null, status: status ?? null, passwordChanged: password !== undefined }, req.ip);
    res.json({ status: "ok" });
  } catch (error) {
    logger.error({ err: error }, "employee update error");
    res.status(500).json({ status: "error", message: "server error" });
  }
});

router.delete("/employees/:id", requireAuth, requireWriteRate, requireRole("super_admin"), async (req: AuthRequest, res: Response) => {
  const id = Number(req.params["id"]);
  if (!Number.isSafeInteger(id) || id <= 0) { res.status(400).json({ status: "error", message: "invalid id" }); return; }
  if (id === req.actor?.sub) { res.status(400).json({ status: "error", message: "cannot archive yourself" }); return; }
  try {
    const [target] = await db.select({ id: employeesTable.id, role: employeesTable.role, status: employeesTable.status })
      .from(employeesTable).where(eq(employeesTable.id, id)).limit(1);
    if (!target || target.status === "archived") { res.status(404).json({ status: "error", message: "employee not found" }); return; }
    if (target.role === "super_admin" && target.status === "active") {
      const activeSuperAdmins = await db.select({ count: sql<number>`count(*)` }).from(employeesTable)
        .where(and(eq(employeesTable.role, "super_admin"), eq(employeesTable.status, "active")));
      if (Number(activeSuperAdmins[0]?.count || 0) <= 1) {
        res.status(409).json({ status: "error", message: "cannot archive the last active super_admin" });
        return;
      }
    }
    await db.update(employeesTable).set({ status: "archived", updatedAt: new Date() }).where(eq(employeesTable.id, id));
    /* An archived employee's open session must end now, not at token expiry. */
    await revokeAllSessions("admin", id);
    await auditLog("archive_employee", req.actor, `staff:${id}`, { previousStatus: target.status }, req.ip);
    res.json({ status: "ok", archived: true });
  } catch (error) {
    logger.error({ err: error }, "employee archive error");
    res.status(500).json({ status: "error", message: "server error" });
  }
});

/* ─── Subscription Plans + server-evaluated pricing ─── */
/* Price is business-critical. These helpers keep the editable snapshot small,
 * deterministic and reversible without ever deleting a previous offer row. */
type StoredPricingOffer = {
  id: string;
  audience: string;
  price: number;
  oldPrice: number | null;
  badgeMode: string;
  badgeText: string | null;
  startsAt: string | null;
  endsAt: string | null;
  showCountdown: boolean;
  priority: number;
};
type StoredPricingState = {
  price: number;
  oldPrice: number | null;
  badgeMode: string;
  badgeText: string | null;
  offers: StoredPricingOffer[];
};

function dateIso(value: unknown): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function pricingState(plan: any, offers: any[]): StoredPricingState {
  return {
    price: Number(plan.price),
    oldPrice: plan.oldPrice === null || plan.oldPrice === undefined ? null : Number(plan.oldPrice),
    badgeMode: String(plan.priceBadgeMode || "none"),
    badgeText: plan.priceBadgeText ? String(plan.priceBadgeText) : null,
    offers: offers
      .filter((offer) => offer.status === "active")
      .map((offer) => ({
        id: String(offer.id),
        audience: String(offer.audience),
        price: Number(offer.price),
        oldPrice: offer.oldPrice === null || offer.oldPrice === undefined ? null : Number(offer.oldPrice),
        badgeMode: String(offer.badgeMode || "none"),
        badgeText: offer.badgeText ? String(offer.badgeText) : null,
        startsAt: dateIso(offer.startsAt),
        endsAt: dateIso(offer.endsAt),
        showCountdown: Boolean(offer.showCountdown),
        priority: Number(offer.priority || 0),
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function samePricingState(left: StoredPricingState, right: StoredPricingState): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validatedPricingState(raw: Record<string, unknown>, previous?: StoredPricingState): { state: StoredPricingState; warnings: string[] } {
  const has = (key: string) => Object.prototype.hasOwnProperty.call(raw, key);
  const base = validatePricePresentation({
    price: has("price") ? raw["price"] : previous?.price,
    oldPrice: has("oldPrice") ? raw["oldPrice"] : previous?.oldPrice,
    priceBadgeMode: has("priceBadgeMode") ? raw["priceBadgeMode"] : has("badgeMode") ? raw["badgeMode"] : previous?.badgeMode,
    priceBadgeText: has("priceBadgeText") ? raw["priceBadgeText"] : has("badgeText") ? raw["badgeText"] : previous?.badgeText,
  });
  const rawOffers = raw["offers"] === undefined ? previous?.offers || [] : raw["offers"];
  if (!Array.isArray(rawOffers) || rawOffers.length > 12) {
    throw new PricingInputError("أدخل حتى 12 عرضاً لكل باقة");
  }
  const offers: StoredPricingOffer[] = [];
  const ids = new Set<string>();
  const warnings = [...base.warnings];
  for (const candidate of rawOffers) {
    if (!candidate || typeof candidate !== "object") throw new PricingInputError("بيانات العرض غير صحيحة");
    const parsed: ValidatedOfferInput = validatePriceOffer(candidate as Record<string, unknown>);
    const id = parsed.id || `offer-${crypto.randomUUID()}`;
    if (ids.has(id)) throw new PricingInputError("لا يمكن تكرار العرض نفسه");
    ids.add(id);
    warnings.push(...parsed.warnings);
    offers.push({
      id,
      audience: parsed.audience,
      price: parsed.price,
      oldPrice: parsed.oldPrice,
      badgeMode: parsed.badgeMode,
      badgeText: parsed.badgeText,
      startsAt: parsed.startsAt?.toISOString() || null,
      endsAt: parsed.endsAt?.toISOString() || null,
      showCountdown: parsed.showCountdown,
      priority: parsed.priority,
    });
  }
  return {
    state: {
      price: base.price,
      oldPrice: base.oldPrice,
      badgeMode: base.badgeMode,
      badgeText: base.badgeText,
      offers: offers.sort((left, right) => left.id.localeCompare(right.id)),
    },
    warnings: [...new Set(warnings)],
  };
}

/** Applies a full active pricing state without deleting an offer/history row. */
async function applyPricingState(tx: any, planId: number, state: StoredPricingState, now: Date): Promise<void> {
  await tx.update(subscriptionPlansTable).set({
    price: state.price,
    oldPrice: state.oldPrice,
    priceBadgeMode: state.badgeMode,
    priceBadgeText: state.badgeText,
    updatedAt: now,
  }).where(eq(subscriptionPlansTable.id, planId));

  const existing = await tx.select().from(planPriceOffersTable)
    .where(eq(planPriceOffersTable.planId, planId));
  const existingById = new Map(existing.map((offer: any) => [String(offer.id), offer]));
  const activeIds = new Set(state.offers.map((offer) => offer.id));
  for (const offer of existing) {
    if (offer.status === "active" && !activeIds.has(String(offer.id))) {
      await tx.update(planPriceOffersTable).set({
        status: "archived",
        archivedAt: now,
        updatedAt: now,
      }).where(eq(planPriceOffersTable.id, offer.id));
    }
  }
  for (const offer of state.offers) {
    const values = {
      planId,
      audience: offer.audience,
      price: offer.price,
      oldPrice: offer.oldPrice,
      badgeMode: offer.badgeMode,
      badgeText: offer.badgeText,
      startsAt: offer.startsAt ? new Date(offer.startsAt) : null,
      endsAt: offer.endsAt ? new Date(offer.endsAt) : null,
      showCountdown: offer.showCountdown,
      priority: offer.priority,
      status: "active",
      archivedAt: null,
      updatedAt: now,
    };
    if (existingById.has(offer.id)) {
      await tx.update(planPriceOffersTable).set(values).where(eq(planPriceOffersTable.id, offer.id));
    } else {
      await tx.insert(planPriceOffersTable).values({ id: offer.id, ...values, createdAt: now });
    }
  }
}

function pricingLogDetail(before: StoredPricingState, after: StoredPricingState): Record<string, unknown> {
  return {
    fromPrice: before.price,
    toPrice: after.price,
    fromOfferCount: before.offers.length,
    toOfferCount: after.offers.length,
  };
}

/* A read is authorized as pricing access too, so detailed targeted-offer rules
 * are never exposed to ordinary support/editor accounts. */
router.get("/plans", requireAuth, requirePricingAccess, async (_req: AuthRequest, res: Response) => {
  try {
    const plans = await db.select().from(subscriptionPlansTable).orderBy(subscriptionPlansTable.price);
    const allOffers = await db.select().from(planPriceOffersTable);
    const now = new Date();
    const decorated = await Promise.all(plans.map(async (plan) => {
      const offers = allOffers.filter((offer) => offer.planId === plan.id);
      const effective = await getEffectivePrice(null, plan, now);
      const changes = await db.select({
        id: planPriceChangeLogsTable.id,
        changedBy: planPriceChangeLogsTable.changedBy,
        changedByName: planPriceChangeLogsTable.changedByName,
        changedByRole: planPriceChangeLogsTable.changedByRole,
        changeType: planPriceChangeLogsTable.changeType,
        beforeState: planPriceChangeLogsTable.beforeState,
        afterState: planPriceChangeLogsTable.afterState,
        revertedAt: planPriceChangeLogsTable.revertedAt,
        revertedByName: planPriceChangeLogsTable.revertedByName,
        createdAt: planPriceChangeLogsTable.createdAt,
      }).from(planPriceChangeLogsTable)
        .where(eq(planPriceChangeLogsTable.planId, plan.id))
        .orderBy(desc(planPriceChangeLogsTable.createdAt)).limit(8);
      return { ...plan, offers, effective, pricingHistory: changes };
    }));
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.json({ status: "ok", plans: decorated, pricingVersion: pricingCacheVersion(), cairoTimeZone: "Africa/Cairo" });
  } catch (e) {
    logger.error({ err: e }, "plans read error");
    res.status(500).json({ status: "error", message: "server error" });
  }
});

router.get("/settings/pricing", requireAuth, requirePricingAccess, async (_req: AuthRequest, res: Response) => {
  try {
    res.json({ status: "ok", priceLockHours: await getPaymentPriceLockHours(), minHours: 1, maxHours: 168 });
  } catch (e) {
    logger.error({ err: e }, "pricing settings read error");
    res.status(500).json({ status: "error", message: "server error" });
  }
});

router.put("/settings/pricing", requireAuth, requireWriteRate, requirePricingAccess, async (req: AuthRequest, res: Response) => {
  try {
    const hours = validatePaymentPriceLockHours(req.body?.priceLockHours);
    await db.insert(appSettingsTable).values({ key: "payment_price_lock_hours", value: String(hours), updatedAt: new Date() })
      .onConflictDoUpdate({ target: appSettingsTable.key, set: { value: String(hours), updatedAt: new Date() } });
    await auditLog("update_payment_price_lock", req.actor, "pricing", { priceLockHours: hours }, req.ip);
    res.json({ status: "ok", priceLockHours: hours });
  } catch (e) {
    if (e instanceof PricingInputError) { res.status(400).json({ status: "error", message: e.message }); return; }
    logger.error({ err: e }, "pricing settings update error");
    res.status(500).json({ status: "error", message: "server error" });
  }
});

router.post("/plans", requireAuth, requireWriteRate, requirePricingAccess, async (req: AuthRequest, res: Response) => {
  const { key, nameAr, durationMonths, features, badge } = req.body || {};
  if (!key || !nameAr || durationMonths === undefined) {
    res.status(400).json({ status: "error", message: "key, nameAr, price, durationMonths required" });
    return;
  }
  if (!ID_RX.test(String(key))) { res.status(400).json({ status: "error", message: "key must be alphanumeric" }); return; }
  const duration = Number(durationMonths);
  if (!Number.isSafeInteger(duration) || duration < 1 || duration > 120) {
    res.status(400).json({ status: "error", message: "مدة الخطة غير صحيحة" });
    return;
  }
  try {
    const base = validatePricePresentation(req.body || {});
    const { plan, after } = await db.transaction(async (tx) => {
      const now = new Date();
      const [plan] = await tx.insert(subscriptionPlansTable).values({
        key: String(key).toLowerCase(),
        nameAr: String(nameAr).slice(0, 100),
        price: base.price,
        oldPrice: base.oldPrice,
        priceBadgeMode: base.badgeMode,
        priceBadgeText: base.badgeText,
        durationMonths: duration,
        features: Array.isArray(features) ? features.map((feature) => String(feature).slice(0, 160)).slice(0, 12) : [],
        isActive: true,
        badge: badge ? String(badge).slice(0, 50) : null,
        createdAt: now,
        updatedAt: now,
      }).returning();
      const after = pricingState(plan, []);
      await tx.insert(planPriceChangeLogsTable).values({
        id: `price-change-${crypto.randomUUID()}`,
        planId: plan.id,
        changedBy: req.actor?.sub ?? null,
        changedByName: req.actor?.name ?? "legacy-admin",
        changedByRole: req.actor?.role ?? "super_admin",
        changeType: "pricing_create",
        beforeState: {},
        afterState: after,
        createdAt: now,
      });
      return { plan, after };
    });
    invalidatePricingCache();
    await auditLog("create_plan", req.actor, String(key), { ...pricingLogDetail({ ...after, price: 0, offers: [] }, after), hasOldPrice: base.oldPrice !== null }, req.ip);
    res.json({ status: "ok", plan, warnings: base.warnings, pricingVersion: pricingCacheVersion() });
  } catch (e: unknown) {
    if (e instanceof PricingInputError) { res.status(400).json({ status: "error", message: e.message }); return; }
    if (isDuplicateKeyError(e)) { res.status(409).json({ status: "error", message: "plan key already exists" }); return; }
    logger.error({ err: e }, "plan create error");
    res.status(500).json({ status: "error", message: "server error" });
  }
});

/* Atomically replaces the current base display and active offer set. Every
 * update receives one before/after history row, which powers a safe undo. */
router.put("/plans/:id/pricing", requireAuth, requireWriteRate, requirePricingAccess, async (req: AuthRequest, res: Response) => {
  const id = Number(req.params["id"]);
  if (!Number.isSafeInteger(id) || id <= 0) { res.status(400).json({ status: "error", message: "invalid id" }); return; }
  try {
    const result = await db.transaction(async (tx) => {
      const [plan] = await tx.select().from(subscriptionPlansTable).where(eq(subscriptionPlansTable.id, id)).for("update");
      if (!plan) throw new PricingInputError("الخطة غير موجودة");
      const oldOffers = await tx.select().from(planPriceOffersTable).where(eq(planPriceOffersTable.planId, id));
      const before = pricingState(plan, oldOffers);
      const parsed = validatedPricingState((req.body || {}) as Record<string, unknown>, before);
      const suppliedIds = new Set(parsed.state.offers.map((offer) => offer.id));
      for (const offer of parsed.state.offers) {
        const known = oldOffers.find((row) => row.id === offer.id);
        if (offer.id.startsWith("offer-") && !known) continue;
        if (!known) throw new PricingInputError("العرض لا يخص هذه الباقة");
      }
      if (suppliedIds.size !== parsed.state.offers.length) throw new PricingInputError("تكرار معرّف العرض غير مسموح");
      if (samePricingState(before, parsed.state)) return { changed: false, before, after: before, warnings: parsed.warnings };
      const now = new Date();
      await applyPricingState(tx, id, parsed.state, now);
      await tx.insert(planPriceChangeLogsTable).values({
        id: `price-change-${crypto.randomUUID()}`,
        planId: id,
        changedBy: req.actor?.sub ?? null,
        changedByName: req.actor?.name ?? "legacy-admin",
        changedByRole: req.actor?.role ?? "super_admin",
        changeType: "pricing_update",
        beforeState: before,
        afterState: parsed.state,
        createdAt: now,
      });
      return { changed: true, before, after: parsed.state, warnings: parsed.warnings };
    });
    if (result.changed) {
      invalidatePricingCache();
      await auditLog("update_plan_pricing", req.actor, `plan:${id}`, pricingLogDetail(result.before, result.after), req.ip);
    }
    res.json({ status: "ok", changed: result.changed, warnings: result.warnings, pricingVersion: pricingCacheVersion() });
  } catch (e) {
    if (e instanceof PricingInputError) { res.status(400).json({ status: "error", message: e.message }); return; }
    logger.error({ err: e }, "plan pricing update error");
    res.status(500).json({ status: "error", message: "server error" });
  }
});

router.post("/plans/:id/pricing/revert", requireAuth, requireWriteRate, requirePricingAccess, async (req: AuthRequest, res: Response) => {
  const id = Number(req.params["id"]);
  if (!Number.isSafeInteger(id) || id <= 0) { res.status(400).json({ status: "error", message: "invalid id" }); return; }
  try {
    const outcome = await db.transaction(async (tx) => {
      const [plan] = await tx.select().from(subscriptionPlansTable).where(eq(subscriptionPlansTable.id, id)).for("update");
      if (!plan) throw new PricingInputError("الخطة غير موجودة");
      const history = await tx.select().from(planPriceChangeLogsTable)
        .where(and(eq(planPriceChangeLogsTable.planId, id), isNull(planPriceChangeLogsTable.revertedAt)))
        .orderBy(desc(planPriceChangeLogsTable.createdAt)).limit(20);
      const latest = history.find((row) => row.changeType === "pricing_update");
      if (!latest) throw new PricingInputError("لا يوجد تعديل أسعار قابل للتراجع");
      const previous = latest.beforeState as StoredPricingState;
      if (!previous || !Array.isArray(previous.offers) || !Number.isSafeInteger(previous.price) || previous.price <= 0) {
        throw new PricingInputError("سجل السعر السابق غير صالح للتراجع");
      }
      const currentOffers = await tx.select().from(planPriceOffersTable).where(eq(planPriceOffersTable.planId, id));
      const current = pricingState(plan, currentOffers);
      const now = new Date();
      await applyPricingState(tx, id, previous, now);
      await tx.update(planPriceChangeLogsTable).set({ revertedAt: now, revertedBy: req.actor?.sub ?? null, revertedByName: req.actor?.name ?? "legacy-admin" })
        .where(eq(planPriceChangeLogsTable.id, latest.id));
      return { before: current, after: previous, logId: latest.id };
    });
    invalidatePricingCache();
    await auditLog("revert_plan_pricing", req.actor, `plan:${id}`, { ...pricingLogDetail(outcome.before, outcome.after), revertedChangeId: outcome.logId }, req.ip);
    res.json({ status: "ok", pricingVersion: pricingCacheVersion() });
  } catch (e) {
    if (e instanceof PricingInputError) { res.status(400).json({ status: "error", message: e.message }); return; }
    logger.error({ err: e }, "plan pricing revert error");
    res.status(500).json({ status: "error", message: "server error" });
  }
});

/* Existing plan metadata controls are retained. Price fields are deliberately
 * refused on this generic route so every live price change has exactly one
 * before/after history row via PUT /plans/:id/pricing. */
router.put("/plans/:id", requireAuth, requireWriteRate, requirePricingAccess, async (req: AuthRequest, res: Response) => {
  const id = Number(req.params["id"]);
  if (!Number.isSafeInteger(id) || id <= 0) { res.status(400).json({ status: "error", message: "invalid id" }); return; }
  try {
    const [existing] = await db.select().from(subscriptionPlansTable).where(eq(subscriptionPlansTable.id, id)).limit(1);
    if (!existing) { res.status(404).json({ status: "error", message: "plan not found" }); return; }
    const { nameAr, durationMonths, features, isActive, badge } = req.body || {};
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (nameAr !== undefined) updates["nameAr"] = String(nameAr).slice(0, 100);
    if (durationMonths !== undefined) {
      const duration = Number(durationMonths);
      if (!Number.isSafeInteger(duration) || duration < 1 || duration > 120) { res.status(400).json({ status: "error", message: "مدة الخطة غير صحيحة" }); return; }
      updates["durationMonths"] = duration;
    }
    if (features !== undefined) updates["features"] = Array.isArray(features) ? features.map((feature) => String(feature).slice(0, 160)).slice(0, 12) : [];
    if (isActive !== undefined) updates["isActive"] = Boolean(isActive);
    if (badge !== undefined) updates["badge"] = badge ? String(badge).slice(0, 50) : null;
    const hasPricingField = ["price", "oldPrice", "priceBadgeMode", "priceBadgeText", "badgeMode", "badgeText", "offers"].some((key) => Object.prototype.hasOwnProperty.call(req.body || {}, key));
    if (hasPricingField) {
      res.status(400).json({ status: "error", message: "استخدم محرر السعر والعروض لتسجيل التغيير وإتاحته للتراجع" });
      return;
    }
    await db.update(subscriptionPlansTable).set(updates as any).where(eq(subscriptionPlansTable.id, id));
    invalidatePricingCache();
    await auditLog("update_plan", req.actor, String(id), { nameAr, isActive }, req.ip);
    res.json({ status: "ok", pricingVersion: pricingCacheVersion() });
  } catch (e) {
    if (e instanceof PricingInputError) { res.status(400).json({ status: "error", message: e.message }); return; }
    logger.error({ err: e }, "plan update error");
    res.status(500).json({ status: "error", message: "server error" });
  }
});

router.delete("/plans/:id", requireAuth, requireWriteRate, requirePricingAccess, async (req: AuthRequest, res: Response) => {
  const id = Number(req.params["id"]);
  if (!Number.isSafeInteger(id) || id <= 0) { res.status(400).json({ status: "error", message: "invalid id" }); return; }
  /* Plans are archived, never deleted. Existing subscriptions and pending
   * price snapshots remain intact. */
  await db.update(subscriptionPlansTable).set({ isActive: false, updatedAt: new Date() })
    .where(eq(subscriptionPlansTable.id, id));
  invalidatePricingCache();
  await auditLog("archive_plan", req.actor, String(id), {}, req.ip);
  res.json({ status: "ok", archived: true, pricingVersion: pricingCacheVersion() });
});

/* ─── Coupons ─── */
router.get("/coupons", requireAuth, requireRole("super_admin", "admin", "marketing"), async (_req, res: Response) => {
  const coupons = await db.select().from(couponsTable).orderBy(desc(couponsTable.createdAt));
  res.json({ status: "ok", coupons });
});

router.post("/coupons", requireAuth, requireWriteRate, requireRole("super_admin", "admin", "marketing"), async (req: AuthRequest, res: Response) => {
  const { code, discountType, discountValue, maxUses, startsAt, expiresAt } = req.body || {};
  if (!code || discountValue === undefined) {
    res.status(400).json({ status: "error", message: "code and discountValue required" });
    return;
  }
  const dtype = String(discountType || "percent");
  if (!["percent", "fixed"].includes(dtype)) {
    res.status(400).json({ status: "error", message: "discountType must be percent|fixed" });
    return;
  }
  const dval = Number(discountValue);
  if (isNaN(dval) || dval <= 0) { res.status(400).json({ status: "error", message: "discountValue must be positive" }); return; }
  if (dtype === "percent" && dval > 100) { res.status(400).json({ status: "error", message: "percent cannot exceed 100" }); return; }
  try {
    const [coupon] = await db.insert(couponsTable).values({
      code: String(code).toUpperCase().trim(),
      discountType: dtype,
      discountValue: dval,
      maxUses: maxUses ? Number(maxUses) : null,
      startsAt: startsAt ? new Date(startsAt) : null,
      expiresAt: expiresAt ? new Date(expiresAt) : null,
      isActive: true,
      createdBy: req.actor?.sub ?? null,
    }).returning();
    await auditLog("create_coupon", req.actor, String(code), { discountType: dtype, discountValue: dval }, req.ip);
    res.json({ status: "ok", coupon });
  } catch (e: unknown) {
    if (isDuplicateKeyError(e)) { res.status(409).json({ status: "error", message: "coupon code already exists" }); return; }
    logger.error({ err: e }, "coupon create error");
    res.status(500).json({ status: "error", message: "server error" });
  }
});

router.put("/coupons/:id", requireAuth, requireWriteRate, requireRole("super_admin", "admin", "marketing"), async (req: AuthRequest, res: Response) => {
  const id = Number(req.params["id"]);
  if (isNaN(id)) { res.status(400).json({ status: "error", message: "invalid id" }); return; }
  const { isActive, maxUses, expiresAt } = req.body || {};
  const updates: Record<string, unknown> = {};
  if (isActive !== undefined) updates["isActive"] = Boolean(isActive);
  if (maxUses !== undefined) updates["maxUses"] = maxUses === null ? null : Number(maxUses);
  if (expiresAt !== undefined) updates["expiresAt"] = expiresAt ? new Date(expiresAt) : null;
  if (Object.keys(updates).length === 0) { res.status(400).json({ status: "error", message: "no updates provided" }); return; }
  await db.update(couponsTable).set(updates as any).where(eq(couponsTable.id, id));
  await auditLog("update_coupon", req.actor, String(id), updates, req.ip);
  res.json({ status: "ok" });
});

router.delete("/coupons/:id", requireAuth, requireWriteRate, requireRole("super_admin", "admin"), async (req: AuthRequest, res: Response) => {
  const id = Number(req.params["id"]);
  if (!Number.isSafeInteger(id) || id <= 0) { res.status(400).json({ status: "error", message: "invalid id" }); return; }
  try {
    /* Coupon history can be referenced by payments/referrals, so DELETE means
     * archive: disable future use without removing financial evidence. */
    const archived = await db.update(couponsTable).set({ isActive: false }).where(eq(couponsTable.id, id))
      .returning({ id: couponsTable.id });
    if (!archived.length) { res.status(404).json({ status: "error", message: "coupon not found" }); return; }
    await auditLog("archive_coupon", req.actor, String(id), {}, req.ip);
    res.json({ status: "ok", archived: true });
  } catch (error) {
    logger.error({ err: error }, "coupon archive error");
    res.status(500).json({ status: "error", message: "server error" });
  }
});

/* Public: validate coupon code */
router.post("/coupons/validate", async (req: Request, res: Response) => {
  const { code } = req.body || {};
  if (!code) { res.status(400).json({ status: "error", message: "code required" }); return; }
  const [coupon] = await db.select().from(couponsTable)
    .where(and(eq(couponsTable.code, String(code).toUpperCase()), eq(couponsTable.isActive, true))).limit(1);
  if (!coupon) { res.status(404).json({ status: "error", message: "invalid or inactive coupon" }); return; }
  const now = new Date();
  if (coupon.startsAt && coupon.startsAt > now) { res.status(400).json({ status: "error", message: "coupon not yet valid" }); return; }
  if (coupon.expiresAt && coupon.expiresAt < now) { res.status(400).json({ status: "error", message: "coupon expired" }); return; }
  if (coupon.maxUses !== null && (coupon.usedCount ?? 0) >= coupon.maxUses) { res.status(400).json({ status: "error", message: "coupon usage limit reached" }); return; }
  res.json({ status: "ok", coupon: { code: coupon.code, discountType: coupon.discountType, discountValue: coupon.discountValue } });
});

/* ─── AI Config ─── */
router.get("/ai-config", requireAuth, async (_req, res: Response) => {
  await ensureAiConfig();
  const [cfg] = await db.select().from(aiConfigTable).limit(1);
  res.json({ status: "ok", config: cfg });
});

router.put("/ai-config", requireAuth, requireWriteRate, requireRole("super_admin", "admin"), async (req: AuthRequest, res: Response) => {
  await ensureAiConfig();
  const { analyzerEnabled, summaryEnabled, rewriterEnabled, dailyRequestLimit } = req.body || {};
  const updates: Record<string, unknown> = { updatedAt: new Date(), updatedBy: req.actor?.name ?? "admin" };
  if (analyzerEnabled !== undefined) updates["analyzerEnabled"] = Boolean(analyzerEnabled);
  if (summaryEnabled !== undefined) updates["summaryEnabled"] = Boolean(summaryEnabled);
  if (rewriterEnabled !== undefined) updates["rewriterEnabled"] = Boolean(rewriterEnabled);
  if (dailyRequestLimit !== undefined) updates["dailyRequestLimit"] = Math.max(0, Number(dailyRequestLimit));
  await db.update(aiConfigTable).set(updates as any);
  await auditLog("update_ai_config", req.actor, "ai_config", updates, req.ip);
  res.json({ status: "ok" });
});

router.get("/ai-usage", requireAuth, requireRole("super_admin", "admin", "analyst"), async (req: Request, res: Response) => {
  const days = Math.min(90, Math.max(1, Number(req.query["days"] || 30)));
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const byType = await db.execute(sql`
    SELECT request_type, COUNT(*) as count, DATE(created_at) as day
    FROM ai_usage
    WHERE created_at >= ${since}
    GROUP BY request_type, DATE(created_at)
    ORDER BY day DESC
  `);

  const [total] = await db.select({ count: sql<number>`count(*)` })
    .from(aiUsageTable).where(gte(aiUsageTable.createdAt, since));

  const topUsers = await db.execute(sql`
    SELECT user_id, COUNT(*) as count
    FROM ai_usage
    WHERE created_at >= ${since}
    GROUP BY user_id
    ORDER BY count DESC
    LIMIT 10
  `);

  res.json({ status: "ok", totalRequests: Number(total?.count ?? 0), byType: byType.rows, topUsers: topUsers.rows, days });
});

/* ─── Audit Logs ─── */
router.get("/audit-logs", requireAuth, requireRole("super_admin", "admin"), async (req: Request, res: Response) => {
  const page = Math.max(0, Number(req.query["page"] || 0));
  const limit = Math.min(100, Math.max(10, Number(req.query["limit"] || 50)));
  const search = String(req.query["search"] || "").trim();
  const action = String(req.query["action"] || "").trim();

  let conditions = [];
  if (search) conditions.push(or(like(auditLogsTable.actorName, `%${search}%`), like(auditLogsTable.target, `%${search}%`)));
  if (action) conditions.push(eq(auditLogsTable.action, action));

  const logs = await db.select().from(auditLogsTable)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(auditLogsTable.createdAt))
    .limit(limit).offset(page * limit);

  const [countResult] = await db.select({ count: sql<number>`count(*)` }).from(auditLogsTable)
    .where(conditions.length ? and(...conditions) : undefined);

  res.json({ status: "ok", logs, total: Number(countResult?.count ?? 0), page, limit });
});

/* ─── User Management (via localStorage sync) ─── */
router.get("/users", requireAuth, requireRole("super_admin", "admin", "support"), async (_req: Request, res: Response) => {
  const rows = await db.select({
    id: appUsersTable.id,
    phone: appUsersTable.phone,
    name: appUsersTable.name,
    legacyPlan: appUsersTable.plan,
    legacyVipExpiresAt: appUsersTable.vipExpiresAt,
    status: appUsersTable.status,
    createdAt: appUsersTable.createdAt,
    subscriptionStatus: userSubscriptionsTable.status,
    subscriptionExpiresAt: userSubscriptionsTable.expiresAt,
    subscriptionPlanKey: userSubscriptionsTable.planKey,
  }).from(appUsersTable)
    .leftJoin(userSubscriptionsTable, eq(userSubscriptionsTable.userId, appUsersTable.id))
    .orderBy(desc(appUsersTable.createdAt)).limit(1000);
  const now = new Date();
  const users = rows.map((row) => {
    /* Administrative display follows the same entitlement precedence as
     * hasVip(): a present subscription always overrides legacy projection. */
    const hasSubscription = row.subscriptionStatus !== null;
    const subscriptionActive = row.subscriptionStatus === "active"
      && !!row.subscriptionExpiresAt && row.subscriptionExpiresAt > now;
    const legacyActive = row.legacyPlan === "vip"
      && (!row.legacyVipExpiresAt || row.legacyVipExpiresAt > now);
    return {
      id: row.id,
      phone: row.phone,
      name: row.name,
      plan: hasSubscription ? (subscriptionActive ? "vip" : "free") : (legacyActive ? "vip" : "free"),
      vipExpiresAt: hasSubscription ? row.subscriptionExpiresAt : row.legacyVipExpiresAt,
      subscriptionStatus: hasSubscription ? (subscriptionActive ? "active" : row.subscriptionStatus) : "legacy",
      subscriptionPlanKey: row.subscriptionPlanKey,
      status: row.status,
      createdAt: row.createdAt,
    };
  });
  res.json({ status: "ok", users });
});

router.post("/users/action", requireAuth, requireWriteRate, requireRole("super_admin", "admin", "support"), async (req: AuthRequest, res: Response) => {
  const { action, phone } = req.body || {};
  const validActions = ["ban_user", "unban_user", "downgrade_vip"];
  /* A manual one-month upgrade would bypass the plan snapshot, payment
   * history, and central entitlement record. Never fabricate one: use the
   * reviewed payment-request path instead. */
  if (String(action) === "upgrade_vip") {
    res.status(409).json({
      status: "error",
      message: "لا توجد ترقية VIP يدوية؛ راجع/اعتمد طلب دفع مرتبطًا بباقة حتى يُسجل الاشتراك بصورة صحيحة",
    });
    return;
  }
  if (!validActions.includes(String(action))) {
    res.status(400).json({ status: "error", message: "action must be: " + validActions.join(", ") });
    return;
  }
  if (!phone) { res.status(400).json({ status: "error", message: "phone required" }); return; }
  const [user] = await db.select().from(appUsersTable).where(eq(appUsersTable.phone, String(phone))).limit(1);
  if (!user) { res.status(404).json({ status: "error", message: "user not found" }); return; }

  try {
    if (action === "downgrade_vip") {
      /* Revoke is an archived state transition, not a destructive delete. */
      await db.transaction(async (tx) => {
        const now = new Date();
        await tx.update(userSubscriptionsTable).set({
          status: "cancelled",
          cancelledAt: now,
          updatedAt: now,
        }).where(eq(userSubscriptionsTable.userId, user.id));
        await tx.update(appUsersTable).set({
          /* Compatibility projection only; hasVip() reads the cancellation
           * from user_subscriptions and fails closed immediately. */
          plan: "free",
          vipExpiresAt: null,
          updatedAt: now,
        }).where(eq(appUsersTable.id, user.id));
      });
    } else {
      const updates: Partial<typeof appUsersTable.$inferInsert> = {
        updatedAt: new Date(),
        ...(action === "ban_user" ? { status: "banned" } : { status: "active" }),
      };
      await db.update(appUsersTable).set(updates).where(eq(appUsersTable.id, user.id));
    }
    /* A ban or a VIP downgrade must take effect on sessions already open,
     * not only at the next login. */
    if (action === "ban_user" || action === "downgrade_vip") {
      await revokeAllSessions("user", user.id);
    }
    await auditLog(String(action), req.actor, `user:${user.id}`, {}, req.ip);
    res.json({ status: "ok", action, phone });
  } catch (e) {
    logger.error({ err: e }, "user status/subscription action failed");
    res.status(500).json({ status: "error", message: "server error" });
  }
});

/* ══════════════════════════════════════════════
   PAYMENT REQUESTS (subscription sign-ups)
══════════════════════════════════════════════ */

/* Legacy submission endpoint retired: it accepted payment metadata without
 * the proof/method safeguards in /api/payments. The current frontend submits
 * only through that canonical route; fail closed rather than silently
 * accepting a second, weaker payment path. */
router.post("/requests", (_req: Request, res: Response) => {
  res.status(410).json({
    status: "error",
    message: "مسار طلب الدفع تغيّر — حدّث الصفحة ثم أرسل الطلب من الاشتراك",
  });
});

/* Protected: list all payment requests */
router.get("/requests", requireAuth, requireRole("super_admin", "admin", "support"), async (req: AuthRequest, res: Response) => {
  try {
    const statusFilter = String(req.query["status"] || "").trim();
    let rows;
    if (statusFilter && ["pending", "approved", "rejected", "refunded", "cancelled", "expired"].includes(statusFilter)) {
      rows = await db.select({
        id: paymentRequestsTable.id, phone: paymentRequestsTable.phone, name: paymentRequestsTable.name,
        planKey: paymentRequestsTable.planKey, payMethod: paymentRequestsTable.payMethod,
        price: paymentRequestsTable.price, priceSnapshot: paymentRequestsTable.priceSnapshot, priceLockedUntil: paymentRequestsTable.priceLockedUntil,
        tx: paymentRequestsTable.tx, status: paymentRequestsTable.status,
        notes: paymentRequestsTable.notes, proofImage: paymentRequestsTable.proofImage,
        proofName: paymentRequestsTable.proofName, senderPhone: paymentRequestsTable.senderPhone,
        referralRewardId: paymentRequestsTable.referralRewardId, createdAt: paymentRequestsTable.createdAt,
      }).from(paymentRequestsTable).where(eq(paymentRequestsTable.status, statusFilter)).orderBy(desc(paymentRequestsTable.createdAt)).limit(300);
    } else {
      rows = await db.select({
        id: paymentRequestsTable.id, phone: paymentRequestsTable.phone, name: paymentRequestsTable.name,
        planKey: paymentRequestsTable.planKey, payMethod: paymentRequestsTable.payMethod,
        price: paymentRequestsTable.price, priceSnapshot: paymentRequestsTable.priceSnapshot, priceLockedUntil: paymentRequestsTable.priceLockedUntil,
        tx: paymentRequestsTable.tx, status: paymentRequestsTable.status,
        notes: paymentRequestsTable.notes, proofImage: paymentRequestsTable.proofImage,
        proofName: paymentRequestsTable.proofName, senderPhone: paymentRequestsTable.senderPhone,
        referralRewardId: paymentRequestsTable.referralRewardId, createdAt: paymentRequestsTable.createdAt,
      }).from(paymentRequestsTable).orderBy(desc(paymentRequestsTable.createdAt)).limit(300);
    }
    /* Pending-age tracking so the UI can flag requests waiting > 1h. */
    const nowMs = Date.now();
    const outRows = rows.map((r) =>
      r.status === "pending"
        ? { ...r, waitSeconds: Math.max(0, Math.floor((nowMs - new Date(r.createdAt).getTime()) / 1000)) }
        : r,
    );
    res.json({ status: "ok", requests: outRows });
  } catch (e) {
    logger.error({ err: e }, "payment requests list error");
    res.status(500).json({ status: "error", message: "server error" });
  }
});

/* Protected: approve or reject a request */
class PaymentDecisionError extends Error {
  constructor(readonly httpStatus: number, message: string) {
    super(message);
  }
}

/** A scoped test clock keeps production approval time authoritative while
 * allowing lifecycle regression tests to exercise exact renewal boundaries. */
function paymentDecisionNow(): Date {
  const injected = process.env.NODE_ENV === "test"
    ? (globalThis as typeof globalThis & { __egytrendTestClock?: Date }).__egytrendTestClock
    : undefined;
  return injected instanceof Date && Number.isFinite(injected.getTime()) ? new Date(injected) : new Date();
}

router.put("/requests/:id", requireAuth, requireWriteRate, requireRole("super_admin", "admin"), async (req: AuthRequest, res: Response) => {
  const id = String(req.params["id"] || "").trim();
  const requestedStatus = req.body?.status === "approved" ? "approved"
    : req.body?.status === "rejected" ? "rejected"
      : req.body?.status === "refunded" ? "refunded"
        : req.body?.status === "cancelled" ? "cancelled"
          : null;
  const decisionNotes = stripHtml(String(req.body?.notes || "").trim()).slice(0, 200) || null;
  if (!requestedStatus) {
    res.status(400).json({ status: "error", message: "status must be approved|rejected|refunded|cancelled" });
    return;
  }

  try {
    /* Lifecycle settings are server-owned and default safely to zero grace.
     * They are read before the approval transaction, then snapshotted into the
     * new entitlement's grace_ends_at so a later settings edit cannot rewrite
     * a term the customer already bought. */
    const lifecycleSettings = await readSubscriptionLifecycleSettings();
    /* The status change and VIP activation are one transaction. A locked
     * request row prevents two admin clicks from extending the same payment
     * twice, and validation happens before the request is marked approved. */
    const outcome = await db.transaction(async (tx) => {
      const [existing] = await tx.select().from(paymentRequestsTable)
        .where(eq(paymentRequestsTable.id, id)).for("update");
      if (!existing) throw new PaymentDecisionError(404, "request not found");

      if (existing.status !== "pending") {
        /* A rejected request can be re-reviewed after corrected proof. An
         * approved request may only move to refunded/cancelled: entitlement
         * reversal remains an explicit separate administrative decision, while
         * the referral hold is cancelled safely by the post-commit hook. */
        if (requestedStatus === "rejected" && existing.status === "approved") {
          throw new PaymentDecisionError(409, "الطلب مقبول بالفعل ولا يمكن رفضه؛ استخدم حالة الاسترجاع أو الإلغاء عند الحاجة");
        }
        if (["refunded", "cancelled"].includes(requestedStatus) && !["approved", "pending"].includes(existing.status)) {
          throw new PaymentDecisionError(409, "لا يمكن استرجاع أو إلغاء هذه الحالة");
        }
        if (requestedStatus === existing.status) {
          return { already: true as const, existing, planNameAr: existing.planKey };
        }
      }

      let planNameAr = existing.planKey;
      let approvedUserId: number | null = null;
      if (requestedStatus === "approved") {
        const now = paymentDecisionNow();
        /* New-format requests reserve their immutable server price only for
         * the configured window. Mark an overdue pending request expired in
         * the same transaction; its snapshot remains auditable. */
        if (existing.priceLockedUntil && existing.priceLockedUntil.getTime() <= now.getTime()) {
          await tx.update(paymentRequestsTable).set({
            status: "expired",
            notes: "انتهت مدة تثبيت السعر؛ يلزم إنشاء طلب جديد بالسعر الحالي.",
            updatedAt: now,
            decidedAt: now,
          }).where(eq(paymentRequestsTable.id, id));
          return { expired: true as const, existing, planNameAr };
        }

        /* A payment request created by the current flow owns a complete,
         * server-authored plan snapshot. Therefore an ordinary later price,
         * name, duration or archive edit cannot change what the user bought.
         * Legacy records fall back to the historical plan lookup. */
        const snapshot = readPaymentPriceSnapshot(existing.priceSnapshot);
        let activationPlan: { key: string; nameAr: string; durationMonths: number; features: string[] } | null = null;
        if (snapshot && snapshot.plan.key === existing.planKey && snapshot.effective.price === existing.price) {
          activationPlan = snapshot.plan;
        } else {
          const [plan] = await tx.select({
            key: subscriptionPlansTable.key,
            durationMonths: subscriptionPlansTable.durationMonths,
            nameAr: subscriptionPlansTable.nameAr,
            features: subscriptionPlansTable.features,
          }).from(subscriptionPlansTable)
            .where(and(eq(subscriptionPlansTable.key, existing.planKey), eq(subscriptionPlansTable.isActive, true)))
            .limit(1);
          activationPlan = plan
            ? { key: plan.key, nameAr: plan.nameAr, durationMonths: plan.durationMonths, features: Array.isArray(plan.features) ? plan.features : [] }
            : null;
        }

        /* Lock the user row as well as the request: separate approved renewal
         * requests for the same user must stack rather than race. */
        const [user] = await tx.select({
          id: appUsersTable.id,
          plan: appUsersTable.plan,
          vipExpiresAt: appUsersTable.vipExpiresAt,
          status: appUsersTable.status,
        }).from(appUsersTable).where(eq(appUsersTable.phone, existing.phone)).for("update").limit(1);

        /* Never report a successful approval when activation cannot happen. */
        if (!activationPlan || !user || user.status !== "active") {
          throw new PaymentDecisionError(409, "تعذر تفعيل الاشتراك؛ راجع الخطة وحالة الحساب قبل الموافقة");
        }
        approvedUserId = user.id;
        const [currentSubscription] = await tx.select({
          id: userSubscriptionsTable.id,
          cycleId: userSubscriptionsTable.cycleId,
          startsAt: userSubscriptionsTable.startsAt,
          expiresAt: userSubscriptionsTable.expiresAt,
          status: userSubscriptionsTable.status,
          subscriptionType: userSubscriptionsTable.subscriptionType,
          trialFeatureScope: userSubscriptionsTable.trialFeatureScope,
          trialAiDailyLimit: userSubscriptionsTable.trialAiDailyLimit,
          trialStartedAt: userSubscriptionsTable.trialStartedAt,
          trialEndsAt: userSubscriptionsTable.trialEndsAt,
          trialEndedAt: userSubscriptionsTable.trialEndedAt,
          trialConvertedAt: userSubscriptionsTable.trialConvertedAt,
        }).from(userSubscriptionsTable).where(eq(userSubscriptionsTable.userId, user.id)).limit(1);

        planNameAr = activationPlan.nameAr;
        /* A paid renewal before the term ends stacks from the current expiry.
         * A post-expiry (including grace-period) approval starts from approval
         * time, as required; monthly arithmetic is exactly 30 elapsed days. */
        const extendsCurrentTerm = currentSubscription?.status === "active" && currentSubscription.expiresAt > now;
        const convertsLiveTrial = extendsCurrentTerm && currentSubscription?.subscriptionType === "trial";
        const extendsLegacyProjection = !currentSubscription && user.plan === "vip" && user.vipExpiresAt && user.vipExpiresAt > now;
        const existingExpiry = extendsCurrentTerm
          ? currentSubscription.expiresAt
          : extendsLegacyProjection
            ? user.vipExpiresAt!
            : now;
        /* Paying on day 3 of a trial reserves the paid term after the trial;
         * it never consumes the free days or begins a second entitlement now. */
        const expires = calculateApprovedSubscriptionEnd(existingExpiry, activationPlan.durationMonths);
        const startsAt = extendsCurrentTerm
          ? (convertsLiveTrial ? existingExpiry : currentSubscription.startsAt)
          : now;
        const subscriptionId = currentSubscription?.id || `sub-${user.id}`;
        const cycleId = createSubscriptionCycleId(user.id, existing.id);
        const graceEndsAt = calculateSubscriptionGraceEnd(expires, lifecycleSettings.graceDays);
        const isRenewal = Boolean((currentSubscription && !convertsLiveTrial) || extendsLegacyProjection);

        /* The prior current row is overwritten, so cancel only undelivered or
         * still-pending deliveries from its old cycle inside this same payment
         * transaction. Already-visible in-app history stays visible. */
        if (currentSubscription?.cycleId) {
          await tx.update(subscriptionRemindersSentTable).set({
            emailStatus: "cancelled",
            emailNextAttemptAt: null,
            cancelledAt: now,
            updatedAt: now,
          }).where(and(
            eq(subscriptionRemindersSentTable.subscriptionCycleId, currentSubscription.cycleId),
            inArray(subscriptionRemindersSentTable.emailStatus, ["pending", "sending"]),
          ));
          await tx.update(subscriptionRemindersSentTable).set({
            deliveryStatus: "cancelled",
            emailStatus: "cancelled",
            emailNextAttemptAt: null,
            cancelledAt: now,
            updatedAt: now,
          }).where(and(
            eq(subscriptionRemindersSentTable.subscriptionCycleId, currentSubscription.cycleId),
            eq(subscriptionRemindersSentTable.deliveryStatus, "queued"),
          ));
        }

        await tx.insert(userSubscriptionsTable).values({
          id: subscriptionId,
          userId: user.id,
          planKey: activationPlan.key,
          planNameAr: activationPlan.nameAr,
          planDurationMonths: activationPlan.durationMonths,
          planFeatures: activationPlan.features,
          subscriptionType: "paid",
          /* During a paid term scheduled after a live trial, retain the
           * trial snapshot until startsAt so selected-feature trials do not
           * become all-feature access early. */
          trialFeatureScope: convertsLiveTrial ? currentSubscription?.trialFeatureScope || "all" : null,
          trialAiDailyLimit: convertsLiveTrial ? currentSubscription?.trialAiDailyLimit || null : null,
          trialStartedAt: currentSubscription?.trialStartedAt || null,
          trialEndsAt: currentSubscription?.trialEndsAt || (convertsLiveTrial ? currentSubscription?.expiresAt || null : null),
          trialEndedAt: convertsLiveTrial ? currentSubscription?.expiresAt || null : (currentSubscription?.trialEndedAt || null),
          trialConvertedAt: convertsLiveTrial ? now : (currentSubscription?.trialConvertedAt || null),
          status: "active",
          cycleId,
          startsAt,
          expiresAt: expires,
          graceEndsAt,
          paymentRequestId: existing.id,
          source: "payment",
          cancelledAt: null,
          createdAt: now,
          updatedAt: now,
        }).onConflictDoUpdate({
          target: userSubscriptionsTable.userId,
          set: {
            planKey: activationPlan.key,
            planNameAr: activationPlan.nameAr,
            planDurationMonths: activationPlan.durationMonths,
            planFeatures: activationPlan.features,
            subscriptionType: "paid",
            trialFeatureScope: convertsLiveTrial ? currentSubscription?.trialFeatureScope || "all" : null,
            trialAiDailyLimit: convertsLiveTrial ? currentSubscription?.trialAiDailyLimit || null : null,
            trialStartedAt: currentSubscription?.trialStartedAt || null,
            trialEndsAt: currentSubscription?.trialEndsAt || (convertsLiveTrial ? currentSubscription?.expiresAt || null : null),
            trialEndedAt: convertsLiveTrial ? currentSubscription?.expiresAt || null : (currentSubscription?.trialEndedAt || null),
            trialConvertedAt: convertsLiveTrial ? now : (currentSubscription?.trialConvertedAt || null),
            status: "active",
            cycleId,
            startsAt,
            expiresAt: expires,
            graceEndsAt,
            paymentRequestId: existing.id,
            source: "payment",
            cancelledAt: null,
            updatedAt: now,
          },
        });
        if (convertsLiveTrial) {
          /* Preserve conversion evidence outside the current-entitlement row;
           * the paid row replaces the trial projection but sequence delivery
           * is already cancelled above and cannot resume later. */
          await tx.update(trialClaimsTable).set({
            convertedAt: now,
            paidStartsAt: existingExpiry,
            updatedAt: now,
          }).where(eq(trialClaimsTable.userId, user.id));
        }
        await tx.insert(subscriptionLifecycleEventsTable).values({
          id: `subevent-${existing.id}`,
          userId: user.id,
          subscriptionId,
          subscriptionCycleId: cycleId,
          eventType: convertsLiveTrial ? "trial_converted" : isRenewal ? "renewed" : "activated",
          relatedCycleId: currentSubscription?.cycleId || null,
          planKey: activationPlan.key,
          occurredAt: now,
          createdAt: now,
        }).onConflictDoNothing();
        await tx.update(appUsersTable).set({
          /* Compatibility projection only. New server authorization reads
           * user_subscriptions through hasVip(). */
          plan: "vip",
          vipExpiresAt: expires,
          updatedAt: now,
        }).where(eq(appUsersTable.id, user.id));
      }

      await tx.update(paymentRequestsTable).set({
        status: requestedStatus,
        notes: decisionNotes,
        updatedAt: new Date(),
        decidedAt: new Date(),
      }).where(eq(paymentRequestsTable.id, id));
      return { already: false as const, existing, planNameAr, userId: approvedUserId };
    });

    if ("expired" in outcome && outcome.expired) {
      await auditLog("expire_payment_price_lock", req.actor, `payment-request:${id}`, { planKey: outcome.existing.planKey }, req.ip);
      res.status(409).json({ status: "error", message: "انتهت مدة تثبيت سعر هذا الطلب؛ أنشئ طلب دفع جديدًا بالسعر الحالي" });
      return;
    }
    if ("already" in outcome && outcome.already) {
      res.json({ status: "ok", already: true });
      return;
    }

    /* Referral reward state is a separate durable/idempotent concern. It runs
     * only after the payment decision committed, so a retry or double-click
     * cannot grant a second reward. A failure is logged for the shared
     * lifecycle worker/review tooling rather than misreporting payment state. */
    try {
      if (requestedStatus === "approved" && outcome.userId) {
        await onReferralPaymentApproved({ userId: outcome.userId, paymentRequestId: id, senderPhone: outcome.existing.senderPhone, proofHash: outcome.existing.proofHash, now: paymentDecisionNow() });
      } else if (requestedStatus === "refunded" || requestedStatus === "cancelled" || requestedStatus === "rejected") {
        await onReferralPaymentCancelled(id, requestedStatus === "rejected" ? "تم رفض الدفع" : "تم إلغاء أو استرجاع الدفع", paymentDecisionNow());
      }
    } catch (referralError) {
      logger.error({ err: referralError, paymentRequestId: id }, "referral payment hook failed");
    }

    /* Notifications are best-effort only; entitlement and payment status were
     * already committed together in the transaction above. */
    try {
      const notifId = `un-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      await db.insert(userNotificationsTable).values({
        id: notifId,
        phone: outcome.existing.phone,
        kind: requestedStatus === "approved" ? "payment_approved" : "payment_rejected",
        title: requestedStatus === "approved" ? "🎉 تم تفعيل اشتراك VIP" : requestedStatus === "refunded" || requestedStatus === "cancelled" ? "تحديث بخصوص الدفع" : "تحديث بخصوص طلب الدفع",
        body:
          requestedStatus === "approved"
            ? `تم تأكيد دفعتك (${outcome.planNameAr}) بالقيمة المثبتة ${outcome.existing.price} جنيه وتفعيل اشتراك VIP بنجاح.`
            : requestedStatus === "refunded" || requestedStatus === "cancelled"
              ? (decisionNotes || "تم تسجيل إلغاء أو استرجاع الدفع. لا تتغير الصلاحية تلقائيًا من هذا الإجراء؛ راجع الإدارة عند الحاجة.")
              : decisionNotes
                ? `تم رفض طلب الدفع. السبب: ${decisionNotes}`
                : "تم رفض طلب الدفع. يمكنك إعادة الطلب بعد تصحيح بيانات التحويل.",
      });
    } catch (notificationError) {
      logger.error({ err: notificationError }, "user notification insert failed after payment decision");
    }

    /* Audit identifiers are non-sensitive: do not persist phone numbers,
     * transaction IDs, wallet values, or client-supplied notes in log rows. */
    await auditLog(
      `request_${requestedStatus}`,
      req.actor,
      `payment-request:${id}`,
      { planKey: outcome.existing.planKey },
      req.ip,
    );
    res.json({ status: "ok" });
  } catch (e) {
    if (e instanceof PaymentDecisionError) {
      res.status(e.httpStatus).json({ status: "error", message: e.message });
      return;
    }
    logger.error({ err: e }, "payment request update error");
    res.status(500).json({ status: "error", message: "server error" });
  }
});

/* ════════════════════════════════════════════
   SUBSCRIPTION LIFECYCLE — staff visibility and safe controls
════════════════════════════════════════════ */
router.get("/subscriptions/summary", requireAuth, requireRole("super_admin", "admin", "support"), async (_req: Request, res: Response) => {
  try {
    const summary = await subscriptionAdminSummary(new Date());
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.json({ status: "ok", summary });
  } catch (error) {
    logger.error({ err: error }, "subscription summary error");
    res.status(503).json({ status: "error", message: "إحصاءات الاشتراكات غير متاحة حاليًا" });
  }
});

router.get("/subscriptions/expiring", requireAuth, requireRole("super_admin", "admin", "support"), async (_req: Request, res: Response) => {
  try {
    const subscriptions = await listExpiringSubscriptions(new Date());
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.json({ status: "ok", subscriptions, asOf: new Date().toISOString(), timezone: "Africa/Cairo" });
  } catch (error) {
    logger.error({ err: error }, "expiring subscriptions list error");
    res.status(503).json({ status: "error", message: "قائمة الاشتراكات غير متاحة حاليًا" });
  }
});

router.get("/subscriptions/email-failures", requireAuth, requireRole("super_admin", "admin", "support"), async (req: Request, res: Response) => {
  try {
    const raw = Number(req.query["limit"] || 100);
    const failures = await listSubscriptionEmailFailures(Number.isInteger(raw) ? raw : 100);
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.json({ status: "ok", failures, asOf: new Date().toISOString() });
  } catch (error) {
    logger.error({ err: error }, "subscription email failures list error");
    res.status(503).json({ status: "error", message: "حالة البريد غير متاحة حاليًا" });
  }
});

router.get("/subscriptions/settings", requireAuth, requireRole("super_admin", "admin", "support"), async (_req: Request, res: Response) => {
  try {
    const settings = await readSubscriptionLifecycleSettings();
    res.json({
      status: "ok",
      settings,
      note: "تُطبّق فترة السماح على الاشتراكات التي تُعتمد بعد هذا التعديل. رسائل الانتهاء المعاملاتية لا تتعطل؛ خيار وحشتنا تسويقي ويمكن إيقافه.",
    });
  } catch (error) {
    logger.error({ err: error }, "subscription settings read error");
    res.status(503).json({ status: "error", message: "إعدادات الاشتراك غير متاحة حاليًا" });
  }
});

router.put("/subscriptions/settings", requireAuth, requireWriteRate, requireRole("super_admin", "admin"), async (req: AuthRequest, res: Response) => {
  const settings = validateSubscriptionLifecycleSettings(req.body);
  if (!settings) {
    res.status(400).json({ status: "error", message: "إعدادات الاشتراك غير صالحة: فترة السماح من 0 إلى 31 يومًا وخيار التسويق منطقي." });
    return;
  }
  try {
    await saveSubscriptionLifecycleSettings(settings, new Date());
    await auditLog("update_subscription_lifecycle_settings", req.actor, "subscription-lifecycle", {
      graceDays: settings.graceDays,
      winbackMarketingEnabled: settings.winbackMarketingEnabled,
    }, req.ip);
    res.json({ status: "ok", settings });
  } catch (error) {
    logger.error({ err: error }, "subscription settings update error");
    res.status(503).json({ status: "error", message: "تعذر حفظ إعدادات الاشتراك" });
  }
});

/* No state transition, notification, or e-mail is performed by this route. */
router.post("/subscriptions/dry-run", requireAuth, requireWriteRate, requireRole("super_admin", "admin", "support"), async (req: AuthRequest, res: Response) => {
  const supplied = typeof req.body?.at === "string" ? req.body.at : "";
  const simulatedAt = supplied ? parseCairoDateTime(supplied) : new Date();
  if (!simulatedAt) {
    res.status(400).json({ status: "error", message: "استخدم تاريخًا صالحًا (Cairo datetime أو ISO UTC)." });
    return;
  }
  try {
    const result = await runSubscriptionLifecycle({ now: simulatedAt, dryRun: true });
    await auditLog("dry_run_subscription_lifecycle", req.actor, "subscription-lifecycle", {
      at: result.now,
      inspected: result.inspected,
      wouldQueue: result.previews.length,
    }, req.ip);
    res.json({ status: "ok", result });
  } catch (error) {
    logger.error({ err: error }, "subscription dry run error");
    res.status(503).json({ status: "error", message: "تعذر تنفيذ المحاكاة حاليًا" });
  }
});

router.post("/subscriptions/:id/manual-reminder", requireAuth, requireWriteRate, requireRole("super_admin", "admin"), async (req: AuthRequest, res: Response) => {
  const subscriptionId = String(req.params["id"] || "").trim().slice(0, 120);
  if (!subscriptionId) {
    res.status(400).json({ status: "error", message: "معرف الاشتراك مطلوب" });
    return;
  }
  try {
    const outcome = await queueManualSubscriptionReminder(subscriptionId, new Date());
    if (outcome.status === "not_found") {
      res.status(404).json({ status: "error", message: "الاشتراك غير موجود" });
      return;
    }
    if (outcome.status === "not_eligible") {
      res.status(422).json({ status: "error", message: "التذكير اليدوي متاح فقط لاشتراك نشط ينتهي خلال 7 أيام" });
      return;
    }
    if (outcome.status === "already_queued") {
      res.status(409).json({ status: "error", message: "أُنشئ تذكير يدوي لهذه الدورة بالفعل؛ لا يمكن تكراره" });
      return;
    }
    await auditLog("manual_subscription_reminder", req.actor, `subscription:${subscriptionId}`, {
      inAppDelivered: outcome.result?.inAppDelivered || 0,
      emailSent: outcome.result?.emailSent || 0,
      emailRetrying: outcome.result?.emailRetrying || 0,
      emailUnavailable: outcome.result?.emailUnavailable || 0,
    }, req.ip);
    res.json({ status: "ok", delivery: outcome.result });
  } catch (error) {
    logger.error({ err: error }, "manual subscription reminder error");
    res.status(503).json({ status: "error", message: "تعذر إنشاء التذكير اليدوي حاليًا" });
  }
});

/* ════════════════════════════════════════════
   PAYMENT SETTINGS (Vodafone Cash wallet + price)
════════════════════════════════════════════ */
/* Per-method wallet settings — a method is "enabled" (shown to users) iff its
 * number is set. InstaPay uses the same number field (wallet/UPN). */
const PAY_METHODS = [
  { id: "vodafone", label: "فودافون كاش" },
  { id: "orange", label: "أورنج كاش" },
  { id: "etisalat", label: "اتصالات كاش" },
  { id: "instapay", label: "إنستاباي" },
] as const;
const PAYMENT_SETTING_KEYS = [
  ...PAY_METHODS.flatMap((m) => [`payment_${m.id}_number`, `payment_${m.id}_instructions`, `payment_${m.id}_enabled`]),
];

/* Read current payment settings (super_admin/admin/support). */
router.get("/settings/payment", requireAuth, requireRole("super_admin", "admin", "support"), async (_req, res: Response) => {
  try {
    const rows = await db.select().from(appSettingsTable);
    const out: Record<string, string> = {};
    for (const k of PAYMENT_SETTING_KEYS) {
      const r = rows.find((x) => x.key === k);
      /* No public or admin-facing fallback wallet values: an absent DB setting
       * means absent, so an operator cannot accidentally see or publish a
       * stale number as if it were configured. */
      out[k] = r?.value ?? "";
    }
    res.json({ status: "ok", settings: out, methods: PAY_METHODS });
  } catch (e) {
    logger.error({ err: e }, "payment settings read error");
    res.status(500).json({ status: "error", message: "server error" });
  }
});

/* Update payment settings (super_admin/admin). */
router.put("/settings/payment", requireAuth, requireWriteRate, requireRole("super_admin", "admin"), async (req: AuthRequest, res: Response) => {
  const b = (req.body || {}) as Record<string, unknown>;
  const updates: Array<[string, string]> = [];
  for (const m of PAY_METHODS) {
    const ek = `payment_${m.id}_enabled`;
    const enVal = b[ek] !== undefined ? (String(b[ek]) === "1" ? "1" : "0") : undefined;
    if (enVal !== undefined) updates.push([ek, enVal]);
    const k = `payment_${m.id}_number`;
    if (b[k] !== undefined) {
      const num = String(b[k]).replace(/\s/g, "");
      if (num === "") {
        /* Clearing the number hides the method — but not while enabling it in the same request. */
        if (enVal === "1") {
          res.status(400).json({ status: "error", message: `أدخل رقم ${m.label} أو عطّل الوسيلة` });
          return;
        }
      } else {
        /* InstaPay addresses may be alphanumeric; wallets must be Egyptian mobile numbers. */
        const okNum = m.id === "instapay" ? /^[A-Za-z0-9@.\-]{6,40}$/.test(num) : /^01[0-9]{9}$/.test(num);
        if (!okNum) {
          res.status(400).json({
            status: "error",
            message:
              m.id === "instapay"
                ? "عنوان إنستاباي غير صحيح (حروف/أرقام 6-40)"
                : `رقم ${m.label} يجب أن يكون رقم موبايل مصري (11 رقمًا يبدأ بـ 01)`,
          });
          return;
        }
      }
      updates.push([k, num]);
    }
    const ik = `payment_${m.id}_instructions`;
    if (b[ik] !== undefined) {
      updates.push([ik, String(b[ik]).slice(0, 300)]);
    }
  }
  if (!updates.length) {
    res.status(400).json({ status: "error", message: "لا توجد تعديلات" });
    return;
  }
  try {
    for (const [key, value] of updates) {
      await db
        .insert(appSettingsTable)
        .values({ key, value, updatedAt: new Date() })
        .onConflictDoUpdate({ target: appSettingsTable.key, set: { value, updatedAt: new Date() } });
    }
    /* Wallet values are sensitive operational data; audit only which setting
     * keys changed, never their values. */
    await auditLog("update_payment_settings", req.actor, "payment", { changedKeys: updates.map(([key]) => key) }, req.ip);
    res.json({ status: "ok" });
  } catch (e) {
    logger.error({ err: e }, "payment settings update error");
    res.status(500).json({ status: "error", message: "server error" });
  }
});

/* ════════════════════════════════════════════
   FREE VIP TRIAL — server-authorized settings, sequence and users
════════════════════════════════════════════ */
function trialStepRouteId(value: unknown): string | null {
  const id = String(value || "").trim();
  return /^trial-step-[a-zA-Z0-9_-]{1,100}$/.test(id) ? id : null;
}

function trialUserId(value: unknown): number | null {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

router.get("/free-trial", requireAuth, requireRole("super_admin", "admin", "support"), async (_req: Request, res: Response) => {
  try {
    const now = new Date();
    const [settings, steps, users, stats] = await Promise.all([
      readFreeTrialSettings(),
      listFreeTrialMessageSteps(true),
      listAdminFreeTrialUsers(now),
      freeTrialStats(now),
    ]);
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.json({
      status: "ok", timezone: "Africa/Cairo", asOf: now.toISOString(), settings, steps, users, stats,
      antiAbuse: {
        emailCanonicalization: "lowercase + remove +suffix; Gmail dots removed and googlemail.com unified",
        disposableEmail: "rejected from self-service trial",
        ipDevice: "hashed review signals only; never an automatic rejection",
        phoneOtp: "اقتراح اختياري فقط؛ غير مفعّل ولا يوجد مزود أو تكلفة معتمدة.",
      },
    });
  } catch (error) {
    logger.error({ err: error }, "free trial admin dashboard error");
    res.status(503).json({ status: "error", message: "تعذر تحميل لوحة التجربة المجانية حاليًا" });
  }
});

router.get("/free-trial/settings", requireAuth, requireRole("super_admin", "admin", "support"), async (_req: Request, res: Response) => {
  try {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.json({ status: "ok", settings: await readFreeTrialSettings(), timezone: "Africa/Cairo" });
  } catch (error) {
    logger.error({ err: error }, "free trial settings read error");
    res.status(503).json({ status: "error", message: "إعدادات التجربة غير متاحة حاليًا" });
  }
});

router.put("/free-trial/settings", requireAuth, requireWriteRate, requireRole("super_admin", "admin"), async (req: AuthRequest, res: Response) => {
  const settings = validateFreeTrialSettings(req.body);
  if (!settings) {
    res.status(400).json({ status: "error", message: "إعدادات التجربة غير صالحة: المدة 1–31 يومًا، وحد AI 0–100، ونافذة الجمهور 1–90 يومًا." });
    return;
  }
  try {
    await saveFreeTrialSettings(settings, new Date());
    await auditLog("update_free_trial_settings", req.actor, "free-trial:settings", {
      enabled: settings.enabled,
      durationDays: settings.durationDays,
      startMode: settings.startMode,
      scope: settings.featureScope,
      aiDailyLimit: settings.aiDailyLimit,
      recentlyExpiredAudienceDays: settings.recentlyExpiredAudienceDays,
    }, req.ip);
    res.json({
      status: "ok", settings,
      note: "تعطيل التجربة يوقف بدايات جديدة فقط ولا يقطع تجربة نشطة أو يغيّر لقطة نطاقها.",
    });
  } catch (error) {
    logger.error({ err: error }, "free trial settings save error");
    res.status(503).json({ status: "error", message: "تعذر حفظ إعدادات التجربة" });
  }
});

router.get("/free-trial/messages", requireAuth, requireRole("super_admin", "admin", "support"), async (_req: Request, res: Response) => {
  try {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.json({ status: "ok", steps: await listFreeTrialMessageSteps(true) });
  } catch (error) {
    logger.error({ err: error }, "free trial message list error");
    res.status(503).json({ status: "error", message: "تعذر تحميل رسائل التجربة" });
  }
});

router.post("/free-trial/messages/preview", requireAuth, requireWriteRate, requireRole("super_admin", "admin", "support"), async (req: AuthRequest, res: Response) => {
  try {
    const preview = await previewFreeTrialMessageStep(req.body, new Date());
    if (!preview.message) { res.status(400).json({ status: "error", message: preview.error || "تعذر إنشاء المعاينة." }); return; }
    await auditLog("preview_free_trial_message", req.actor, "free-trial:preview", { delivery: "admin_preview_only" }, req.ip);
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.json({ status: "ok", preview: preview.message, mode: "admin_only_no_delivery" });
  } catch (error) {
    logger.error({ err: error }, "free trial message preview error");
    res.status(503).json({ status: "error", message: "تعذر إنشاء المعاينة الحقيقية حاليًا" });
  }
});

router.post("/free-trial/messages", requireAuth, requireWriteRate, requireRole("super_admin", "admin"), async (req: AuthRequest, res: Response) => {
  try {
    const result = await createFreeTrialMessageStep(req.body, req.actor?.sub && req.actor.sub > 0 ? req.actor.sub : null, new Date());
    if (!result.step) { res.status(400).json({ status: "error", message: result.error || "تعذر إنشاء الرسالة." }); return; }
    await auditLog("create_free_trial_message", req.actor, `free-trial-step:${result.step.id}`, { timing: result.step.timing, channels: result.step.channels, status: result.step.status }, req.ip);
    res.status(201).json({ status: "ok", step: result.step });
  } catch (error) {
    logger.error({ err: error }, "free trial message create error");
    res.status(503).json({ status: "error", message: "تعذر حفظ رسالة التجربة" });
  }
});

router.put("/free-trial/messages/:id", requireAuth, requireWriteRate, requireRole("super_admin", "admin"), async (req: AuthRequest, res: Response) => {
  const id = trialStepRouteId(req.params["id"]);
  if (!id) { res.status(404).json({ status: "error", message: "الرسالة غير موجودة." }); return; }
  try {
    const result = await updateFreeTrialMessageStep(id, req.body, req.actor?.sub && req.actor.sub > 0 ? req.actor.sub : null, new Date());
    if (!result.step) { res.status(400).json({ status: "error", message: result.error || "تعذر تحديث الرسالة." }); return; }
    await auditLog("update_free_trial_message", req.actor, `free-trial-step:${id}`, { timing: result.step.timing, channels: result.step.channels, status: result.step.status, version: result.step.version }, req.ip);
    res.json({ status: "ok", step: result.step, note: "التعديل يؤثر على الإرسال المستقبلي فقط؛ اللقطات المرسلة تبقى محفوظة." });
  } catch (error) {
    logger.error({ err: error }, "free trial message update error");
    res.status(503).json({ status: "error", message: "تعذر تحديث رسالة التجربة" });
  }
});

router.post("/free-trial/messages/:id/archive", requireAuth, requireWriteRate, requireRole("super_admin", "admin"), async (req: AuthRequest, res: Response) => {
  const id = trialStepRouteId(req.params["id"]);
  if (!id) { res.status(404).json({ status: "error", message: "الرسالة غير موجودة." }); return; }
  try {
    const step = await archiveFreeTrialMessageStep(id, req.actor?.sub && req.actor.sub > 0 ? req.actor.sub : null, new Date());
    if (!step) { res.status(404).json({ status: "error", message: "الرسالة غير موجودة أو مؤرشفة." }); return; }
    await auditLog("archive_free_trial_message", req.actor, `free-trial-step:${id}`, {}, req.ip);
    res.json({ status: "ok", step });
  } catch (error) {
    logger.error({ err: error }, "free trial message archive error");
    res.status(503).json({ status: "error", message: "تعذر أرشفة رسالة التجربة" });
  }
});

function trialPreviewPlainText(content: unknown): string {
  const blocks = content && typeof content === "object" && Array.isArray((content as { blocks?: unknown }).blocks)
    ? (content as { blocks: Array<Record<string, unknown>> }).blocks : [];
  return blocks.flatMap((block) => {
    if (Array.isArray(block.inlines)) return [(block.inlines as Array<{ text?: unknown }>).map((item) => String(item.text || "")).join("")];
    if (Array.isArray(block.items)) return (block.items as Array<Array<{ text?: unknown }>>).map((items) => items.map((item) => String(item.text || "")).join(""));
    return [];
  }).join("\n").slice(0, 5_000);
}

/* This is the only trial test-send path. It resolves the currently logged-in
 * active employee from the database and sends only to that employee address;
 * no audience/user delivery or state is touched. */
router.post("/free-trial/messages/:id/test", requireAuth, requireWriteRate, requireRole("super_admin", "admin"), async (req: AuthRequest, res: Response) => {
  const id = trialStepRouteId(req.params["id"]);
  if (!id || !req.actor?.sub || req.actor.sub <= 0) { res.status(403).json({ status: "error", message: "يتطلب إرسال الاختبار جلسة موظف فعلية." }); return; }
  try {
    const [employee] = await db.select({ id: employeesTable.id, email: employeesTable.email, status: employeesTable.status })
      .from(employeesTable).where(eq(employeesTable.id, req.actor.sub)).limit(1);
    const step = (await listFreeTrialMessageSteps(true)).find((entry) => entry.id === id);
    if (!employee || employee.status !== "active" || !step) { res.status(404).json({ status: "error", message: "الموظف أو الرسالة غير متاح." }); return; }
    const preview = await previewFreeTrialMessageStep({
      timing: step.timing, offsetDays: step.offsetDays, channels: step.channels,
      titleTemplate: step.titleTemplate, bodyTemplate: step.bodyTemplate, messageType: step.messageType,
      actionLabel: step.actionLabel, actionPlanKey: step.actionPlanKey, emailMarketing: step.emailMarketing, status: step.status === "archived" ? "paused" : step.status,
    });
    if (!preview.message) { res.status(400).json({ status: "error", message: preview.error || "تعذر إعداد رسالة الاختبار." }); return; }
    if (!isSmtpConfigured()) { res.status(503).json({ status: "error", message: "خدمة البريد غير مفعّلة؛ لم يُرسل اختبار وهمي." }); return; }
    const body = trialPreviewPlainText(preview.message.content);
    const sent = await sendMail(employee.email, `اختبار تجربة VIP — ${preview.message.title}`.slice(0, 180), `<div dir="rtl"><h2>${preview.message.title.replace(/[&<>"']/g, "")}</h2><p style="white-space:pre-line">${body.replace(/[&<>"']/g, "")}</p></div>`);
    if (!sent.delivered) { res.status(503).json({ status: "error", message: "تعذر إرسال اختبار البريد؛ لم تُرسل أي رسالة للمستخدمين." }); return; }
    await auditLog("test_send_free_trial_message", req.actor, `free-trial-step:${id}`, { delivery: "employee_email_only" }, req.ip);
    res.json({ status: "ok", delivery: "employee_email_only", message: "أُرسل الاختبار إلى بريد الموظف الحالي فقط." });
  } catch (error) {
    logger.error({ err: error }, "free trial message test send error");
    res.status(503).json({ status: "error", message: "تعذر إرسال اختبار رسالة التجربة" });
  }
});

router.get("/free-trial/users", requireAuth, requireRole("super_admin", "admin", "support"), async (_req: Request, res: Response) => {
  try {
    const now = new Date();
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.json({ status: "ok", users: await listAdminFreeTrialUsers(now), asOf: now.toISOString(), timezone: "Africa/Cairo" });
  } catch (error) {
    logger.error({ err: error }, "free trial users list error");
    res.status(503).json({ status: "error", message: "تعذر تحميل مستخدمي التجربة" });
  }
});

router.post("/free-trial/users/:id/extend", requireAuth, requireWriteRate, requireRole("super_admin", "admin"), async (req: AuthRequest, res: Response) => {
  const userId = trialUserId(req.params["id"]);
  const days = Number(req.body?.days);
  if (!userId || !Number.isInteger(days) || days < 1 || days > 31) { res.status(400).json({ status: "error", message: "حدّد زيادة من 1 إلى 31 يومًا." }); return; }
  try {
    const result = await extendFreeTrial(userId, days, new Date());
    if (result.status !== "extended") { res.status(result.status === "not_found" ? 404 : 409).json({ status: "error", message: "التجربة غير نشطة أو غير موجودة." }); return; }
    await auditLog("extend_free_trial", req.actor, `user:${userId}`, { days, endsAt: result.endsAt?.toISOString() || null }, req.ip);
    res.json({ status: "ok", endsAt: result.endsAt?.toISOString() || null, message: "تم تمديد التجربة؛ الرسائل القادمة تُحسب من تاريخ الانتهاء الجديد." });
  } catch (error) {
    logger.error({ err: error }, "free trial extension error");
    res.status(503).json({ status: "error", message: "تعذر تمديد التجربة" });
  }
});

router.post("/free-trial/users/:id/end-now", requireAuth, requireWriteRate, requireRole("super_admin", "admin"), async (req: AuthRequest, res: Response) => {
  const userId = trialUserId(req.params["id"]);
  if (!userId) { res.status(400).json({ status: "error", message: "معرف المستخدم غير صالح." }); return; }
  try {
    const result = await endFreeTrialNow(userId, new Date());
    if (result.status !== "ended") { res.status(result.status === "not_found" ? 404 : 409).json({ status: "error", message: "التجربة غير نشطة أو غير موجودة." }); return; }
    await auditLog("end_free_trial_now", req.actor, `user:${userId}`, {}, req.ip);
    res.json({ status: "ok", message: "انتهت التجربة وعاد الحساب للخطة المجانية؛ البيانات محفوظة." });
  } catch (error) {
    logger.error({ err: error }, "free trial end-now error");
    res.status(503).json({ status: "error", message: "تعذر إنهاء التجربة" });
  }
});

router.post("/free-trial/users/:id/grant", requireAuth, requireWriteRate, requireRole("super_admin", "admin"), async (req: AuthRequest, res: Response) => {
  const userId = trialUserId(req.params["id"]);
  const days = req.body?.days === undefined ? undefined : Number(req.body.days);
  if (!userId || (days !== undefined && (!Number.isInteger(days) || days < 1 || days > 31))) { res.status(400).json({ status: "error", message: "المدة اليدوية يجب أن تكون من 1 إلى 31 يومًا." }); return; }
  try {
    const result = await startFreeTrial({ userId, mode: "admin", durationDays: days, actorEmployeeId: req.actor?.sub || null, ip: req.ip || "", device: "admin-manual-grant" });
    if (result.reason !== "started") { res.status(409).json({ status: "error", reason: result.reason, message: "تعذر منح التجربة: الحساب لديه تجربة نشطة أو اشتراك مدفوع." }); return; }
    await auditLog("grant_free_trial", req.actor, `user:${userId}`, { days: days || null, endsAt: result.endsAt?.toISOString() || null }, req.ip);
    try { const { recordReferralEvent } = await import("../lib/referrals"); await recordReferralEvent({ userId, event: "trial_started", now: new Date() }); }
    catch (referralError) { logger.error({ err: referralError, userId }, "referral event after manual trial grant failed"); }
    res.status(201).json({ status: "ok", endsAt: result.endsAt?.toISOString() || null });
  } catch (error) {
    logger.error({ err: error }, "free trial manual grant error");
    res.status(503).json({ status: "error", message: "تعذر منح التجربة" });
  }
});

router.get("/free-trial/stats", requireAuth, requireRole("super_admin", "admin", "support"), async (_req: Request, res: Response) => {
  try { res.setHeader("Cache-Control", "no-store, max-age=0"); res.json({ status: "ok", stats: await freeTrialStats(new Date()) }); }
  catch (error) { logger.error({ err: error }, "free trial stats error"); res.status(503).json({ status: "error", message: "إحصاءات التجربة غير متاحة حاليًا" }); }
});

/* ════════════════════════════════════════════
   REFERRAL PROGRAM — all rules and interventions are server-authorized
════════════════════════════════════════════ */
function referralRouteId(value: unknown, prefix: string): string | null {
  const id = String(value || "").trim();
  return new RegExp(`^${prefix}-[a-zA-Z0-9_-]{8,100}$`).test(id) ? id : null;
}
function referralActorId(req: AuthRequest): number | null { return req.actor?.sub && req.actor.sub > 0 ? req.actor.sub : null; }

router.get("/referrals", requireAuth, requireRole("super_admin", "admin", "support"), async (_req: Request, res: Response) => {
  try {
    const dashboard = await adminReferralDashboard(new Date());
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.json({ status: "ok", timezone: "Africa/Cairo", ...dashboard });
  } catch (error) {
    logger.error({ err: error }, "referral admin dashboard error");
    res.status(503).json({ status: "error", message: "تعذر تحميل لوحة الإحالات حاليًا" });
  }
});

router.put("/referrals/settings", requireAuth, requireWriteRate, requireRole("super_admin", "admin"), async (req: AuthRequest, res: Response) => {
  const settings = validateReferralSettings(req.body);
  if (!settings) { res.status(400).json({ status: "error", message: "إعدادات الإحالة غير صالحة: مدة cookie من 1 إلى 90 يومًا." }); return; }
  try {
    await saveReferralSettings(settings, referralActorId(req), new Date());
    await auditLog("update_referral_settings", req.actor, "referrals:settings", { enabled: settings.enabled, cookieDays: settings.attributionCookieDays }, req.ip);
    res.json({ status: "ok", settings, note: "التعديل يطبّق على الروابط والإحالات الجديدة؛ لا يعيد كتابة لقطات القواعد السابقة." });
  } catch (error) {
    logger.error({ err: error }, "referral settings save error");
    res.status(503).json({ status: "error", message: "تعذر حفظ إعدادات الإحالات" });
  }
});

router.post("/referrals/campaigns", requireAuth, requireWriteRate, requireRole("super_admin", "admin"), async (req: AuthRequest, res: Response) => {
  const input = validateReferralCampaign(req.body);
  if (!input) { res.status(400).json({ status: "error", message: "بيانات الحملة غير صالحة. راجع الجوائز، المواعيد بتوقيت القاهرة، والسقوف." }); return; }
  try {
    const campaign = await createReferralCampaign(input, referralActorId(req), new Date());
    await auditLog("create_referral_campaign", req.actor, `referral-campaign:${campaign.id}`, { status: campaign.status, qualificationEvent: campaign.qualificationEvent, priority: campaign.priority }, req.ip);
    res.status(201).json({ status: "ok", campaign });
  } catch (error) {
    logger.error({ err: error }, "create referral campaign error");
    res.status(503).json({ status: "error", message: "تعذر إنشاء الحملة" });
  }
});

router.put("/referrals/campaigns/:id", requireAuth, requireWriteRate, requireRole("super_admin", "admin"), async (req: AuthRequest, res: Response) => {
  const id = referralRouteId(req.params["id"], "refcamp"), input = validateReferralCampaign(req.body);
  if (!id || !input) { res.status(400).json({ status: "error", message: "بيانات الحملة غير صالحة." }); return; }
  try {
    const campaign = await updateReferralCampaign(id, input, referralActorId(req), new Date());
    if (!campaign) { res.status(404).json({ status: "error", message: "الحملة غير موجودة أو مؤرشفة." }); return; }
    await auditLog("update_referral_campaign", req.actor, `referral-campaign:${id}`, { status: campaign.status, priority: campaign.priority }, req.ip);
    res.json({ status: "ok", campaign, note: "التعديل يسري على الإحالات الجديدة فقط؛ اللقطات السابقة محفوظة." });
  } catch (error) {
    logger.error({ err: error }, "update referral campaign error");
    res.status(503).json({ status: "error", message: "تعذر تعديل الحملة" });
  }
});

router.post("/referrals/campaigns/:id/archive", requireAuth, requireWriteRate, requireRole("super_admin", "admin"), async (req: AuthRequest, res: Response) => {
  const id = referralRouteId(req.params["id"], "refcamp");
  if (!id) { res.status(404).json({ status: "error", message: "الحملة غير موجودة." }); return; }
  try {
    const campaign = await archiveReferralCampaign(id, referralActorId(req), new Date());
    if (!campaign) { res.status(404).json({ status: "error", message: "الحملة غير موجودة أو مؤرشفة." }); return; }
    await auditLog("archive_referral_campaign", req.actor, `referral-campaign:${id}`, {}, req.ip);
    res.json({ status: "ok", campaign, note: "أرشفة الحملة لا تلغي الجوائز أو السجل السابق." });
  } catch (error) { logger.error({ err: error }, "archive referral campaign error"); res.status(503).json({ status: "error", message: "تعذر أرشفة الحملة" }); }
});

router.post("/referrals/tiers", requireAuth, requireWriteRate, requireRole("super_admin", "admin"), async (req: AuthRequest, res: Response) => {
  const input = validateReferralTier(req.body);
  if (!input) { res.status(400).json({ status: "error", message: "بيانات المستوى غير صالحة." }); return; }
  try {
    const tier = await createReferralTier(input, referralActorId(req), new Date());
    if (!tier) { res.status(409).json({ status: "error", message: "الحملة غير موجودة أو يوجد مستوى بنفس العتبة." }); return; }
    await auditLog("create_referral_tier", req.actor, `referral-tier:${tier.id}`, { campaignId: tier.campaignId, threshold: tier.threshold }, req.ip);
    res.status(201).json({ status: "ok", tier });
  } catch (error) { logger.error({ err: error }, "create referral tier error"); res.status(503).json({ status: "error", message: "تعذر إنشاء المستوى" }); }
});

router.put("/referrals/tiers/:id", requireAuth, requireWriteRate, requireRole("super_admin", "admin"), async (req: AuthRequest, res: Response) => {
  const id = referralRouteId(req.params["id"], "reftier"), input = validateReferralTier(req.body);
  if (!id || !input) { res.status(400).json({ status: "error", message: "بيانات المستوى غير صالحة." }); return; }
  try {
    const tier = await updateReferralTier(id, input, referralActorId(req), new Date());
    if (!tier) { res.status(404).json({ status: "error", message: "المستوى غير موجود أو مؤرشف." }); return; }
    await auditLog("update_referral_tier", req.actor, `referral-tier:${id}`, { threshold: tier.threshold }, req.ip);
    res.json({ status: "ok", tier, note: "التعديل للحوافز المستقبلية فقط." });
  } catch (error) { logger.error({ err: error }, "update referral tier error"); res.status(503).json({ status: "error", message: "تعذر تعديل المستوى" }); }
});

router.post("/referrals/tiers/:id/archive", requireAuth, requireWriteRate, requireRole("super_admin", "admin"), async (req: AuthRequest, res: Response) => {
  const id = referralRouteId(req.params["id"], "reftier");
  if (!id) { res.status(404).json({ status: "error", message: "المستوى غير موجود." }); return; }
  try {
    const tier = await archiveReferralTier(id, referralActorId(req), new Date());
    if (!tier) { res.status(404).json({ status: "error", message: "المستوى غير موجود أو مؤرشف." }); return; }
    await auditLog("archive_referral_tier", req.actor, `referral-tier:${id}`, {}, req.ip);
    res.json({ status: "ok", tier });
  } catch (error) { logger.error({ err: error }, "archive referral tier error"); res.status(503).json({ status: "error", message: "تعذر أرشفة المستوى" }); }
});

router.post("/referrals/special-codes", requireAuth, requireWriteRate, requireRole("super_admin", "admin"), async (req: AuthRequest, res: Response) => {
  try {
    const code = await createSpecialReferralCode(req.body || {}, referralActorId(req), new Date());
    if (!code) { res.status(400).json({ status: "error", message: "الكود الخاص أو بياناته غير صالحة أو غير فريدة." }); return; }
    await auditLog("create_referral_special_code", req.actor, `referral-code:${code.id}`, { kind: "special", campaignId: code.campaignId }, req.ip);
    res.status(201).json({ status: "ok", code });
  } catch (error) {
    if (isDuplicateKeyError(error)) { res.status(409).json({ status: "error", message: "الكود مستخدم بالفعل." }); return; }
    logger.error({ err: error }, "create special referral code error"); res.status(503).json({ status: "error", message: "تعذر إنشاء الكود الخاص" });
  }
});

router.put("/referrals/special-codes/:id", requireAuth, requireWriteRate, requireRole("super_admin", "admin"), async (req: AuthRequest, res: Response) => {
  const id = referralRouteId(req.params["id"], "refcode");
  if (!id) { res.status(404).json({ status: "error", message: "الكود غير موجود." }); return; }
  try {
    const code = await updateSpecialReferralCode(id, (req.body || {}) as Record<string, unknown>, referralActorId(req), new Date());
    if (!code) { res.status(400).json({ status: "error", message: "تعذر تعديل الكود؛ راجع البيانات والحالة." }); return; }
    await auditLog("update_referral_special_code", req.actor, `referral-code:${id}`, { status: code.status, commissionDue: code.commissionDue }, req.ip);
    res.json({ status: "ok", code, note: "تعديل/إيقاف الكود لا يغيّر الإحالات المسجلة سابقًا." });
  } catch (error) { logger.error({ err: error }, "update special referral code error"); res.status(503).json({ status: "error", message: "تعذر تعديل الكود الخاص" }); }
});

router.post("/referrals/special-codes/:id/archive", requireAuth, requireWriteRate, requireRole("super_admin", "admin"), async (req: AuthRequest, res: Response) => {
  const id = referralRouteId(req.params["id"], "refcode");
  if (!id) { res.status(404).json({ status: "error", message: "الكود غير موجود." }); return; }
  try {
    const code = await archiveSpecialReferralCode(id, referralActorId(req), new Date());
    if (!code) { res.status(404).json({ status: "error", message: "الكود غير موجود أو مؤرشف." }); return; }
    await auditLog("archive_referral_special_code", req.actor, `referral-code:${id}`, {}, req.ip);
    res.json({ status: "ok", code });
  } catch (error) { logger.error({ err: error }, "archive special referral code error"); res.status(503).json({ status: "error", message: "تعذر أرشفة الكود الخاص" }); }
});

router.post("/referrals/users/:id/:action", requireAuth, requireWriteRate, requireRole("super_admin", "admin"), async (req: AuthRequest, res: Response) => {
  const userId = Number(req.params["id"]), action = String(req.params["action"] || "");
  if (!Number.isSafeInteger(userId) || userId <= 0 || !["block", "disable_code", "regenerate_code"].includes(action)) { res.status(400).json({ status: "error", message: "طلب إدارة المستخدم غير صالح." }); return; }
  try {
    const result = await setReferralUserProgramState(userId, action as "block" | "disable_code" | "regenerate_code", referralActorId(req), new Date());
    await auditLog(`referral_user_${action}`, req.actor, `user:${userId}`, {}, req.ip);
    res.json({ status: "ok", result });
  } catch (error) { logger.error({ err: error }, "referral user admin action error"); res.status(503).json({ status: "error", message: "تعذر تنفيذ إدارة المستخدم" }); }
});

router.post("/referrals/rewards/manual", requireAuth, requireWriteRate, requireRole("super_admin", "admin"), async (req: AuthRequest, res: Response) => {
  const userId = Number(req.body?.userId), campaignId = String(req.body?.campaignId || "").trim();
  try {
    const result = await grantManualReferralReward({ userId, campaignId, rewardType: req.body?.rewardType, rewardValue: req.body?.rewardValue, reason: req.body?.reason, actorEmployeeId: referralActorId(req), now: new Date() });
    if (result.status !== "granted" && result.status !== "already_granted") { res.status(400).json({ status: "error", message: "تعذر منح الجائزة يدويًا؛ راجع المستخدم والحملة وقيمة الجائزة." }); return; }
    await auditLog("manual_referral_reward", req.actor, `referral-reward:${result.rewardId || ""}`, { userId, campaignId }, req.ip);
    res.json({ status: "ok", result });
  } catch (error) { logger.error({ err: error }, "manual referral reward error"); res.status(503).json({ status: "error", message: "تعذر منح الجائزة" }); }
});

router.post("/referrals/rewards/:id/withdraw", requireAuth, requireWriteRate, requireRole("super_admin", "admin"), async (req: AuthRequest, res: Response) => {
  const id = referralRouteId(req.params["id"], "refreward"), reason = stripHtml(String(req.body?.reason || "")).slice(0, 300);
  if (!id || !reason) { res.status(400).json({ status: "error", message: "سبب السحب مطلوب." }); return; }
  try {
    const result = await withdrawReferralReward(id, referralActorId(req), reason, new Date());
    if (!result.status.startsWith("withdrawn")) { res.status(409).json({ status: "error", message: "الجائزة ليست ممنوحة أو لا يمكن سحبها." }); return; }
    await auditLog("withdraw_referral_reward", req.actor, `referral-reward:${id}`, { status: result.status }, req.ip);
    res.json({ status: "ok", result, note: result.status === "withdrawn_recorded" ? "سُجل السحب؛ لم تُقصّر صلاحية تراكمت بعدها مدة مدفوعة تلقائيًا." : undefined });
  } catch (error) { logger.error({ err: error }, "withdraw referral reward error"); res.status(503).json({ status: "error", message: "تعذر سحب الجائزة" }); }
});

router.post("/referrals/reviews/:id/:decision", requireAuth, requireWriteRate, requireRole("super_admin", "admin"), async (req: AuthRequest, res: Response) => {
  const id = referralRouteId(req.params["id"], "refattr"), decision = String(req.params["decision"] || "");
  if (!id || !["approve", "reject"].includes(decision)) { res.status(400).json({ status: "error", message: "قرار المراجعة غير صالح." }); return; }
  const reason = stripHtml(String(req.body?.reason || "")).slice(0, 300);
  try {
    const ok = decision === "approve" ? await approveReferralReview(id, referralActorId(req), new Date()) : await rejectReferralReview(id, referralActorId(req), reason || "رفض المراجعة", new Date());
    if (!ok) { res.status(409).json({ status: "error", message: "الإحالة ليست قيد المراجعة." }); return; }
    await auditLog(`referral_review_${decision}`, req.actor, `referral-attribution:${id}`, { reason: reason || null }, req.ip);
    res.json({ status: "ok" });
  } catch (error) { logger.error({ err: error }, "referral review decision error"); res.status(503).json({ status: "error", message: "تعذر حفظ قرار المراجعة" }); }
});

router.put("/referrals/templates/:event", requireAuth, requireWriteRate, requireRole("super_admin", "admin"), async (req: AuthRequest, res: Response) => {
  const event = String(req.params["event"] || "");
  try {
    const template = await saveReferralTemplate(event, req.body, referralActorId(req), new Date());
    if (!template) { res.status(400).json({ status: "error", message: "القالب أو المتغيرات غير صالحة. المتغيرات المسموحة: {{name}}, {{reward}}, {{friend_name}}, {{days}}." }); return; }
    await auditLog("update_referral_template", req.actor, `referral-template:${event}`, { version: template.version }, req.ip);
    res.json({ status: "ok", template, note: "التعديل يؤثر على الإرسال المستقبلي فقط؛ اللقطات السابقة محفوظة." });
  } catch (error) { logger.error({ err: error }, "referral template save error"); res.status(503).json({ status: "error", message: "تعذر حفظ قالب الإحالة" }); }
});

router.get("/referrals/export.csv", requireAuth, requireRole("super_admin", "admin", "support"), async (_req: Request, res: Response) => {
  try {
    const dashboard = await adminReferralDashboard(new Date());
    const safeCsv = (value: unknown) => {
      const text = String(value ?? "").replace(/[\r\n]+/g, " ");
      const neutral = /^[=+\-@]/.test(text) ? `'${text}` : text;
      return `"${neutral.replace(/"/g, '""')}"`;
    };
    const rows = [["نوع", "المعرف", "الحالة", "تاريخ", "القيمة"],
      ...dashboard.attributions.map((a) => ["إحالة", a.id, `${a.status}/${a.reviewStatus}`, a.createdAt.toISOString(), a.codeSnapshot]),
      ...dashboard.rewards.map((r) => ["جائزة", r.id, r.status, r.createdAt.toISOString(), `${r.rewardType}:${r.rewardValue}`]),
    ];
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=referrals.csv");
    res.send(`\uFEFF${rows.map((row) => row.map(safeCsv).join(",")).join("\r\n")}`);
  } catch (error) { logger.error({ err: error }, "referral csv export error"); res.status(503).json({ status: "error", message: "تعذر تصدير تقرير الإحالات" }); }
});

/* ════════════════════════════════════════════
   USER NOTIFICATIONS (in-platform)
   Users poll /api/user/notifications (payments.ts). Decisions made here
   (approve/reject) insert a row; polling surfaces it with the bell badge.
════════════════════════════════════════════ */
router.get("/user-notifications", requireAuth, requireRole("super_admin", "admin", "support"), async (req: AuthRequest, res: Response) => {
  try {
    const phone = String(req.query["phone"] || "").trim();
    if (!phone) {
      res.status(400).json({ status: "error", message: "phone required" });
      return;
    }
    const rows = await db.select().from(userNotificationsTable)
      .where(eq(userNotificationsTable.phone, phone))
      .orderBy(desc(userNotificationsTable.createdAt)).limit(50);
    res.json({ status: "ok", notifications: rows });
  } catch (e) {
    logger.error({ err: e }, "user notifications admin read error");
    res.status(500).json({ status: "error", message: "server error" });
  }
});

/* ════════════════════════════════════════════
   BROADCASTS — audited, server-authorized public announcements
════════════════════════════════════════════ */
function broadcastRouteId(value: unknown): string | null {
  const id = String(value || "").trim();
  return /^broadcast-[a-zA-Z0-9_-]{8,100}$/.test(id) ? id : null;
}

router.get("/broadcasts/templates", requireAuth, requireBroadcastAccess, (_req: BroadcastAuthRequest, res: Response) => {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.json({ status: "ok", templates: BROADCAST_TEMPLATES, timezone: "Africa/Cairo", marketingEmail: { enabled: false, reason: "لا يوجد إرسال جماعي قبل تشغيل consent وunsubscribe والموافقة التشغيلية." } });
});

router.get("/broadcasts", requireAuth, requireBroadcastAccess, async (_req: BroadcastAuthRequest, res: Response) => {
  try {
    const broadcasts = await listBroadcastsForAdmin(new Date());
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.json({
      status: "ok",
      timezone: "Africa/Cairo",
      marketingEmail: { enabled: false, reason: "الإرسال الجماعي غير مفعّل ولا تُرسل أي رسالة بريدية من هذه الشاشة." },
      broadcasts: broadcasts.map(({ message, effectiveState, stats }) => ({
        id: message.id,
        title: message.title,
        content: message.content,
        messageType: message.messageType,
        audience: message.audience,
        priority: message.priority,
        status: message.status,
        effectiveState,
        startsAt: message.startsAt?.toISOString() || null,
        endsAt: message.endsAt?.toISOString() || null,
        imageMediaId: message.imageMediaId,
        imageUrl: message.imageMediaId ? `/api/admin/broadcasts/media/${encodeURIComponent(message.imageMediaId)}` : null,
        action: message.action,
        variablePlanKey: message.variablePlanKey,
        createdAt: message.createdAt.toISOString(),
        updatedAt: message.updatedAt.toISOString(),
        archivedAt: message.archivedAt?.toISOString() || null,
        stats,
      })),
    });
  } catch (error) {
    logger.error({ err: error }, "broadcast list error");
    res.status(503).json({ status: "error", message: "تعذر تحميل الرسائل العامة حاليًا" });
  }
});

router.get("/broadcasts/media/:id", requireAuth, requireBroadcastAccess, async (req: BroadcastAuthRequest, res: Response) => {
  const id = String(req.params["id"] || "").trim();
  if (!/^broadcast-media-[a-zA-Z0-9_-]{8,100}$/.test(id)) { res.status(404).end(); return; }
  try {
    const media = await broadcastMediaById(id);
    if (!media) { res.status(404).end(); return; }
    const encoded = media.dataUrl.split(",", 2)[1];
    if (!encoded) { res.status(404).end(); return; }
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.type(media.mimeType).send(Buffer.from(encoded, "base64"));
  } catch (error) {
    logger.error({ err: error }, "broadcast admin media error");
    res.status(503).end();
  }
});

router.post("/broadcasts/media", requireAuth, requireWriteRate, requireBroadcastAccess, async (req: BroadcastAuthRequest, res: Response) => {
  try {
    const result = await createBroadcastMedia({ dataUrl: req.body?.dataUrl, employeeId: req.broadcastActorId!, now: new Date() });
    if (!result.media) { res.status(400).json({ status: "error", message: result.error || "الصورة غير صالحة." }); return; }
    await auditLog("create_broadcast_media", req.actor, `broadcast-media:${result.media.id}`, {
      mimeType: result.media.mimeType,
      sizeBytes: result.media.sizeBytes,
    }, req.ip);
    res.status(201).json({ status: "ok", media: { id: result.media.id, mimeType: result.media.mimeType, sizeBytes: result.media.sizeBytes, imageUrl: `/api/admin/broadcasts/media/${encodeURIComponent(result.media.id)}` } });
  } catch (error) {
    logger.error({ err: error }, "broadcast media upload error");
    res.status(503).json({ status: "error", message: "تعذر حفظ الصورة حاليًا" });
  }
});

router.post("/broadcasts/preview", requireAuth, requireBroadcastAccess, async (req: BroadcastAuthRequest, res: Response) => {
  const checked = parseBroadcastDraftRequest(req.body);
  if (!checked.value) { res.status(400).json({ status: "error", message: checked.error || "بيانات الرسالة غير صالحة." }); return; }
  try {
    const preview = await previewBroadcastDraft(checked.value, new Date());
    if (!preview.message) { res.status(400).json({ status: "error", message: preview.error || "تعذر إنشاء المعاينة." }); return; }
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.json({ status: "ok", preview: preview.message, imageDataUrl: preview.imageDataUrl || null, mode: "admin_only_no_delivery" });
  } catch (error) {
    logger.error({ err: error }, "broadcast preview error");
    res.status(503).json({ status: "error", message: "تعذر إنشاء المعاينة الحقيقية حاليًا" });
  }
});

router.post("/broadcasts", requireAuth, requireWriteRate, requireBroadcastAccess, async (req: BroadcastAuthRequest, res: Response) => {
  const checked = parseBroadcastDraftRequest(req.body);
  if (!checked.value) { res.status(400).json({ status: "error", message: checked.error || "بيانات الرسالة غير صالحة." }); return; }
  try {
    const result = await createBroadcast(checked.value, req.broadcastActorId!, new Date());
    if (!result.message) { res.status(400).json({ status: "error", message: result.error || "تعذر إنشاء الرسالة." }); return; }
    const message = result.message;
    await auditLog("create_broadcast", req.actor, `broadcast:${message.id}`, {
      messageType: message.messageType, audience: message.audience, priority: message.priority, status: message.status,
      startsAt: message.startsAt?.toISOString() || null, endsAt: message.endsAt?.toISOString() || null,
      hasImage: Boolean(message.imageMediaId), actionKind: message.action.kind, marketingEmailSent: false,
    }, req.ip);
    res.status(201).json({ status: "ok", message: { id: message.id } });
  } catch (error) {
    logger.error({ err: error }, "broadcast create error");
    res.status(503).json({ status: "error", message: "تعذر إنشاء الرسالة حاليًا" });
  }
});

router.put("/broadcasts/:id", requireAuth, requireWriteRate, requireBroadcastAccess, async (req: BroadcastAuthRequest, res: Response) => {
  const id = broadcastRouteId(req.params["id"]);
  if (!id) { res.status(404).json({ status: "error", message: "الرسالة غير موجودة." }); return; }
  const checked = parseBroadcastDraftRequest(req.body);
  if (!checked.value) { res.status(400).json({ status: "error", message: checked.error || "بيانات الرسالة غير صالحة." }); return; }
  try {
    const result = await updateBroadcast(id, checked.value, req.broadcastActorId!, new Date());
    if (!result.message) { res.status(404).json({ status: "error", message: result.error || "الرسالة غير موجودة." }); return; }
    const message = result.message;
    await auditLog("update_broadcast", req.actor, `broadcast:${message.id}`, {
      messageType: message.messageType, audience: message.audience, priority: message.priority, status: message.status,
      startsAt: message.startsAt?.toISOString() || null, endsAt: message.endsAt?.toISOString() || null,
      hasImage: Boolean(message.imageMediaId), actionKind: message.action.kind, marketingEmailSent: false,
    }, req.ip);
    res.json({ status: "ok", message: { id: message.id } });
  } catch (error) {
    logger.error({ err: error }, "broadcast update error");
    res.status(503).json({ status: "error", message: "تعذر تحديث الرسالة حاليًا" });
  }
});

router.post("/broadcasts/:id/pause", requireAuth, requireWriteRate, requireBroadcastAccess, async (req: BroadcastAuthRequest, res: Response) => {
  const id = broadcastRouteId(req.params["id"]);
  if (!id) { res.status(404).json({ status: "error", message: "الرسالة غير موجودة." }); return; }
  try {
    const message = await pauseBroadcast(id, req.broadcastActorId!, new Date());
    if (!message) { res.status(404).json({ status: "error", message: "الرسالة غير موجودة." }); return; }
    await auditLog("pause_broadcast", req.actor, `broadcast:${id}`, { previousSchedule: Boolean(message.startsAt || message.endsAt) }, req.ip);
    res.json({ status: "ok" });
  } catch (error) {
    logger.error({ err: error }, "broadcast pause error");
    res.status(503).json({ status: "error", message: "تعذر إيقاف الرسالة حاليًا" });
  }
});

router.post("/broadcasts/:id/archive", requireAuth, requireWriteRate, requireBroadcastAccess, async (req: BroadcastAuthRequest, res: Response) => {
  const id = broadcastRouteId(req.params["id"]);
  if (!id) { res.status(404).json({ status: "error", message: "الرسالة غير موجودة." }); return; }
  try {
    const message = await archiveBroadcast(id, req.broadcastActorId!, new Date());
    if (!message) { res.status(404).json({ status: "error", message: "الرسالة غير موجودة." }); return; }
    await auditLog("archive_broadcast", req.actor, `broadcast:${id}`, {}, req.ip);
    res.json({ status: "ok" });
  } catch (error) {
    logger.error({ err: error }, "broadcast archive error");
    res.status(503).json({ status: "error", message: "تعذر أرشفة الرسالة حاليًا" });
  }
});

router.post("/broadcasts/:id/duplicate", requireAuth, requireWriteRate, requireBroadcastAccess, async (req: BroadcastAuthRequest, res: Response) => {
  const id = broadcastRouteId(req.params["id"]);
  if (!id) { res.status(404).json({ status: "error", message: "الرسالة غير موجودة." }); return; }
  try {
    const copy = await duplicateBroadcast(id, req.broadcastActorId!, new Date());
    if (!copy) { res.status(404).json({ status: "error", message: "الرسالة غير موجودة." }); return; }
    await auditLog("duplicate_broadcast", req.actor, `broadcast:${copy.id}`, { sourceBroadcastId: id }, req.ip);
    res.status(201).json({ status: "ok", message: { id: copy.id } });
  } catch (error) {
    logger.error({ err: error }, "broadcast duplicate error");
    res.status(503).json({ status: "error", message: "تعذر تكرار الرسالة حاليًا" });
  }
});

/* A test is an audit-recorded private composer preview only — it never sends
 * an e-mail, marks a user as having seen a message, or expands the audience. */
router.post("/broadcasts/:id/test", requireAuth, requireWriteRate, requireBroadcastAccess, async (req: BroadcastAuthRequest, res: Response) => {
  const id = broadcastRouteId(req.params["id"]);
  if (!id) { res.status(404).json({ status: "error", message: "الرسالة غير موجودة." }); return; }
  try {
    const exists = await createBroadcastTestDelivery(id, req.broadcastActorId!, new Date());
    if (!exists) { res.status(404).json({ status: "error", message: "الرسالة غير موجودة." }); return; }
    await auditLog("test_broadcast_preview", req.actor, `broadcast:${id}`, { delivery: "admin_preview_only", emailSent: false }, req.ip);
    res.json({ status: "ok", delivery: "admin_preview_only", emailSent: false, message: "تم تسجيل تجربة خاصة بحساب المدير فقط؛ لم يُرسل بريد أو إشعار للمستخدمين." });
  } catch (error) {
    logger.error({ err: error }, "broadcast test preview error");
    res.status(503).json({ status: "error", message: "تعذر تسجيل التجربة حاليًا" });
  }
});

export default router;
