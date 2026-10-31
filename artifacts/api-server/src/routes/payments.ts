/* ─── Public payment endpoints for the wallet/InstaPay VIP flow ─────────
 * GET  /payments/config → enabled methods (number+instructions) + live plans
 * GET  /payments/my     → the logged-in user's own requests + current state
 * POST /payments        → submit a request (planKey + method + tx + proof)
 *
 * Server is the source of truth: the plan price comes from
 * subscription_plans (admin-editable via the existing plans CRUD), the
 * per-method numbers/instructions from app_settings (admin-editable), and
 * VIP is granted only by admin approval in admin.ts — never from anything
 * the client sends. Proof is stored as an inlined data URL (capped below
 * the server's 300kb JSON body limit) — no filesystem, survives DB backups.
 * ═══════════════════════════════════════════════════════════════════════ */
import { Router, type Request, type Response } from "express";
import { timingSafeEqual } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  appSettingsTable,
  appUsersTable,
  paymentRequestsTable,
  subscriptionPlansTable,
  subscriptionRenewalsTable,
  userNotificationsTable,
  userWalletsTable,
  walletTransactionsTable,
} from "@workspace/db/schema";
import { currentUser, getVipEntitlement, normalizeUserPhone } from "../lib/userAuth";
import { isDuplicateKeyError } from "../lib/dbErrors";
import {
  buildPaymentPriceSnapshot,
  effectivePriceTemplateVariables,
  effectivePriceToken,
  getEffectivePrice,
  getPaymentPriceLockHours,
  pricingCacheVersion,
} from "../lib/pricing";
import { logger } from "../lib/logger";
import { freeTrialAccountStatus } from "../lib/free-trials";
import { referralProofHash, reserveReferralPaymentDiscount, resolveReferralPaymentDiscount } from "../lib/referrals";
import { checkPayRateLimit } from "./admin";
import {
  WALLET_TOPUP_MAX,
  WALLET_TOPUP_MIN,
  WALLET_TOPUP_PLAN_KEY,
  disableAutoRenewal,
  renewalsCycleNow,
  runRenewalsCycle,
  setAutoRenewalConsent,
} from "../lib/wallet-renewals";
import { cairoCalendarDaysUntil, formatCairoDate } from "../lib/subscription-time";

const router: Router = Router();

/* Admin-editable keys (write side lives in admin.ts /settings/payment). */
const METHODS = ["vodafone", "orange", "etisalat", "instapay"] as const;
const METHOD_LABELS: Record<string, string> = {
  vodafone: "فودافون كاش",
  orange: "أورنج كاش",
  etisalat: "اتصالات كاش",
  instapay: "إنستاباي",
};

function methodKey(m: string, field: "number" | "instructions") {
  return `payment_${m}_${field}`;
}

/**
 * A signed user JWT is only an identity hint. Payment and account-data routes
 * reload the active account and use canonical server values, so a banned or
 * archived account cannot submit/view requests through an old cookie.
 */
async function currentActivePaymentUser(req: Request) {
  const claims = currentUser(req);
  if (!claims || !Number.isSafeInteger(claims.sub) || claims.sub <= 0) return null;
  const [user] = await db.select({
    id: appUsersTable.id,
    phone: appUsersTable.phone,
    name: appUsersTable.name,
    plan: appUsersTable.plan,
    vipExpiresAt: appUsersTable.vipExpiresAt,
  }).from(appUsersTable).where(and(eq(appUsersTable.id, claims.sub), eq(appUsersTable.status, "active"))).limit(1);
  if (!user) return null;
  return {
    sub: user.id,
    phone: user.phone,
    name: user.name,
    role: "user" as const,
    plan: user.plan,
    ...(user.vipExpiresAt ? { vipExpiresAt: user.vipExpiresAt.toISOString() } : {}),
  };
}

async function readMethodSettings() {
  const rows = await db.select().from(appSettingsTable);
  const get = (k: string, fb = "") => rows.find((r) => r.key === k)?.value ?? fb;
  /* Payments are fail-closed: a wallet stays hidden and unusable unless an
   * authorized admin explicitly stores enabled = "1" in addition to a number.
   * A legacy number by itself must never silently activate collection. */
  const methods = METHODS.filter(
    (m) => get(methodKey(m, "number")).trim() !== "" && get(`${methodKey(m, "number").replace("_number", "")}_enabled`, "0") === "1",
  ).map((m) => ({
    id: m,
    label: METHOD_LABELS[m] ?? m,
    number: get(methodKey(m, "number")),
    instructions: get(methodKey(m, "instructions")),
  }));
  return methods;
}

