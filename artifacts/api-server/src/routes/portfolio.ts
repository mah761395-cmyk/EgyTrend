import crypto from "node:crypto";
import { Router, type Request, type Response } from "express";
import { and, eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { portfolioPositionsTable } from "@workspace/db/schema";
import { EGX_STOCKS } from "../lib/market-data/catalog";
import { currentUser, requireVipFeature } from "../lib/userAuth";
import { getStocksSnapshot, type StockQuote } from "./markets";
import { logger } from "../lib/logger";
import { withTimeout } from "../lib/with-timeout";

const router = Router();
const SYMBOL_RX = /^[A-Z0-9._-]{1,16}$/;
const ID_RX = /^[a-z0-9-]{20,80}$/i;

type PositionInput = {
  symbol: string;
  quantity: number;
  averageCost: number;
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

function canonicalInstrument(symbol: string) {
  return EGX_STOCKS.find((definition) => definition.sym.toUpperCase() === symbol) ?? null;
}

function publicPosition(row: typeof portfolioPositionsTable.$inferSelect, quote?: StockQuote) {
  const averageCost = Number(row.averageCost);
  const market = quote && Number.isFinite(quote.price) && quote.source
    ? {
      price: quote.price,
      source: quote.source,
      asOf: quote.ts,
      delayedMinutes: quote.delayedMinutes,
      freshness: quote.freshness,
    }
    : null;
  /* Catalog metadata (label + sector) only. It is display grouping for the
   * portfolio analytics, never a price or a valuation input. */
  const catalog = canonicalInstrument(row.symbol);
  return {
    id: row.id,
    instrumentId: row.instrumentId,
    symbol: row.symbol,
    name: catalog?.name ?? null,
    sector: catalog?.sector ?? null,
    quantity: row.quantity,
    /* Explicitly user-entered, never represented as a market price. */
    averageCost: Number.isFinite(averageCost) ? averageCost : null,
    currency: row.currency,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    market,
  };
}

/* All portfolio reads/writes require the central server-side entitlement.
 * Local storage may still hold old UI preferences, but never portfolio truth. */
router.get("/portfolio", requireVipFeature("portfolio"), async (req: Request, res: Response) => {
  const user = currentUser(req)!;
  try {
    const rows = await db.select().from(portfolioPositionsTable)
      .where(and(eq(portfolioPositionsTable.userId, user.sub), eq(portfolioPositionsTable.status, "active")))
      .orderBy(portfolioPositionsTable.createdAt);

    /* Quotes are optional presentation data. A failed/unlicensed provider
     * produces `market: null`, not a fabricated zero or server timestamp.
     * A cold instance may still be fetching the full stock snapshot when this
     * request arrives; positions must return immediately, so the quote wait
     * is time-boxed (the in-flight snapshot keeps finishing for the cache). */
    let quotes: Awaited<ReturnType<typeof getStocksSnapshot>> = null;
    try { quotes = await withTimeout(getStocksSnapshot(), 4_000, null); } catch (error) {
      logger.warn({ err: (error as Error).message }, "portfolio quote snapshot unavailable");
    }
    const quoteBySymbol = new Map((quotes || []).map((quote) => [quote.sym.toUpperCase(), quote]));
    res.json({
      status: "ok",
      positions: rows.map((row) => publicPosition(row, quoteBySymbol.get(row.symbol.toUpperCase()))),
      marketAvailable: Boolean(quotes?.length),
    });
  } catch (error) {
    logger.error({ err: error }, "portfolio read failed");
    res.status(500).json({ status: "error", message: "تعذر تحميل المحفظة حاليًا" });
  }
});

router.post("/portfolio/positions", requireVipFeature("portfolio"), async (req: Request, res: Response) => {
  const user = currentUser(req)!;
  const input = parsePositionInput(req.body);
  if (!input) {
    res.status(400).json({ status: "error", message: "أدخل رمزًا صحيحًا وكمية صحيحة ومتوسط تكلفة أكبر من صفر" });
    return;
  }
  const definition = canonicalInstrument(input.symbol);
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
  const user = currentUser(req)!;
  const id = String(req.params["id"] || "").trim();
  const input = parsePositionInput(req.body);
  if (!ID_RX.test(id) || !input) {
    res.status(400).json({ status: "error", message: "بيانات المركز غير صحيحة" });
    return;
  }
  const definition = canonicalInstrument(input.symbol);
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
  const user = currentUser(req)!;
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
