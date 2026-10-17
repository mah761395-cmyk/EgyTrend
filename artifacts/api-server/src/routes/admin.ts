import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { logger } from "../lib/logger";
import {
  ADMIN_SESSION_COOKIE,
  currentUser,
  readSessionCookie,
  sessionCookieOptions,
} from "../lib/userAuth";
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
  subscriptionLifecycleEventsTable, subscriptionRemindersSentTable,
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

const router: IRouter = Router();

/* ─── Secrets ─── */
const JWT_SECRET = process.env["SESSION_SECRET"];
const ADMIN_PASSWORD = process.env["ADMIN_PASSWORD"];
const LEGACY_TOKEN = process.env["ADMIN_TOKEN"] || "";

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
interface JWTPayload { sub: number; name: string; role: string; email: string; }

function signToken(payload: JWTPayload): string {
  if (!JWT_SECRET) throw new Error("SESSION_SECRET is not configured");
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "24h" });
}

const STAFF_ROLES = new Set(["super_admin", "admin", "editor", "analyst", "support", "marketing"]);

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

function verifyToken(token: string): JWTPayload | null {
  if (!JWT_SECRET) return null;
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (typeof decoded === "string") return null;
    // Reject non-staff tokens (e.g. app-user JWTs with role "user") so a
    // regular user token can never pass requireAuth on admin endpoints.
    const role = (decoded as { role?: unknown }).role;
    if (typeof role !== "string" || !STAFF_ROLES.has(role)) return null;
    return decoded as unknown as JWTPayload;
  }
  catch { return null; }
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
interface AuthRequest extends Request { actor?: JWTPayload; isLegacyAdmin?: boolean; }

function extractToken(req: Request): string {
  return readSessionCookie(req, ADMIN_SESSION_COOKIE)
    || (req.header("x-admin-token") || "").trim()
    || (req.header("authorization") || "").replace(/^Bearer\s+/i, "").trim();
}

function requireAuth(req: AuthRequest, res: Response, next: NextFunction): void {
  const token = extractToken(req);
  if (!token) { res.status(401).json({ status: "error", message: "unauthorized" }); return; }

  // Legacy static token (backward compat for mobile admin flow)
  if (LEGACY_TOKEN && token === LEGACY_TOKEN) {
    req.isLegacyAdmin = true;
    req.actor = { sub: 0, name: "Super Admin", role: "super_admin", email: "admin@egytrend" };
    next(); return;
  }

  // JWT token
  const payload = verifyToken(token);
  if (!payload) { res.status(401).json({ status: "error", message: "invalid or expired token" }); return; }
  req.actor = payload;
  next();
}

function requireRole(...roles: string[]) {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (req.isLegacyAdmin) { next(); return; }
    if (!req.actor || !roles.includes(req.actor.role)) {
      res.status(403).json({ status: "error", message: "insufficient permissions" });
      return;
    }
    next();
  };
}

/* Subscription pricing is intentionally narrower than generic dashboard
 * access. A super admin is allowed; every other employee needs this explicit
 * server-checked permission in their current staff row, not in a browser/JWT. */
const PRICING_MANAGE_PERMISSION = "pricing.manage";
async function requirePricingAccess(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  if (req.isLegacyAdmin) { next(); return; }
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

/* Legacy password login → returns static token */
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

  // Check if this matches an employee email/password (new JWT flow)
  const email = String((req.body || {}).email || "");
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
      await db.update(employeesTable).set({ lastLogin: new Date() }).where(eq(employeesTable.id, emp.id));
      const token = signToken({ sub: emp.id, name: emp.name, role: emp.role, email: emp.email });
      await auditLog("login", { sub: emp.id, name: emp.name, role: emp.role, email: emp.email }, `staff:${emp.id}`, {}, req.ip);
      res.cookie(ADMIN_SESSION_COOKIE, token, sessionCookieOptions(24 * 60 * 60 * 1000));
      res.json({ status: "ok", employee: { id: emp.id, name: emp.name, role: emp.role, email: emp.email } });
      return;
    }
    recordLoginFailure(ip);
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
    res.status(401).json({ status: "error", message: "invalid password" });
    return;
  }
  clearLoginFailures(ip);
  const token = LEGACY_TOKEN || signToken({
    sub: 0,
    name: "Super Admin",
    role: "super_admin",
    email: "admin@egytrend",
  });
  res.cookie(ADMIN_SESSION_COOKIE, token, sessionCookieOptions(24 * 60 * 60 * 1000));
  res.json({ status: "ok", employee: { id: 0, name: "Super Admin", role: "super_admin", email: "admin@egytrend" } });
});

