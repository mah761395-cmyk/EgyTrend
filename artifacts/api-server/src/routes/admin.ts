import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import fs from "node:fs";
import path from "node:path";
import { logger } from "../lib/logger";
import { adminToken, currentUser } from "../lib/userAuth";
import { ADMIN_COOKIE, ONE_DAY_MS, clearSessionCookie, setSessionCookie } from "../lib/security";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import {
  listSources, upsertSource, deleteSource,
  listCustomArticles, upsertCustomArticle, deleteCustomArticle,
  type SourceMeta, type CustomArticle,
} from "../lib/dataStore";import { db } from "@workspace/db";
import {
  employeesTable, subscriptionPlansTable, couponsTable,
  auditLogsTable, aiConfigTable, aiUsageTable, paymentRequestsTable, appUsersTable, userNotificationsTable,
  appSettingsTable,
} from "@workspace/db";
import { eq, desc, and, gte, lte, like, or, sql } from "drizzle-orm";
import {
  checkEmployeePermission,
  normalizePermissions,
  effectivePermissions,
  type AdminPermission,
} from "../lib/adminPerms";

const router: IRouter = Router();

/* ─── Secrets ───
 * NOTE (security audit): the legacy static `ADMIN_TOKEN` was removed. It was a
 * non-expiring shared string that (a) authenticated as super_admin on EVERY
 * admin endpoint and (b) made `requireRole` skip all role checks, so a single
 * leaked value — or a value committed to git — was a permanent full takeover.
 * Sessions are now short-lived signed JWTs delivered in an httpOnly cookie. */
const JWT_SECRET = process.env["SESSION_SECRET"];
const ADMIN_PASSWORD = process.env["ADMIN_PASSWORD"];

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

/* ─── Auth middleware ───
 * A staff session is proven ONLY by a signed JWT carrying a staff role, read
 * from the httpOnly `et_admin` cookie (header fallback for non-browser
 * tooling). There is no static/backdoor token any more. */
interface AuthRequest extends Request { actor?: JWTPayload; }

function extractToken(req: Request): string {
  return adminToken(req);
}

function requireAuth(req: AuthRequest, res: Response, next: NextFunction): void {
  const token = extractToken(req);
  if (!token) { res.status(401).json({ status: "error", message: "unauthorized" }); return; }

  // Signed JWT with a staff role — anything else is rejected.
  const payload = verifyToken(token);
  if (!payload) { res.status(401).json({ status: "error", message: "invalid or expired token" }); return; }
  req.actor = payload;
  next();
}

/* Role gate. Every admin route must chain this after requireAuth; the actor is
 * always a verified staff JWT (no bypass path exists any more). */
function requireRole(...roles: string[]) {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (!req.actor || !roles.includes(req.actor.role)) {
      logger.warn(
        { actor: req.actor?.email, role: req.actor?.role, need: roles, path: req.path },
        "admin role check denied",
      );
      res.status(403).json({ status: "error", message: "insufficient permissions" });
      return;
    }
    next();
  };
}

/* Fine-grained employee permissions. See lib/adminPerms for the full contract.
 * The list is read from the employee row on every request so a revocation
 * takes effect immediately (the JWT only carries the role). super_admin is
 * never restricted. A failed lookup responds 503. */
function requirePermission(permission: AdminPermission) {
  return async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
    const actor = req.actor;
    if (!actor) {
      res.status(401).json({ status: "error", message: "unauthorized" });
      return;
    }
    if (actor.role === "super_admin") {
      next();
      return;
    }
    const decision = await checkEmployeePermission(actor, permission);
    if (decision === "denied") {
      logger.warn({ actor: actor.email, role: actor.role, need: permission, path: req.path }, "employee permission denied");
      res.status(403).json({ status: "error", message: `missing permission: ${permission}` });
      return;
    }
    if (decision === "error") {
      logger.error({ actor: actor.email }, "permission check unavailable");
      res.status(503).json({ status: "error", message: "permission check unavailable" });
      return;
    }
    next();
  };
}

