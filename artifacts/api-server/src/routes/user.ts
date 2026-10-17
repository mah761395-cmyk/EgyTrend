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
  USER_SESSION_COOKIE,
  sessionCookieOptions,
  getVipEntitlement,
  type VipEntitlement,
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

function publicUser(user: typeof appUsersTable.$inferSelect, entitlement?: VipEntitlement) {
  /* A user-visible plan is a server-side entitlement view, not the stale JWT
   * or the transitional app_users projection. Registration is the sole call
   * without an entitlement and is necessarily a free account. */
  const activeVip = entitlement?.active === true;
  return {
    id: user.id,
    phone: user.phone,
    name: user.name,
    plan: activeVip ? "vip" : "free",
    vipExpiresAt: activeVip ? entitlement?.expiresAt?.toISOString() || null : null,
    /* Consent is account state from the server, never inferred from the email field. */
    marketingEmailOptIn: user.marketingEmailOptIn,
  };
}

function publicSubscription(entitlement: VipEntitlement) {
  return {
    active: entitlement.active,
    status: entitlement.status,
    planKey: entitlement.planKey,
    planNameAr: entitlement.planNameAr,
    planFeatures: entitlement.planFeatures,
    expiresAt: entitlement.expiresAt?.toISOString() || null,
    /** Clear lifecycle names for new clients; expiresAt remains backward compatible. */
    endsAt: entitlement.expiresAt?.toISOString() || null,
    graceEndsAt: entitlement.graceEndsAt?.toISOString() || null,
    renewalState: entitlement.status,
    /* Compatibility is visible to the account only as neutral state; the
     * browser still never determines authorization. */
    source: entitlement.source,
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
  res.cookie(USER_SESSION_COOKIE, token, sessionCookieOptions(7 * 24 * 60 * 60 * 1000));
  res.status(201).json({ status: "ok", user: publicUser(user) });
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
  const entitlement = await getVipEntitlement({ sub: user.id });
  const normalized = publicUser(user, entitlement);
  const token = signUserToken({
    sub: user.id,
    phone: user.phone,
    name: user.name,
    role: "user",
    plan: normalized.plan,
    ...(normalized.vipExpiresAt ? { vipExpiresAt: normalized.vipExpiresAt } : {}),
  });
  await db.update(appUsersTable).set({ updatedAt: new Date() }).where(eq(appUsersTable.id, user.id));
  res.cookie(USER_SESSION_COOKIE, token, sessionCookieOptions(7 * 24 * 60 * 60 * 1000));
  res.json({ status: "ok", user: normalized, subscription: publicSubscription(entitlement) });
});