router.post("/logout", (_req: Request, res: Response) => {
  res.clearCookie(ADMIN_SESSION_COOKIE, sessionCookieOptions());
  res.status(204).end();
});

router.get("/session", requireAuth, (req: AuthRequest, res: Response) => {
  const actor = req.actor;
  res.json({
    status: "ok",
    employee: actor ? { id: actor.sub, name: actor.name, role: actor.role, email: actor.email } : null,
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
      permissions: Array.isArray(permissions) ? permissions : [],
      status: "active",
    }).returning({ id: employeesTable.id, name: employeesTable.name, email: employeesTable.email, role: employeesTable.role });
    await auditLog("create_employee", req.actor, `staff:${emp.id}`, { role: emp.role }, req.ip);
    res.json({ status: "ok", employee: emp });
  } catch (e: unknown) {
    const msg = String(e);
    if (msg.includes("unique")) { res.status(409).json({ status: "error", message: "email already exists" }); return; }
    logger.error({ err: e }, "employee create error");
    res.status(500).json({ status: "error", message: "server error" });
  }
});

router.put("/employees/:id", requireAuth, requireWriteRate, requireRole("super_admin", "admin"), async (req: AuthRequest, res: Response) => {
  const id = Number(req.params["id"]);
  const { name, role, status, permissions, password } = req.body || {};
  if (isNaN(id)) { res.status(400).json({ status: "error", message: "invalid id" }); return; }
  if (role && !EMPLOYEE_ROLES.has(role)) {
    res.status(400).json({ status: "error", message: "invalid role" });
    return;
  }
  if (["super_admin", "admin"].includes(role) && req.actor?.role !== "super_admin") {
    res.status(403).json({ status: "error", message: "only super_admin can set admin roles" });
    return;
  }
  if (Array.isArray(permissions) && permissions.includes(PRICING_MANAGE_PERMISSION) && req.actor?.role !== "super_admin") {
    res.status(403).json({ status: "error", message: "only super_admin can grant pricing permission" });
    return;
  }
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (name) updates["name"] = String(name).slice(0, 100);
  if (role) updates["role"] = String(role);
  if (status) updates["status"] = String(status);
  if (permissions) updates["permissions"] = permissions;
  if (password) {
    if (String(password).length < 8) { res.status(400).json({ status: "error", message: "password min 8 chars" }); return; }
    updates["passwordHash"] = hashPassword(String(password));
  }
  await db.update(employeesTable).set(updates as any).where(eq(employeesTable.id, id));
  await auditLog("update_employee", req.actor, `staff:${id}`, { role, status, passwordChanged: Boolean(password) }, req.ip);
  res.json({ status: "ok" });
});