/* ── Public config: every displayed amount comes from getEffectivePrice(). ── */
router.get("/payments/config", async (req: Request, res: Response) => {
  try {
    const methods = await readMethodSettings();
    const user = await currentActivePaymentUser(req);
    const rawPlans = await db
      .select()
      .from(subscriptionPlansTable)
      .where(eq(subscriptionPlansTable.isActive, true));
    const now = new Date();
    /* Legacy zero-priced rows are not valid paid plans. Do not fabricate a
     * free amount; hide them until a pricing-authorized operator fixes them. */
    const pricedPlans = rawPlans.filter((plan) => Number.isSafeInteger(plan.price) && plan.price > 0);
    const plans = await Promise.all(pricedPlans.map(async (plan) => {
      const effective = await getEffectivePrice(user, plan, now);
      /* Referral discounts are resolved for the authenticated account on the
       * server and shown as a normal locked price—there is no coupon field for
       * the invitee to copy, edit or fabricate. */
      const referral = user ? await resolveReferralPaymentDiscount({ userId: user.sub, phone: user.phone, price: effective.price, now }) : { price: effective.price, rewardId: null, couponId: null, discount: 0, label: null };
      const displayed = referral.discount > 0 ? {
        ...effective,
        price: referral.price,
        oldPrice: effective.price,
        discountPercent: Math.round((referral.discount / effective.price) * 100),
        badge: referral.label,
      } : effective;
      return {
        key: plan.key,
        nameAr: plan.nameAr,
        /* `price` remains the client contract but is always effective, never base. */
        price: displayed.price,
        oldPrice: displayed.oldPrice,
        discountPercent: displayed.discountPercent,
        priceBadge: displayed.badge,
        durationMonths: plan.durationMonths,
        features: plan.features,
        /* Preserve the existing descriptive plan label separately. */
        badge: plan.badge,
        showCountdown: displayed.showCountdown,
        endsAt: displayed.endsAt?.toISOString() || null,
        priceSource: displayed.source,
        pricingToken: effectivePriceToken(plan, displayed),
        templateVariables: effectivePriceTemplateVariables(displayed),
        referralApplied: referral.discount > 0,
      };
    }));
    plans.sort((left, right) => left.price - right.price || left.key.localeCompare(right.key));
    /* Public price config must never be served stale after a pricing change. */
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.json({ status: "ok", methods, plans, pricingVersion: pricingCacheVersion(), generatedAt: now.toISOString() });
  } catch (e) {
    logger.error({ err: e }, "payments config error");
    res.status(500).json({ status: "error", message: "server error" });
  }
});

/* ── My requests: the user's own payment status (auth required) ── */
router.get("/payments/my", async (req: Request, res: Response) => {
  const user = await currentActivePaymentUser(req);
  if (!user) {
    res.status(401).json({ status: "error", message: "login required" });
    return;
  }
  try {
    const rows = await db
      .select({
        id: paymentRequestsTable.id,
        planKey: paymentRequestsTable.planKey,
        method: paymentRequestsTable.payMethod,
        price: paymentRequestsTable.price,
        priceSnapshot: paymentRequestsTable.priceSnapshot,
        priceLockedUntil: paymentRequestsTable.priceLockedUntil,
        tx: paymentRequestsTable.tx,
        status: paymentRequestsTable.status,
        notes: paymentRequestsTable.notes,
        createdAt: paymentRequestsTable.createdAt,
        decidedAt: paymentRequestsTable.decidedAt,
      })
      .from(paymentRequestsTable)
      .where(eq(paymentRequestsTable.phone, user.phone))
      .orderBy(desc(paymentRequestsTable.createdAt))
      .limit(10);
    const [entitlement, trial] = await Promise.all([
      getVipEntitlement(user),
      freeTrialAccountStatus(user.sub),
    ]);
    res.json({
      status: "ok",
      requests: rows,
      trial,
      plan: entitlement.active ? "vip" : "free",
      subscription: {
        active: entitlement.active,
        status: entitlement.status,
        planKey: entitlement.planKey,
        planNameAr: entitlement.planNameAr,
        planFeatures: entitlement.planFeatures,
        expiresAt: entitlement.expiresAt?.toISOString() || null,
        endsAt: entitlement.expiresAt?.toISOString() || null,
        graceEndsAt: entitlement.graceEndsAt?.toISOString() || null,
        renewalState: entitlement.status,
        subscriptionType: entitlement.subscriptionType,
        trialFeatureScope: entitlement.trialFeatureScope,
        trialAiDailyLimit: entitlement.trialAiDailyLimit,
        trialStartedAt: entitlement.trialStartedAt?.toISOString() || null,
        trialEndsAt: entitlement.trialEndsAt?.toISOString() || null,
        trialEndedAt: entitlement.trialEndedAt?.toISOString() || null,
        trialConvertedAt: entitlement.trialConvertedAt?.toISOString() || null,
      },
    });
  } catch (e) {
    logger.error({ err: e }, "payments my error");
    res.status(500).json({ status: "error", message: "server error" });
  }
});

