import { Router, type Request, type Response } from "express";
import crypto from "crypto";
import { and, eq, gt, isNull, ne } from "drizzle-orm";
import { appUsersTable, passwordResetsTable } from "@workspace/db/schema";
import { db } from "@workspace/db";
import {
  checkUserPassword,
  currentUser,
  hashUserPassword,
  normalizeUserPhone,
  signUserToken,
} from "../lib/userAuth";
import { isSmtpConfigured, resetEmailHtml, sendMail } from "../lib/mailer";
import { logger } from "../lib/logger";

const router = Router();

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/* Small in-memory limiter (same pattern as admin.ts) for the public
 * forgot-password endpoint — blocks mailbox/API flooding. */
const rlMap = new Map<string, { n: number; reset: number }>();
function rateLimitHit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const e = rlMap.get(key);
  if (!e || now > e.reset) {
    if (rlMap.size > 5000) for (const [k, v] of rlMap) if (now > v.reset) rlMap.delete(k);
    rlMap.set(key, { n: 1, reset: now + windowMs });
    return false;
  }
  e.n += 1;
  return e.n > max;
}

function publicUser(user: typeof appUsersTable.$inferSelect) {
  return {
    id: user.id,
    phone: user.phone,
    name: user.name,
    plan: user.plan === "vip" && user.vipExpiresAt && user.vipExpiresAt.getTime() <= Date.now() ? "free" : user.plan,
    vipExpiresAt: user.vipExpiresAt?.toISOString() || null,
  };
}

router.post("/register", async (req: Request, res: Response) => {
  const phone = normalizeUserPhone(req.body?.phone);
  const name = String(req.body?.name || "").trim().slice(0, 80);
  const password = String(req.body?.password || "");
  const email = String(req.body?.email || "").trim().toLowerCase();
  if (!/^01\d{9}$/.test(phone) || !name || password.length < 8) {
    res.status(400).json({ status: "error", message: "valid phone, name and password of at least 8 characters required" });
    return;
  }
  if (email && !EMAIL_RE.test(email)) {
    res.status(400).json({ status: "error", message: "invalid email" });
    return;
  }

  const existing = await db.select({ id: appUsersTable.id }).from(appUsersTable)
    .where(eq(appUsersTable.phone, phone)).limit(1);
  if (existing.length) {
    res.status(409).json({ status: "error", message: "phone already registered" });
    return;
  }
  if (email) {
    const [emailTaken] = await db.select({ id: appUsersTable.id }).from(appUsersTable)
      .where(eq(appUsersTable.email, email)).limit(1);
    if (emailTaken) {
      res.status(409).json({ status: "error", message: "email already registered" });
      return;
    }
  }

  const [user] = await db.insert(appUsersTable).values({
    phone,
    name,
    passwordHash: hashUserPassword(password),
    ...(email ? { email } : {}),
  }).returning();
  const token = signUserToken({ sub: user.id, phone: user.phone, name: user.name, role: "user", plan: user.plan });
  res.status(201).json({ status: "ok", token, user: publicUser(user) });
});

router.post("/login", async (req: Request, res: Response) => {
  const phone = normalizeUserPhone(req.body?.phone);
  const password = String(req.body?.password || "");
  if (!phone || !password) {
    res.status(400).json({ status: "error", message: "phone and password required" });
    return;
  }
  const [user] = await db.select().from(appUsersTable)
    .where(and(eq(appUsersTable.phone, phone), eq(appUsersTable.status, "active"))).limit(1);
  if (!user || !checkUserPassword(password, user.passwordHash)) {
    res.status(401).json({ status: "error", message: "invalid credentials" });
    return;
  }
  const normalized = publicUser(user);
  const token = signUserToken({
    sub: user.id,
    phone: user.phone,
    name: user.name,
    role: "user",
    plan: normalized.plan,
    ...(normalized.vipExpiresAt ? { vipExpiresAt: normalized.vipExpiresAt } : {}),
  });
  await db.update(appUsersTable).set({ updatedAt: new Date() }).where(eq(appUsersTable.id, user.id));
  res.json({ status: "ok", token, user: normalized });
});