router.delete("/employees/:id", requireAuth, requireWriteRate, requireRole("super_admin"), async (req: AuthRequest, res: Response) => {
  const id = Number(req.params["id"]);
  if (isNaN(id)) { res.status(400).json({ status: "error", message: "invalid id" }); return; }
  if (id === req.actor?.sub) { res.status(400).json({ status: "error", message: "cannot delete yourself" }); return; }
  await db.delete(employeesTable).where(eq(employeesTable.id, id));
  await auditLog("delete_employee", req.actor, String(id), {}, req.ip);
  res.json({ status: "ok" });
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
    const msg = String(e);
    if (msg.includes("unique")) { res.status(409).json({ status: "error", message: "plan key already exists" }); return; }
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
    const msg = String(e);
    if (msg.includes("unique")) { res.status(409).json({ status: "error", message: "coupon code already exists" }); return; }
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
  if (isNaN(id)) { res.status(400).json({ status: "error", message: "invalid id" }); return; }
  await db.delete(couponsTable).where(eq(couponsTable.id, id));
  await auditLog("delete_coupon", req.actor, String(id), {}, req.ip);
  res.json({ status: "ok" });
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
    if (statusFilter && ["pending", "approved", "rejected", "expired"].includes(statusFilter)) {
      rows = await db.select({
        id: paymentRequestsTable.id, phone: paymentRequestsTable.phone, name: paymentRequestsTable.name,
        planKey: paymentRequestsTable.planKey, payMethod: paymentRequestsTable.payMethod,
        price: paymentRequestsTable.price, priceSnapshot: paymentRequestsTable.priceSnapshot, priceLockedUntil: paymentRequestsTable.priceLockedUntil,
        tx: paymentRequestsTable.tx, status: paymentRequestsTable.status,
        notes: paymentRequestsTable.notes, proofImage: paymentRequestsTable.proofImage,
        proofName: paymentRequestsTable.proofName, createdAt: paymentRequestsTable.createdAt,
      }).from(paymentRequestsTable).where(eq(paymentRequestsTable.status, statusFilter)).orderBy(desc(paymentRequestsTable.createdAt)).limit(300);
    } else {
      rows = await db.select({
        id: paymentRequestsTable.id, phone: paymentRequestsTable.phone, name: paymentRequestsTable.name,
        planKey: paymentRequestsTable.planKey, payMethod: paymentRequestsTable.payMethod,
        price: paymentRequestsTable.price, priceSnapshot: paymentRequestsTable.priceSnapshot, priceLockedUntil: paymentRequestsTable.priceLockedUntil,
        tx: paymentRequestsTable.tx, status: paymentRequestsTable.status,
        notes: paymentRequestsTable.notes, proofImage: paymentRequestsTable.proofImage,
        proofName: paymentRequestsTable.proofName, createdAt: paymentRequestsTable.createdAt,
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
      : null;
  const decisionNotes = stripHtml(String(req.body?.notes || "").trim()).slice(0, 200) || null;
  if (!requestedStatus) {
    res.status(400).json({ status: "error", message: "status must be approved|rejected" });
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
        /* A rejected request can be re-reviewed and approved after corrected
         * proof; an approved request can never be downgraded by this path. */
        if (requestedStatus === "rejected" && existing.status === "approved") {
          throw new PaymentDecisionError(409, "الطلب مقبول بالفعل ولا يمكن رفضه");
        }
        if (requestedStatus === existing.status) {
          return { already: true as const, existing, planNameAr: existing.planKey };
        }
      }

      let planNameAr = existing.planKey;
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
        const [currentSubscription] = await tx.select({
          id: userSubscriptionsTable.id,
          cycleId: userSubscriptionsTable.cycleId,
          startsAt: userSubscriptionsTable.startsAt,
          expiresAt: userSubscriptionsTable.expiresAt,
          status: userSubscriptionsTable.status,
        }).from(userSubscriptionsTable).where(eq(userSubscriptionsTable.userId, user.id)).limit(1);

        planNameAr = activationPlan.nameAr;
        /* A paid renewal before the term ends stacks from the current expiry.
         * A post-expiry (including grace-period) approval starts from approval
         * time, as required; monthly arithmetic is exactly 30 elapsed days. */
        const extendsCurrentTerm = currentSubscription?.status === "active" && currentSubscription.expiresAt > now;
        const extendsLegacyProjection = !currentSubscription && user.plan === "vip" && user.vipExpiresAt && user.vipExpiresAt > now;
        const existingExpiry = extendsCurrentTerm
          ? currentSubscription.expiresAt
          : extendsLegacyProjection
            ? user.vipExpiresAt!
            : now;
        const expires = calculateApprovedSubscriptionEnd(existingExpiry, activationPlan.durationMonths);
        const startsAt = extendsCurrentTerm ? currentSubscription.startsAt : now;
        const subscriptionId = currentSubscription?.id || `sub-${user.id}`;
        const cycleId = createSubscriptionCycleId(user.id, existing.id);
        const graceEndsAt = calculateSubscriptionGraceEnd(expires, lifecycleSettings.graceDays);
        const isRenewal = Boolean(currentSubscription || extendsLegacyProjection);

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
        await tx.insert(subscriptionLifecycleEventsTable).values({
          id: `subevent-${existing.id}`,
          userId: user.id,
          subscriptionId,
          subscriptionCycleId: cycleId,
          eventType: isRenewal ? "renewed" : "activated",
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
      return { already: false as const, existing, planNameAr };
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

    /* Notifications are best-effort only; entitlement and payment status were
     * already committed together in the transaction above. */
    try {
      const notifId = `un-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      await db.insert(userNotificationsTable).values({
        id: notifId,
        phone: outcome.existing.phone,
        kind: requestedStatus === "approved" ? "payment_approved" : "payment_rejected",
        title: requestedStatus === "approved" ? "🎉 تم تفعيل اشتراك VIP" : "تحديث بخصوص طلب الدفع",
        body:
          requestedStatus === "approved"
            ? `تم تأكيد دفعتك (${outcome.planNameAr}) بالقيمة المثبتة ${outcome.existing.price} جنيه وتفعيل اشتراك VIP بنجاح.`
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

export default router;