/* ─── Audit log helper ─── */
async function auditLog(
  action: string, actor: JWTPayload | undefined, target: string | undefined,
  detail: Record<string, unknown>, ip?: string,
): Promise<void> {
  try {
    await db.insert(auditLogsTable).values({
      action, actorId: actor?.sub ?? null, actorName: actor?.name ?? "unknown",
      actorRole: actor?.role ?? "unknown", target: target ?? null,
      detail, ip: ip ?? null,
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

/* Editorial configuration (the full source list and every custom article) —
 * admin-managed content, so it now requires a staff session. The public UI
 * reads the source pills from the unauthenticated /api/news/sources instead. */
router.get("/bootstrap", requireAuth, (_req, res: Response) => {
  res.setHeader("Cache-Control", "no-store");
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
      await auditLog("login", { sub: emp.id, name: emp.name, role: emp.role, email: emp.email }, "employee", { email }, req.ip);
      /* The session now travels in an httpOnly cookie only — no token is put
       * in the response body, so nothing can be parked in localStorage. */
      setSessionCookie(res, ADMIN_COOKIE, token, ONE_DAY_MS);
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
  const token = signToken({
    sub: 0,
    name: "Super Admin",
    role: "super_admin",
    email: "admin@egytrend",
  });
  await auditLog("login", { sub: 0, name: "Super Admin", role: "super_admin", email: "admin@egytrend" }, "password", {}, req.ip);
  setSessionCookie(res, ADMIN_COOKIE, token, ONE_DAY_MS);
  res.json({ status: "ok", employee: { id: 0, name: "Super Admin", role: "super_admin", email: "admin@egytrend" } });
});

/* ── Admin panel asset — server-gated ────────────────────────────────────
 * The panel used to ship inside the public HTML, so any visitor could read the
 * complete admin interface (users/payments/subscriptions/coupons/employees/
 * audit screens). It now lives in a separate file that is only ever sent to a
 * request carrying a verified staff session cookie. */
function adminPanelSources(): string[] {
  const here = typeof __dirname !== "undefined" ? __dirname : path.dirname(new URL(import.meta.url).pathname);
  return [
    path.resolve(here, "admin-panel.js"), // build output (dist/admin-panel.js)
    path.resolve(here, "../assets/admin-panel.js"), // local dev / source tree
  ];
}

let panelCache: string | null = null;
function readAdminPanel(): string | null {
  if (panelCache !== null) return panelCache;
  for (const candidate of adminPanelSources()) {
    try {
      panelCache = fs.readFileSync(candidate, "utf8");
      return panelCache;
    } catch {
      /* try the next candidate */
    }
  }
  logger.error({ tried: adminPanelSources() }, "admin panel asset not found");
  return null;
}

router.get("/panel.js", requireAuth, (_req: Request, res: Response) => {
  const src = readAdminPanel();
  if (!src) {
    res.status(503).type("text/plain").send("admin panel asset unavailable");
    return;
  }
  /* no-store: the asset is role-gated, so it must never sit in a shared cache */
  res.setHeader("Cache-Control", "no-store, private");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.type("application/javascript").send(src);
});

/* Session probe: the admin panel calls this before showing any UI, so the
 * admin interface is only ever revealed to a server-verified staff session. */
router.get("/me", requireAuth, async (req: AuthRequest, res: Response) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({
    status: "ok",
    actor: {
      id: req.actor?.sub ?? null,
      name: req.actor?.name ?? "",
      email: req.actor?.email ?? "",
      role: req.actor?.role ?? "",
    },
    /* Effective permission list: super_admin never restricted; staff see the
     * list stored on their employee row, or the empty list when the role
     * alone already decides (no narrowing). A lookup failure answers null so
     * the UI keeps working (the server still 403s on any sensitive read). */
    permissions: await effectivePermissions(req.actor),
  });
});

/* Explicit logout: clears the httpOnly session cookie server-side, so a
 * logged-out admin cannot be replayed from any client storage. */
router.post("/logout", (_req: Request, res: Response) => {
  clearSessionCookie(res, ADMIN_COOKIE);
  res.setHeader("Cache-Control", "no-store");
  res.json({ status: "ok" });
});

/* AI feature flags — staff only. Nothing in the public bundle calls this
 * (the AI route itself reads the config server-side), so requiring a session
 * removes a free probe of the platform's internal switches. */
router.get("/ai-status", requireAuth, async (_req, res: Response) => {
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
      userId: String(req.actor?.email || req.actor?.name || "staff"),
      requestType: String(requestType || "unknown").slice(0, 40),
      tokensEstimate: Math.max(0, Math.min(1_000_000, Number(tokensEstimate) || 0)),
    });
    res.json({ status: "ok" });
  } catch (e) {
    res.status(500).json({ status: "error", message: String(e) });
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
    res.status(500).json({ status: "error", message: String(e) });
  }
});

