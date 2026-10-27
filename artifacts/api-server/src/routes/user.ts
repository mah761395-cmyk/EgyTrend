import { Router, type Request, type Response } from "express";
import crypto from "crypto";
import { and, eq, gt, isNull, ne } from "drizzle-orm";
import { appUsersTable, emailVerificationTokensTable, passwordResetsTable } from "@workspace/db/schema";
import { db } from "@workspace/db";
import {
  bearerToken,
  checkUserPassword,
  currentUser,
  hashUserPassword,
  normalizeUserPhone,
  readSessionCookie,
  signUserToken,
  USER_SESSION_COOKIE,
  sessionCookieOptions,
  getVipEntitlement,
  type VipEntitlement,
} from "../lib/userAuth";
import { escapeHtml, isSmtpConfigured, resetEmailHtml, sendMail } from "../lib/mailer";
import {
  canonicalTrialEmail,
  freeTrialAccountStatus,
  isDisposableTrialEmail,
  listFreeTrialMessages,
  recordFreeTrialMessageEvent,
  startFreeTrial,
} from "../lib/free-trials";
import { readFreeTrialSettings } from "../lib/trial-settings";
import { onboardingState, recordOnboardingEvent, resetOnboardingTour, setOnboardingTourAction, type OnboardingEvent, type OnboardingTourAction, type OnboardingTourKind } from "../lib/onboarding";
import { validMarketingUnsubscribeToken } from "../lib/marketing-email";
import { logger } from "../lib/logger";
import { isDuplicateKeyError } from "../lib/dbErrors";
import { LIMITS, getAttemptStore } from "../lib/rate-limit";
import {
  checkRegisterAllowed,
  clearRegisterAttempts,
  evaluateLogin,
  phoneBucket,
  recordRegisterAttempt,
} from "../lib/user-login";
import { revokeAllSessions, revokePresentedSession } from "../lib/session-revocation";
import {
  attachReferralAtRegistration,
  decodeReferralCookie,
  deliverReferralMessage,
  publicReferralDashboard,
  recordReferralEvent,
} from "../lib/referrals";

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
    email: user.email || null,
    emailVerified: Boolean(user.emailVerifiedAt),
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
    subscriptionType: entitlement.subscriptionType,
    trialFeatureScope: entitlement.trialFeatureScope,
    trialAiDailyLimit: entitlement.trialAiDailyLimit,
    trialStartedAt: entitlement.trialStartedAt?.toISOString() || null,
    trialEndsAt: entitlement.trialEndsAt?.toISOString() || null,
    trialEndedAt: entitlement.trialEndedAt?.toISOString() || null,
    trialConvertedAt: entitlement.trialConvertedAt?.toISOString() || null,
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

  /* Account creation is capped per IP and per phone in the shared store: a
   * script cannot mint accounts in bulk, and replaying the request cannot
   * bypass the count. */
  const store = getAttemptStore();
  const ip = req.ip || "unknown";
  const gate = await checkRegisterAllowed({ phone, ip }, store);
  if (!gate.allowed) {
    res.setHeader("Retry-After", String(gate.retryAfterSec));
    res.status(429).json({ status: "error", message: "محاولات كثيرة — حاول مرة أخرى بعد قليل", retryAfter: gate.retryAfterSec });
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

  /* Referral attribution is accepted only in this new-account transaction.
   * A logged-in/existing account has no route to change it later. An invalid,
   * expired or rate-limited code is intentionally ignored rather than exposed
   * as a code-existence oracle. */
  const explicitReferral = typeof req.body?.referralCode === "string" ? req.body.referralCode : "";
  const cookieReferral = decodeReferralCookie(req.cookies?.["egytrend_referral"]);
  const referralCode = rateLimitHit(`referral-code:${req.ip || "unknown"}`, 12, 15 * 60 * 1000)
    ? null : (explicitReferral || cookieReferral || null);
  let referral: { attributionId: string | null; attached: boolean; referrerUserId: number | null } = { attributionId: null, attached: false, referrerUserId: null };
  const [user] = await db.transaction(async (tx) => {
    const [created] = await tx.insert(appUsersTable).values({
      phone,
      name,
      passwordHash: hashUserPassword(password),
      ...(email ? { email } : {}),
    }).returning();
    if (!created) throw new Error("user creation failed");
    referral = await attachReferralAtRegistration({
      userId: created.id, email: email || null, phone: created.phone, code: referralCode,
      ip: req.ip || "", device: req.header("user-agent") || "", now: new Date(), database: tx,
    });
    return [created];
  });
  await clearRegisterAttempts({ phone, ip }, store);
  const token = signUserToken({ sub: user.id, phone: user.phone, name: user.name, role: "user", plan: user.plan });
  res.cookie(USER_SESSION_COOKIE, token, sessionCookieOptions(7 * 24 * 60 * 60 * 1000));
  /* A referral notification is transactional and independently idempotent;
   * failure to deliver it can never roll back a safely registered account. */
  if (referral.attached && referral.referrerUserId) {
    const friendName = name.split(/\s+/)[0] || "صديقك";
    void deliverReferralMessage({ deliveryKey: `registered:${referral.attributionId}`, recipientUserId: referral.referrerUserId, eventKey: "friend_registered", vars: { name: "", friend_name: friendName, reward: "", days: "" } });
  }
  res.status(201).json({ status: "ok", user: publicUser(user), referral: { attached: referral.attached } });
});

