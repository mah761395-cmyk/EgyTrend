import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { logger } from "../lib/logger";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import {
  listSources, upsertSource, deleteSource,
  listCustomArticles, upsertCustomArticle, deleteCustomArticle,
  type SourceMeta, type CustomArticle,
} from "../lib/dataStore";
import { db } from "@workspace/db";
import {
  employeesTable, subscriptionPlansTable, couponsTable,
  auditLogsTable, aiConfigTable, aiUsageTable, paymentRequestsTable,
} from "@workspace/db";
import { eq, desc, and, gte, lte, like, or, sql } from "drizzle-orm";

const router: IRouter = Router();

/* ─── Secrets ─── */
const JWT_SECRET = process.env["SESSION_SECRET"] || "egytrend-secret-2026";
const ADMIN_PASSWORD = process.env["ADMIN_PASSWORD"] || "egytrend2026";
const LEGACY_TOKEN = process.env["ADMIN_TOKEN"] || process.env["SESSION_SECRET"] || "";

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
const payReqMap = new Map<string, number[]>();
const PAY_REQ_MAX    = 3;
const PAY_REQ_WINDOW = 10 * 60 * 1000; // 10 min

function checkPayRateLimit(phone: string): "ok" | "limited" {
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
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "24h" });
}

function verifyToken(token: string): JWTPayload | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (typeof decoded === "string") return null;
    return decoded as unknown as JWTPayload;
  }
  catch { return null; }
}

/* ─── Password helpers ─── */
function hashPassword(pw: string): string {
  return crypto.createHash("sha256").update(pw + JWT_SECRET).digest("hex");
}
function checkPassword(pw: string, hash: string): boolean {
  return hashPassword(pw) === hash;
}

/* ─── Auth middleware ─── */
interface AuthRequest extends Request { actor?: JWTPayload; isLegacyAdmin?: boolean; }

