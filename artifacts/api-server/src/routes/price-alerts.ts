import crypto from "node:crypto";
import { Router, type Request, type Response } from "express";
import { and, eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { appUsersTable, userNotificationsTable, userPriceAlertsTable } from "@workspace/db/schema";
import { EGX_STOCKS } from "../lib/market-data/catalog";
import { currentAppOwner, requireVipFeature } from "../lib/userAuth";
import { escapeHtml, isSmtpConfigured, sendMail } from "../lib/mailer";
import { attachMarketValue, computePortfolio } from "../lib/portfolio-accounting";
import { logger } from "../lib/logger";
import { getStocksSnapshot, type StockQuote } from "./markets";
import { loadUserLedger } from "./portfolio";
import { notifPrefEnabled } from "../lib/notifications";

const router = Router();
const SYMBOL_RX = /^[A-Z0-9._-]{1,16}$/;
const ID_RX = /^[a-z0-9-]{20,80}$/i;
const CONDITIONS = new Set([
  "price_above", "price_below", "change_percent_above", "change_percent_below",
  /* Portfolio-level alerts reuse this same system (same table, evaluation
   * job, notifications and e-mail path) with reserved pseudo-symbols. */
  "portfolio_value_above", "portfolio_value_below", "concentration_above",
] as const);
type AlertCondition =
  | "price_above" | "price_below" | "change_percent_above" | "change_percent_below"
  | "portfolio_value_above" | "portfolio_value_below" | "concentration_above";

/** Reserved pseudo-symbols for portfolio-level alert conditions. */
export const PORTFOLIO_ALERT_SYMBOL = "PORTFOLIO";
export const CONCENTRATION_ALERT_SYMBOL = "CONCENTRATION";
export const PORTFOLIO_CONDITIONS: readonly AlertCondition[] = [
  "portfolio_value_above", "portfolio_value_below", "concentration_above",
];
export function isPortfolioCondition(condition: AlertCondition): boolean {
  return condition === "portfolio_value_above" || condition === "portfolio_value_below" || condition === "concentration_above";
}

type AlertInput = { symbol: string; condition: AlertCondition; targetValue: number; emailEnabled: boolean };

function canonicalInstrument(symbol: string) {
  return EGX_STOCKS.find((definition) => definition.sym.toUpperCase() === symbol) ?? null;
}

function parseAlertInput(raw: unknown): AlertInput | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const body = raw as Record<string, unknown>;
  const condition = String(body.condition || "") as AlertCondition;
  const targetValue = Number(body.targetValue);
  if (!CONDITIONS.has(condition) || !Number.isFinite(targetValue)) return null;

  if (isPortfolioCondition(condition)) {
    /* The server owns the pseudo-symbol; the client's symbol field is
     * deliberately ignored for these conditions. */
    const symbol = condition === "concentration_above" ? CONCENTRATION_ALERT_SYMBOL : PORTFOLIO_ALERT_SYMBOL;
    if (condition === "concentration_above") {
      if (targetValue <= 0 || targetValue > 100) return null;
    } else {
      if (targetValue <= 0 || targetValue > 1_000_000_000) return null;
    }
    return { symbol, condition, targetValue, emailEnabled: body.emailEnabled === true };
  }

  const symbol = String(body.symbol || "").trim().toUpperCase();
  if (!SYMBOL_RX.test(symbol)) return null;
  const isPrice = condition === "price_above" || condition === "price_below";
  if ((isPrice && (targetValue <= 0 || targetValue > 1_000_000_000))
    || (!isPrice && (targetValue === 0 || targetValue < -1_000 || targetValue > 1_000))) return null;
  return { symbol, condition, targetValue, emailEnabled: body.emailEnabled === true };
}

function validEmail(value: string | null): value is string {
  return !!value && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value);
}