router.post("/login", async (req: Request, res: Response) => {
  /* Shape → attempt limit → credential check, in that order. The limit is read
   * before any password work (no CPU burned on scrypt while blocked), counted
   * in the shared store so parallel instances cannot multiply it, and cleared
   * for the account on success. */
  const outcome = await evaluateLogin(
    { phone: req.body?.phone, password: req.body?.password, ip: req.ip || "unknown" },
    {
      store: getAttemptStore(),
      findUser: async (phone) => {
        const [row] = await db.select().from(appUsersTable)
          .where(and(eq(appUsersTable.phone, phone), eq(appUsersTable.status, "active"))).limit(1);
        return row ?? null;
      },
    },
  );
  if (outcome.kind === "limited") {
    res.setHeader("Retry-After", String(outcome.retryAfterSec));
    res.status(429).json({ status: "error", message: "محاولات كثيرة — حاول مرة أخرى بعد قليل", retryAfter: outcome.retryAfterSec });
    return;
  }
  if (outcome.kind === "invalid") {
    res.status(outcome.status).json({ status: "error", message: outcome.message });
    return;
  }
  /* The shared limiter only needs the credential fields; reload the full row
   * for the entitlement projection (email verification, marketing flags). */
  const [user] = await db.select().from(appUsersTable)
    .where(and(eq(appUsersTable.id, outcome.user.id), eq(appUsersTable.status, "active"))).limit(1);
  if (!user) {
    res.status(401).json({ status: "error", message: "invalid credentials" });
    return;
  }
  const [entitlement, trial] = await Promise.all([
    getVipEntitlement({ sub: user.id }),
    freeTrialAccountStatus(user.id),
  ]);
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
  res.json({ status: "ok", user: normalized, subscription: publicSubscription(entitlement), trial });
});

/* Explicit logout: revoke THIS session server-side, then expire the cookie.
 * Clearing the cookie alone left any copy of the token valid until it expired. */
router.post("/logout", async (req: Request, res: Response) => {
  const token = readSessionCookie(req, USER_SESSION_COOKIE) || bearerToken(req);
  await revokePresentedSession("user", token);
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
  const [entitlement, trial] = await Promise.all([
    getVipEntitlement({ sub: user.id }),
    freeTrialAccountStatus(user.id),
  ]);
  const normalized = publicUser(user, entitlement);
  /* Sliding refresh: an active session with under 24h left gets a fresh
   * 7-day cookie, so an all-day market screen does not die mid-use. This does
   * not weaken revocation: a password change revokes by issued-after (the new
   * token is issued now), logout revokes by jti, and a deleted/cancelled row
   * is still denied because this route re-reads the user row every time. */
  const remainingMs = claims.exp ? claims.exp * 1000 - Date.now() : Number.POSITIVE_INFINITY;
  if (Number.isFinite(remainingMs) && remainingMs < 24 * 60 * 60 * 1000) {
    const fresh = signUserToken({
      sub: user.id,
      phone: user.phone,
      name: user.name,
      role: "user",
      plan: normalized.plan,
      ...(normalized.vipExpiresAt ? { vipExpiresAt: normalized.vipExpiresAt } : {}),
    });
    res.cookie(USER_SESSION_COOKIE, fresh, sessionCookieOptions(7 * 24 * 60 * 60 * 1000));
  }
  res.json({ status: "ok", user: normalized, subscription: publicSubscription(entitlement), trial });
});