function extractToken(req: Request): string {
  return (req.header("x-admin-token") || "").trim()
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

/* ─── Audit log helper ─── */
async function auditLog(
  action: string, actor: JWTPayload | undefined, target: string | undefined,
  detail: Record<string, unknown>, ip?: string,
): Promise<void> {
  try {
    await db.insert(auditLogsTable).values({
      action, actorId: actor?.sub ?? null, actorName: actor?.name ?? "Legacy Admin",
      actorRole: actor?.role ?? "super_admin", target: target ?? null,
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

  // Check if this matches an employee email/password (new JWT flow)
  const email = String((req.body || {}).email || "");
  if (email) {
    const employees = await db.select().from(employeesTable).where(eq(employeesTable.email, email)).limit(1);
    if (employees.length && checkPassword(password, employees[0].passwordHash)) {
      const emp = employees[0];
      if (emp.status !== "active") {
        res.status(403).json({ status: "error", message: "account disabled" });
        return;
      }
      clearLoginFailures(ip);
      await db.update(employeesTable).set({ lastLogin: new Date() }).where(eq(employeesTable.id, emp.id));
      const token = signToken({ sub: emp.id, name: emp.name, role: emp.role, email: emp.email });
      await auditLog("login", { sub: emp.id, name: emp.name, role: emp.role, email: emp.email }, "employee", { email }, req.ip);
      res.json({ status: "ok", token, employee: { id: emp.id, name: emp.name, role: emp.role, email: emp.email } });
      return;
    }
    recordLoginFailure(ip);
    res.status(401).json({ status: "error", message: "invalid credentials" });
    return;
  }

  // Legacy password-only login
  if (password !== ADMIN_PASSWORD) {
    recordLoginFailure(ip);
    res.status(401).json({ status: "error", message: "invalid password" });
    return;
  }
  clearLoginFailures(ip);
  if (!LEGACY_TOKEN) {
    res.status(503).json({ status: "error", message: "ADMIN_TOKEN not configured on server" });
    return;
  }
  res.json({ status: "ok", token: LEGACY_TOKEN });
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

/* Log AI usage (called by AI routes) */
router.post("/ai-usage/log", async (req: Request, res: Response) => {
  try {
    const { userId, requestType, tokensEstimate } = req.body || {};
    await db.insert(aiUsageTable).values({
      userId: String(userId || "anonymous"),
      requestType: String(requestType || "unknown"),
      tokensEstimate: Number(tokensEstimate || 0),
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
router.get("/sources", requireAuth, (_req, res: Response) => {
  res.json({ status: "ok", sources: listSources() });
});

router.post("/sources", requireAuth, requireRole("super_admin", "admin", "editor"), async (req: AuthRequest, res: Response) => {
  const v = validateSource(req.body);
  if ("error" in v) { res.status(400).json({ status: "error", message: v.error }); return; }
  await upsertSource(v);
  await auditLog("upsert_source", req.actor, v.id, { name: v.name }, req.ip);
  logger.info({ id: v.id }, "admin: source upserted");
  res.json({ status: "ok", source: v });
});

router.delete("/sources/:id", requireAuth, requireRole("super_admin", "admin"), async (req: AuthRequest, res: Response) => {
  const id = String(req.params["id"] || "");
  const ok = await deleteSource(id);
  if (!ok) { res.status(404).json({ status: "error", message: "not found" }); return; }
  await auditLog("delete_source", req.actor, id, {}, req.ip);
  logger.info({ id }, "admin: source deleted");
  res.json({ status: "ok" });
});

/* ─── Articles (enhanced with audit) ─── */
router.get("/articles", requireAuth, (_req, res: Response) => {
  res.json({ status: "ok", articles: listCustomArticles() });
});

router.post("/articles", requireAuth, requireRole("super_admin", "admin", "editor"), async (req: AuthRequest, res: Response) => {
  const v = validateArticle(req.body);
  if ("error" in v) { res.status(400).json({ status: "error", message: v.error }); return; }
  await upsertCustomArticle(v);
  await auditLog("upsert_article", req.actor, v.id, { title: v.title.slice(0, 60), scheduled: v.pubDate }, req.ip);
  logger.info({ id: v.id }, "admin: article upserted");
  res.json({ status: "ok", article: v });
});

router.delete("/articles/:id", requireAuth, requireRole("super_admin", "admin", "editor"), async (req: AuthRequest, res: Response) => {
  const id = String(req.params["id"] || "");
  const ok = await deleteCustomArticle(id);
  if (!ok) { res.status(404).json({ status: "error", message: "not found" }); return; }
  await auditLog("delete_article", req.actor, id, {}, req.ip);
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

router.post("/employees", requireAuth, requireRole("super_admin", "admin"), async (req: AuthRequest, res: Response) => {
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
      permissions: Array.isArray(permissions) ? permissions : [],
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

router.put("/employees/:id", requireAuth, requireRole("super_admin", "admin"), async (req: AuthRequest, res: Response) => {
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
  if (permissions) updates["permissions"] = permissions;
  if (password) {
    if (String(password).length < 8) { res.status(400).json({ status: "error", message: "password min 8 chars" }); return; }
    updates["passwordHash"] = hashPassword(String(password));
  }
  await db.update(employeesTable).set(updates as any).where(eq(employeesTable.id, id));
  await auditLog("update_employee", req.actor, String(id), { name, role, status }, req.ip);
  res.json({ status: "ok" });
});

router.delete("/employees/:id", requireAuth, requireRole("super_admin"), async (req: AuthRequest, res: Response) => {
  const id = Number(req.params["id"]);
  if (isNaN(id)) { res.status(400).json({ status: "error", message: "invalid id" }); return; }
  if (id === req.actor?.sub) { res.status(400).json({ status: "error", message: "cannot delete yourself" }); return; }
  await db.delete(employeesTable).where(eq(employeesTable.id, id));
  await auditLog("delete_employee", req.actor, String(id), {}, req.ip);
  res.json({ status: "ok" });
});

/* ─── Subscription Plans ─── */
router.get("/plans", requireAuth, async (_req, res: Response) => {
  const plans = await db.select().from(subscriptionPlansTable).orderBy(subscriptionPlansTable.price);
  res.json({ status: "ok", plans });
});

router.post("/plans", requireAuth, requireRole("super_admin", "admin"), async (req: AuthRequest, res: Response) => {
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

router.put("/plans/:id", requireAuth, requireRole("super_admin", "admin"), async (req: AuthRequest, res: Response) => {
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

router.delete("/plans/:id", requireAuth, requireRole("super_admin", "admin"), async (req: AuthRequest, res: Response) => {
  const id = Number(req.params["id"]);
  if (isNaN(id)) { res.status(400).json({ status: "error", message: "invalid id" }); return; }
  await db.delete(subscriptionPlansTable).where(eq(subscriptionPlansTable.id, id));
  await auditLog("delete_plan", req.actor, String(id), {}, req.ip);
  res.json({ status: "ok" });
});

/* ─── Coupons ─── */
router.get("/coupons", requireAuth, requireRole("super_admin", "admin", "marketing"), async (_req, res: Response) => {
  const coupons = await db.select().from(couponsTable).orderBy(desc(couponsTable.createdAt));
  res.json({ status: "ok", coupons });
});

router.post("/coupons", requireAuth, requireRole("super_admin", "admin", "marketing"), async (req: AuthRequest, res: Response) => {
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

router.put("/coupons/:id", requireAuth, requireRole("super_admin", "admin", "marketing"), async (req: AuthRequest, res: Response) => {
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

router.delete("/coupons/:id", requireAuth, requireRole("super_admin", "admin"), async (req: AuthRequest, res: Response) => {
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

router.put("/ai-config", requireAuth, requireRole("super_admin", "admin"), async (req: AuthRequest, res: Response) => {
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
router.get("/users", requireAuth, requireRole("super_admin", "admin", "support"), async (req: Request, res: Response) => {
  // Users are stored client-side; this endpoint returns a lookup of server-side user states
  const states = await db.execute(sql`
    SELECT target as phone, detail, created_at
    FROM audit_logs
    WHERE action IN ('ban_user', 'unban_user', 'upgrade_vip', 'downgrade_vip')
    ORDER BY created_at DESC
  `);
  res.json({ status: "ok", userEvents: states.rows });
});

router.post("/users/action", requireAuth, requireRole("super_admin", "admin", "support"), async (req: AuthRequest, res: Response) => {
  const { action, phone, name, reason } = req.body || {};
  const validActions = ["ban_user", "unban_user", "upgrade_vip", "downgrade_vip"];
  if (!validActions.includes(String(action))) {
    res.status(400).json({ status: "error", message: "action must be: " + validActions.join(", ") });
    return;
  }
  if (!phone) { res.status(400).json({ status: "error", message: "phone required" }); return; }
  await auditLog(String(action), req.actor, String(phone), { name: name || phone, reason: reason || "" }, req.ip);
  res.json({ status: "ok", action, phone });
});

/* ══════════════════════════════════════════════
   PAYMENT REQUESTS (subscription sign-ups)
══════════════════════════════════════════════ */

/* Public: any logged-in user can submit a payment request */
router.post("/requests", async (req: Request, res: Response) => {
  const b = req.body || {};
  const id = String(b.id || `req-${Date.now()}`).trim().slice(0, 60);
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

  // Rate limit: max 3 requests per phone per 10 minutes
  if (checkPayRateLimit(phone) === "limited") {
    res.status(429).json({ status: "error", message: "تم إرسال طلبات كثيرة — يرجى الانتظار 10 دقائق" });
    return;
  }

  try {
    await db.insert(paymentRequestsTable).values({ id, phone, name, planKey, payMethod, price, tx, status: "pending" })
      .onConflictDoUpdate({ target: paymentRequestsTable.id, set: { phone, name, planKey, payMethod, price, tx, status: "pending", updatedAt: new Date() } });
    logger.info({ phone, planKey }, "payment request submitted");
    res.json({ status: "ok", id });
  } catch (e) {
    logger.error({ err: e }, "payment request create error");
    res.status(500).json({ status: "error", message: "server error" });
  }
});

/* Protected: list all payment requests */
router.get("/requests", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const statusFilter = String(req.query["status"] || "").trim();
    let rows;
    if (statusFilter && ["pending", "approved", "rejected"].includes(statusFilter)) {
      rows = await db.select().from(paymentRequestsTable).where(eq(paymentRequestsTable.status, statusFilter)).orderBy(desc(paymentRequestsTable.createdAt)).limit(300);
    } else {
      rows = await db.select().from(paymentRequestsTable).orderBy(desc(paymentRequestsTable.createdAt)).limit(300);
    }
    res.json({ status: "ok", requests: rows });
  } catch (e) {
    res.status(500).json({ status: "error", message: String(e) });
  }
});

/* Protected: approve or reject a request */
router.put("/requests/:id", requireAuth, async (req: AuthRequest, res: Response) => {
  const id = String(req.params["id"] || "").trim();
  const { status, notes } = req.body || {};
  if (!["approved", "rejected"].includes(String(status))) {
    res.status(400).json({ status: "error", message: "status must be approved|rejected" });
    return;
  }
  try {
    const [existing] = await db.select().from(paymentRequestsTable).where(eq(paymentRequestsTable.id, id));
    if (!existing) { res.status(404).json({ status: "error", message: "request not found" }); return; }
    await db.update(paymentRequestsTable)
      .set({ status: String(status), notes: notes ? String(notes).slice(0, 200) : null, updatedAt: new Date() })
      .where(eq(paymentRequestsTable.id, id));
    await auditLog(`request_${status}`, req.actor, existing.phone, { id, planKey: existing.planKey, tx: existing.tx }, req.ip);
    res.json({ status: "ok" });
  } catch (e) {
    logger.error({ err: e }, "payment request update error");
    res.status(500).json({ status: "error", message: String(e) });
  }
});

export default router;
