import crypto from "node:crypto";
import { Router, type Request, type Response } from "express";
import { and, eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { appUsersTable, userNotificationsTable, userPriceAlertsTable } from "@workspace/db/schema";
import { EGX_STOCKS } from "../lib/market-data/catalog";
import { currentUser, requireVipUser } from "../lib/userAuth";
import { escapeHtml, isSmtpConfigured, sendMail } from "../lib/mailer";
import { logger } from "../lib/logger";
import { getStocksSnapshot, type StockQuote } from "./markets";

const router = Router();
const SYMBOL_RX = /^[A-Z0-9._-]{1,16}$/;
const ID_RX = /^[a-z0-9-]{20,80}$/i;
const CONDITIONS = new Set(["price_above", "price_below", "change_percent_above", "change_percent_below"] as const);
type AlertCondition = "price_above" | "price_below" | "change_percent_above" | "change_percent_below";

type AlertInput = { symbol: string; condition: AlertCondition; targetValue: number; emailEnabled: boolean };

function canonicalInstrument(symbol: string) {
  return EGX_STOCKS.find((definition) => definition.sym.toUpperCase() === symbol) ?? null;
}

function parseAlertInput(raw: unknown): AlertInput | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const body = raw as Record<string, unknown>;
  const symbol = String(body.symbol || "").trim().toUpperCase();
  const condition = String(body.condition || "") as AlertCondition;
  const targetValue = Number(body.targetValue);
  if (!SYMBOL_RX.test(symbol) || !CONDITIONS.has(condition) || !Number.isFinite(targetValue)) return null;
  const isPrice = condition === "price_above" || condition === "price_below";
  if ((isPrice && (targetValue <= 0 || targetValue > 1_000_000_000))
    || (!isPrice && (targetValue === 0 || targetValue < -1_000 || targetValue > 1_000))) return null;
  return { symbol, condition, targetValue, emailEnabled: body.emailEnabled === true };
}

function validEmail(value: string | null): value is string {
  return !!value && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value);
}

export function evaluatePriceAlert(condition: AlertCondition, targetValue: number, quote: Pick<StockQuote, "price" | "chgPct">): boolean {
  if (condition === "price_above") return Number.isFinite(quote.price) && quote.price >= targetValue;
  if (condition === "price_below") return Number.isFinite(quote.price) && quote.price <= targetValue;
  if (condition === "change_percent_above") return Number.isFinite(quote.chgPct) && (quote.chgPct as number) >= targetValue;
  return Number.isFinite(quote.chgPct) && (quote.chgPct as number) <= targetValue;
}

/** Price alerts must not fire from an unknown/end-of-day/stale quote. */
export function quoteEligibleForAlert(quote: StockQuote, now = Date.now()): boolean {
  if (!quote.source || !Number.isFinite(quote.price) || !Number.isFinite(quote.ts) || quote.ts <= 0) return false;
  if (quote.freshness === "end-of-day" || quote.freshness === "unknown") return false;
  const delay = Number.isFinite(quote.delayedMinutes) ? Math.max(0, quote.delayedMinutes as number) : 0;
  /* 20 min transmission grace above declared delay; alerting from an old cache
   * is worse than waiting for the next licensed snapshot. */
  return now - quote.ts <= (delay + 20) * 60_000;
}

function publicAlert(row: typeof userPriceAlertsTable.$inferSelect) {
  return {
    id: row.id,
    symbol: row.symbol,
    condition: row.condition,
    targetValue: Number(row.targetValue),
    emailEnabled: row.emailEnabled,
    status: row.status,
    lastEvaluatedAt: row.lastEvaluatedAt?.toISOString() || null,
    triggeredAt: row.triggeredAt?.toISOString() || null,
    triggerValue: row.triggerValue === null ? null : Number(row.triggerValue),
    triggerSource: row.triggerSource || null,
    triggerAsOf: row.triggerAsOf?.toISOString() || null,
    emailStatus: row.emailStatus,
    createdAt: row.createdAt.toISOString(),
  };
}