export function evaluatePriceAlert(condition: AlertCondition, targetValue: number, quote: Pick<StockQuote, "price" | "chgPct">): boolean {
  if (condition === "price_above") return typeof quote.price === "number" && quote.price >= targetValue;
  if (condition === "price_below") return typeof quote.price === "number" && quote.price <= targetValue;
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

router.get("/price-alerts", requireVipFeature("price_alerts"), async (req: Request, res: Response) => {
  const user = await currentAppOwner(req);
  if (!user) {
    res.status(401).json({ status: "error", message: "login required" });
    return;
  }
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

router.post("/price-alerts", requireVipFeature("price_alerts"), async (req: Request, res: Response) => {
  const user = await currentAppOwner(req);
  if (!user) {
    res.status(401).json({ status: "error", message: "login required" });
    return;
  }
  const input = parseAlertInput(req.body);
  if (!input) {
    res.status(400).json({ status: "error", message: "بيانات التنبيه غير صحيحة" });
    return;
  }
  const portfolioAlert = isPortfolioCondition(input.condition);
  const definition = portfolioAlert ? null : canonicalInstrument(input.symbol);
  if (!portfolioAlert && !definition) {
    res.status(400).json({ status: "error", message: "رمز السهم غير مدعوم في تنبيهات EGX حاليًا" });
    return;
  }
  const instrumentId = portfolioAlert
    ? (input.condition === "concentration_above" ? "portfolio:concentration" : "portfolio:value")
    : definition!.id;
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
    const duplicate = rows.find((row) => row.symbol === input.symbol
      && row.condition === input.condition && Number(row.targetValue) === input.targetValue);
    const now = new Date();
    if (duplicate?.status === "active") {
      res.status(409).json({ status: "error", message: "هذا التنبيه موجود بالفعل" });
      return;
    }
    if (duplicate) {
      await db.update(userPriceAlertsTable).set({
        instrumentId,
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
      instrumentId,
      symbol: input.symbol,
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

router.delete("/price-alerts/:id", requireVipFeature("price_alerts"), async (req: Request, res: Response) => {
  const user = await currentAppOwner(req);
  if (!user) {
    res.status(401).json({ status: "error", message: "login required" });
    return;
  }
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
    portfolio_value_above: "قيمة المحفظة وصلت إلى أو تجاوزت",
    portfolio_value_below: "قيمة المحفظة وصلت إلى أو هبطت دون",
    concentration_above: "حصة أكبر سهم وصلت إلى أو تجاوزت",
  } as Record<AlertCondition, string>)[condition];
}

function isPercentCondition(condition: AlertCondition): boolean {
  return condition === "change_percent_above" || condition === "change_percent_below" || condition === "concentration_above";
}

function alertEmailHtml(input: { name: string; symbol: string; condition: AlertCondition; target: number; actual: number; source: string; asOf: Date; portfolio?: boolean }) {
  const unit = isPercentCondition(input.condition) ? "%" : " ج";
  const heading = input.portfolio ? "🔔 تنبيه المحفظة — EgyTrend" : "🔔 تنبيه سعر — EgyTrend";
  const subject = input.portfolio
    ? "حقق شرط تنبيه المحفظة الذي اخترته."
    : `حقق شرط تنبيهك لسهم <b>${escapeHtml(input.symbol)}</b>.`;
  return `<!doctype html><html dir="rtl" lang="ar"><body style="font-family:Tahoma,Arial,sans-serif;background:#f4f6f5;padding:20px;color:#111827;">
    <div style="max-width:520px;margin:auto;background:#fff;border-radius:14px;padding:22px;border:1px solid #e5e7eb;">
      <h2 style="margin:0;color:#047857">${heading}</h2>
      <p>مرحبًا ${escapeHtml(input.name)}، ${subject}</p>
      <p><b>${escapeHtml(conditionLabel(input.condition))}</b> ${input.target}${unit}. القيمة عند التحقق: <b>${input.actual}${unit}</b>.</p>
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
  const jobs: Array<{ candidate: TriggerCandidate; actual: number; source: string; asOf: Date; portfolio: boolean }> = [];
  const userIdToValuation = new Map<number, UserValuation | null>();

  for (const candidate of candidates) {
    const target = Number(candidate.targetValue);
    if (!Number.isFinite(target)) continue;

    if (isPortfolioCondition(candidate.condition)) {
      /* Portfolio-level alert: the "quote" is the user's own ledger valued
       * with the same fresh licensed quotes. No price ⇒ not evaluable, and
       * the alert simply waits for the next run with real data. */
      const actual = await portfolioActualValue(candidate, userIdToValuation, quoteBySymbol);
      if (actual === null) {
        await db.update(userPriceAlertsTable).set({ lastEvaluatedAt: now, updatedAt: now })
          .where(and(eq(userPriceAlertsTable.id, candidate.id), eq(userPriceAlertsTable.status, "active")));
        continue;
      }
      if (!evaluatePortfolioCondition(candidate.condition, target, actual)) {
        await db.update(userPriceAlertsTable).set({ lastEvaluatedAt: now, updatedAt: now })
          .where(and(eq(userPriceAlertsTable.id, candidate.id), eq(userPriceAlertsTable.status, "active")));
        continue;
      }
      const transitioned = await triggerAlert(candidate, actual, "المحفظة + أسعار مرخّصة", now);
      if (!transitioned) continue;
      await insertAlertNotification(candidate, target, actual, now);
      jobs.push({ candidate, actual, source: "المحفظة + أسعار مرخّصة", asOf: now, portfolio: true });
      continue;
    }

    const quote = quoteBySymbol.get(candidate.symbol.toUpperCase());
    if (!quote) continue;
    const actualValue = isPercentCondition(candidate.condition) ? quote.chgPct : quote.price;
    if (!Number.isFinite(actualValue)) continue;
    const actual = Number(actualValue);
    if (!evaluatePriceAlert(candidate.condition, target, quote)) {
      await db.update(userPriceAlertsTable).set({ lastEvaluatedAt: now, updatedAt: now })
        .where(and(eq(userPriceAlertsTable.id, candidate.id), eq(userPriceAlertsTable.status, "active")));
      continue;
    }
    const transitioned = await triggerAlert(candidate, actual, quote.source || null, new Date(quote.ts));
    if (!transitioned) continue;
    await insertAlertNotification(candidate, target, actual, now);
    jobs.push({ candidate, actual, source: quote.source || "غير متاح", asOf: new Date(quote.ts), portfolio: false });
  }

  let emailDelivered = 0;
  for (const job of jobs) {
    const { candidate, actual, source, asOf, portfolio } = job;
    if (!candidate.emailEnabled) continue;
    if (!validEmail(candidate.email) || !isSmtpConfigured()) {
      await db.update(userPriceAlertsTable).set({ emailStatus: "unavailable", updatedAt: new Date() })
        .where(eq(userPriceAlertsTable.id, candidate.id));
      continue;
    }
    /* Development and production both send only to this alert owner's account;
     * there is no operator copy/catch-all recipient. */
    const delivery = await sendMail(candidate.email, portfolio ? "EgyTrend — تنبيه المحفظة" : `EgyTrend — تنبيه ${candidate.symbol}`, alertEmailHtml({
      name: candidate.name,
      symbol: candidate.symbol,
      condition: candidate.condition,
      target: Number(candidate.targetValue),
      actual,
      source,
      asOf,
      portfolio,
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

/**
 * Pure portfolio valuation used by the alert job. Exported for unit tests —
 * the same math the /api/portfolio endpoint shows the user, derived from the
 * ledger plus verified quotes only (no stale or invented prices).
 */
export function computePortfolioValuation(
  transactions: ReadonlyArray<{ id: string; symbol: string; side: "buy" | "sell"; quantity: number; price: number; fees: number; tradeDate: string; createdAtMs: number }>,
  legacy: ReadonlyArray<{ symbol: string; quantity: number; averageCost: string | number }>,
  startingCash: number,
  quotes: ReadonlyMap<string, { price?: number; source?: string } | null | undefined>,
): { totalValue: number | null; topConcentrationPct: number | null } {
  const computation = computePortfolio(transactions, startingCash);
  const extraHeld = new Map(legacy.map((row) => [row.symbol.toUpperCase(), { quantity: row.quantity, averageCost: Number(row.averageCost) }]));
  const market = attachMarketValue(computation, quotes, extraHeld);
  return { totalValue: market.totalValue, topConcentrationPct: market.topConcentrationPct };
}

/**
 * Memoized per-user portfolio valuation for one evaluation run. A user's
 * ledger is read at most once even with several portfolio alerts.
 */
type UserValuation = { totalValue: number | null; topConcentrationPct: number | null };
async function portfolioActualValue(
  candidate: TriggerCandidate,
  cache: Map<number, UserValuation | null>,
  quoteBySymbol: Map<string, StockQuote>,
): Promise<number | null> {
  if (!cache.has(candidate.userId)) {
    try {
      const { transactions, legacyRows, startingCash } = await loadUserLedger(candidate.userId);
      const valuation = computePortfolioValuation(
        transactions,
        legacyRows.map((row) => ({ symbol: row.symbol, quantity: row.quantity, averageCost: row.averageCost })),
        startingCash,
        quoteBySymbol,
      );
      cache.set(candidate.userId, valuation);
    } catch (error) {
      logger.warn({ err: (error as Error).message, userId: candidate.userId }, "portfolio alert valuation failed");
      cache.set(candidate.userId, null);
    }
  }
  const valuation = cache.get(candidate.userId);
  if (!valuation) return null;
  const actual = candidate.condition === "concentration_above" ? valuation.topConcentrationPct : valuation.totalValue;
  return actual === null || !Number.isFinite(actual) ? null : actual;
}

export function evaluatePortfolioCondition(condition: AlertCondition, targetValue: number, actual: number): boolean {
  if (condition === "portfolio_value_above") return actual >= targetValue;
  if (condition === "portfolio_value_below") return actual <= targetValue;
  if (condition === "concentration_above") return actual >= targetValue;
  return false;
}

/**
 * The conditional active→triggered transition is the idempotency boundary:
 * concurrent scheduler invocations cannot notify or email the same alert twice.
 */
async function triggerAlert(candidate: TriggerCandidate, actual: number, source: string | null, asOf: Date): Promise<boolean> {
  const now = new Date();
  const transitioned = await db.update(userPriceAlertsTable).set({
    status: "triggered",
    lastEvaluatedAt: now,
    triggeredAt: now,
    triggerValue: String(actual),
    triggerSource: source,
    triggerAsOf: asOf,
    emailStatus: candidate.emailEnabled ? "pending" : "not_requested",
    updatedAt: now,
  }).where(and(eq(userPriceAlertsTable.id, candidate.id), eq(userPriceAlertsTable.status, "active")))
    .returning({ id: userPriceAlertsTable.id });
  return transitioned.length > 0;
}

/**
 * Exported for unit tests. The in-platform row respects the user's
 * notification-center preference ("price" family) — the alert itself has
 * already transitioned to triggered (and e-mail is a separate, per-alert
 * choice), so disabling the feed never swallows a user-requested trigger.
 */
export async function insertAlertNotification(candidate: TriggerCandidate, target: number, actual: number, now: Date): Promise<void> {
  if (!(await notifPrefEnabled(candidate.phone, "price"))) return;
  const unit = isPercentCondition(candidate.condition) ? "%" : " ج";
  const title = isPortfolioCondition(candidate.condition) ? "🔔 تنبيه المحفظة" : `🔔 تنبيه ${candidate.symbol}`;
  await db.insert(userNotificationsTable).values({
    id: `price-${candidate.id}-${now.getTime()}`,
    phone: candidate.phone,
    kind: "price_alert",
    title,
    body: `${conditionLabel(candidate.condition)} ${target}${unit}. القيمة عند التحقق: ${actual}${unit}.`,
  });
}

function cronAuthorized(req: Request): boolean {
  const configured = process.env["CRON_SECRET"];
  const supplied = String(req.header("x-cron-secret") || "");
  if (!configured || !supplied) return false;
  const a = Buffer.from(configured);
  const b = Buffer.from(supplied);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function vercelCronAuthorized(req: Request): boolean {
  const userAgent = String(req.get("user-agent") || "").toLowerCase();
  const schedule = String(req.get("x-vercel-cron-schedule") || "").trim();
  return userAgent.startsWith("vercel-cron") && schedule.length > 0;
}

async function runPriceAlertsCronHandler(req: Request, res: Response): Promise<void> {
  if (!process.env["CRON_SECRET"]) {
    res.status(503).json({ status: "error", message: "price alert scheduler is not configured" });
    return;
  }
  if (!cronAuthorized(req) && !vercelCronAuthorized(req)) {
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
}

router.post("/internal/price-alerts/run", (req: Request, res: Response) => {
  void runPriceAlertsCronHandler(req, res);
});

/* Vercel's scheduler issues a plain GET (it cannot attach custom headers) —
   the same platform-marker pattern as the opportunities/backups crons. */
router.get("/internal/price-alerts/run", (req: Request, res: Response) => {
  if (!vercelCronAuthorized(req)) {
    res.status(404).json({ status: "error", message: "not found" });
    return;
  }
  void runPriceAlertsCronHandler(req, res);
});

export default router;