/* ═══════════ FIRST-USE ONBOARDING (authenticated account only) ═══════════ */
router.get("/onboarding", async (req: Request, res: Response) => {
  const claims = currentUser(req);
  if (!claims) { res.status(401).json({ status: "error", message: "login required" }); return; }
  try {
    const onboarding = await onboardingState(claims.sub, new Date());
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    res.json({ status: "ok", ...onboarding });
  } catch (error) {
    logger.error({ err: error }, "onboarding state error");
    res.status(503).json({ status: "error", message: "تعذر تحميل خطوات البداية حاليًا" });
  }
});

router.post("/onboarding/tour", async (req: Request, res: Response) => {
  const claims = currentUser(req);
  if (!claims) { res.status(401).json({ status: "error", message: "login required" }); return; }
  const action = String(req.body?.action || "");
  if (!(["started", "completed", "skipped"] as const).includes(action as OnboardingTourAction)) {
    res.status(400).json({ status: "error", message: "إجراء الجولة غير صالح" }); return;
  }
  /* Two independent tours: the general platform tour and the VIP welcome
   * tour. Neither influences an entitlement; both are display state. */
  const tour = req.body?.tour === undefined ? "user" : String(req.body?.tour || "");
  if (!(tour === "user" || tour === "vip")) {
    res.status(400).json({ status: "error", message: "نوع الجولة غير صالح" }); return;
  }
  try {
    const onboarding = await setOnboardingTourAction(claims.sub, action as OnboardingTourAction, new Date(), tour as OnboardingTourKind);
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    res.json({ status: "ok", ...onboarding });
  } catch (error) {
    logger.error({ err: error }, "onboarding tour update error");
    res.status(503).json({ status: "error", message: "تعذر حفظ حالة الجولة حاليًا" });
  }
});

router.post("/onboarding/reset", async (req: Request, res: Response) => {
  const claims = currentUser(req);
  if (!claims) { res.status(401).json({ status: "error", message: "login required" }); return; }
  if (rateLimitHit(`onboarding-reset:${claims.sub}`, 6, 15 * 60 * 1000)) {
    res.status(429).json({ status: "error", message: "محاولات كثيرة — حاول لاحقًا" }); return;
  }
  /* Default replays only the general tour so the existing settings button
   * never re-arms the VIP tour implicitly. */
  const tour = req.body?.tour === undefined ? "user" : String(req.body?.tour || "");
  if (!(tour === "user" || tour === "vip")) {
    res.status(400).json({ status: "error", message: "نوع الجولة غير صالح" }); return;
  }
  try {
    const onboarding = await resetOnboardingTour(claims.sub, new Date(), tour as OnboardingTourKind);
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    res.json({ status: "ok", ...onboarding });
  } catch (error) {
    logger.error({ err: error }, "onboarding reset error");
    res.status(503).json({ status: "error", message: "تعذر إعادة الجولة حاليًا" });
  }
});

router.post("/onboarding/events", async (req: Request, res: Response) => {
  const claims = currentUser(req);
  if (!claims) { res.status(401).json({ status: "error", message: "login required" }); return; }
  const event = String(req.body?.event || "");
  if (!(["watchlist_progress", "notifications_enabled", "news_explored"] as const).includes(event as OnboardingEvent)) {
    res.status(400).json({ status: "error", message: "حدث البداية غير صالح" }); return;
  }
  if (rateLimitHit(`onboarding-event:${claims.sub}`, 60, 10 * 60 * 1000)) {
    res.status(429).json({ status: "error", message: "محاولات كثيرة — حاول لاحقًا" }); return;
  }
  try {
    const onboarding = await recordOnboardingEvent(claims.sub, event as OnboardingEvent, req.body?.payload, new Date());
    if (!onboarding) { res.status(400).json({ status: "error", message: "بيانات تقدم قائمة المتابعة غير صالحة" }); return; }
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    res.json({ status: "ok", ...onboarding });
  } catch (error) {
    logger.error({ err: error }, "onboarding event error");
    res.status(503).json({ status: "error", message: "تعذر حفظ تقدم البداية حاليًا" });
  }
});