router.get("/me", async (req: Request, res: Response) => {
  const claims = currentUser(req);
  if (!claims) {
    res.status(401).json({ status: "error", message: "login required" });
    return;
  }
  const [user] = await db.select().from(appUsersTable)
    .where(and(eq(appUsersTable.id, claims.sub), eq(appUsersTable.status, "active"))).limit(1);
  if (!user) {
    res.status(401).json({ status: "error", message: "user not found" });
    return;
  }
  res.json({ status: "ok", user: publicUser(user) });
});

router.put("/password", async (req: Request, res: Response) => {
  const claims = currentUser(req);
  const currentPassword = String(req.body?.currentPassword || "");
  const newPassword = String(req.body?.newPassword || "");
  if (!claims || !currentPassword || newPassword.length < 8) {
    res.status(400).json({ status: "error", message: "login required and new password must be at least 8 characters" });
    return;
  }
  const [user] = await db.select().from(appUsersTable)
    .where(and(eq(appUsersTable.id, claims.sub), eq(appUsersTable.status, "active"))).limit(1);
  if (!user || !checkUserPassword(currentPassword, user.passwordHash)) {
    res.status(401).json({ status: "error", message: "current password is incorrect" });
    return;
  }
  await db.update(appUsersTable).set({
    passwordHash: hashUserPassword(newPassword),
    updatedAt: new Date(),
  }).where(eq(appUsersTable.id, user.id));
  res.json({ status: "ok" });
});

/* ═══════════ PASSWORD RESET (email) ═══════════ */
/* POST /api/user/forgot-password { email }
 * Always answers ok (no account enumeration). Sends a single-use link
 * valid 30 minutes when the account has a verified-shape email on file;
 * without SMTP the flow answers ok but no email is delivered (the link is
 * only logged server-side for local testing). */
router.post("/forgot-password", async (req: Request, res: Response) => {
  const ip = req.ip || "unknown";
  const email0 = String(req.body?.email || "").trim().toLowerCase();
  // Shared-IP friendly (mobile carrier NAT is common in Egypt): a generous
  // per-IP ceiling plus a strict per-mailbox ceiling.
  if (rateLimitHit(`fp-ip:${ip}`, 20, 15 * 60 * 1000) || rateLimitHit(`fp-em:${email0}`, 3, 15 * 60 * 1000)) {
    res.status(429).json({ status: "error", message: "طلبات كثيرة — حاول بعد 15 دقيقة" });
    return;
  }
  const email = email0;
  if (!EMAIL_RE.test(email)) {
    res.status(400).json({ status: "error", message: "بريد إلكتروني غير صالح" });
    return;
  }
  let sent = false;
  try {
    const [user] = await db.select().from(appUsersTable)
      .where(and(eq(appUsersTable.email, email), eq(appUsersTable.status, "active"))).limit(1);
    if (user) {
      // Invalidate previous unused tokens for this user (single active link).
      await db.update(passwordResetsTable)
        .set({ usedAt: new Date() })
        .where(and(eq(passwordResetsTable.userId, user.id), isNull(passwordResetsTable.usedAt)));
      const raw = crypto.randomBytes(32).toString("hex");
      const tokenHash = crypto.createHash("sha256").update(raw).digest("hex");
      await db.insert(passwordResetsTable).values({
        userId: user.id,
        tokenHash,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      });
      const base = String(process.env["APP_BASE_URL"] || "http://localhost:3000").replace(/\/+$/, "");
      const link = `${base}/?reset=${raw}`;
      const r = await sendMail(email, "EgyTrend — إعادة تعيين كلمة المرور", resetEmailHtml(user.name, link));
      sent = r.delivered;
      // Without SMTP there is no delivery — log the link ONLY outside
      // production so local testing can complete the flow end-to-end.
      if (!sent && process.env.NODE_ENV !== "production") {
        logger.warn({ to: email, resetLink: link }, "DEV reset link (SMTP not configured)");
      }
    }
  } catch (e) {
    // Never leak DB failures as account hints — answer the same generic ok.
    req.log?.error?.({ err: e }, "forgot-password internal error");
  }
  res.json({
    status: "ok",
    message: isSmtpConfigured()
      ? "لو البريد مسجّل عندنا ستصل رسالة خلال دقائق — افحص صندوق الرسائل غير المرغوبة أيضًا"
      : "تم استلام الطلب — خدمة البريد غير مفعّلة حاليًا، تواصل مع الدعم على واتساب لإعادة تعيين كلمة المرور",
    emailDelivered: sent,
  });
});