/* A small server-calculated banner model. The browser can render it but cannot
 * decide whether a member is entitled to see VIP or choose a different plan. */
router.get("/subscriptions/banner", async (req: Request, res: Response) => {
  const user = await currentActivePaymentUser(req);
  if (!user) {
    res.status(401).json({ status: "error", message: "login required" });
    return;
  }
  try {
    const entitlement = await getVipEntitlement(user);
    const now = new Date();
    const endsAt = entitlement.expiresAt;
    const daysUntilExpiry = endsAt ? cairoCalendarDaysUntil(endsAt, now) : null;
    /* The retention banner is only for the final three local Cairo dates of
     * an active paid term, not a client-side plan guess or post-expiry grace. */
    if (!entitlement.active || entitlement.status !== "active" || !endsAt || daysUntilExpiry === null || daysUntilExpiry < 0 || daysUntilExpiry > 3 || !entitlement.planKey) {
      res.setHeader("Cache-Control", "private, no-store, max-age=0");
      res.json({ status: "ok", visible: false, asOf: now.toISOString() });
      return;
    }
    const isTrial = entitlement.subscriptionType === "trial";
    const actionUrl = isTrial ? "/vip?renew=1" : `/vip?plan=${encodeURIComponent(entitlement.planKey)}&renew=1`;
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    res.json({
      status: "ok",
      visible: true,
      daysUntilExpiry,
      endsAt: endsAt.toISOString(),
      endsOn: formatCairoDate(endsAt),
      planKey: isTrial ? null : entitlement.planKey,
      body: isTrial
        ? `تنتهي تجربتك المجانية يوم ${formatCairoDate(endsAt)}. لا يوجد خصم أو تجديد تلقائي؛ تبقى بياناتك محفوظة ويمكنك اختيار باقة عندما تكون جاهزًا.`
        : `ينتهي اشتراكك يوم ${formatCairoDate(endsAt)}. بعد الانتهاء يعود الحساب للخطة المجانية وتبقى قوائمك ومحفظتك وتنبيهاتك وسيناريوهاتك محفوظة لكنها مقفولة حتى التجديد.`,
      actionUrl,
      actionLabel: isTrial ? "اختيار باقة" : "جدّد الآن",
      asOf: now.toISOString(),
    });
  } catch (error) {
    logger.error({ err: error }, "subscription banner error");
    res.status(503).json({ status: "error", message: "حالة الاشتراك غير متاحة حاليًا" });
  }
});

/* Data-URL allowlist + size ceiling (kept below the 300kb express.json cap). */
const PROOF_MAX = 290_000; // base64 chars ≈ 217KB image
const DATA_URL_RE = /^data:image\/(png|jpe?g|webp|gif|bmp);base64,[A-Za-z0-9+/=]+$/;