/* ═══════════ REFERRAL DASHBOARD (authenticated account only) ═══════════ */
router.get("/referrals", async (req: Request, res: Response) => {
  const claims = currentUser(req);
  if (!claims) { res.status(401).json({ status: "error", message: "login required" }); return; }
  try {
    const dashboard = await publicReferralDashboard(claims.sub, new Date());
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    res.json({ status: "ok", ...dashboard });
  } catch (error) {
    logger.error({ err: error }, "referral user dashboard error");
    res.status(503).json({ status: "error", message: "إحصاءات الإحالات غير متاحة حاليًا" });
  }
});

/* ═══════════ FREE VIP TRIAL + EMAIL VERIFICATION ═══════════ */
function verifiedEmailLink(rawToken: string): string | null {
  const configured = String(process.env["APP_BASE_URL"] || "").trim().replace(/\/+$/, "");
  const fallback = process.env.NODE_ENV === "production" ? "" : "http://localhost:3000";
  try {
    const base = new URL(configured || fallback);
    if (base.protocol !== "https:" && process.env.NODE_ENV === "production") return null;
    if (base.protocol !== "https:" && base.protocol !== "http:") return null;
    return new URL(`/?verify_email=${encodeURIComponent(rawToken)}`, base).toString();
  } catch { return null; }
}

function verificationEmailHtml(name: string, link: string): string {
  return `<!doctype html><html dir="rtl" lang="ar"><body style="margin:0;background:#f4f6f5;padding:22px;font-family:Tahoma,Arial,sans-serif;color:#172033"><div style="max-width:560px;margin:auto;background:#fff;border:1px solid #e5e7eb;border-radius:16px;padding:24px"><h2 style="margin:0 0 14px;color:#047857">تأكيد البريد الإلكتروني — EgyTrend</h2><p style="font-size:15px;line-height:1.9">مرحبًا ${escapeHtml(name)}. أكّد بريدك لفتح أهلية تجربة VIP المجانية عند تفعيلها من الإدارة. لا تبدأ تجربة ولا تُخصم أي مبالغ بمجرد فتح هذا الرابط.</p><p style="text-align:center;margin:24px 0"><a href="${escapeHtml(link)}" style="display:inline-block;background:#059669;color:#fff;text-decoration:none;font-weight:700;padding:12px 26px;border-radius:10px">تأكيد البريد</a></p><p style="font-size:12px;color:#6b7280;line-height:1.7">الرابط صالح 30 دقيقة ويستخدم مرة واحدة. إذا لم تطلبه فتجاهل الرسالة.</p></div></body></html>`;
}

function trialReasonMessage(reason: string): string {
  const messages: Record<string, string> = {
    disabled: "التجربة المجانية غير مفعّلة حاليًا.",
    email_unverified: "أكّد بريدك الإلكتروني أولًا قبل بدء التجربة.",
    email_missing: "أضف بريدًا إلكترونيًا صالحًا ثم أكّده قبل بدء التجربة.",
    email_disposable: "لا يمكن استخدام بريد مؤقت للتجربة المجانية.",
    already_claimed: "استُخدمت التجربة المجانية سابقًا لهذا الحساب أو البريد.",
    already_active: "لديك تجربة VIP نشطة بالفعل.",
    already_paid: "لديك اشتراك VIP مدفوع نشط بالفعل.",
    user_not_found: "الحساب غير متاح حاليًا.",
  };
  return messages[reason] || "تعذر بدء التجربة حاليًا.";
}

router.get("/trial", async (req: Request, res: Response) => {
  const claims = currentUser(req);
  if (!claims) { res.status(401).json({ status: "error", message: "login required" }); return; }
  try {
    const trial = await freeTrialAccountStatus(claims.sub);
    res.setHeader("Cache-Control", "private, no-store");
    res.json({ status: "ok", trial });
  } catch (error) {
    logger.error({ err: error }, "free trial status error");
    res.status(503).json({ status: "error", message: "تعذر تحميل حالة التجربة حاليًا" });
  }
});

