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
import { and, asc, desc, eq } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  appSettingsTable,
  paymentRequestsTable,
  subscriptionPlansTable,
  userNotificationsTable,
} from "@workspace/db/schema";
import { currentUser, getVipEntitlement } from "../lib/userAuth";
import { logger } from "../lib/logger";
import { checkPayRateLimit } from "./admin";

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

async function readMethodSettings() {
  const rows = await db.select().from(appSettingsTable);
  const get = (k: string, fb = "") => rows.find((r) => r.key === k)?.value ?? fb;
  /* A method is user-visible iff the admin enabled it (payment_<m>_enabled != "0")
   * AND its number/instruction value is non-empty. */
  const methods = METHODS.filter(
    (m) => get(methodKey(m, "number")).trim() !== "" && get(`${methodKey(m, "number").replace("_number", "")}_enabled`, "1") !== "0",
  ).map((m) => ({
    id: m,
    label: METHOD_LABELS[m] ?? m,
    number: get(methodKey(m, "number")),
    instructions: get(methodKey(m, "instructions")),
  }));
  return methods;
}

/* ── Public config: what the subscribe flow needs (no auth) ── */
router.get("/payments/config", async (_req: Request, res: Response) => {
  try {
    const methods = await readMethodSettings();
    const plans = await db
      .select({
        key: subscriptionPlansTable.key,
        nameAr: subscriptionPlansTable.nameAr,
        price: subscriptionPlansTable.price,
        durationMonths: subscriptionPlansTable.durationMonths,
        features: subscriptionPlansTable.features,
        badge: subscriptionPlansTable.badge,
      })
      .from(subscriptionPlansTable)
      .where(eq(subscriptionPlansTable.isActive, true))
      .orderBy(asc(subscriptionPlansTable.price));
    res.json({ status: "ok", methods, plans });
  } catch (e) {
    logger.error({ err: e }, "payments config error");
    res.status(500).json({ status: "error", message: "server error" });
  }
});

/* ── My requests: the user's own payment status (auth required) ── */
router.get("/payments/my", async (req: Request, res: Response) => {
  const user = currentUser(req);
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
    const entitlement = await getVipEntitlement(user);
    res.json({
      status: "ok",
      requests: rows,
      plan: entitlement.active ? "vip" : "free",
      subscription: {
        active: entitlement.active,
        status: entitlement.status,
        planKey: entitlement.planKey,
        planNameAr: entitlement.planNameAr,
        planFeatures: entitlement.planFeatures,
        expiresAt: entitlement.expiresAt?.toISOString() || null,
      },
    });
  } catch (e) {
    logger.error({ err: e }, "payments my error");
    res.status(500).json({ status: "error", message: "server error" });
  }
});

/* Data-URL allowlist + size ceiling (kept below the 300kb express.json cap). */
const PROOF_MAX = 290_000; // base64 chars ≈ 217KB image
const DATA_URL_RE = /^data:image\/(png|jpe?g|webp|gif|bmp);base64,[A-Za-z0-9+/=]+$/;

