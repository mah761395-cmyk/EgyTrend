import crypto from "node:crypto";
import { Router, type Request, type Response } from "express";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@workspace/db";
import { portfolioCashEventsTable, portfolioPositionsTable, portfolioSettingsTable, portfolioTransactionsTable } from "@workspace/db/schema";
import {
  attachMarketValue,
  cashBalanceOn,
  cashEventDelta,
  computePortfolio,
  quoteVerified,
  round6,
  type CashEventKind,
  type CashEventLike,
  type PortfolioTxInput,
  type TradeEvent,
  type TradeSide,
} from "../lib/portfolio-accounting";
import { EGX_STOCKS, type StockDefinition } from "../lib/market-data/catalog";
import {
  resolveMarketHistoryReadRepository,
  selectOneSource,
  sourceMeta,
  type StoredMarketOhlc,
} from "../lib/market-data/history";
import {
  buildPortfolioSeries,
  parsePortfolioSeriesRange,
  seriesWindow,
  type HeldSymbol,
} from "../lib/portfolio-series";
import { currentAppOwner, requireVipFeature } from "../lib/userAuth";
import { activeHistoryRedisplaySources, getStocksSnapshot, type StockQuote } from "./markets";
import { logger } from "../lib/logger";
import { withTimeout } from "../lib/with-timeout";

const router = Router();
const SYMBOL_RX = /^[A-Z0-9._-]{1,16}$/;
const ID_RX = /^[a-z0-9-]{20,80}$/i;
const DATE_RX = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TX_HISTORY = 200;
const MAX_PRICE = 1_000_000;
const MAX_FEES = 1_000_000;
const MAX_CASH = 1_000_000_000;

type PositionInput = {
  symbol: string;
  quantity: number;
  averageCost: number;
};

type TransactionInput = {
  symbol: string;
  side: TradeSide;
  quantity: number;
  price: number;
  fees: number;
  tradeDate: string;
  note: string | null;
};

function parsePositionInput(raw: unknown): PositionInput | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const body = raw as Record<string, unknown>;
  const symbol = String(body.symbol || "").trim().toUpperCase();
  const quantity = Number(body.quantity);
  const averageCost = Number(body.averageCost);
  if (!SYMBOL_RX.test(symbol)
    || !Number.isInteger(quantity) || quantity < 1 || quantity > 1_000_000_000
    || !Number.isFinite(averageCost) || averageCost <= 0 || averageCost > 1_000_000_000) return null;
  return { symbol, quantity, averageCost };
}

function parseDate(value: unknown): string | null {
  const text = String(value || "").trim();
  if (!DATE_RX.test(text)) return null;
  const [y, m, d] = text.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  if (text < "2000-01-01" || text > "2100-12-31") return null;
  return text;
}

/** Calendar date "today" in the user's market timezone (Cairo), YYYY-MM-DD. */
function cairoToday(): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Africa/Cairo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

/** drizzle `date` columns may surface as Date or as YYYY-MM-DD text; normalize. */
export function dateOnly(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value ?? "").slice(0, 10);
}

function parseTransactionInput(raw: unknown): TransactionInput | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const body = raw as Record<string, unknown>;
  const symbol = String(body.symbol || "").trim().toUpperCase();
  const side = body.side === "buy" || body.side === "sell" ? body.side : null;
  const quantity = Number(body.quantity);
  const price = Number(body.price);
  const fees = body.fees === undefined || body.fees === null || body.fees === "" ? 0 : Number(body.fees);
  const note = body.note === undefined || body.note === null ? null : String(body.note).trim().slice(0, 200) || null;
  if (!SYMBOL_RX.test(symbol) || !side
    || !Number.isInteger(quantity) || quantity < 1 || quantity > 1_000_000_000
    || !Number.isFinite(price) || price < 0.01 || price > MAX_PRICE
    || !Number.isFinite(fees) || fees < 0 || fees > MAX_FEES) return null;
  return { symbol, side, quantity, price, fees, tradeDate: "", note };
}

function canonicalInstrument(symbol: string) {
  return EGX_STOCKS.find((definition) => definition.sym.toUpperCase() === symbol) ?? null;
}

/** A symbol outside the curated catalog is accepted only when the licensed
 *  scanner currently prices it — the same list /api/markets/stocks serves to
 *  the UI (296 listed EGX equities, not the curated subset). Name and sector
 *  then come from that live, sourced row — never invented. If the scan is
 *  unavailable the curated catalog alone decides, and a symbol that can be
 *  verified by neither is refused, exactly like before. */
async function resolveInstrumentSymbol(symbol: string): Promise<StockDefinition | null> {
  const curated = canonicalInstrument(symbol);
  if (curated) return curated;
  try {
    const quotes = await withTimeout(getStocksSnapshot(), 4_000, null);
    const live = (quotes || []).find((quote) => quoteVerified(quote) && quote.sym.toUpperCase() === symbol);
    if (!live) return null;
    return { id: `stock:egx:${symbol}`, sym: symbol, name: live.name || symbol, sector: live.sector || "غير محدد" };
  } catch {
    return null;
  }
}

function publicMarket(quote: StockQuote | undefined) {
  if (!quoteVerified(quote)) return null;
  return {
    price: quote.price,
    source: quote.source,
    asOf: quote.ts,
    delayedMinutes: quote.delayedMinutes,
    freshness: quote.freshness,
  };
}

/**
 * The user's ledger: active transactions in stable order, legacy active
 * positions (old aggregated model) and declared starting cash. Exported so
 * the price-alert evaluation job reuses the exact same read path (no
 * duplicated queries or math).
 */