router.post("/email-verification/request", async (req: Request, res: Response) => {
  const claims = currentUser(req);
  if (!claims) { res.status(401).json({ status: "error", message: "login required" }); return; }
  const ip = req.ip || "unknown";
  if (rateLimitHit(`ev-ip:${ip}`, 10, 15 * 60 * 1000) || rateLimitHit(`ev-user:${claims.sub}`, 3, 15 * 60 * 1000)) {
    res.status(429).json({ status: "error", message: "طلبات كثيرة — حاول بعد 15 دقيقة" });
    return;
  }
  try {
    const [user] = await db.select().from(appUsersTable)
      .where(and(eq(appUsersTable.id, claims.sub), eq(appUsersTable.status, "active"))).limit(1);
    if (!user) { res.status(401).json({ status: "error", message: "الحساب غير متاح" }); return; }
    const canonical = canonicalTrialEmail(user.email);
    if (!canonical) { res.status(400).json({ status: "error", message: "أضف بريدًا إلكترونيًا صالحًا أولًا." }); return; }
    if (isDisposableTrialEmail(canonical)) { res.status(400).json({ status: "error", message: "لا يمكن استخدام بريد مؤقت لتأكيد أهلية التجربة." }); return; }
    if (user.emailVerifiedAt) { res.json({ status: "ok", alreadyVerified: true, emailDelivered: false, message: "بريدك مؤكد بالفعل." }); return; }
    const raw = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(raw).digest("hex");
    const now = new Date();
    await db.transaction(async (tx) => {
      await tx.update(emailVerificationTokensTable).set({ usedAt: now })
        .where(and(eq(emailVerificationTokensTable.userId, user.id), isNull(emailVerificationTokensTable.usedAt)));
      await tx.insert(emailVerificationTokensTable).values({
        id: `email-verify-${crypto.randomUUID()}`,
        userId: user.id,
        tokenHash,
        expiresAt: new Date(now.getTime() + 30 * 60 * 1000),
        createdAt: now,
      });
    });
    const link = verifiedEmailLink(raw);
    if (!link) {
      res.status(503).json({ status: "error", message: "رابط التأكيد غير مهيأ بأمان حاليًا؛ تواصل مع الدعم." });
      return;
    }
    const delivery = await sendMail(user.email!, "EgyTrend — تأكيد البريد الإلكتروني", verificationEmailHtml(user.name, link));
    res.json({
      status: "ok",
      emailDelivered: delivery.delivered,
      message: delivery.delivered
        ? "أرسلنا رابط التأكيد إلى بريدك. افحص البريد غير المرغوب أيضًا."
        : "لم تُرسل الرسالة لأن خدمة البريد غير مفعّلة حاليًا؛ لا يمكن تأكيد البريد من دون رابط آمن.",
    });
  } catch (error) {
    logger.error({ err: error }, "email verification request error");
    res.status(503).json({ status: "error", message: "تعذر طلب تأكيد البريد حاليًا" });
  }
});