/* ─── Sources (existing, enhanced) ─── */
router.get("/sources", requireAuth, requirePermission("content"), (_req, res: Response) => {
  res.json({ status: "ok", sources: listSources() });
});

router.post("/sources", requireAuth, requireWriteRate, requireRole("super_admin", "admin", "editor"), requirePermission("content"), async (req: AuthRequest, res: Response) => {
  const v = validateSource(req.body);
  if ("error" in v) { res.status(400).json({ status: "error", message: v.error }); return; }
  await upsertSource(v);
  await auditLog("upsert_source", req.actor, v.id, { name: v.name }, req.ip);
  logger.info({ id: v.id }, "admin: source upserted");
  res.json({ status: "ok", source: v });
});

router.delete("/sources/:id", requireAuth, requireWriteRate, requireRole("super_admin", "admin"), requirePermission("content"), async (req: AuthRequest, res: Response) => {
  const id = String(req.params["id"] || "");
  const ok = await deleteSource(id);
  if (!ok) { res.status(404).json({ status: "error", message: "not found" }); return; }
  await auditLog("delete_source", req.actor, id, {}, req.ip);
  logger.info({ id }, "admin: source deleted");
  res.json({ status: "ok" });
});

/* ─── Articles (enhanced with audit) ─── */
router.get("/articles", requireAuth, requirePermission("content"), (_req, res: Response) => {
  res.json({ status: "ok", articles: listCustomArticles() });
});

router.post("/articles", requireAuth, requireWriteRate, requireRole("super_admin", "admin", "editor"), requirePermission("content"), async (req: AuthRequest, res: Response) => {
  const v = validateArticle(req.body);
  if ("error" in v) { res.status(400).json({ status: "error", message: v.error }); return; }
  await upsertCustomArticle(v);
  await auditLog("upsert_article", req.actor, v.id, { title: v.title.slice(0, 60), scheduled: v.pubDate }, req.ip);
  logger.info({ id: v.id }, "admin: article upserted");
  res.json({ status: "ok", article: v });
});

router.delete("/articles/:id", requireAuth, requireWriteRate, requireRole("super_admin", "admin", "editor"), requirePermission("content"), async (req: AuthRequest, res: Response) => {
  const id = String(req.params["id"] || "");
  const ok = await deleteCustomArticle(id);
  if (!ok) { res.status(404).json({ status: "error", message: "not found" }); return; }
  await auditLog("delete_article", req.actor, id, {}, req.ip);
  logger.info({ id }, "admin: article deleted");
  res.json({ status: "ok" });
});

/* ─── Employees ─── */
router.get("/employees", requireAuth, requireRole("super_admin", "admin"), requirePermission("employees"), async (_req, res: Response) => {
  const employees = await db.select({
    id: employeesTable.id, name: employeesTable.name, email: employeesTable.email,
    role: employeesTable.role, status: employeesTable.status,
    permissions: employeesTable.permissions, lastLogin: employeesTable.lastLogin,
    createdAt: employeesTable.createdAt,
  }).from(employeesTable).orderBy(desc(employeesTable.createdAt));
  res.json({ status: "ok", employees });
});