export async function loadUserLedger(userId: number) {
  const [txRows, legacyRows, settingsRows, cashRows] = await Promise.all([
    db.select().from(portfolioTransactionsTable)
      .where(and(eq(portfolioTransactionsTable.userId, userId), isNull(portfolioTransactionsTable.archivedAt)))
      .orderBy(portfolioTransactionsTable.tradeDate, portfolioTransactionsTable.createdAt),
    db.select().from(portfolioPositionsTable)
      .where(and(eq(portfolioPositionsTable.userId, userId), eq(portfolioPositionsTable.status, "active")))
      .orderBy(portfolioPositionsTable.createdAt),
    db.select().from(portfolioSettingsTable).where(eq(portfolioSettingsTable.userId, userId)),
    db.select().from(portfolioCashEventsTable)
      .where(and(eq(portfolioCashEventsTable.userId, userId), isNull(portfolioCashEventsTable.archivedAt)))
      .orderBy(portfolioCashEventsTable.tradeDate, portfolioCashEventsTable.createdAt),
  ]);
  const transactions: PortfolioTxInput[] = txRows.map((row) => ({
    id: row.id,
    symbol: row.symbol,
    side: row.side as TradeSide,
    quantity: row.quantity,
    price: Number(row.price),
    fees: Number(row.fees),
    tradeDate: dateOnly(row.tradeDate),
    createdAtMs: row.createdAt.getTime(),
  }));
  const startingCash = settingsRows.length ? Number(settingsRows[0].startingCash) : 0;
  const cashEvents: CashEventLike[] = cashRows.map((row) => ({
    id: row.id,
    kind: row.kind as CashEventKind,
    amount: Number(row.amount),
    tradeDate: dateOnly(row.tradeDate),
    createdAtMs: row.createdAt.getTime(),
  }));
  return { transactions, legacyRows, startingCash, cashEvents };
}

/**
 * Write validation: compute the ledger after applying the candidate change.
 * A sell that would exceed the held quantity at its date is rejected — the
 * client shows the exact held amount from the returned error.
 */
function timelineErrors(transactions: PortfolioTxInput[]): { txId: string; held: number; requested: number; symbol: string; tradeDate: string } | null {
  const computation = computePortfolio(transactions);
  for (const error of computation.errors) {
    return { txId: error.txId, held: error.held, requested: error.requested, symbol: error.symbol, tradeDate: error.tradeDate };
  }
  return null;
}

