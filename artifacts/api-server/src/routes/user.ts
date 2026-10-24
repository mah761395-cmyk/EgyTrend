import { Router, type Request, type Response } from "express";
import crypto from "crypto";
import { and, eq, gt, isNull, ne } from "drizzle-orm";
import { appUsersTable, passwordResetsTable } from "@workspace/db/schema";
import { db } from "@workspace/db";
import {
  bearerToken,
  checkUserPassword,
  currentUser,
  hashUserPassword,
  normalizeUserPhone,
  signUserToken,
} from "../lib/userAuth";
import { SESSION_COOKIE, SEVEN_DAYS_MS, clearSessionCookie, setSessionCookie } from "../lib/security";
import {
  checkRegisterAllowed,
  clearRegisterAttempts,
  evaluateLogin,
  phoneBucket,
  recordRegisterAttempt,
} from "../lib/user-login";
import { LIMITS, getAttemptStore } from "../lib/rate-limit";
import { revokeAllSessions, revokePresentedSession } from "../lib/session-revocation";
import { isSmtpConfigured, resetEmailHtml, sendMail } from "../lib/mailer";
import { logger } from "../lib/logger";

const router = Router();

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/* Attempt counters live in the shared store (Postgres when configured), so the
 * limits hold across Vercel instances instead of multiplying per instance. */
function tooMany(retryAfterSec: number, res: Response): void {
  res.setHeader("Retry-After", String(retryAfterSec));
  res.setHeader("Cache-Control", "no-store");
  res.status(429).json({
    status: "error",
    message: "محاولات كثيرة — حاول مرة أخرى بعد قليل",
    retryAfter: retryAfterSec,
  });
}

type PublicUserInput = {
  id: number;
  phone: string;
  name: string;
  plan: string;
  vipExpiresAt: Date | null;
};

function publicUser(user: PublicUserInput) {
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

  /* Account creation is capped per IP and per phone: a script cannot mint
   * accounts in bulk, and replayed requests cannot bypass the count. */
  const store = getAttemptStore();
  const ip = req.ip || "unknown";
  const gate = await checkRegisterAllowed({ phone, ip }, store);
  if (!gate.allowed) {
    tooMany(gate.retryAfterSec, res);
    return;
  }
  await recordRegisterAttempt({ phone, ip }, store);

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
  await clearRegisterAttempts({ phone, ip }, store);
  const token = signUserToken({ sub: user.id, phone: user.phone, name: user.name, role: "user", plan: user.plan });
  /* httpOnly cookie only — the SPA never stores a credential any more. */
  setSessionCookie(res, SESSION_COOKIE, token, SEVEN_DAYS_MS);
  res.setHeader("Cache-Control", "no-store");
  res.status(201).json({ status: "ok", user: publicUser(user) });
});

router.post("/login", async (req: Request, res: Response) => {
  const ip = req.ip || "unknown";
  /* Limits are checked before any password work, so a blocked caller cannot
   * spend CPU on scrypt and cannot slip extra guesses through by replaying. */
  const outcome = await evaluateLogin(
    { phone: req.body?.phone, password: req.body?.password, ip },
    {
      store: getAttemptStore(),
      findUser: async (phone) => {
        const [user] = await db.select().from(appUsersTable)
          .where(and(eq(appUsersTable.phone, phone), eq(appUsersTable.status, "active"))).limit(1);
        return user ?? null;
      },
    },
  );

  if (outcome.kind === "limited") {
    tooMany(outcome.retryAfterSec, res);
    return;
  }
  if (outcome.kind === "invalid") {
    res.setHeader("Cache-Control", "no-store");
    res.status(outcome.status).json({ status: "error", message: outcome.message });
    return;
  }

  const user = outcome.user;
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
  setSessionCookie(res, SESSION_COOKIE, token, SEVEN_DAYS_MS);
  res.setHeader("Cache-Control", "no-store");
  res.json({ status: "ok", user: normalized });
});

/* Explicit logout: revoke this session server-side, then clear the cookie.
 * Clearing the cookie alone would leave any copy of the token valid. */
router.post("/logout", async (req: Request, res: Response) => {
  await revokePresentedSession("user", bearerToken(req));
  clearSessionCookie(res, SESSION_COOKIE);
  res.setHeader("Cache-Control", "no-store");
  res.json({ status: "ok" });
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
  /* Changing the password ends every other session (a stolen token dies here).
   * This device gets a fresh session whose `iat` is strictly after the
   * revocation, so the revocation never eats the session it just replaced. */
  const revokedAt = Date.now();
  await revokeAllSessions("user", user.id);
  const fresh = signUserToken(
    {
      sub: user.id,
      phone: user.phone,
      name: user.name,
      role: "user",
      plan: publicUser(user).plan,
    },
    { issuedAfterMs: revokedAt },
  );
  setSessionCookie(res, SESSION_COOKIE, fresh, SEVEN_DAYS_MS);
  res.setHeader("Cache-Control", "no-store");
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
  // per-IP ceiling plus a strict per-mailbox ceiling, both counted in the
  // shared store so multiple instances cannot multiply them.
  const store = getAttemptStore();
  const byIp = await store.hit(`fp-ip:${ip}`, LIMITS.forgotIp.limit, LIMITS.forgotIp.windowMs);
  const byMail = await store.hit(
    `fp-em:${email0}`,
    LIMITS.forgotEmail.limit,
    LIMITS.forgotEmail.windowMs,
  );
  if (byIp.blocked || byMail.blocked) {
    res.setHeader("Retry-After", String(Math.max(byIp.retryAfterSec, byMail.retryAfterSec, 1)));
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
  const rpState = await getAttemptStore().hit(`rp:${ip}`, 30, 15 * 60 * 1000);
  if (rpState.blocked) {
    res.setHeader("Retry-After", String(rpState.retryAfterSec));
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
  /* A reset means the account may have been compromised: every old session
   * dies, and the login counter is cleared so the owner can sign in again. */
  await revokeAllSessions("user", user.id);
  await getAttemptStore().clear(phoneBucket(user.phone));
  res.setHeader("Cache-Control", "no-store");
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