router.post("/email-verification/confirm", async (req: Request, res: Response) => {
  const ip = req.ip || "unknown";
  if (rateLimitHit(`ev-confirm:${ip}`, 20, 15 * 60 * 1000)) { res.status(429).json({ status: "error", message: "محاولات كثيرة — حاول لاحقًا" }); return; }
  const raw = String(req.body?.token || "").trim();
  if (!/^[a-f0-9]{64}$/i.test(raw)) { res.status(400).json({ status: "error", message: "رابط التأكيد غير صالح أو منتهي." }); return; }
  const tokenHash = crypto.createHash("sha256").update(raw).digest("hex");
  const now = new Date();
  try {
    const verified = await db.transaction(async (tx) => {
      const [token] = await tx.select().from(emailVerificationTokensTable)
        .where(and(eq(emailVerificationTokensTable.tokenHash, tokenHash), isNull(emailVerificationTokensTable.usedAt), gt(emailVerificationTokensTable.expiresAt, now)))
        .for("update").limit(1);
      if (!token) return null;
      const [user] = await tx.select().from(appUsersTable).where(and(eq(appUsersTable.id, token.userId), eq(appUsersTable.status, "active"))).limit(1);
      if (!user) return null;
      await tx.update(emailVerificationTokensTable).set({ usedAt: now }).where(eq(emailVerificationTokensTable.id, token.id));
      await tx.update(appUsersTable).set({ emailVerifiedAt: now, updatedAt: now }).where(eq(appUsersTable.id, user.id));
      return user;
    });
    if (!verified) { res.status(400).json({ status: "error", message: "رابط التأكيد غير صالح أو منتهي." }); return; }
    const settings = await readFreeTrialSettings();
    const trial = settings.enabled && settings.startMode === "after_email_verification"
      ? await startFreeTrial({ userId: verified.id, now, mode: "auto", ip, device: req.header("user-agent") || "" })
      : null;
    /* Referral credit requires server-confirmed email. A configured auto-trial
     * records its own event only after the trial row was created. */
    try {
      await recordReferralEvent({ userId: verified.id, event: "email_verified", now });
      if (trial?.reason === "started") await recordReferralEvent({ userId: verified.id, event: "trial_started", now });
    } catch (referralError) { logger.error({ err: referralError }, "referral event after email verification failed"); }
    res.json({
      status: "ok",
      emailVerified: true,
      trialStarted: trial?.reason === "started",
      trialReason: trial?.reason || null,
      message: trial?.reason === "started"
        ? `تم تأكيد بريدك وبدأت تجربتك المجانية لمدة ${Number(settings.durationDays)} أيام.`
        : "تم تأكيد بريدك الإلكتروني بنجاح.",
    });
  } catch (error) {
    logger.error({ err: error }, "email verification confirm error");
    res.status(503).json({ status: "error", message: "تعذر تأكيد البريد حاليًا" });
  }
});

router.post("/trial/start", async (req: Request, res: Response) => {
  const claims = currentUser(req);
  if (!claims) { res.status(401).json({ status: "error", message: "login required" }); return; }
  try {
    const result = await startFreeTrial({
      userId: claims.sub,
      mode: "self",
      ip: req.ip || "",
      device: `${req.header("user-agent") || ""}|${String(req.header("x-device-id") || "").slice(0, 160)}`,
    });
    if (result.reason !== "started") {
      const status = ["already_claimed", "already_active", "already_paid"].includes(result.reason) ? 409 : 400;
      res.status(status).json({ status: "error", reason: result.reason, message: trialReasonMessage(result.reason) });
      return;
    }
    const trial = await freeTrialAccountStatus(claims.sub);
    try { await recordReferralEvent({ userId: claims.sub, event: "trial_started", now: new Date() }); }
    catch (referralError) { logger.error({ err: referralError }, "referral event after trial start failed"); }
    /* The configured duration, never a hardcoded 7: the operator may change it. */
    const durationDays = Number(trial.settings.durationDays);
    res.json({
      status: "ok",
      trial,
      message: `بدأت تجربتك المجانية لمدة ${Number.isInteger(durationDays) && durationDays > 0 ? durationDays : 7} أيام. لا توجد بيانات دفع أو خصم أو تجديد تلقائي.`,
    });
  } catch (error) {
    logger.error({ err: error }, "free trial self-start error");
    res.status(503).json({ status: "error", message: "تعذر بدء التجربة حاليًا" });
  }
});

router.get("/trial/messages", async (req: Request, res: Response) => {
  const claims = currentUser(req);
  if (!claims) { res.status(401).json({ status: "error", message: "login required" }); return; }
  try {
    const messages = await listFreeTrialMessages(claims.sub);
    res.setHeader("Cache-Control", "private, no-store");
    res.json({ status: "ok", messages });
  } catch (error) {
    logger.error({ err: error }, "trial messages list error");
    res.status(503).json({ status: "error", message: "تعذر تحميل رسائل التجربة حاليًا" });
  }
});