/* ── Submit a payment request (auth required) ── */
router.post("/payments", async (req: Request, res: Response) => {
  const user = await currentActivePaymentUser(req);
  if (!user) {
    res.status(401).json({ status: "error", message: "login required" });
    return;
  }

  /* Active members may submit one renewal request before expiry. The server
   * still owns plan price/duration and approval stacks time transactionally;
   * a pending request below prevents accidental duplicate renewals. */
  const b = (req.body || {}) as Record<string, unknown>;
  const planKey = String(b.planKey || "").trim().replace(/[^a-z0-9_\-]/gi, "").slice(0, 30);
  const method = String(b.method || "vodafone").trim().toLowerCase().replace(/[^a-z]/g, "").slice(0, 20);
  /* The transfer reference (tx) is OPTIONAL since the transfer-number field
   * was retired from the UI: proof image + admin review carry the approval.
   * Legacy clients may still send it; it is stored for continuity but never
   * required, and the duplicate check applies only when non-empty. */
  const tx = String(b.tx || "").trim().slice(0, 100);
  /* Freshness marker from the exact server-rendered plan response. It is not
   * an amount and can never authorize a price; it only prevents stale UI. */
  const pricingToken = typeof b.pricingToken === "string" ? b.pricingToken.trim().slice(0, 1000) : "";
  const proofImage = typeof b.proofImage === "string" ? b.proofImage : "";
  const proofName = String(b.proofName || "").trim().slice(0, 120);
  /* Optional sender number is normalized server-side and kept only for a
   * referral-review signal. It never affects payment approval by itself. */
  const senderPhoneRaw = typeof b.senderPhone === "string" ? b.senderPhone : "";
  const senderPhone = senderPhoneRaw ? normalizeUserPhone(senderPhoneRaw) : null;
  /* Explicit consent to auto-renew from the user's wallet balance. Stored in
   * the immutable price snapshot and applied by the admin approval — a
   * checkbox alone, without approval, changes nothing. */
  const autoRenewConsent = b.autoRenew === true;

  if (!planKey) {
    res.status(400).json({ status: "error", message: "اختر خطة الاشتراك" });
    return;
  }
  if (!proofImage || !DATA_URL_RE.test(proofImage)) {
    res.status(400).json({ status: "error", message: "ارفع صورة إثبات الدفع (PNG/JPG)" });
    return;
  }
  if (senderPhoneRaw && !senderPhone) {
    res.status(400).json({ status: "error", message: "رقم هاتف المُحوِّل غير صحيح" });
    return;
  }
  if (proofImage.length > PROOF_MAX) {
    res.status(413).json({ status: "error", message: "حجم الصورة كبير — استخدم صورة أصغر" });
    return;
  }

  /* Duplicate tx check BEFORE the rate limiter: a duplicate is a user mistake
   * (or retry), not fresh load — it must answer 409 instead of 429, and must
   * not consume one of the scarce submission slots (3 / 10 min). */
  const txKey = tx.toLowerCase();
  if (txKey) {
    try {
      const [dup0] = await db
        .select({ id: paymentRequestsTable.id })
        .from(paymentRequestsTable)
        /* The matching expression is identical to migration 0012's unique
         * index. This gives a friendly fast-path response; the index remains
         * the authoritative race-safe enforcement at INSERT time. */
        .where(sql`lower(${paymentRequestsTable.tx}) = ${txKey}`)
        .limit(1);
      if (dup0) {
        res.status(409).json({ status: "error", message: "رقم العملية مستخدم من قبل — كل تحويل له رقم مختلف" });
        return;
      }
    } catch { /* fall through to the insert-time guarantee */ }
  }

  /* One proof image backs at most one live (pending/approved) request —
   * reusing the same screenshot for a second payment is rejected up front.
   * The admin decision re-checks inside its transaction as well. */
  {
    const proofHash = referralProofHash(proofImage);
    if (proofHash) {
      const [proofDup] = await db
        .select({ id: paymentRequestsTable.id })
        .from(paymentRequestsTable)
        .where(and(
          eq(paymentRequestsTable.proofHash, proofHash),
          inArray(paymentRequestsTable.status, ["pending", "approved"]),
        ))
        .limit(1);
      if (proofDup) {
        res.status(409).json({ status: "error", message: "هذه صورة الإثبات مستخدمة في طلب آخر (قيد المراجعة أو مقبول) — كل إثبات لدفع واحد فقط" });
        return;
      }
    }
  }

  /* Rate limit: reuse the existing per-phone payment limiter (3 / 10 min). */
  if (checkPayRateLimit(user.phone) === "limited") {
    res.status(429).json({ status: "error", message: "طلبات كثيرة — يرجى الانتظار 10 دقائق" });
    return;
  }

  const id = `req-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
  try {
    /* The full plan and the price are fetched server-side. The body has no
     * amount field that is trusted or even read. */
    const [plan] = await db
      .select()
      .from(subscriptionPlansTable)
      .where(and(eq(subscriptionPlansTable.key, planKey), eq(subscriptionPlansTable.isActive, true)))
      .limit(1);
    if (!plan) {
      res.status(400).json({ status: "error", message: "خطة غير متاحة — اختر خطة صحيحة" });
      return;
    }
    const now = new Date();
    const effective = await getEffectivePrice(user, plan, now);
    const referral = await resolveReferralPaymentDiscount({ userId: user.sub, phone: user.phone, price: effective.price, now });
    const lockedEffective = referral.discount > 0 ? {
      ...effective,
      price: referral.price,
      oldPrice: effective.price,
      discountPercent: Math.round((referral.discount / effective.price) * 100),
      badge: referral.label,
    } : effective;
    if (!Number.isSafeInteger(lockedEffective.price) || lockedEffective.price <= 0) {
      res.status(503).json({ status: "error", message: "سعر الباقة غير متاح حاليًا — تواصل مع الإدارة" });
      return;
    }
    if (!pricingToken || pricingToken !== effectivePriceToken(plan, lockedEffective)) {
      res.status(409).json({ status: "error", message: "تغيّر سعر أو عرض الباقة — أعد تحميل الباقات قبل إنشاء الطلب" });
      return;
    }
    const lockHours = await getPaymentPriceLockHours();
    const priceLockedUntil = new Date(now.getTime() + lockHours * 60 * 60 * 1000);
    const priceSnapshot = { ...buildPaymentPriceSnapshot(plan, lockedEffective, lockHours, now), referral: referral.rewardId ? { rewardId: referral.rewardId, couponId: referral.couponId, discount: referral.discount, automatic: true } : null, autoRenewConsent };

    /* Method must be one the admin enabled (wallet number configured). */
    const methods = await readMethodSettings();
    const chosen = methods.find((m) => m.id === method);
    if (!chosen) {
      res.status(400).json({ status: "error", message: "وسيلة الدفع غير متاحة حاليًا — اختر وسيلة أخرى" });
      return;
    }

    /* tx uniqueness — second, authoritative check. Migration 0012 enforces
     * one trimmed, case-insensitive transfer reference across all methods, so
     * a concurrent insert becomes a clean 409 below rather than a duplicate. */
    const [dup] = await db
      .select({ id: paymentRequestsTable.id })
      .from(paymentRequestsTable)
      .where(sql`lower(${paymentRequestsTable.tx}) = ${txKey}`)
      .limit(1);
    if (dup) {
      res.status(409).json({ status: "error", message: "رقم العملية مستخدم من قبل — كل تحويل له رقم مختلف" });
      return;
    }

    const [pending] = await db.select({
      id: paymentRequestsTable.id,
      priceLockedUntil: paymentRequestsTable.priceLockedUntil,
    })
      .from(paymentRequestsTable)
      .where(and(eq(paymentRequestsTable.phone, user.phone), eq(paymentRequestsTable.status, "pending")))
      .limit(1);
    if (pending) {
      /* A new-format expired price hold stops blocking a fresh request. Legacy
       * rows with no lock remain reviewable and retain their historic price. */
      if (pending.priceLockedUntil && pending.priceLockedUntil.getTime() <= now.getTime()) {
        await db.update(paymentRequestsTable).set({
          status: "expired",
          notes: "انتهت مدة تثبيت السعر؛ أنشئ طلبًا جديدًا بالسعر الحالي.",
          updatedAt: now,
          decidedAt: now,
        }).where(eq(paymentRequestsTable.id, pending.id));
      } else {
        res.status(409).json({ status: "error", message: "لديك طلب دفع قيد المراجعة بالفعل — تابع حالته من صفحة اشتراكي" });
        return;
      }
    }

    await db.insert(paymentRequestsTable).values({
      id,
      phone: user.phone,
      name: user.name || user.phone,
      planKey: plan.key,
      payMethod: chosen.id,
      /* Exact server-calculated (and, when eligible, auto-referral-discounted)
       * amount—never a browser-supplied value. */
      price: lockedEffective.price,
      priceSnapshot,
      priceLockedUntil,
      tx,
      status: "pending",
      proofImage,
      proofName: proofName || null,
      senderPhone,
      proofHash: referralProofHash(proofImage),
      referralRewardId: referral.rewardId,
    });
    try { await reserveReferralPaymentDiscount({ rewardId: referral.rewardId, couponId: referral.couponId, paymentRequestId: id, now }); }
    catch (referralError) { logger.error({ err: referralError, paymentRequestId: id }, "referral discount reservation failed after payment insert"); }
    logger.info({ planKey: plan.key, price: lockedEffective.price, method: chosen.id, referralApplied: Boolean(referral.rewardId) }, "payment request submitted");
    res.json({
      status: "ok",
      id,
      amount: lockedEffective.price,
      priceLockedUntil: priceLockedUntil.toISOString(),
      message: "تم إرسال طلبك — السعر محفوظ لمدة محدودة وجارٍ مراجعة الدفع",
    });
  } catch (e: unknown) {
    /* The authoritative duplicate guard is migration 0012's unique index.
     * Drizzle hides its SQLSTATE on the cause chain, so the raw error text is
     * never enough to answer 409 instead of a misleading 500. */
    if (isDuplicateKeyError(e)) {
      res.status(409).json({ status: "error", message: "رقم العملية مستخدم من قبل — كل تحويل له رقم مختلف" });
      return;
    }
    logger.error({ err: e }, "payment create error");
    res.status(500).json({ status: "error", message: "server error" });
  }
});

/* ── User wallet + auto-renewal ───────────────────────────────────────────
 * The wallet is stored value the user fills through EXPLICIT top-up
 * requests (same proof + admin-review pipeline as plan payments) and spends
 * through explicit auto-renewal consent. Nothing credits it automatically.
 * ═══════════════════════════════════════════════════════════════════════ */

/* Cron protection mirrors the notifications cycle: a configured secret in
 * MARKET_SNAPSHOT_CRON_SECRET and a matching x-cron-secret header. */
function verifyRenewalsCronSecret(req: Request): boolean {
  const configured = (process.env["MARKET_SNAPSHOT_CRON_SECRET"] || "").trim();
  const supplied = String(req.get("x-cron-secret") || req.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!configured || !supplied) return false;
  const a = Buffer.from(configured);
  const b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}

/* ── GET /payments/wallet — balance, recent ledger, renewal state ── */
router.get("/payments/wallet", async (req: Request, res: Response) => {
  const user = await currentActivePaymentUser(req);
  if (!user) {
    res.status(401).json({ status: "error", message: "login required" });
    return;
  }
  try {
    const [wallet] = await db.select().from(userWalletsTable).where(eq(userWalletsTable.userId, user.sub)).limit(1);
    const [renewal] = await db.select().from(subscriptionRenewalsTable).where(eq(subscriptionRenewalsTable.userId, user.sub)).limit(1);
    const transactions = await db
      .select({
        id: walletTransactionsTable.id,
        kind: walletTransactionsTable.kind,
        amount: walletTransactionsTable.amount,
        balanceAfter: walletTransactionsTable.balanceAfter,
        note: walletTransactionsTable.note,
        createdAt: walletTransactionsTable.createdAt,
      })
      .from(walletTransactionsTable)
      .where(eq(walletTransactionsTable.userId, user.sub))
      .orderBy(desc(walletTransactionsTable.createdAt))
      .limit(10);
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    res.json({
      status: "ok",
      wallet: {
        balance: wallet ? wallet.balance : 0,
        topupMin: WALLET_TOPUP_MIN,
        topupMax: WALLET_TOPUP_MAX,
        transactions,
      },
      renewal: renewal
        ? {
            status: renewal.status,
            planKey: renewal.planKey,
            planNameAr: renewal.planNameAr,
            planDurationMonths: renewal.planDurationMonths,
            lastKnownPrice: renewal.lastKnownPrice,
            nextRenewalAt: renewal.nextRenewalAt?.toISOString() || null,
            lastRenewedAt: renewal.lastRenewedAt?.toISOString() || null,
            consentAt: renewal.consentAt.toISOString(),
            consentSource: renewal.consentSource,
            lastAttemptResult: renewal.lastAttemptResult,
          }
        : null,
    });
  } catch (e) {
    logger.error({ err: e }, "wallet state error");
    res.status(500).json({ status: "error", message: "server error" });
  }
});

/* ── POST /payments/wallet/topup — explicit stored-value top-up request ──
 * Creates a pending payment_requests row (planKey "wallet_topup") that only
 * an admin approval can convert into a wallet credit. No automatic credit
 * from any external payment method exists anywhere in the system. */
router.post("/payments/wallet/topup", async (req: Request, res: Response) => {
  const user = await currentActivePaymentUser(req);
  if (!user) {
    res.status(401).json({ status: "error", message: "login required" });
    return;
  }
  const b = (req.body || {}) as Record<string, unknown>;
  const amount = Number(b.amount);
  if (!Number.isSafeInteger(amount) || amount < WALLET_TOPUP_MIN || amount > WALLET_TOPUP_MAX) {
    res.status(400).json({ status: "error", message: `مبلغ الشحن يجب أن يكون عددًا صحيحًا بين ${WALLET_TOPUP_MIN} و${WALLET_TOPUP_MAX} جنيه` });
    return;
  }
  const method = String(b.method || "").trim().toLowerCase().replace(/[^a-z]/g, "").slice(0, 20);
  const proofImage = typeof b.proofImage === "string" ? b.proofImage : "";
  const proofName = String(b.proofName || "").trim().slice(0, 120);
  if (!proofImage || !DATA_URL_RE.test(proofImage)) {
    res.status(400).json({ status: "error", message: "ارفع صورة إثبات التحويل (PNG/JPG)" });
    return;
  }
  if (proofImage.length > PROOF_MAX) {
    res.status(413).json({ status: "error", message: "حجم الصورة كبير — استخدم صورة أصغر" });
    return;
  }

  /* One proof backs at most one live request (same rule as plan payments). */
  const proofHash = referralProofHash(proofImage);
  if (proofHash) {
    const [proofDup] = await db
      .select({ id: paymentRequestsTable.id })
      .from(paymentRequestsTable)
      .where(and(
        eq(paymentRequestsTable.proofHash, proofHash),
        inArray(paymentRequestsTable.status, ["pending", "approved"]),
      ))
      .limit(1);
    if (proofDup) {
      res.status(409).json({ status: "error", message: "هذه صورة الإثبات مستخدمة في طلب آخر (قيد المراجعة أو مقبول) — كل إثبات لدفع واحد فقط" });
      return;
    }
  }

  if (checkPayRateLimit(user.phone) === "limited") {
    res.status(429).json({ status: "error", message: "طلبات كثيرة — يرجى الانتظار 10 دقائق" });
    return;
  }

  const id = `req-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
  try {
    const methods = await readMethodSettings();
    const chosen = methods.find((m) => m.id === method);
    if (!chosen) {
      res.status(400).json({ status: "error", message: "وسيلة الدفع غير متاحة حاليًا — اختر وسيلة أخرى" });
      return;
    }

    const [pending] = await db
      .select({ id: paymentRequestsTable.id, priceLockedUntil: paymentRequestsTable.priceLockedUntil })
      .from(paymentRequestsTable)
      .where(and(
        eq(paymentRequestsTable.phone, user.phone),
        eq(paymentRequestsTable.planKey, WALLET_TOPUP_PLAN_KEY),
        eq(paymentRequestsTable.status, "pending"),
      ))
      .limit(1);
    const now = new Date();
    if (pending) {
      if (pending.priceLockedUntil && pending.priceLockedUntil.getTime() <= now.getTime()) {
        await db.update(paymentRequestsTable).set({
          status: "expired",
          notes: "انتهت مدة تثبيت مبلغ الشحن؛ أنشئ طلبًا جديدًا.",
          updatedAt: now,
          decidedAt: now,
        }).where(eq(paymentRequestsTable.id, pending.id));
      } else {
        res.status(409).json({ status: "error", message: "لديك طلب شحن محفظة قيد المراجعة بالفعل" });
        return;
      }
    }

    const lockHours = await getPaymentPriceLockHours();
    const priceLockedUntil = new Date(now.getTime() + lockHours * 60 * 60 * 1000);
    await db.insert(paymentRequestsTable).values({
      id,
      phone: user.phone,
      name: user.name || user.phone,
      planKey: WALLET_TOPUP_PLAN_KEY,
      payMethod: chosen.id,
      price: amount,
      /* Custom snapshot for top-ups: no plan involved; the admin approval
       * branch keys off planKey and this kind. */
      priceSnapshot: { kind: "wallet_topup", amount, method: chosen.id, calculatedAt: now.toISOString(), lockHours },
      priceLockedUntil,
      /* Transfer number was retired from the flow; stored empty. */
      tx: "",
      status: "pending",
      proofImage,
      proofName: proofName || null,
      senderPhone: null,
      proofHash,
      referralRewardId: null,
    });
    logger.info({ amount, method: chosen.id }, "wallet topup request submitted");
    res.json({
      status: "ok",
      id,
      amount,
      message: "تم إرسال طلب الشحن — يُضاف المبلغ لرصيد محفظتك بعد اعتماد الإدارة",
    });
  } catch (e) {
    logger.error({ err: e }, "wallet topup error");
    res.status(500).json({ status: "error", message: "server error" });
  }
});