function publicTransaction(row: {
  id: string; symbol: string; side: string; quantity: number; price: string | number;
  fees: string | number; tradeDate: Date | string; note: string | null;
  createdAt: Date; updatedAt: Date;
}, event?: TradeEvent) {
  return {
    id: row.id,
    symbol: row.symbol,
    side: row.side,
    quantity: row.quantity,
    price: Number(row.price),
    fees: Number(row.fees),
    tradeDate: dateOnly(row.tradeDate),
    note: row.note ?? null,
    realizedPnl: event?.realizedPnl ?? null,
    heldAfter: event ? event.heldAfter : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/* All portfolio reads/writes require the central server-side entitlement.
 * Local storage may still hold old UI preferences, but never portfolio truth. */
router.get("/portfolio", requireVipFeature("portfolio"), async (req: Request, res: Response) => {
  const user = await currentAppOwner(req);
  if (!user) {
    res.status(401).json({ status: "error", message: "login required" });
    return;
  }
  try {
    const { transactions, legacyRows, startingCash, cashEvents } = await loadUserLedger(user.sub);
    const computation = computePortfolio(transactions, startingCash);
    /* Cash = trade-derived cash + non-trade cash movements (deposits,
     * dividends in; withdrawals out). Both halves are computed here; the
     * client renders the number, it never derives it. */
    const cashEventsDelta = cashEvents.reduce((sum, event) => sum + cashEventDelta(event.kind, event.amount), 0);
    const totalCash = round6(computation.cash + cashEventsDelta);
    const eventsByTx = new Map(computation.events.map((event) => [event.txId, event]));

    /* Quotes are optional presentation data. A failed/unlicensed provider
     * produces `market: null`, not a fabricated zero or server timestamp.
     * A cold instance may still be fetching the full stock snapshot when this
     * request arrives; positions must return immediately, so the quote wait
     * is time-boxed (the in-flight snapshot keeps finishing for the cache). */
    let quotes: Awaited<ReturnType<typeof getStocksSnapshot>> = null;
    try { quotes = await withTimeout(getStocksSnapshot(), 4_000, null); } catch (error) {
      logger.warn({ err: (error as Error).message }, "portfolio quote snapshot unavailable");
    }
    const quoteBySymbol = new Map((quotes || []).filter(quoteVerified).map((quote) => [quote.sym.toUpperCase(), quote]));
    const extraHeld = new Map(
      legacyRows.map((row) => [row.symbol.toUpperCase(), { quantity: row.quantity, averageCost: Number(row.averageCost) }]),
    );
    /* Valuation reads `cash` from the computation; hand it the event-adjusted
     * balance so total value reflects deposits/withdrawals/dividends too. */
    const market = attachMarketValue({ ...computation, cash: totalCash }, quoteBySymbol, extraHeld);

    const positions: unknown[] = [];
    for (const symbol of computation.symbolOrder) {
      const ledger = computation.bySymbol.get(symbol)!;
      /* Held positions always appear; fully closed symbols (0 held but with
       * trade history) stay visible with their realized result. */
      if (ledger.quantity <= 0 && ledger.buyCount + ledger.sellCount === 0) continue;
      const entry = market.perSymbol.get(symbol.toUpperCase()) ?? null;
      const catalog = canonicalInstrument(symbol);
      positions.push({
        id: `pos:${symbol.toLowerCase()}`,
        instrumentId: catalog?.id ?? null,
        symbol,
        name: catalog?.name ?? null,
        sector: catalog?.sector ?? null,
        quantity: ledger.quantity,
        averageCost: ledger.averageCost,
        currency: "EGP",
        costBasis: ledger.costBasis,
        realizedPnl: ledger.realizedPnl,
        totalFees: ledger.totalFees,
        buyCount: ledger.buyCount,
        sellCount: ledger.sellCount,
        legacy: false,
        closed: ledger.quantity === 0,
        market: publicMarket(quoteBySymbol.get(symbol.toUpperCase())),
        marketValue: entry?.marketValue ?? null,
        unrealizedPnl: entry?.unrealizedPnl ?? null,
        unrealizedPnlPct: entry?.unrealizedPnlPct ?? null,
        weightPct: entry?.weightPct ?? null,
      });
    }
    for (const row of legacyRows) {
      if (computation.bySymbol.has(row.symbol.toUpperCase())) continue; // trades exist: the ledger owns this symbol
      const entry = market.perSymbol.get(row.symbol.toUpperCase()) ?? null;
      const catalog = canonicalInstrument(row.symbol);
      positions.push({
        id: row.id,
        instrumentId: row.instrumentId,
        symbol: row.symbol,
        name: catalog?.name ?? null,
        sector: catalog?.sector ?? null,
        quantity: row.quantity,
        averageCost: Number(row.averageCost),
        currency: row.currency,
        costBasis: row.quantity * Number(row.averageCost),
        realizedPnl: 0,
        totalFees: 0,
        buyCount: 0,
        sellCount: 0,
        legacy: true,
        closed: false,
        market: publicMarket(quoteBySymbol.get(row.symbol.toUpperCase())),
        marketValue: entry?.marketValue ?? null,
        unrealizedPnl: entry?.unrealizedPnl ?? null,
        unrealizedPnlPct: entry?.unrealizedPnlPct ?? null,
        weightPct: entry?.weightPct ?? null,
      });
    }

    const txRows = await db.select().from(portfolioTransactionsTable)
      .where(and(eq(portfolioTransactionsTable.userId, user.sub), isNull(portfolioTransactionsTable.archivedAt)))
      .orderBy(desc(portfolioTransactionsTable.tradeDate), desc(portfolioTransactionsTable.createdAt), desc(portfolioTransactionsTable.id))
      .limit(MAX_TX_HISTORY);

    const cashEventRows = await db.select().from(portfolioCashEventsTable)
      .where(and(eq(portfolioCashEventsTable.userId, user.sub), isNull(portfolioCashEventsTable.archivedAt)))
      .orderBy(desc(portfolioCashEventsTable.tradeDate), desc(portfolioCashEventsTable.createdAt), desc(portfolioCashEventsTable.id))
      .limit(MAX_TX_HISTORY);

    /* The simple model's cost belongs in the same denominator: every held
     * position counts once — trade-derived ledgers keep ownership of their
     * symbols, so only simple rows the ledger does not cover are added. */
    const investedCost = round6(computation.investedCost + legacyRows
      .filter((row) => !computation.bySymbol.has(row.symbol.toUpperCase()))
      .reduce((sum, row) => sum + row.quantity * Number(row.averageCost), 0));

    res.json({
      status: "ok",
      positions,
      summary: {
        cash: totalCash,
        /* Sums of the non-trade cash movements, for display and audit. */
        cashEventsIn: round6(cashEvents.filter((event) => event.kind !== "withdrawal").reduce((sum, event) => sum + event.amount, 0)),
        cashEventsOut: round6(cashEvents.filter((event) => event.kind === "withdrawal").reduce((sum, event) => sum + event.amount, 0)),
        investedCost,
        /* Capital deployed on buys (qty·price + buy fees), all time — the
         * documented denominator of the client-side return-on-cost %. */
        totalBuyOutlay: computation.totalBuyOutlay,
        /* Cost basis of the sold portion of every trade (fees excluded). */
        costBasisSold: computation.costBasisSold,
        pricedMarketValue: market.pricedMarketValue,
        marketValue: market.marketValue,
        totalValue: market.totalValue,
        totalValuePriced: market.totalValuePriced,
        unrealizedPnl: market.unrealizedPnl,
        unrealizedPnlPriced: market.unrealizedPnlPriced,
        realizedPnl: computation.realizedPnl,
        totalFees: computation.totalFees,
        buyCount: computation.buyCount,
        sellCount: computation.sellCount,
        topConcentrationPct: market.topConcentrationPct,
        missingPriceSymbols: market.missingSymbols,
      },
      transactions: txRows.map((row) => publicTransaction(row, eventsByTx.get(row.id))),
      /* Dated, non-trade cash movements (newest first). Soft-archived rows
       * never appear; they are audit history, not deletions. */
      cashEvents: cashEventRows.map((row) => ({
        id: row.id,
        kind: row.kind,
        amount: Number(row.amount),
        instrumentId: row.instrumentId ?? null,
        symbol: row.symbol ?? null,
        tradeDate: dateOnly(row.tradeDate),
        note: row.note ?? null,
        createdAt: row.createdAt.toISOString(),
      })),
      settings: { startingCash },
      marketAvailable: Boolean(quotes?.length),
      legacyPositions: legacyRows.length > 0,
    });
  } catch (error) {
    logger.error({ err: error }, "portfolio read failed");
    res.status(500).json({ status: "error", message: "تعذر تحميل المحفظة حاليًا" });
  }
});

router.post("/portfolio/transactions", requireVipFeature("portfolio"), async (req: Request, res: Response) => {
  const user = await currentAppOwner(req);
  if (!user) {
    res.status(401).json({ status: "error", message: "login required" });
    return;
  }
  const input = parseTransactionInput(req.body);
  if (!input) {
    res.status(400).json({ status: "error", message: "أدخل بيانات العملية بشكل صحيح (الرمز، الاتجاه، الكمية، السعر، العمولة، التاريخ)" });
    return;
  }
  const definition = await resolveInstrumentSymbol(input.symbol);
  if (!definition) {
    res.status(400).json({ status: "error", message: "رمز السهم غير مدعوم في محفظة EGX حاليًا" });
    return;
  }
  /* An explicit but malformed date is a client error — silently replacing it
   * with today would corrupt the user's ledger. Absent → today (Cairo). */
  const rawDate = req.body?.tradeDate;
  const tradeDate = rawDate === undefined || rawDate === null || rawDate === ""
    ? cairoToday()
    : parseDate(rawDate);
  if (!tradeDate) {
    res.status(400).json({ status: "error", message: "تاريخ العملية غير صالح (الصيغة: 2026-09-01)" });
    return;
  }
  if (tradeDate > cairoToday()) {
    res.status(400).json({ status: "error", message: "لا يمكن تسجيل عملية بتاريخ في المستقبل" });
    return;
  }

  try {
    const { transactions } = await loadUserLedger(user.sub);
    const candidate: PortfolioTxInput = {
      id: "candidate",
      symbol: definition.sym,
      side: input.side,
      quantity: input.quantity,
      price: input.price,
      fees: input.fees,
      tradeDate,
      createdAtMs: Date.now(),
    };
    const problem = timelineErrors([...transactions, candidate]);
    if (problem && problem.txId === "candidate") {
      res.status(400).json({
        status: "error",
        message: `لا يمكنك بيع ${problem.requested} سهم من ${definition.sym} — الكمية المتوفرة حاليًا ${problem.held} فقط`,
        held: problem.held,
      });
      return;
    }
    const id = crypto.randomUUID();
    const now = new Date();
    const [row] = await db.insert(portfolioTransactionsTable).values({
      id,
      userId: user.sub,
      instrumentId: definition.id,
      symbol: definition.sym,
      side: input.side,
      quantity: input.quantity,
      price: String(input.price),
      fees: String(input.fees),
      currency: "EGP",
      tradeDate,
      note: input.note,
      createdAt: now,
      updatedAt: now,
    }).returning();
    /* Derive this trade's own realized P/L (sells) from the recomputed ledger
     * so the response shows the exact accounting, not a client guess. */
    const storedTx: PortfolioTxInput = { ...candidate, id, createdAtMs: now.getTime() };
    const event = computePortfolio([...transactions, storedTx]).events.find((entry) => entry.txId === id);
    res.status(201).json({
      status: "ok",
      transaction: publicTransaction(row, event),
    });
  } catch (error) {
    logger.error({ err: error }, "portfolio transaction create failed");
    res.status(500).json({ status: "error", message: "تعذر حفظ العملية حاليًا" });
  }
});

router.put("/portfolio/transactions/:id", requireVipFeature("portfolio"), async (req: Request, res: Response) => {
  const user = await currentAppOwner(req);
  if (!user) {
    res.status(401).json({ status: "error", message: "login required" });
    return;
  }
  const id = String(req.params["id"] || "").trim();
  const input = parseTransactionInput(req.body);
  if (!ID_RX.test(id) || !input) {
    res.status(400).json({ status: "error", message: "بيانات العملية غير صحيحة" });
    return;
  }
  const definition = await resolveInstrumentSymbol(input.symbol);
  if (!definition) {
    res.status(400).json({ status: "error", message: "رمز السهم غير مدعوم في محفظة EGX حاليًا" });
    return;
  }
  const rawDate = req.body?.tradeDate;
  const tradeDate = rawDate === undefined || rawDate === null || rawDate === ""
    ? cairoToday()
    : parseDate(rawDate);
  if (!tradeDate) {
    res.status(400).json({ status: "error", message: "تاريخ العملية غير صالح (الصيغة: 2026-09-01)" });
    return;
  }
  if (tradeDate > cairoToday()) {
    res.status(400).json({ status: "error", message: "لا يمكن تسجيل عملية بتاريخ في المستقبل" });
    return;
  }

  try {
    const { transactions } = await loadUserLedger(user.sub);
    const existing = transactions.find((tx) => tx.id === id);
    if (!existing) {
      res.status(404).json({ status: "error", message: "العملية غير موجودة" });
      return;
    }
    const candidate: PortfolioTxInput = {
      ...existing,
      symbol: definition.sym,
      side: input.side,
      quantity: input.quantity,
      price: input.price,
      fees: input.fees,
      tradeDate,
    };
    /* Any inconsistency in the resulting timeline is rejected: the edit may
     * be to a sell, or to a buy that later sells depended on. */
    const problem = timelineErrors(transactions.filter((tx) => tx.id !== id).concat(candidate));
    if (problem) {
      res.status(400).json({
        status: "error",
        message: problem.txId === id
          ? `لا يمكنك بيع ${problem.requested} سهم من ${problem.symbol} — الكمية المتوفرة عند تاريخ العملية ${problem.held} فقط`
          : `تعذر حفظ التعديل: بيع ${problem.symbol} بتاريخ ${problem.tradeDate} أصبح أكبر من الكمية المتوفرة (${problem.held} < ${problem.requested})`,
        held: problem.held,
      });
      return;
    }
    const [updated] = await db.update(portfolioTransactionsTable).set({
      instrumentId: definition.id,
      symbol: definition.sym,
      side: input.side,
      quantity: input.quantity,
      price: String(input.price),
      fees: String(input.fees),
      tradeDate,
      note: input.note,
      updatedAt: new Date(),
    }).where(and(
      eq(portfolioTransactionsTable.id, id),
      eq(portfolioTransactionsTable.userId, user.sub),
      isNull(portfolioTransactionsTable.archivedAt),
    )).returning();
    if (!updated) {
      res.status(404).json({ status: "error", message: "العملية غير موجودة" });
      return;
    }
    res.json({ status: "ok", transaction: publicTransaction(updated) });
  } catch (error) {
    logger.error({ err: error }, "portfolio transaction update failed");
    res.status(500).json({ status: "error", message: "تعذر تحديث العملية حاليًا" });
  }
});

router.delete("/portfolio/transactions/:id", requireVipFeature("portfolio"), async (req: Request, res: Response) => {
  const user = await currentAppOwner(req);
  if (!user) {
    res.status(401).json({ status: "error", message: "login required" });
    return;
  }
  const id = String(req.params["id"] || "").trim();
  if (!ID_RX.test(id)) {
    res.status(400).json({ status: "error", message: "معرّف العملية غير صحيح" });
    return;
  }
  try {
    const { transactions } = await loadUserLedger(user.sub);
    if (!transactions.some((tx) => tx.id === id)) {
      res.status(404).json({ status: "error", message: "العملية غير موجودة" });
      return;
    }
    const remaining = transactions.filter((tx) => tx.id !== id);
    const problem = timelineErrors(remaining);
    if (problem) {
      res.status(400).json({
        status: "error",
        message: `حذف هذه العملية سيجعل بيع ${problem.symbol} بتاريخ ${problem.tradeDate} أكبر من الكمية المتوفرة (${problem.held} < ${problem.requested})`,
      });
      return;
    }
    const archived = await db.update(portfolioTransactionsTable).set({
      archivedAt: new Date(),
      updatedAt: new Date(),
    }).where(and(
      eq(portfolioTransactionsTable.id, id),
      eq(portfolioTransactionsTable.userId, user.sub),
      isNull(portfolioTransactionsTable.archivedAt),
    )).returning({ id: portfolioTransactionsTable.id });
    if (!archived.length) {
      res.status(404).json({ status: "error", message: "العملية غير موجودة" });
      return;
    }
    res.json({ status: "ok", archived: true });
  } catch (error) {
    logger.error({ err: error }, "portfolio transaction archive failed");
    res.status(500).json({ status: "error", message: "تعذر حذف العملية حاليًا" });
  }
});

router.put("/portfolio/settings", requireVipFeature("portfolio"), async (req: Request, res: Response) => {
  const user = await currentAppOwner(req);
  if (!user) {
    res.status(401).json({ status: "error", message: "login required" });
    return;
  }
  const body = (req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {}) as Record<string, unknown>;
  const startingCash = Number(body.startingCash);
  if (!Number.isFinite(startingCash) || startingCash < 0 || startingCash > MAX_CASH) {
    res.status(400).json({ status: "error", message: "أدخل رصيدًا نقديًا أوليًا صحيحًا (0 أو أكثر)" });
    return;
  }
  try {
    const now = new Date();
    const existing = await db.select({ userId: portfolioSettingsTable.userId })
      .from(portfolioSettingsTable).where(eq(portfolioSettingsTable.userId, user.sub)).limit(1);
    if (existing.length) {
      await db.update(portfolioSettingsTable).set({ startingCash: String(startingCash), updatedAt: now })
        .where(eq(portfolioSettingsTable.userId, user.sub));
    } else {
      await db.insert(portfolioSettingsTable).values({ userId: user.sub, startingCash: String(startingCash), updatedAt: now });
    }
    res.json({ status: "ok", settings: { startingCash } });
  } catch (error) {
    logger.error({ err: error }, "portfolio settings update failed");
    res.status(500).json({ status: "error", message: "تعذر حفظ الإعدادات حاليًا" });
  }
});

/* ═══════════ Cash events: deposits / withdrawals / dividends ══════════════ */

/**
 * Record one non-trade cash movement. Validation mirrors the trade ledger:
 * server-side entitlement, dated in Cairo, positive bounded amount. A
 * withdrawal may not exceed the known cash balance as of its date (the
 * balance folds in trades + earlier events), so a portfolio can never show a
 * silently-impossible negative liquidity from its own records.
 */
router.post("/portfolio/cash", requireVipFeature("portfolio"), async (req: Request, res: Response) => {
  const user = await currentAppOwner(req);
  if (!user) {
    res.status(401).json({ status: "error", message: "login required" });
    return;
  }
  const body = (req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {}) as Record<string, unknown>;
  const kind = body.kind === "deposit" || body.kind === "withdrawal" || body.kind === "dividend" ? body.kind : null;
  const amount = Number(body.amount);
  if (!kind || !Number.isFinite(amount) || amount < 0.01 || amount > MAX_CASH) {
    res.status(400).json({ status: "error", message: "أدخل نوعًا صحيحًا (إيداع/سحب/توزيعات) ومبلغًا موجبًا" });
    return;
  }
  const tradeDate = parseDate(body.tradeDate) ?? cairoToday();
  if (tradeDate > cairoToday()) {
    res.status(400).json({ status: "error", message: "التاريخ في المستقبل — سجل الحركة بتاريخ اليوم أو ما قبله" });
    return;
  }
  const note = body.note === undefined || body.note === null ? null : String(body.note).trim().slice(0, 200) || null;
  let symbol: string | null = null;
  let instrumentId: string | null = null;
  const rawSymbol = String(body.symbol ?? "").trim().toUpperCase();
  if (kind === "dividend" && rawSymbol.length > 0) {
    const catalog = canonicalInstrument(rawSymbol);
    if (!catalog) {
      res.status(400).json({ status: "error", message: "التوزيع يخص سهمًا غير موجود في كتالوج EGX — اترك حقل السهم فارغًا لتسجيل توزيع عام" });
      return;
    }
    symbol = catalog.sym;
    instrumentId = catalog.id;
  }
  try {
    const { transactions, startingCash, cashEvents } = await loadUserLedger(user.sub);
    if (kind === "withdrawal") {
      const available = cashBalanceOn(startingCash, transactions, cashEvents, tradeDate);
      if (amount > available + 1e-9) {
        res.status(400).json({
          status: "error",
          code: "insufficient_cash",
          cashAvailable: round6(available),
          message: `لا يمكن سحب ${amount} ج.م بتاريخ ${tradeDate}: الرصيد المعروف لذلك التاريخ ${round6(available)} ج.م فقط`,
        });
        return;
      }
    }
    const id = `c${crypto.randomUUID()}`;
    const now = new Date();
    await db.insert(portfolioCashEventsTable).values({
      id,
      userId: user.sub,
      kind,
      amount: String(amount),
      instrumentId,
      symbol,
      tradeDate,
      note,
      createdAt: now,
      updatedAt: now,
    });
    const totalCash = round6(cashBalanceOn(startingCash, transactions, [...cashEvents, { id, kind, amount, tradeDate, createdAtMs: now.getTime() }], cairoToday()));
    res.status(201).json({
      status: "ok",
      event: { id, kind, amount, instrumentId, symbol, tradeDate, note, createdAt: now.toISOString() },
      totalCash,
    });
  } catch (error) {
    logger.error({ err: error }, "portfolio cash event create failed");
    res.status(500).json({ status: "error", message: "تعذر تسجيل حركة النقد حاليًا" });
  }
});

/* Soft-archive one of the user's own cash events (audit trail preserved). */
router.delete("/portfolio/cash/:id", requireVipFeature("portfolio"), async (req: Request, res: Response) => {
  const user = await currentAppOwner(req);
  if (!user) {
    res.status(401).json({ status: "error", message: "login required" });
    return;
  }
  const id = String(req.params.id || "");
  if (!/^[a-z0-9-]{20,80}$/i.test(id)) {
    res.status(400).json({ status: "error", message: "معرف غير صالح" });
    return;
  }
  try {
    const now = new Date();
    const updated = await db.update(portfolioCashEventsTable)
      .set({ archivedAt: now, updatedAt: now })
      .where(and(eq(portfolioCashEventsTable.id, id), eq(portfolioCashEventsTable.userId, user.sub), isNull(portfolioCashEventsTable.archivedAt)))
      .returning({ id: portfolioCashEventsTable.id });
    if (!updated.length) {
      res.status(404).json({ status: "error", message: "الحركة غير موجودة" });
      return;
    }
    const { transactions, startingCash, cashEvents } = await loadUserLedger(user.sub);
    const totalCash = round6(cashBalanceOn(startingCash, transactions, cashEvents, cairoToday()));
    res.json({ status: "ok", deleted: true, totalCash });
  } catch (error) {
    logger.error({ err: error }, "portfolio cash event delete failed");
    res.status(500).json({ status: "error", message: "تعذر حذف حركة النقد حاليًا" });
  }
});

/* ═══════════ Value-over-time series (charts, real stored closes) ═════════ */

/* EGX30 reference index from the instrument catalog — the comparison
 * benchmark. Only used when the stored history actually contains its rows. */
const BENCHMARK_INSTRUMENT_ID = "egx:EGX30";

router.get("/portfolio/series", requireVipFeature("portfolio"), async (req: Request, res: Response) => {
  const user = await currentAppOwner(req);
  if (!user) {
    res.status(401).json({ status: "error", message: "login required" });
    return;
  }
  const range = parsePortfolioSeriesRange(req.query["range"]);
  const to = cairoToday();
  try {
    const { transactions, legacyRows, startingCash, cashEvents } = await loadUserLedger(user.sub);
    const computation = computePortfolio(transactions, startingCash);

    /* Symbols held today (ledger + legacy), with their catalog instrument
     * ids for the history store. */
    const held: HeldSymbol[] = [];
    const heldInstrumentIds = new Set<string>();
    for (const symbol of computation.symbolOrder) {
      const ledger = computation.bySymbol.get(symbol)!;
      if (ledger.quantity <= 0) continue;
      const catalog = canonicalInstrument(symbol);
      if (catalog) {
        held.push({ symbol: symbol.toUpperCase(), quantityNow: ledger.quantity, legacy: false });
        heldInstrumentIds.add(catalog.id);
      } else {
        held.push({ symbol: symbol.toUpperCase(), quantityNow: ledger.quantity, legacy: true });
      }
    }
    for (const row of legacyRows) {
      const symbol = row.symbol.toUpperCase();
      if (computation.bySymbol.has(symbol)) continue; // the ledger owns this symbol
      held.push({ symbol, quantityNow: row.quantity, legacy: true });
      if (row.instrumentId) heldInstrumentIds.add(row.instrumentId);
    }

    const earliestActivity =
      transactions.length || cashEvents.length
        ? [...transactions, ...cashEvents].map((item) => item.tradeDate).sort()[0] ?? null
        : null;

    /* One batched read from the licensed stored-history store. An empty
     * approval set means no redistribution right: fail closed, no query. */
    const allowed = activeHistoryRedisplaySources();
    const fromDate = range === "ALL" ? undefined : seriesWindow(range, to, earliestActivity).from;
    let closes: Map<string, Map<string, number>> = new Map();
    let benchmark: { symbol: string; points: Array<{ date: string; close: number }>; source: { id: string; name: string; asOf: number; delayedMinutes?: number } | null } | null = null;
    if (allowed.size > 0) {
      const repository = resolveMarketHistoryReadRepository();
      const [heldRows, benchmarkRows] = await Promise.all([
        heldInstrumentIds.size ? repository.list([...heldInstrumentIds], fromDate) : Promise.resolve([] as StoredMarketOhlc[]),
        repository.list([BENCHMARK_INSTRUMENT_ID], fromDate),
      ]);
      const idToSymbol = new Map<string, string>();
      for (const entry of held) {
        const catalog = canonicalInstrument(entry.symbol);
        if (catalog) idToSymbol.set(catalog.id, entry.symbol);
      }
      for (const row of legacyRows) {
        if (row.instrumentId) idToSymbol.set(row.instrumentId, row.symbol.toUpperCase());
      }
      const byInstrument = new Map<string, StoredMarketOhlc[]>();
      for (const row of heldRows) {
        const list = byInstrument.get(row.instrumentId) ?? [];
        list.push(row);
        byInstrument.set(row.instrumentId, list);
      }
      for (const [instrumentId, rows] of byInstrument) {
        const symbol = idToSymbol.get(instrumentId);
        if (!symbol) continue;
        const sourceRows = selectOneSource(rows, allowed);
        let dayCloses = closes.get(symbol);
        if (!dayCloses) {
          dayCloses = new Map<string, number>();
          closes.set(symbol, dayCloses);
        }
        for (const bar of sourceRows) dayCloses.set(bar.tradingDate, bar.close);
      }
      const benchmarkSourceRows = selectOneSource(benchmarkRows, allowed);
      if (benchmarkSourceRows.length) {
        benchmark = {
          symbol: "EGX30",
          points: benchmarkSourceRows.map((row) => ({ date: row.tradingDate, close: row.close })),
          source: sourceMeta(benchmarkSourceRows) ?? null,
        };
      }
    }

    res.json({
      status: "ok",
      ...buildPortfolioSeries({ range, to, startingCash, trades: transactions, cashEvents, held, closes, earliestActivity }),
      benchmark,
    });
  } catch (error) {
    logger.error({ err: error }, "portfolio series read failed");
    res.status(500).json({ status: "error", message: "تعذّر تحميل سلسلة قيمة المحفظة حاليًا", debugMsg: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
  }
});

router.get("/portfolio/report", requireVipFeature("portfolio"), async (req: Request, res: Response) => {
  const user = await currentAppOwner(req);
  if (!user) {
    res.status(401).json({ status: "error", message: "login required" });
    return;
  }
  const from = parseDate(req.query["from"] ?? "") ?? "2000-01-01";
  const to = parseDate(req.query["to"] ?? "") ?? cairoToday();
  if (from > to) {
    res.status(400).json({ status: "error", message: "الفترة غير صحيحة: التاريخ الأول بعد الثاني" });
    return;
  }
  const spanDays = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
  if (spanDays > 3650) {
    res.status(400).json({ status: "error", message: "الفترة المطلوبة أطول من الحد الأقصى (10 سنوات)" });
    return;
  }

  try {
    const { transactions } = await loadUserLedger(user.sub);
    const computation = computePortfolio(transactions);
    const inWindow = computation.events.filter((event) => event.tradeDate >= from && event.tradeDate <= to);
    const byDay = new Map<string, { date: string; realizedPnl: number; fees: number; buyCount: number; sellCount: number; buyValue: number; sellValue: number }>();
    for (const event of inWindow) {
      const day = byDay.get(event.tradeDate) ?? { date: event.tradeDate, realizedPnl: 0, fees: 0, buyCount: 0, sellCount: 0, buyValue: 0, sellValue: 0 };
      day.realizedPnl += event.realizedPnl ?? 0;
      day.fees += event.fees;
      if (event.side === "buy") { day.buyCount += 1; day.buyValue += event.quantity * event.price; }
      else { day.sellCount += 1; day.sellValue += event.quantity * event.price; }
      byDay.set(event.tradeDate, day);
    }
    const days = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
    res.json({
      status: "ok",
      from,
      to,
      realizedPnl: days.reduce((sum, day) => sum + day.realizedPnl, 0),
      fees: days.reduce((sum, day) => sum + day.fees, 0),
      buyCount: days.reduce((sum, day) => sum + day.buyCount, 0),
      sellCount: days.reduce((sum, day) => sum + day.sellCount, 0),
      buyValue: days.reduce((sum, day) => sum + day.buyValue, 0),
      sellValue: days.reduce((sum, day) => sum + day.sellValue, 0),
      byDay: days,
      allTime: {
        realizedPnl: computation.realizedPnl,
        fees: computation.totalFees,
        buyCount: computation.buyCount,
        sellCount: computation.sellCount,
      },
    });
  } catch (error) {
    logger.error({ err: error }, "portfolio report failed");
    res.status(500).json({ status: "error", message: "تعذر إعداد التقرير حاليًا" });
  }
});

/* ── Legacy aggregated-position endpoints (old UI / cached clients) ────────
 * Kept intentionally: existing user rows in portfolio_positions keep working
 * and the GET /portfolio merge reads them. New clients use /transactions. */
router.post("/portfolio/positions", requireVipFeature("portfolio"), async (req: Request, res: Response) => {
  const user = await currentAppOwner(req);
  if (!user) {
    res.status(401).json({ status: "error", message: "login required" });
    return;
  }
  const input = parsePositionInput(req.body);
  if (!input) {
    res.status(400).json({ status: "error", message: "أدخل رمزًا صحيحًا وكمية صحيحة ومتوسط تكلفة أكبر من صفر" });
    return;
  }
  const definition = await resolveInstrumentSymbol(input.symbol);
  if (!definition) {
    res.status(400).json({ status: "error", message: "رمز السهم غير مدعوم في محفظة EGX حاليًا" });
    return;
  }

  try {
    const [existing] = await db.select().from(portfolioPositionsTable)
      .where(and(eq(portfolioPositionsTable.userId, user.sub), eq(portfolioPositionsTable.symbol, definition.sym)))
      .limit(1);
    const now = new Date();
    if (existing?.status === "active") {
      res.status(409).json({ status: "error", message: "هذا السهم موجود بالفعل؛ حدّث الكمية أو متوسط التكلفة بدلًا من إضافته مرة أخرى" });
      return;
    }
    if (existing) {
      await db.update(portfolioPositionsTable).set({
        instrumentId: definition.id,
        quantity: input.quantity,
        averageCost: String(input.averageCost),
        currency: "EGP",
        status: "active",
        archivedAt: null,
        updatedAt: now,
      }).where(eq(portfolioPositionsTable.id, existing.id));
      res.json({ status: "ok", id: existing.id, restored: true });
      return;
    }
    const id = crypto.randomUUID();
    await db.insert(portfolioPositionsTable).values({
      id,
      userId: user.sub,
      instrumentId: definition.id,
      symbol: definition.sym,
      quantity: input.quantity,
      averageCost: String(input.averageCost),
      currency: "EGP",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    res.status(201).json({ status: "ok", id });
  } catch (error) {
    logger.error({ err: error }, "portfolio position create failed");
    res.status(500).json({ status: "error", message: "تعذر حفظ المركز حاليًا" });
  }
});

router.put("/portfolio/positions/:id", requireVipFeature("portfolio"), async (req: Request, res: Response) => {
  const user = await currentAppOwner(req);
  if (!user) {
    res.status(401).json({ status: "error", message: "login required" });
    return;
  }
  const id = String(req.params["id"] || "").trim();
  const input = parsePositionInput(req.body);
  if (!ID_RX.test(id) || !input) {
    res.status(400).json({ status: "error", message: "بيانات المركز غير صحيحة" });
    return;
  }
  const definition = await resolveInstrumentSymbol(input.symbol);
  if (!definition) {
    res.status(400).json({ status: "error", message: "رمز السهم غير مدعوم في محفظة EGX حاليًا" });
    return;
  }
  try {
    const updated = await db.update(portfolioPositionsTable).set({
      instrumentId: definition.id,
      symbol: definition.sym,
      quantity: input.quantity,
      averageCost: String(input.averageCost),
      updatedAt: new Date(),
    }).where(and(
      eq(portfolioPositionsTable.id, id),
      eq(portfolioPositionsTable.userId, user.sub),
      eq(portfolioPositionsTable.status, "active"),
    )).returning({ id: portfolioPositionsTable.id });
    if (!updated.length) {
      res.status(404).json({ status: "error", message: "المركز غير موجود" });
      return;
    }
    res.json({ status: "ok" });
  } catch (error) {
    logger.error({ err: error }, "portfolio position update failed");
    res.status(500).json({ status: "error", message: "تعذر تحديث المركز حاليًا" });
  }
});

router.delete("/portfolio/positions/:id", requireVipFeature("portfolio"), async (req: Request, res: Response) => {
  const user = await currentAppOwner(req);
  if (!user) {
    res.status(401).json({ status: "error", message: "login required" });
    return;
  }
  const id = String(req.params["id"] || "").trim();
  if (!ID_RX.test(id)) {
    res.status(400).json({ status: "error", message: "معرّف المركز غير صحيح" });
    return;
  }
  try {
    const archived = await db.update(portfolioPositionsTable).set({
      status: "archived",
      archivedAt: new Date(),
      updatedAt: new Date(),
    }).where(and(
      eq(portfolioPositionsTable.id, id),
      eq(portfolioPositionsTable.userId, user.sub),
      eq(portfolioPositionsTable.status, "active"),
    )).returning({ id: portfolioPositionsTable.id });
    if (!archived.length) {
      res.status(404).json({ status: "error", message: "المركز غير موجود" });
      return;
    }
    res.json({ status: "ok", archived: true });
  } catch (error) {
    logger.error({ err: error }, "portfolio position archive failed");
    res.status(500).json({ status: "error", message: "تعذر أرشفة المركز حاليًا" });
  }
});

export default router;