router.get("/price-alerts", requireVipUser, async (req: Request, res: Response) => {
  const user = currentUser(req)!;
  try {
    const rows = await db.select().from(userPriceAlertsTable)
      .where(eq(userPriceAlertsTable.userId, user.sub))
      .orderBy(userPriceAlertsTable.createdAt);
    res.json({ status: "ok", alerts: rows.map(publicAlert) });
  } catch (error) {
    logger.error({ err: error }, "price alert list failed");
    res.status(500).json({ status: "error", message: "تعذر تحميل تنبيهات الأسعار حاليًا" });
  }
});

router.post("/price-alerts", requireVipUser, async (req: Request, res: Response) => {
  const user = currentUser(req)!;
  const input = parseAlertInput(req.body);
  if (!input) {
    res.status(400).json({ status: "error", message: "بيانات التنبيه غير صحيحة" });
    return;
  }
  const definition = canonicalInstrument(input.symbol);
  if (!definition) {
    res.status(400).json({ status: "error", message: "رمز السهم غير مدعوم في تنبيهات EGX حاليًا" });
    return;
  }
  try {
    if (input.emailEnabled) {
      const [account] = await db.select({ email: appUsersTable.email }).from(appUsersTable)
        .where(eq(appUsersTable.id, user.sub)).limit(1);
      if (!validEmail(account?.email || null)) {
        res.status(400).json({ status: "error", message: "أضف بريدًا إلكترونيًا صحيحًا إلى حسابك قبل تفعيل الإرسال بالبريد" });
        return;
      }
    }
    const rows = await db.select().from(userPriceAlertsTable)
      .where(eq(userPriceAlertsTable.userId, user.sub));
    if (rows.filter((row) => row.status === "active").length >= 50) {
      res.status(429).json({ status: "error", message: "وصلت للحد الأقصى: 50 تنبيهًا فعالًا" });
      return;
    }
    const duplicate = rows.find((row) => row.symbol === definition.sym
      && row.condition === input.condition && Number(row.targetValue) === input.targetValue);
    const now = new Date();
    if (duplicate?.status === "active") {
      res.status(409).json({ status: "error", message: "هذا التنبيه موجود بالفعل" });
      return;
    }
    if (duplicate) {
      await db.update(userPriceAlertsTable).set({
        instrumentId: definition.id,
        emailEnabled: input.emailEnabled,
        status: "active",
        lastEvaluatedAt: null,
        triggeredAt: null,
        triggerValue: null,
        triggerSource: null,
        triggerAsOf: null,
        emailStatus: input.emailEnabled ? "pending" : "not_requested",
        emailSentAt: null,
        archivedAt: null,
        updatedAt: now,
      }).where(eq(userPriceAlertsTable.id, duplicate.id));
      res.json({ status: "ok", id: duplicate.id, restored: true });
      return;
    }
    const id = crypto.randomUUID();
    await db.insert(userPriceAlertsTable).values({
      id,
      userId: user.sub,
      instrumentId: definition.id,
      symbol: definition.sym,
      condition: input.condition,
      targetValue: String(input.targetValue),
      emailEnabled: input.emailEnabled,
      status: "active",
      emailStatus: input.emailEnabled ? "pending" : "not_requested",
      createdAt: now,
      updatedAt: now,
    });
    res.status(201).json({ status: "ok", id });
  } catch (error) {
    logger.error({ err: error }, "price alert create failed");
    res.status(500).json({ status: "error", message: "تعذر حفظ تنبيه السعر حاليًا" });
  }
});

router.delete("/price-alerts/:id", requireVipUser, async (req: Request, res: Response) => {
  const user = currentUser(req)!;
  const id = String(req.params["id"] || "").trim();
  if (!ID_RX.test(id)) {
    res.status(400).json({ status: "error", message: "معرّف التنبيه غير صحيح" });
    return;
  }
  try {
    const archived = await db.update(userPriceAlertsTable).set({
      status: "archived",
      archivedAt: new Date(),
      updatedAt: new Date(),
    }).where(and(
      eq(userPriceAlertsTable.id, id),
      eq(userPriceAlertsTable.userId, user.sub),
      eq(userPriceAlertsTable.status, "active"),
    )).returning({ id: userPriceAlertsTable.id });
    if (!archived.length) {
      res.status(404).json({ status: "error", message: "التنبيه غير موجود أو لم يعد فعالًا" });
      return;
    }
    res.json({ status: "ok", archived: true });
  } catch (error) {
    logger.error({ err: error }, "price alert archive failed");
    res.status(500).json({ status: "error", message: "تعذر أرشفة التنبيه حاليًا" });
  }
});