router.post("/logout", (_req: Request, res: Response) => {
  res.clearCookie(USER_SESSION_COOKIE, sessionCookieOptions());
  res.status(204).end();
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
  const entitlement = await getVipEntitlement({ sub: user.id });
  res.json({ status: "ok", user: publicUser(user, entitlement), subscription: publicSubscription(entitlement) });
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
      // Do not log reset links, even in development: logs are routinely
      // exported and would turn a single-use credential into a leak. Local
      // testing can inspect the test mailbox or use a disposable SMTP sink.
      if (!sent && process.env.NODE_ENV !== "production") {
        logger.warn({ userId: user.id }, "password reset requested but SMTP is not configured");
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

/* Explicit account-level marketing consent. Supplying an email for password
 * recovery is deliberately not consent. This setting does not activate a mail
 * worker; broadcasts remain in-product until a separately approved sender is
 * built and can include unsubscribe links on every delivery. */
router.put("/marketing-email", async (req: Request, res: Response) => {
  const claims = currentUser(req);
  if (!claims) { res.status(401).json({ status: "error", message: "login required" }); return; }
  const optIn = req.body?.optIn === true;
  const confirmation = req.body?.confirmation === true;
  try {
    const [user] = await db.select({ id: appUsersTable.id, email: appUsersTable.email })
      .from(appUsersTable).where(and(eq(appUsersTable.id, claims.sub), eq(appUsersTable.status, "active"))).limit(1);
    if (!user) { res.status(401).json({ status: "error", message: "الحساب غير موجود" }); return; }
    if (optIn && (!user.email || !EMAIL_RE.test(user.email))) {
      res.status(400).json({ status: "error", message: "أضف بريدًا إلكترونيًا صالحًا قبل الموافقة على الرسائل التسويقية." });
      return;
    }
    if (optIn && !confirmation) {
      res.status(400).json({ status: "error", message: "يلزم تأكيد موافقتك الصريحة على الرسائل التسويقية." });
      return;
    }
    const now = new Date();
    await db.update(appUsersTable).set({
      marketingEmailOptIn: optIn,
      marketingEmailOptedInAt: optIn ? now : undefined,
      marketingEmailUnsubscribedAt: optIn ? null : now,
      updatedAt: now,
    }).where(eq(appUsersTable.id, user.id));
    res.json({
      status: "ok",
      marketingEmailOptIn: optIn,
      mailSendingEnabled: false,
      message: optIn
        ? "تم حفظ موافقتك. لا توجد حملة بريدية مفعّلة حاليًا."
        : "تم إلغاء اشتراكك من الرسائل التسويقية ولن نرسل حملات بريدية لهذا العنوان.",
    });
  } catch (error) {
    logger.error({ err: error }, "marketing consent update error");
    res.status(503).json({ status: "error", message: "تعذر حفظ تفضيلات البريد حاليًا" });
  }
});

/* Future campaign mail must link here with a short-lived HMAC token. The
 * broadcast implementation intentionally creates no campaign mail at all;
 * this endpoint exists now so unsubscribe is not bolted on afterward. */
/** For a future, separately approved sender only. The broadcast feature does
 * not call this and therefore cannot send campaign e-mail by accident. */
export function createMarketingUnsubscribeToken(userId: number, expiresAt = Date.now() + 90 * 24 * 60 * 60 * 1000): string | null {
  const secret = process.env["SESSION_SECRET"];
  if (!secret || !Number.isSafeInteger(userId) || userId <= 0 || !Number.isSafeInteger(expiresAt)) return null;
  const payload = `${userId}.${expiresAt}`;
  const signature = crypto.createHmac("sha256", secret).update(`marketing-unsubscribe:${payload}`).digest("hex");
  return `${payload}.${signature}`;
}

export function createMarketingUnsubscribeUrl(userId: number, appBaseUrl = process.env["APP_BASE_URL"]): string | null {
  const token = createMarketingUnsubscribeToken(userId);
  if (!token || !appBaseUrl) return null;
  try {
    const base = new URL(appBaseUrl);
    if (base.protocol !== "https:" || base.username || base.password) return null;
    return new URL(`/api/user/unsubscribe-marketing?token=${encodeURIComponent(token)}`, base).toString();
  } catch {
    return null;
  }
}

function validMarketingUnsubscribeToken(value: unknown): { userId: number } | null {
  const token = String(value || "").trim();
  const match = /^(\d{1,10})\.(\d{10,13})\.([a-f0-9]{64})$/i.exec(token);
  const secret = process.env["SESSION_SECRET"];
  if (!match || !secret) return null;
  const userId = Number(match[1]);
  const expiresAt = Number(match[2]);
  if (!Number.isSafeInteger(userId) || userId <= 0 || !Number.isFinite(expiresAt) || expiresAt < Date.now()) return null;
  const payload = `${userId}.${expiresAt}`;
  const expected = crypto.createHmac("sha256", secret).update(`marketing-unsubscribe:${payload}`).digest("hex");
  const supplied = Buffer.from(match[3]!, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  if (supplied.length !== expectedBuffer.length || !crypto.timingSafeEqual(supplied, expectedBuffer)) return null;
  return { userId };
}

router.get("/unsubscribe-marketing", async (req: Request, res: Response) => {
  const parsed = validMarketingUnsubscribeToken(req.query?.token);
  if (!parsed) {
    res.status(400).type("html").send("<p dir=\"rtl\">رابط إلغاء الاشتراك غير صالح أو منتهي.</p>");
    return;
  }
  try {
    await db.update(appUsersTable).set({
      marketingEmailOptIn: false,
      marketingEmailUnsubscribedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(appUsersTable.id, parsed.userId));
    res.setHeader("Cache-Control", "no-store");
    res.type("html").send("<p dir=\"rtl\">تم إلغاء اشتراكك من الرسائل التسويقية بنجاح.</p>");
  } catch (error) {
    logger.error({ err: error }, "marketing unsubscribe error");
    res.status(503).type("html").send("<p dir=\"rtl\">تعذر إتمام الطلب حاليًا. حاول لاحقًا.</p>");
  }
});

export default router;
