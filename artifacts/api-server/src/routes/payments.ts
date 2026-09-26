/* ─── Public payment endpoints for the Vodafone Cash VIP flow ──────────
 * GET  /payments/config → wallet number + instructions + live plans
 * GET  /payments/my     → the logged-in user's own requests + current state
 * POST /payments        → submit a request (planKey + tx + proof screenshot)
 *
 * Server is the source of truth: the plan price comes from
 * subscription_plans (admin-editable via the existing plans CRUD), the
 * wallet number from app_settings (admin-editable), and VIP is granted
 * only by admin approval in admin.ts — never from anything the client
 * sends. Proof is stored as an inlined data URL (capped below the
 * server's 300kb JSON body limit) — no filesystem, survives DB backups.
 * ═══════════════════════════════════════════════════════════════════════ */
import { Router, type Request, type Response } from "express";
import { and, asc, desc, eq } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  appSettingsTable,
  paymentRequestsTable,
  subscriptionPlansTable,
} from "@workspace/db/schema";
import { currentUser, isVipActive } from "../lib/userAuth";
import { logger } from "../lib/logger";
import { checkPayRateLimit } from "./admin";

const router: Router = Router();

/* Admin-editable keys (write side lives in admin.ts /settings). */
const K_WALLET = "payment_vodafone_number";
const K_INSTR = "payment_instructions";

async function readSettings(): Promise<{ wallet: string; instructions: string }> {
  const rows = await db.select().from(appSettingsTable);
  let wallet = "01008605139";
  let instructions = "حوّل المبلغ على رقم المحفظة ثم ارفع صورة إثبات التحويل وأدخل رقم العملية.";
  const w = rows.find((r) => r.key === K_WALLET);
  const i = rows.find((r) => r.key === K_INSTR);
  if (w?.value) wallet = w.value;
  if (i?.value) instructions = i.value;
  return { wallet, instructions };
}

/* ── Public config: what the subscribe flow needs (no auth) ── */
router.get("/payments/config", async (_req: Request, res: Response) => {
  try {
    const { wallet, instructions } = await readSettings();
    const plans = await db
      .select({
        key: subscriptionPlansTable.key,
        nameAr: subscriptionPlansTable.nameAr,
        price: subscriptionPlansTable.price,
        durationMonths: subscriptionPlansTable.durationMonths,
        badge: subscriptionPlansTable.badge,
      })
      .from(subscriptionPlansTable)
      .where(eq(subscriptionPlansTable.isActive, true))
      .orderBy(asc(subscriptionPlansTable.price));
    res.json({ status: "ok", walletNumber: wallet, instructions, method: "vodafone", plans });
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
        price: paymentRequestsTable.price,
        tx: paymentRequestsTable.tx,
        status: paymentRequestsTable.status,
        notes: paymentRequestsTable.notes,
        createdAt: paymentRequestsTable.createdAt,
      })
      .from(paymentRequestsTable)
      .where(eq(paymentRequestsTable.phone, user.phone))
      .orderBy(desc(paymentRequestsTable.createdAt))
      .limit(10);
    res.json({ status: "ok", requests: rows, plan: user.plan ?? "free" });
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

  /* VIP already active → no reason to pay again. DB-backed check handles
   * stale JWT claims in both directions (upgraded after login / revoked). */
  if (await isVipActive(user)) {
    res.status(409).json({ status: "error", message: "اشتراكك VIP نشط بالفعل — لا حاجة للدفع" });
    return;
  }

  const b = (req.body || {}) as Record<string, unknown>;
  const planKey = String(b.planKey || "").trim().replace(/[^a-z0-9_\-]/gi, "").slice(0, 30);
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

    /* tx uniqueness: DB unique index (lower(tx), pay_method) is the hard
     * guarantee — the catch below turns a race into a clean 409. */
    const [dup] = await db
      .select({ id: paymentRequestsTable.id })
      .from(paymentRequestsTable)
      .where(eq(paymentRequestsTable.tx, tx))
      .limit(1);
    if (dup) {
      res.status(409).json({ status: "error", message: "رقم العملية مستخدم من قبل — كل تحويل له رقم مختلف" });
      return;
    }

    await db.insert(paymentRequestsTable).values({
      id,
      phone: user.phone,
      name: user.name || user.phone,
      planKey: plan.key,
      payMethod: "vodafone",
      price: plan.price,
      tx,
      status: "pending",
      proofImage,
      proofName: proofName || null,
    });
    logger.info({ phone: user.phone, planKey: plan.key, price: plan.price }, "vodafone payment request submitted");
    res.json({ status: "ok", id, message: "تم إرسال طلبك — جاري مراجعة الدفع" });
  } catch (e: unknown) {
    const msg = String(e);
    if (msg.includes("payment_requests_tx_method_uidx") || msg.includes("unique")) {
      res.status(409).json({ status: "error", message: "رقم العملية مستخدم من قبل — كل تحويل له رقم مختلف" });
      return;
    }
    logger.error({ err: e }, "vodafone payment create error");
    res.status(500).json({ status: "error", message: "server error" });
  }
});

export default router;