/* POST /api/user/reset-password { token, password }
 * Single-use, hash-checked, expiring token → sets a new password. */
router.post("/reset-password", async (req: Request, res: Response) => {
  const ip = req.ip || "unknown";
  if (rateLimitHit(`rp:${ip}`, 30, 15 * 60 * 1000)) {
    res.status(429).json({ status: "error", message: "طلبات كثيرة — حاول بعد 15 دقيقة" });
    return;
  }
  const token = String(req.body?.token || "").trim();
  const password = String(req.body?.password || "");
  if (!token || password.length < 8) {
    res.status(400).json({ status: "error", message: "رمز غير صالح وكلمة المرور يجب أن تكون 8 أحرف على الأقل" });
    return;
  }
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const [row] = await db.select().from(passwordResetsTable)
    .where(and(eq(passwordResetsTable.tokenHash, tokenHash), isNull(passwordResetsTable.usedAt), gt(passwordResetsTable.expiresAt, new Date())))
    .limit(1);
  if (!row) {
    res.status(400).json({ status: "error", message: "الرابط منتهي أو مستخدم من قبل — اطلب رابطًا جديدًا" });
    return;
  }
  const [user] = await db.select().from(appUsersTable)
    .where(and(eq(appUsersTable.id, row.userId), eq(appUsersTable.status, "active"))).limit(1);
  if (!user) {
    res.status(400).json({ status: "error", message: "الحساب غير موجود أو موقوف" });
    return;
  }
  await db.update(appUsersTable).set({
    passwordHash: hashUserPassword(password),
    updatedAt: new Date(),
  }).where(eq(appUsersTable.id, user.id));
  await db.update(passwordResetsTable).set({ usedAt: new Date() }).where(eq(passwordResetsTable.id, row.id));
  res.json({ status: "ok", message: "تم تحديث كلمة المرور — يمكنك تسجيل الدخول الآن" });
});

/* GET /api/user/reset-status?token=...
 * Used by the reset screen to show "link valid / expired" before submitting. */
router.get("/reset-status", async (req: Request, res: Response) => {
  const token = String(req.query?.token || "").trim();
  if (!token) {
    res.status(400).json({ status: "error", message: "token required" });
    return;
  }
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const [row] = await db.select({ id: passwordResetsTable.id })
    .from(passwordResetsTable)
    .where(and(eq(passwordResetsTable.tokenHash, tokenHash), isNull(passwordResetsTable.usedAt), gt(passwordResetsTable.expiresAt, new Date())))
    .limit(1);
  res.json({ status: "ok", valid: Boolean(row) });
});

/* PUT /api/user/email — attach/change the recovery email (authenticated). */
router.put("/email", async (req: Request, res: Response) => {
  const claims = currentUser(req);
  if (!claims) {
    res.status(401).json({ status: "error", message: "login required" });
    return;
  }
  const email = String(req.body?.email || "").trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    res.status(400).json({ status: "error", message: "بريد إلكتروني غير صالح" });
    return;
  }
  // The email must not already belong to a different account.
  const [taken] = await db.select({ id: appUsersTable.id }).from(appUsersTable)
    .where(and(eq(appUsersTable.email, email), ne(appUsersTable.id, claims.sub))).limit(1);
  if (taken) {
    res.status(409).json({ status: "error", message: "هذا البريد مستخدم في حساب آخر" });
    return;
  }
  await db.update(appUsersTable).set({ email, updatedAt: new Date() }).where(eq(appUsersTable.id, claims.sub));
  res.json({ status: "ok", message: "تم حفظ البريد — يمكنك الآن استعادة كلمة المرور عبره" });
});

export default router;