/* ── PUT /payments/wallet/auto-renew — explicit enable/disable ─────────── */
router.put("/payments/wallet/auto-renew", async (req: Request, res: Response) => {
  const user = await currentActivePaymentUser(req);
  if (!user) {
    res.status(401).json({ status: "error", message: "login required" });
    return;
  }
  const b = (req.body || {}) as Record<string, unknown>;
  const now = new Date();
  try {
    if (b.enabled === true) {
      const outcome = await setAutoRenewalConsent(user.sub, user.phone, "settings", now);
      if (!outcome.ok) {
        const message = outcome.reason === "plan_unavailable"
          ? "تعذر تفعيل التجديد التلقائي: باقة اشتراكك غير متاحة حاليًا — تواصل مع الإدارة"
          : "التجديد التلقائي يتطلب اشتراكًا مدفوعًا فعالًا حاليًا — جدّد اشتراكك أولًا";
        res.status(409).json({ status: "error", message });
        return;
      }
    } else if (b.enabled === false) {
      const changed = await disableAutoRenewal(user.sub, now);
      if (!changed) {
        res.status(409).json({ status: "error", message: "التجديد التلقائي غير مفعّل حاليًا — لا يوجد ما يُوقَف" });
        return;
      }
      /* Disabling never cancels the current paid term; it only removes the
       * scheduled debit. Say so in the response for the UI. */
    } else {
      res.status(400).json({ status: "error", message: "enabled يجب أن تكون true أو false" });
      return;
    }
    const [renewal] = await db.select().from(subscriptionRenewalsTable).where(eq(subscriptionRenewalsTable.userId, user.sub)).limit(1);
    res.json({
      status: "ok",
      renewal: renewal
        ? {
            status: renewal.status,
            planKey: renewal.planKey,
            planNameAr: renewal.planNameAr,
            lastKnownPrice: renewal.lastKnownPrice,
            nextRenewalAt: renewal.nextRenewalAt?.toISOString() || null,
            consentAt: renewal.consentAt.toISOString(),
          }
        : null,
      note: b.enabled === false ? "أُوقف التجديد التلقائي — اشتراكك الحالي يستمر حتى نهايته" : null,
    });
  } catch (e) {
    logger.error({ err: e }, "auto-renew toggle error");
    res.status(500).json({ status: "error", message: "server error" });
  }
});