type TriggerCandidate = {
  id: string;
  userId: number;
  phone: string;
  name: string;
  email: string | null;
  symbol: string;
  condition: AlertCondition;
  targetValue: string;
  emailEnabled: boolean;
};

function conditionLabel(condition: AlertCondition): string {
  return ({
    price_above: "السعر وصل إلى أو تجاوز",
    price_below: "السعر وصل إلى أو هبط دون",
    change_percent_above: "نسبة التغير اليومية وصلت إلى أو تجاوزت",
    change_percent_below: "نسبة التغير اليومية وصلت إلى أو هبطت دون",
  } as Record<AlertCondition, string>)[condition];
}

function isPercentCondition(condition: AlertCondition): boolean {
  return condition === "change_percent_above" || condition === "change_percent_below";
}

function alertEmailHtml(input: { name: string; symbol: string; condition: AlertCondition; target: number; actual: number; source: string; asOf: Date }) {
  const unit = isPercentCondition(input.condition) ? "%" : " ج";
  return `<!doctype html><html dir="rtl" lang="ar"><body style="font-family:Tahoma,Arial,sans-serif;background:#f4f6f5;padding:20px;color:#111827;">
    <div style="max-width:520px;margin:auto;background:#fff;border-radius:14px;padding:22px;border:1px solid #e5e7eb;">
      <h2 style="margin:0;color:#047857">🔔 تنبيه سعر — EgyTrend</h2>
      <p>مرحبًا ${escapeHtml(input.name)}، تحقق شرط تنبيهك لسهم <b>${escapeHtml(input.symbol)}</b>.</p>
      <p><b>${escapeHtml(conditionLabel(input.condition))}</b> ${input.target}${unit}. القيمة التي أرسلها المصدر: <b>${input.actual}${unit}</b>.</p>
      <p style="font-size:13px;color:#4b5563">المصدر: ${escapeHtml(input.source)}<br/>وقت المصدر: ${escapeHtml(input.asOf.toLocaleString("ar-EG", { timeZone: "Africa/Cairo" }))}</p>
      <p style="font-size:12px;color:#6b7280">هذا تنبيه وصفي لشرط اخترته أنت، وليس توصية شراء أو بيع أو توقعًا.</p>
    </div></body></html>`;
}

/**
 * Runs only from a protected server-to-server scheduler route. No browser
 * request can call it, and no market provider is contacted without CRON_SECRET.
 */