router.post("/trial/messages/:id/events", async (req: Request, res: Response) => {
  const claims = currentUser(req);
  if (!claims) { res.status(401).json({ status: "error", message: "login required" }); return; }
  const event = req.body?.event === "open" ? "open" : req.body?.event === "cta_click" ? "cta_click" : null;
  if (!event) { res.status(400).json({ status: "error", message: "event must be open or cta_click" }); return; }
  try {
    const recorded = await recordFreeTrialMessageEvent(claims.sub, String(req.params.id || ""), event);
    res.json({ status: "ok", recorded });
  } catch (error) {
    logger.error({ err: error }, "trial message event error");
    res.status(503).json({ status: "error", message: "تعذر تسجيل التفاعل حاليًا" });
  }
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
  res.cookie(USER_SESSION_COOKIE, fresh, sessionCookieOptions(7 * 24 * 60 * 60 * 1000));
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
  const byMail = await store.hit(`fp-em:${email0}`, LIMITS.forgotEmail.limit, LIMITS.forgotEmail.windowMs);
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
  const now = new Date();
  try {
    /* Claim the single-use token and write the password in one transaction.
     * The row lock plus `used_at IS NULL` predicate makes concurrent clicks
     * fail closed instead of allowing two resets to race each other. */
    const result = await db.transaction(async (tx) => {
      const [row] = await tx.select().from(passwordResetsTable)
        .where(and(eq(passwordResetsTable.tokenHash, tokenHash), isNull(passwordResetsTable.usedAt), gt(passwordResetsTable.expiresAt, now)))
        .for("update").limit(1);
      if (!row) return "invalid" as const;
      const [user] = await tx.select({ id: appUsersTable.id, phone: appUsersTable.phone }).from(appUsersTable)
        .where(and(eq(appUsersTable.id, row.userId), eq(appUsersTable.status, "active"))).limit(1);
      if (!user) return "unavailable" as const;
      const claimed = await tx.update(passwordResetsTable).set({ usedAt: now })
        .where(and(eq(passwordResetsTable.id, row.id), isNull(passwordResetsTable.usedAt)))
        .returning({ id: passwordResetsTable.id });
      if (!claimed.length) return "invalid" as const;
      await tx.update(appUsersTable).set({
        passwordHash: hashUserPassword(password),
        updatedAt: now,
      }).where(eq(appUsersTable.id, user.id));
      return { status: "updated" as const, userId: user.id, phone: user.phone };
    });
    if (result === "invalid") {
      res.status(400).json({ status: "error", message: "الرابط منتهي أو مستخدم من قبل — اطلب رابطًا جديدًا" });
      return;
    }
    if (result === "unavailable") {
      res.status(400).json({ status: "error", message: "الحساب غير موجود أو موقوف" });
      return;
    }
    /* A reset means the account may have been compromised: every old session
     * dies, and the login counter is cleared so the owner can sign in. */
    await revokeAllSessions("user", result.userId);
    await getAttemptStore().clear(phoneBucket(result.phone));
    res.setHeader("Cache-Control", "no-store");
    res.json({ status: "ok", message: "تم تحديث كلمة المرور — يمكنك تسجيل الدخول الآن" });
  } catch (error) {
    logger.error({ err: error }, "password reset transaction failed");
    res.status(503).json({ status: "error", message: "تعذر تحديث كلمة المرور حاليًا" });
  }
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
  try {
    const updated = await db.update(appUsersTable).set({
      email,
      /* Changing the address invalidates trial eligibility until the new owner
       * proves control. The old verified timestamp must never follow it. */
      emailVerifiedAt: null,
      updatedAt: new Date(),
    }).where(and(eq(appUsersTable.id, claims.sub), eq(appUsersTable.status, "active")))
      .returning({ id: appUsersTable.id });
    if (!updated.length) {
      res.status(401).json({ status: "error", message: "الحساب غير متاح" });
      return;
    }
    res.json({ status: "ok", message: "تم حفظ البريد — أرسل رابط التأكيد قبل بدء التجربة المجانية." });
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      res.status(409).json({ status: "error", message: "هذا البريد مستخدم في حساب آخر" });
      return;
    }
    logger.error({ err: error }, "account email update error");
    res.status(503).json({ status: "error", message: "تعذر حفظ البريد حاليًا" });
  }
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
/** Marketing unsubscribe token helpers live in lib/marketing-email so the
 * lifecycle outbox and this route use the same signed format. */

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