/* ── POST /subscriptions/internal/renewals/run — scheduled cycle ─────────
 * Runs the wallet auto-renewal cycle: 3-day-ahead notifications + due-slot
 * debits/extensions. Secret-protected like the other internal crons. */
router.post("/subscriptions/internal/renewals/run", (req: Request, res: Response) => {
  if (!verifyRenewalsCronSecret(req)) {
    res.status(401).json({ status: "error", message: "unauthorized" });
    return;
  }
  runRenewalsCycle(renewalsCycleNow())
    .then((result) => {
      logger.info(result, "renewals cycle finished");
      res.json({ status: "ok", ...result });
    })
    .catch((e) => {
      logger.error({ err: e }, "renewals cycle error");
      res.status(500).json({ status: "error", message: "server error" });
    });
});

/* ── In-platform notifications for the logged-in user (bell + badge) ──
 * Server-side rows (inserted by admin decisions); the client tracks which
 * ids it has already shown (pay_notifs_seen_v1). */
router.get("/payments/notifications", async (req: Request, res: Response) => {
  const user = await currentActivePaymentUser(req);
  if (!user) {
    res.status(401).json({ status: "error", message: "login required" });
    return;
  }
  try {
    const rows = await db
      .select({
        id: userNotificationsTable.id,
        kind: userNotificationsTable.kind,
        title: userNotificationsTable.title,
        body: userNotificationsTable.body,
        actionUrl: userNotificationsTable.actionUrl,
        actionLabel: userNotificationsTable.actionLabel,
        createdAt: userNotificationsTable.createdAt,
      })
      .from(userNotificationsTable)
      .where(eq(userNotificationsTable.phone, user.phone))
      .orderBy(desc(userNotificationsTable.createdAt))
      .limit(20);
    /* Client contract: type = approved|rejected, notes = reason for rejection.
     * CTA values are constrained again at the response edge so even an
     * unexpected stored value can never become an open redirect in the UI. */
    const safeAction = (value: string | null) => value && /^\/(?!\/)[a-zA-Z0-9_?=&%./-]{1,300}$/.test(value) ? value : null;
    const notifications = rows.map((r) => {
      const actionUrl = safeAction(r.actionUrl);
      return {
        id: r.id,
        type: r.kind === "payment_approved" ? "approved" : r.kind === "payment_rejected" ? "rejected" : r.kind === "price_alert" ? "price_alert" : r.kind,
        title: r.title,
        body: r.body,
        notes: r.kind === "payment_rejected" ? r.body.replace(/^تم رفض طلب الدفع\. السبب:\s*/, "") : "",
        icon: r.kind === "payment_approved" ? "🎉" : r.kind === "subscription" ? "⏰" : "📋",
        actionUrl,
        actionLabel: actionUrl && r.actionLabel ? r.actionLabel.slice(0, 40) : null,
        createdAt: r.createdAt,
      };
    });
    res.json({ status: "ok", notifications });
  } catch (e) {
    logger.error({ err: e }, "user notifications error");
    res.status(500).json({ status: "error", message: "server error" });
  }
});

export default router;