export async function runPriceAlertEvaluation(): Promise<{ evaluated: number; triggered: number; emailDelivered: number }> {
  const candidates = await db.select({
    id: userPriceAlertsTable.id,
    userId: userPriceAlertsTable.userId,
    phone: appUsersTable.phone,
    name: appUsersTable.name,
    email: appUsersTable.email,
    symbol: userPriceAlertsTable.symbol,
    condition: userPriceAlertsTable.condition,
    targetValue: userPriceAlertsTable.targetValue,
    emailEnabled: userPriceAlertsTable.emailEnabled,
  }).from(userPriceAlertsTable)
    .innerJoin(appUsersTable, eq(userPriceAlertsTable.userId, appUsersTable.id))
    .where(and(eq(userPriceAlertsTable.status, "active"), eq(appUsersTable.status, "active"))) as TriggerCandidate[];
  if (!candidates.length) return { evaluated: 0, triggered: 0, emailDelivered: 0 };

  const quotes = await getStocksSnapshot();
  const quoteBySymbol = new Map((quotes || []).filter((quote) => quoteEligibleForAlert(quote)).map((quote) => [quote.sym.toUpperCase(), quote]));
  const now = new Date();
  const jobs: Array<{ candidate: TriggerCandidate; quote: StockQuote; actual: number }> = [];
  for (const candidate of candidates) {
    const quote = quoteBySymbol.get(candidate.symbol.toUpperCase());
    const target = Number(candidate.targetValue);
    if (!quote || !Number.isFinite(target)) continue;
    const actualValue = isPercentCondition(candidate.condition) ? quote.chgPct : quote.price;
    if (!Number.isFinite(actualValue)) continue;
    const actual = Number(actualValue);
    if (!evaluatePriceAlert(candidate.condition, target, quote)) {
      await db.update(userPriceAlertsTable).set({ lastEvaluatedAt: now, updatedAt: now })
        .where(and(eq(userPriceAlertsTable.id, candidate.id), eq(userPriceAlertsTable.status, "active")));
      continue;
    }
    /* Conditional state transition is the idempotency boundary: concurrent
     * scheduler invocations cannot notify or email the same alert twice. */
    const transitioned = await db.update(userPriceAlertsTable).set({
      status: "triggered",
      lastEvaluatedAt: now,
      triggeredAt: now,
      triggerValue: String(actual),
      triggerSource: quote.source || null,
      triggerAsOf: new Date(quote.ts),
      emailStatus: candidate.emailEnabled ? "pending" : "not_requested",
      updatedAt: now,
    }).where(and(eq(userPriceAlertsTable.id, candidate.id), eq(userPriceAlertsTable.status, "active")))
      .returning({ id: userPriceAlertsTable.id });
    if (!transitioned.length) continue;
    await db.insert(userNotificationsTable).values({
      id: `price-${candidate.id}-${now.getTime()}`,
      phone: candidate.phone,
      kind: "price_alert",
      title: `🔔 تنبيه ${candidate.symbol}`,
      body: `${conditionLabel(candidate.condition)} ${target}${isPercentCondition(candidate.condition) ? "%" : " ج"}. القيمة من المصدر: ${actual}${isPercentCondition(candidate.condition) ? "%" : " ج"}.`,
    });
    jobs.push({ candidate, quote, actual });
  }

  let emailDelivered = 0;
  for (const job of jobs) {
    const { candidate, quote, actual } = job;
    if (!candidate.emailEnabled) continue;
    if (!validEmail(candidate.email) || !isSmtpConfigured()) {
      await db.update(userPriceAlertsTable).set({ emailStatus: "unavailable", updatedAt: new Date() })
        .where(eq(userPriceAlertsTable.id, candidate.id));
      continue;
    }
    /* Development and production both send only to this alert owner's account;
     * there is no operator copy/catch-all recipient. */
    const delivery = await sendMail(candidate.email, `EgyTrend — تنبيه ${candidate.symbol}`, alertEmailHtml({
      name: candidate.name,
      symbol: candidate.symbol,
      condition: candidate.condition,
      target: Number(candidate.targetValue),
      actual,
      source: quote.source || "غير متاح",
      asOf: new Date(quote.ts),
    }));
    await db.update(userPriceAlertsTable).set({
      emailStatus: delivery.delivered ? "sent" : delivery.error === "smtp_not_configured" || delivery.error === "nodemailer_missing" ? "unavailable" : "failed",
      ...(delivery.delivered ? { emailSentAt: new Date() } : {}),
      updatedAt: new Date(),
    }).where(eq(userPriceAlertsTable.id, candidate.id));
    if (delivery.delivered) emailDelivered += 1;
  }
  return { evaluated: candidates.length, triggered: jobs.length, emailDelivered };
}

function cronAuthorized(req: Request): boolean {
  const configured = process.env["CRON_SECRET"];
  const supplied = String(req.header("x-cron-secret") || "");
  if (!configured || !supplied) return false;
  const a = Buffer.from(configured);
  const b = Buffer.from(supplied);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

router.post("/internal/price-alerts/run", async (req: Request, res: Response) => {
  if (!process.env["CRON_SECRET"]) {
    res.status(503).json({ status: "error", message: "price alert scheduler is not configured" });
    return;
  }
  if (!cronAuthorized(req)) {
    res.status(403).json({ status: "error", message: "forbidden" });
    return;
  }
  try {
    const result = await runPriceAlertEvaluation();
    /* Counts only: never expose users, e-mails, symbols, targets, or quotes in logs. */
    logger.info(result, "price alert evaluation complete");
    res.json({ status: "ok", ...result });
  } catch (error) {
    logger.error({ err: error }, "price alert evaluation failed");
    res.status(503).json({ status: "error", message: "price alert evaluation unavailable" });
  }
});

export default router;