/* ── Submit a payment request (auth required) ── */
router.post("/payments", async (req: Request, res: Response) => {
  const user = currentUser(req);
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
  const tx = String(b.tx || "").trim().slice(0, 100);
  const proofImage = typeof b.proofImage === "string" ? b.proofImage : "";
  const proofName = String(b.proofName || "").trim().slice(0, 120);

  if (!planKey) {
    res.status(400).json({ status: "error", message: "اختر خطة الاشتراك" });
    return;
  }
  if (!tx) {
    res.status(400).json({ status: "error", message: "أدخل رقم عملية التحويل" });
    return;
  }
  if (!proofImage || !DATA_URL_RE.test(proofImage)) {
    res.status(400).json({ status: "error", message: "ارفع صورة إثبات الدفع (PNG/JPG)" });
    return;
  }
  if (proofImage.length > PROOF_MAX) {
    res.status(413).json({ status: "error", message: "حجم الصورة كبير — استخدم صورة أصغر" });
    return;
  }

  /* Duplicate tx check BEFORE the rate limiter: a duplicate is a user mistake
   * (or retry), not fresh load — it must answer 409 instead of 429, and must
   * not consume one of the scarce submission slots (3 / 10 min). */
  const tx0 = String(b.tx || "").trim().slice(0, 100);
  if (tx0) {
    try {
      const [dup0] = await db
        .select({ id: paymentRequestsTable.id })
        .from(paymentRequestsTable)
        .where(eq(paymentRequestsTable.tx, tx0))
        .limit(1);
      if (dup0) {
        res.status(409).json({ status: "error", message: "رقم العملية مستخدم من قبل — كل تحويل له رقم مختلف" });
        return;
      }
    } catch { /* fall through to the insert-time guarantee */ }
  }

  /* Rate limit: reuse the existing per-phone payment limiter (3 / 10 min). */
  if (checkPayRateLimit(user.phone) === "limited") {
    res.status(429).json({ status: "error", message: "طلبات كثيرة — يرجى الانتظار 10 دقائق" });
    return;
  }

  const id = `req-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
  try {
    /* Plan + price come from the server (admin-editable) — never the client. */
    const [plan] = await db
      .select({
        key: subscriptionPlansTable.key,
        price: subscriptionPlansTable.price,
      })
      .from(subscriptionPlansTable)
      .where(and(eq(subscriptionPlansTable.key, planKey), eq(subscriptionPlansTable.isActive, true)))
      .limit(1);
    if (!plan) {
      res.status(400).json({ status: "error", message: "خطة غير متاحة — اختر خطة صحيحة" });
      return;
    }

    /* Method must be one the admin enabled (wallet number configured). */
    const methods = await readMethodSettings();
    const chosen = methods.find((m) => m.id === method);
    if (!chosen) {
      res.status(400).json({ status: "error", message: "وسيلة الدفع غير متاحة حاليًا — اختر وسيلة أخرى" });
      return;
    }

    /* tx uniqueness — second, authoritative check (DB unique index on
     * (lower(tx), pay_method) turns any race into a clean 409 below). */
    const [dup] = await db
      .select({ id: paymentRequestsTable.id })
      .from(paymentRequestsTable)
      .where(eq(paymentRequestsTable.tx, tx))
      .limit(1);
    if (dup) {
      res.status(409).json({ status: "error", message: "رقم العملية مستخدم من قبل — كل تحويل له رقم مختلف" });
      return;
    }

    const [pending] = await db.select({ id: paymentRequestsTable.id })
      .from(paymentRequestsTable)
      .where(and(eq(paymentRequestsTable.phone, user.phone), eq(paymentRequestsTable.status, "pending")))
      .limit(1);
    if (pending) {
      res.status(409).json({ status: "error", message: "لديك طلب دفع قيد المراجعة بالفعل — تابع حالته من صفحة اشتراكي" });
      return;
    }

    await db.insert(paymentRequestsTable).values({
      id,
      phone: user.phone,
      name: user.name || user.phone,
      planKey: plan.key,
      payMethod: chosen.id,
      price: plan.price,
      tx,
      status: "pending",
      proofImage,
      proofName: proofName || null,
    });
    logger.info({ planKey: plan.key, price: plan.price, method: chosen.id }, "payment request submitted");
    res.json({ status: "ok", id, message: "تم إرسال طلبك — جاري مراجعة الدفع" });
  } catch (e: unknown) {
    const msg = String(e);
    if (msg.includes("payment_requests_tx_method_uidx") || msg.includes("unique")) {
      res.status(409).json({ status: "error", message: "رقم العملية مستخدم من قبل — كل تحويل له رقم مختلف" });
      return;
    }
    logger.error({ err: e }, "payment create error");
    res.status(500).json({ status: "error", message: "server error" });
  }
});

/* ── In-platform notifications for the logged-in user (bell + badge) ──
 * Server-side rows (inserted by admin decisions); the client tracks which
 * ids it has already shown (pay_notifs_seen_v1). */
router.get("/payments/notifications", async (req: Request, res: Response) => {
  const user = currentUser(req);
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
        createdAt: userNotificationsTable.createdAt,
      })
      .from(userNotificationsTable)
      .where(eq(userNotificationsTable.phone, user.phone))
      .orderBy(desc(userNotificationsTable.createdAt))
      .limit(20);
    /* Client contract: type = approved|rejected, notes = reason for rejection. */
    const notifications = rows.map((r) => ({
      id: r.id,
      type: r.kind === "payment_approved" ? "approved" : r.kind === "payment_rejected" ? "rejected" : r.kind,
      title: r.title,
      body: r.body,
      notes: r.kind === "payment_rejected" ? r.body.replace(/^تم رفض طلب الدفع\. السبب:\s*/, "") : "",
      icon: r.kind === "payment_approved" ? "🎉" : "📋",
      createdAt: r.createdAt,
    }));
    res.json({ status: "ok", notifications });
  } catch (e) {
    logger.error({ err: e }, "user notifications error");
    res.status(500).json({ status: "error", message: "server error" });
  }
});

export default router;