router.post("/employees", requireAuth, requireWriteRate, requireRole("super_admin", "admin"), requirePermission("employees"), async (req: AuthRequest, res: Response) => {
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
  // Only super_admin can create super_admin/admin
  if (["super_admin", "admin"].includes(role) && req.actor?.role !== "super_admin") {
    res.status(403).json({ status: "error", message: "only super_admin can create admin roles" });
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
    await auditLog("create_employee", req.actor, String(email), { name, role }, req.ip);
    res.json({ status: "ok", employee: emp });
  } catch (e: unknown) {
    const msg = String(e);
    if (msg.includes("unique")) { res.status(409).json({ status: "error", message: "email already exists" }); return; }
    res.status(500).json({ status: "error", message: msg });
  }
});

router.put("/employees/:id", requireAuth, requireWriteRate, requireRole("super_admin", "admin"), requirePermission("employees"), async (req: AuthRequest, res: Response) => {
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
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (name) updates["name"] = String(name).slice(0, 100);
  if (role) updates["role"] = String(role);
  if (status) updates["status"] = String(status);
  if (permissions !== undefined) updates["permissions"] = normalizePermissions(permissions);
  if (password) {
    if (String(password).length < 8) { res.status(400).json({ status: "error", message: "password min 8 chars" }); return; }
    updates["passwordHash"] = hashPassword(String(password));
  }
  await db.update(employeesTable).set(updates as any).where(eq(employeesTable.id, id));
  await auditLog("update_employee", req.actor, String(id), { name, role, status }, req.ip);
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

/* ─── Subscription Plans ─── */
router.get("/plans", requireAuth, requirePermission("plans"), async (_req, res: Response) => {
  const plans = await db.select().from(subscriptionPlansTable).orderBy(subscriptionPlansTable.price);
  res.json({ status: "ok", plans });
});

router.post("/plans", requireAuth, requireWriteRate, requireRole("super_admin", "admin"), requirePermission("plans"), async (req: AuthRequest, res: Response) => {
  const { key, nameAr, price, durationMonths, features, badge } = req.body || {};
  if (!key || !nameAr || price === undefined || !durationMonths) {
    res.status(400).json({ status: "error", message: "key, nameAr, price, durationMonths required" });
    return;
  }
  if (!ID_RX.test(String(key))) { res.status(400).json({ status: "error", message: "key must be alphanumeric" }); return; }
  try {
    const [plan] = await db.insert(subscriptionPlansTable).values({
      key: String(key).toLowerCase(),
      nameAr: String(nameAr).slice(0, 100),
      price: Math.max(0, Number(price)),
      durationMonths: Math.max(1, Number(durationMonths)),
      features: Array.isArray(features) ? features : [],
      isActive: true,
      badge: badge ? String(badge).slice(0, 50) : null,
    }).returning();
    await auditLog("create_plan", req.actor, String(key), { nameAr, price }, req.ip);
    res.json({ status: "ok", plan });
  } catch (e: unknown) {
    const msg = String(e);
    if (msg.includes("unique")) { res.status(409).json({ status: "error", message: "plan key already exists" }); return; }
    res.status(500).json({ status: "error", message: msg });
  }
});

router.put("/plans/:id", requireAuth, requireWriteRate, requireRole("super_admin", "admin"), requirePermission("plans"), async (req: AuthRequest, res: Response) => {
  const id = Number(req.params["id"]);
  if (isNaN(id)) { res.status(400).json({ status: "error", message: "invalid id" }); return; }
  const { nameAr, price, durationMonths, features, isActive, badge } = req.body || {};
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (nameAr !== undefined) updates["nameAr"] = String(nameAr).slice(0, 100);
  if (price !== undefined) updates["price"] = Math.max(0, Number(price));
  if (durationMonths !== undefined) updates["durationMonths"] = Math.max(1, Number(durationMonths));
  if (features !== undefined) updates["features"] = Array.isArray(features) ? features : [];
  if (isActive !== undefined) updates["isActive"] = Boolean(isActive);
  if (badge !== undefined) updates["badge"] = badge ? String(badge).slice(0, 50) : null;
  await db.update(subscriptionPlansTable).set(updates as any).where(eq(subscriptionPlansTable.id, id));
  await auditLog("update_plan", req.actor, String(id), { nameAr, price, isActive }, req.ip);
  res.json({ status: "ok" });
});

router.delete("/plans/:id", requireAuth, requireWriteRate, requireRole("super_admin", "admin"), requirePermission("plans"), async (req: AuthRequest, res: Response) => {
  const id = Number(req.params["id"]);
  if (isNaN(id)) { res.status(400).json({ status: "error", message: "invalid id" }); return; }
  await db.delete(subscriptionPlansTable).where(eq(subscriptionPlansTable.id, id));
  await auditLog("delete_plan", req.actor, String(id), {}, req.ip);
  res.json({ status: "ok" });
});

/* ─── Coupons ─── */
router.get("/coupons", requireAuth, requireRole("super_admin", "admin", "marketing"), requirePermission("coupons"), async (_req, res: Response) => {
  const coupons = await db.select().from(couponsTable).orderBy(desc(couponsTable.createdAt));
  res.json({ status: "ok", coupons });
});

router.post("/coupons", requireAuth, requireWriteRate, requireRole("super_admin", "admin", "marketing"), requirePermission("coupons"), async (req: AuthRequest, res: Response) => {
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
    res.status(500).json({ status: "error", message: msg });
  }
});

router.put("/coupons/:id", requireAuth, requireWriteRate, requireRole("super_admin", "admin", "marketing"), requirePermission("coupons"), async (req: AuthRequest, res: Response) => {
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

router.delete("/coupons/:id", requireAuth, requireWriteRate, requireRole("super_admin", "admin"), requirePermission("coupons"), async (req: AuthRequest, res: Response) => {
  const id = Number(req.params["id"]);
  if (isNaN(id)) { res.status(400).json({ status: "error", message: "invalid id" }); return; }
  await db.delete(couponsTable).where(eq(couponsTable.id, id));
  await auditLog("delete_coupon", req.actor, String(id), {}, req.ip);
  res.json({ status: "ok" });
});

/* Public: validate coupon code */
/* Coupon lookup. Was open to the internet with no limit, so coupon codes
 * could be enumerated by brute force. It now needs a session (the subscribe
 * flow is always post-login) AND is rate limited per IP. */
router.post("/coupons/validate", requireAuth, async (req: AuthRequest, res: Response) => {
  const { code } = req.body || {};
  if (!code) { res.status(400).json({ status: "error", message: "code required" }); return; }
  if (!rateLimitHit(`coupon:${req.ip || "unknown"}`, 20, 15 * 60 * 1000)) {
    res.setHeader("Retry-After", "900");
    res.status(429).json({ status: "error", message: "too many coupon attempts — try again later" });
    return;
  }
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
router.get("/ai-config", requireAuth, requirePermission("ai"), async (_req, res: Response) => {
  await ensureAiConfig();
  const [cfg] = await db.select().from(aiConfigTable).limit(1);
  res.json({ status: "ok", config: cfg });
});

router.put("/ai-config", requireAuth, requireWriteRate, requireRole("super_admin", "admin"), requirePermission("ai"), async (req: AuthRequest, res: Response) => {
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

router.get("/ai-usage", requireAuth, requireRole("super_admin", "admin", "analyst"), requirePermission("ai"), async (req: Request, res: Response) => {
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
router.get("/audit-logs", requireAuth, requireRole("super_admin", "admin"), requirePermission("audit"), async (req: Request, res: Response) => {
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
router.get("/users", requireAuth, requireRole("super_admin", "admin", "support"), requirePermission("users"), async (req: Request, res: Response) => {
  const users = await db.select({
    id: appUsersTable.id,
    phone: appUsersTable.phone,
    name: appUsersTable.name,
    plan: appUsersTable.plan,
    vipExpiresAt: appUsersTable.vipExpiresAt,
    status: appUsersTable.status,
    createdAt: appUsersTable.createdAt,
  }).from(appUsersTable).orderBy(desc(appUsersTable.createdAt)).limit(1000);
  res.json({ status: "ok", users });
});

router.post("/users/action", requireAuth, requireWriteRate, requireRole("super_admin", "admin", "support"), requirePermission("users"), async (req: AuthRequest, res: Response) => {
  const { action, phone, name, reason } = req.body || {};
  const validActions = ["ban_user", "unban_user", "upgrade_vip", "downgrade_vip"];
  if (!validActions.includes(String(action))) {
    res.status(400).json({ status: "error", message: "action must be: " + validActions.join(", ") });
    return;
  }
  if (!phone) { res.status(400).json({ status: "error", message: "phone required" }); return; }
  const [user] = await db.select().from(appUsersTable).where(eq(appUsersTable.phone, String(phone))).limit(1);
  if (!user) { res.status(404).json({ status: "error", message: "user not found" }); return; }
  const updates: Partial<typeof appUsersTable.$inferInsert> = { updatedAt: new Date() };
  if (action === "upgrade_vip") {
    const expires = new Date();
    expires.setMonth(expires.getMonth() + 1);
    updates.plan = "vip";
    updates.vipExpiresAt = expires;
  } else if (action === "downgrade_vip") {
    updates.plan = "free";
    updates.vipExpiresAt = null;
  } else if (action === "ban_user") {
    updates.status = "banned";
  } else if (action === "unban_user") {
    updates.status = "active";
  }
  await db.update(appUsersTable).set(updates).where(eq(appUsersTable.id, user.id));
  await auditLog(String(action), req.actor, String(phone), { name: name || phone, reason: reason || "" }, req.ip);
  res.json({ status: "ok", action, phone });
});

/* ══════════════════════════════════════════════
   PAYMENT REQUESTS (subscription sign-ups)
══════════════════════════════════════════════ */

/* Public: any logged-in user can submit a payment request */
router.post("/requests", async (req: Request, res: Response) => {
  const user = currentUser(req);
  if (!user) {
    res.status(401).json({ status: "error", message: "login required" });
    return;
  }
  const b = req.body || {};
  const id = `req-${Date.now()}-${crypto.randomBytes(5).toString("hex")}`;
  const phone    = String(b.phone    || "").trim().slice(0, 30);
  const name     = stripHtml(String(b.name    || "").trim()).slice(0, 80);
  const planKey  = String(b.planKey  || "").trim().replace(/[^a-z0-9_\-]/gi, "").slice(0, 30);
  const payMethod= String(b.payMethod|| "").trim().slice(0, 30);
  const price    = Math.max(0, Number(b.price) || 0);
  const tx       = stripHtml(String(b.tx || "").trim()).slice(0, 100);

  if (!phone || !name || !planKey || !tx) {
    res.status(400).json({ status: "error", message: "phone, name, planKey, tx required" });
    return;
  }
  if (!/^01[0-9]{9}$/.test(phone.replace(/\s/g, ""))) {
    res.status(400).json({ status: "error", message: "رقم الهاتف غير صحيح — يجب أن يبدأ بـ 01 ويكون 11 رقماً" });
    return;
  }
  if (phone !== user.phone) {
    res.status(403).json({ status: "error", message: "phone does not match authenticated user" });
    return;
  }

  const [plan] = await db.select({
    key: subscriptionPlansTable.key,
    price: subscriptionPlansTable.price,
    isActive: subscriptionPlansTable.isActive,
  }).from(subscriptionPlansTable)
    .where(and(eq(subscriptionPlansTable.key, planKey), eq(subscriptionPlansTable.isActive, true)))
    .limit(1);
  if (!plan) {
    res.status(400).json({ status: "error", message: "invalid or inactive plan" });
    return;
  }
  if (price !== plan.price) {
    res.status(400).json({ status: "error", message: "plan price mismatch" });
    return;
  }

  // Rate limit: max 3 requests per phone per 10 minutes
  if (checkPayRateLimit(phone) === "limited") {
    res.status(429).json({ status: "error", message: "تم إرسال طلبات كثيرة — يرجى الانتظار 10 دقائق" });
    return;
  }

  try {
    await db.insert(paymentRequestsTable).values({ id, phone, name, planKey, payMethod, price, tx, status: "pending" });
    logger.info({ phone, planKey }, "payment request submitted");
    res.json({ status: "ok", id });
  } catch (e) {
    logger.error({ err: e }, "payment request create error");
    res.status(500).json({ status: "error", message: "server error" });
  }
});

/* Protected: list all payment requests */
router.get("/requests", requireAuth, requireRole("super_admin", "admin", "support"), requirePermission("payments"), async (req: AuthRequest, res: Response) => {
  try {
    const statusFilter = String(req.query["status"] || "").trim();
    let rows;
    if (statusFilter && ["pending", "approved", "rejected"].includes(statusFilter)) {
      rows = await db.select({
        id: paymentRequestsTable.id, phone: paymentRequestsTable.phone, name: paymentRequestsTable.name,
        planKey: paymentRequestsTable.planKey, payMethod: paymentRequestsTable.payMethod,
        price: paymentRequestsTable.price, tx: paymentRequestsTable.tx, status: paymentRequestsTable.status,
        notes: paymentRequestsTable.notes, proofImage: paymentRequestsTable.proofImage,
        proofName: paymentRequestsTable.proofName, createdAt: paymentRequestsTable.createdAt,
      }).from(paymentRequestsTable).where(eq(paymentRequestsTable.status, statusFilter)).orderBy(desc(paymentRequestsTable.createdAt)).limit(300);
    } else {
      rows = await db.select({
        id: paymentRequestsTable.id, phone: paymentRequestsTable.phone, name: paymentRequestsTable.name,
        planKey: paymentRequestsTable.planKey, payMethod: paymentRequestsTable.payMethod,
        price: paymentRequestsTable.price, tx: paymentRequestsTable.tx, status: paymentRequestsTable.status,
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
    res.status(500).json({ status: "error", message: String(e) });
  }
});

/* Protected: approve or reject a request */
router.put("/requests/:id", requireAuth, requireWriteRate, requireRole("super_admin", "admin"), requirePermission("payments"), async (req: AuthRequest, res: Response) => {
  const id = String(req.params["id"] || "").trim();
  const { status, notes } = req.body || {};
  if (!["approved", "rejected"].includes(String(status))) {
    res.status(400).json({ status: "error", message: "status must be approved|rejected" });
    return;
  }
  try {
    const [existing] = await db.select().from(paymentRequestsTable).where(eq(paymentRequestsTable.id, id));
    if (!existing) { res.status(404).json({ status: "error", message: "request not found" }); return; }
    if (existing.status !== "pending") {
      /* Already decided — keep the endpoint idempotent-safe and re-armable:
       * a rejected request CAN be approved later (user fixed the proof),
       * an approved one cannot be un-approved through this path. */
      if (status === "rejected" && existing.status === "approved") {
        res.status(409).json({ status: "error", message: "الطلب مقبول بالفعل ولا يمكن رفضه" });
        return;
      }
      if (status === existing.status) {
        res.json({ status: "ok", already: true });
        return;
      }
    }
    await db.update(paymentRequestsTable)
      .set({ status: String(status), notes: notes ? String(notes).slice(0, 200) : null, updatedAt: new Date(), decidedAt: new Date() })
      .where(eq(paymentRequestsTable.id, id));
    if (status === "approved") {
      const [plan] = await db.select({
        durationMonths: subscriptionPlansTable.durationMonths,
      }).from(subscriptionPlansTable)
        .where(and(eq(subscriptionPlansTable.key, existing.planKey), eq(subscriptionPlansTable.isActive, true)))
        .limit(1);
      const [user] = await db.select({ id: appUsersTable.id, plan: appUsersTable.plan, vipExpiresAt: appUsersTable.vipExpiresAt }).from(appUsersTable)
        .where(eq(appUsersTable.phone, existing.phone)).limit(1);
      if (plan && user) {
        /* Stack on an existing active VIP instead of restarting it. */
        const base = user.plan === "vip" && user.vipExpiresAt && new Date(user.vipExpiresAt) > new Date()
          ? new Date(user.vipExpiresAt)
          : new Date();
        const expires = new Date(base);
        expires.setMonth(expires.getMonth() + plan.durationMonths);
        await db.update(appUsersTable).set({
          plan: "vip",
          vipExpiresAt: expires,
          updatedAt: new Date(),
        }).where(eq(appUsersTable.id, user.id));
      }
    }
    /* In-platform notification so the user learns the decision without asking support. */
    try {
      let planNameAr = existing.planKey;
      try {
        const [p] = await db.select({ nameAr: subscriptionPlansTable.nameAr }).from(subscriptionPlansTable)
          .where(eq(subscriptionPlansTable.key, existing.planKey)).limit(1);
        if (p?.nameAr) planNameAr = p.nameAr;
      } catch { /* keep key */ }
      const notifId = `un-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      await db.insert(userNotificationsTable).values({
        id: notifId,
        phone: existing.phone,
        kind: status === "approved" ? "payment_approved" : "payment_rejected",
        title: status === "approved" ? "🎉 تم تفعيل اشتراك VIP" : "تحديث بخصوص طلب الدفع",
        body:
          status === "approved"
            ? `تم تأكيد دفعتك (${planNameAr}) وتفعيل اشتراك VIP بنجاح. مبروك!`
            : notes
              ? `تم رفض طلب الدفع. السبب: ${String(notes).slice(0, 150)}`
              : "تم رفض طلب الدفع. يمكنك إعادة الطلب بعد تصحيح بيانات التحويل.",
      });
    } catch (ne) {
      logger.error({ err: ne }, "user notification insert failed (non-fatal)");
    }
    await auditLog(`request_${status}`, req.actor, existing.phone, { id, planKey: existing.planKey, tx: existing.tx }, req.ip);
    res.json({ status: "ok" });
  } catch (e) {
    logger.error({ err: e }, "payment request update error");
    res.status(500).json({ status: "error", message: String(e) });
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
router.get("/settings/payment", requireAuth, requireRole("super_admin", "admin", "support"), requirePermission("settings"), async (_req, res: Response) => {
  try {
    const rows = await db.select().from(appSettingsTable);
    const out: Record<string, string> = {};
    for (const k of PAYMENT_SETTING_KEYS) {
      const r = rows.find((x) => x.key === k);
      out[k] = r?.value ?? (k === "payment_vodafone_number" ? "01008605139" : "");
    }
    res.json({ status: "ok", settings: out, methods: PAY_METHODS });
  } catch (e) {
    res.status(500).json({ status: "error", message: String(e) });
  }
});

/* Update payment settings (super_admin/admin). */
router.put("/settings/payment", requireAuth, requireWriteRate, requireRole("super_admin", "admin"), requirePermission("settings"), async (req: AuthRequest, res: Response) => {
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
    await auditLog("update_payment_settings", req.actor, "payment", Object.fromEntries(updates), req.ip);
    res.json({ status: "ok" });
  } catch (e) {
    logger.error({ err: e }, "payment settings update error");
    res.status(500).json({ status: "error", message: String(e) });
  }
});

/* ════════════════════════════════════════════
   USER NOTIFICATIONS (in-platform)
   Users poll /api/user/notifications (payments.ts). Decisions made here
   (approve/reject) insert a row; polling surfaces it with the bell badge.
════════════════════════════════════════════ */
router.get("/user-notifications", requireAuth, requireRole("super_admin", "admin", "support"), requirePermission("payments"), async (req: AuthRequest, res: Response) => {
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
    res.status(500).json({ status: "error", message: String(e) });
  }
});

export default router;
