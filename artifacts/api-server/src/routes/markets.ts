import crypto from "node:crypto";
import { Router, type IRouter, type Request, type Response } from "express";
import { logger } from "../lib/logger";
import {
  EGX_STOCKS,
  MARKET_INSTRUMENTS,
  US_STOCKS,
  tvSymbolForInstrument,
  type StockDefinition,
  type TvSymbol,
} from "../lib/market-data/catalog";
import { getMarketHistorySnapshot, getMarketSparklines, parseHistoryRange, runMarketDailySnapshot } from "../lib/market-data/history";
import { currentUser, isActivePrivilegedAdmin, hasVipFeature } from "../lib/userAuth";
import { getMarketDataService, type MarketDataService, type QuoteSnapshot } from "../lib/market-data/service";
import type { CalendarEvent, CanonicalQuote, MarketInstrument, MarketSection } from "../lib/market-data/types";

const router: IRouter = Router();

/** Browser-compatible quote contract. Values only originate from a configured,
 * license-acknowledged backend provider; no frontend fallback price exists. */
type Quote = {
  /** Canonical server-side ID for history lookups; never a UI-derived symbol. */
  id: string;
  n: string;
  v: string;
  c: string;
  up: boolean;
  /** True when the provider supplied no change value; never render a direction. */
  flat?: boolean;
  s?: string;
  source?: string;
  clickable?: boolean;
  asOf?: number;
  delayedMinutes?: number;
  freshness?: "real-time" | "delayed" | "end-of-day" | "unknown";
};

type SectionFreshness = {
  sources: string;
  unavailable: boolean;
  fetchedAt?: number;
  delayedMinutes?: number;
  freshness?: "real-time" | "delayed" | "end-of-day" | "unknown";
};

export type MarketsPayload = {
  status: "ok";
  ts: number;
  sources: { indices: string; forex: string; commodities: string; crypto: string };
  freshness: {
    fetchedAt: number;
    stale: boolean;
    cacheTtlSeconds: number;
    sections: Record<MarketSection, SectionFreshness>;
  };
  markets: { eg: Quote[]; gl: Quote[]; cm: Quote[]; cr: Quote[] };
  ticker: Quote[];
  /** TradingView widget symbols per section. They are display-only: the widget
   * renders inside TradingView's own frame and never becomes a platform quote. */
  tv: Record<MarketSection, TvSymbol[]>;
};

export type StockQuote = {
  /** Canonical server-side ID for history lookups; never a UI-derived symbol. */
  instrumentId: string;
  sym: string;
  name: string;
  sector: string;
  price: number;
  /** Omitted when the licensed provider did not supply the field. */
  prevClose?: number;
  chg?: number;
  chgPct?: number;
  vol?: number;
  high?: number;
  low?: number;
  open?: number;
  mktCapM?: number;
  pe?: number;
  forwardPE?: number;
  divYield?: number;
  eps?: number;
  bookValue?: number;
  priceToBook?: number;
  sharesM?: number;
  high52w?: number;
  low52w?: number;
  ts: number;
  source?: string;
  delayedMinutes?: number;
  freshness?: "real-time" | "delayed" | "end-of-day" | "unknown";
};

type StockSnapshot = {
  ts: number;
  fetchedAt: number;
  stale: boolean;
  source: string;
  unavailable: boolean;
  delayedMinutes?: number;
  freshness?: "real-time" | "delayed" | "end-of-day" | "unknown";
  stocks: StockQuote[];
  /** Display-only TradingView widget symbols for this list. */
  tvSymbols: TvSymbol[];
};

type CalEvent = {
  ev: string;
  evEn: string;
  t: string;
  tISO: string;
  imp: string;
  c: string;
  country: string;
  countryAr: string;
  flag: string;
  forecast: string;
  previous: string;
  source?: string;
  fetchedAt?: number;
  delayedMinutes?: number;
  freshness?: "real-time" | "delayed" | "end-of-day" | "unknown";
};

type CalendarPayload = {
  status: "ok";
  ts: number;
  fetchedAt: number;
  stale: boolean;
  unavailable: boolean;
  events: CalEvent[];
  source: string;
  delayedMinutes?: number;
  freshness?: "real-time" | "delayed" | "end-of-day" | "unknown";
};

let marketsCache: MarketsPayload | null = null;
let stocksCache: StockSnapshot | null = null;
let usStocksCache: StockSnapshot | null = null;
let calCache: CalendarPayload | null = null;
let marketsInFlight: Promise<{ data: MarketsPayload; stale?: boolean }> | null = null;
let stocksInFlight: Promise<StockSnapshot> | null = null;
let usStocksInFlight: Promise<StockSnapshot> | null = null;
let calendarInFlight: Promise<CalendarPayload> | null = null;

const MARKETS_TTL_SECONDS = 60;

function marketService(): MarketDataService {
  return getMarketDataService();
}

/** Rows are redisplayed only while their source still has an explicit active
 * customer-display approval. A stored price does not preserve a lapsed right. */
function activeHistoryRedisplaySources(): ReadonlySet<string> {
  const historyCapable = marketService().historySourceIds();
  return new Set(marketService().descriptors()
    .filter((descriptor) => descriptor.state === "configured"
      && descriptor.externalDisplayConfirmed
      && historyCapable.has(descriptor.id))
    .map((descriptor) => descriptor.id));
}

function quoteByInstrument(snapshot: QuoteSnapshot): Map<string, CanonicalQuote> {
  return new Map(snapshot.quotes.map((quote) => [quote.instrumentId, quote]));
}

function formatNumber(value: number, digits = 2): string {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

function priceDigits(instrument: MarketInstrument, value: number): number {
  if (instrument.kind === "fx") return value >= 10 ? 2 : 4;
  if (instrument.kind === "crypto") return value >= 1_000 ? 0 : value >= 1 ? 2 : 4;
  return 2;
}

function formatPrice(instrument: MarketInstrument, quote: CanonicalQuote): string {
  const prefix = quote.currency === "USD" ? "$" : "";
  const suffix = quote.currency && quote.currency !== "USD" ? ` ${quote.currency}` : "";
  return `${prefix}${formatNumber(quote.price, priceDigits(instrument, quote.price))}${suffix}`;
}

function formatChange(quote: CanonicalQuote): { text: string; up: boolean } {
  if (!Number.isFinite(quote.changePercent)) return { text: "—", up: true };
  const change = quote.changePercent!;
  return { text: `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`, up: change >= 0 };
}

function toDisplayQuote(instrument: MarketInstrument, quote: CanonicalQuote): Quote {
  const change = formatChange(quote);
  return {
    id: instrument.id,
    n: instrument.name,
    v: formatPrice(instrument, quote),
    c: change.text,
    up: change.up,
    flat: !Number.isFinite(quote.changePercent),
    s: instrument.subtitle,
    source: quote.sourceName,
    clickable: instrument.id === "egx:EGX30",
    asOf: quote.asOf,
    delayedMinutes: quote.delayedMinutes,
    freshness: quote.freshness,
  };
}

function sectionMeta(rows: Quote[], snapshot: QuoteSnapshot): SectionFreshness {
  const sourceNames = [...new Set(rows.map((row) => row.source).filter(Boolean))] as string[];
  const delayValues = rows.map((row) => row.delayedMinutes).filter((value): value is number => typeof value === "number");
  const qualities = [...new Set(rows.map((row) => row.freshness).filter(Boolean))];
  return {
    sources: sourceNames.length ? sourceNames.join(" + ") : "غير متاح",
    unavailable: rows.length === 0,
    fetchedAt: snapshot.fetchedAt,
    delayedMinutes: delayValues.length ? Math.max(...delayValues) : undefined,
    freshness: qualities.length === 1 ? qualities[0] : qualities.length ? "unknown" : undefined,
  };
}

function toMarketsPayload(snapshot: QuoteSnapshot): MarketsPayload {
  const quotes = quoteByInstrument(snapshot);
  const sections: Record<MarketSection, Quote[]> = { eg: [], gl: [], cm: [], cr: [] };
  const unpricedTv: Record<MarketSection, TvSymbol[]> = { eg: [], gl: [], cm: [], cr: [] };
  for (const instrument of MARKET_INSTRUMENTS) {
    const quote = quotes.get(instrument.id);
    if (quote) { sections[instrument.section].push(toDisplayQuote(instrument, quote)); continue; }
    const tv = tvSymbolForInstrument(instrument.id);
    if (tv) unpricedTv[instrument.section].push({ s: tv, d: instrument.symbol });
  }

  const freshness: Record<MarketSection, SectionFreshness> = {
    eg: sectionMeta(sections.eg, snapshot),
    gl: sectionMeta(sections.gl, snapshot),
    cm: sectionMeta(sections.cm, snapshot),
    cr: sectionMeta(sections.cr, snapshot),
  };
  /* The strip repeats its rows three times for the marquee, so a one-row
   * ticker looks like the same price looped. When index/commodity providers
   * are unlicensed, fall back to every priced FX pair so the strip still
   * carries several real, sourced values instead of one duplicated row. */
  const egTicker = [
    ...sections.eg.filter((row) => row.id === "egx:EGX30"),
    ...sections.eg.filter((row) => row.n.includes("/")),
  ];
  const ticker = [
    ...egTicker.slice(0, 5),
    ...sections.cm.slice(0, 2),
    ...sections.gl.slice(0, 1),
    ...sections.cr.slice(0, 2),
  ];

  return {
    status: "ok",
    ts: snapshot.fetchedAt,
    sources: {
      indices: freshness.gl.sources,
      forex: [...new Set(sections.eg.filter((row) => row.n.includes("/")).map((row) => row.source).filter(Boolean))].join(" + ") || "غير متاح",
      commodities: freshness.cm.sources,
      crypto: freshness.cr.sources,
    },
    freshness: {
      fetchedAt: snapshot.fetchedAt,
      stale: snapshot.stale,
      cacheTtlSeconds: MARKETS_TTL_SECONDS,
      sections: freshness,
    },
    markets: sections,
    ticker,
    tv: unpricedTv,
  };
}

async function buildMarketsSnapshot(): Promise<{ data: MarketsPayload; stale?: boolean }> {
  const snapshot = await marketService().getBoard();
  const data = toMarketsPayload(snapshot);
  marketsCache = data;
  return snapshot.stale ? { data, stale: true } : { data };
}

/** Shared in-process read for AI and opportunities; no localhost self-fetch. */
export function getMarketsSnapshot(): Promise<{ data: MarketsPayload; stale?: boolean }> {
  if (!marketsInFlight) {
    marketsInFlight = buildMarketsSnapshot().finally(() => { marketsInFlight = null; });
  }
  return marketsInFlight;
}

router.get("/", async (_req: Request, res: Response) => {
  try {
    const snapshot = await getMarketsSnapshot();
    res.json(snapshot.stale ? { ...snapshot.data, stale: true } : snapshot.data);
  } catch (error) {
    logger.error({ err: error }, "licensed market board build failed");
    // 503 only when a prior verified snapshot does not exist; clients render a
    // clear Arabic unavailable state, never a static finance fallback.
    if (marketsCache) res.json({ ...marketsCache, stale: true, freshness: { ...marketsCache.freshness, stale: true } });
    else res.status(503).json({ status: "error", message: "بيانات الأسواق غير متاحة حاليًا" });
  }
});

const HISTORY_INSTRUMENT_IDS = new Set([
  ...MARKET_INSTRUMENTS.map((instrument) => instrument.id),
  ...EGX_STOCKS.map((stock) => stock.id),
  ...US_STOCKS.map((stock) => stock.id),
]);

/**
 * Read-only history endpoint. It never calls a provider or starts a snapshot;
 * if the opt-in daily store is unavailable it fails closed for the UI instead
 * of manufacturing a line from the current quote.
 */
router.get("/history/:instrumentId", async (req: Request, res: Response) => {
  const instrumentId = String(req.params["instrumentId"] || "").trim();
  if (!HISTORY_INSTRUMENT_IDS.has(instrumentId)) {
    res.status(404).json({ status: "error", message: "الأداة المطلوبة غير معروفة" });
    return;
  }

  const wantsIndicators = String(req.query["indicators"] || "") === "1";
  let indicatorsAllowed = false;
  if (wantsIndicators) {
    // Indicator output is gated here, rather than trusting a browser flag. The
    // basic OHLC series remains available under the product's free-chart plan.
    if (await isActivePrivilegedAdmin(req)) indicatorsAllowed = true;
    else {
      try { indicatorsAllowed = await hasVipFeature(currentUser(req), "indicators"); } catch { indicatorsAllowed = false; }
    }
  }

  try {
    const data = await getMarketHistorySnapshot({
      instrumentId,
      range: parseHistoryRange(req.query["range"]),
      includeIndicators: indicatorsAllowed,
      allowedSourceIds: activeHistoryRedisplaySources(),
    });
    res.json({
      status: "ok",
      ...data,
      indicatorAccess: wantsIndicators ? (indicatorsAllowed ? "granted" : "vip_required") : "not_requested",
      disclaimer: "السجل اليومي المعروض للاطلاع العام وليس توصية استثمارية.",
    });
  } catch (error) {
    logger.error({ err: error, instrumentId }, "licensed market history read failed");
    res.status(503).json({
      status: "unavailable",
      instrumentId,
      message: "سجل الأسعار المرخّص غير متاح حاليًا. لم يتم رسم بيانات بديلة.",
    });
  }
});

/** One batched, read-only request for visible list sparklines. */
router.get("/sparklines", async (req: Request, res: Response) => {
  const requested = String(req.query["ids"] || "")
    .split(",")
    .map((id) => id.trim())
    .filter((id, index, list) => id && list.indexOf(id) === index)
    .slice(0, 64);
  const ids = requested.filter((id) => HISTORY_INSTRUMENT_IDS.has(id));
  if (!ids.length) {
    res.status(400).json({ status: "error", message: "لم يتم طلب أدوات سوق معروفة" });
    return;
  }
  try {
    const series = await getMarketSparklines({ instrumentIds: ids, days: 31, allowedSourceIds: activeHistoryRedisplaySources() });
    res.json({
      status: "ok",
      interval: "1d",
      range: "1M",
      series,
      disclaimer: "رسوم مصغّرة من سجل يومي مرخّص فقط؛ لا يظهر مسار عند نقص النقاط.",
    });
  } catch (error) {
    logger.error({ err: error, count: ids.length }, "licensed market sparkline read failed");
    res.status(503).json({
      status: "unavailable",
      message: "سجل الرسوم المصغّرة غير متاح حاليًا. لم يتم رسم بيانات بديلة.",
    });
  }
});

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPositiveFinite(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
}

function isNonNegativeFinite(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

function stockInstrument(definition: StockDefinition, market: "egx" | "us"): MarketInstrument {
  return {
    id: definition.id,
    symbol: definition.sym,
    name: definition.name,
    section: market === "egx" ? "eg" : "gl",
    kind: "equity",
    subtitle: definition.sector,
    currency: market === "egx" ? "EGP" : "USD",
  };
}

function toStockSnapshot(snapshot: QuoteSnapshot, definitions: StockDefinition[], market: "egx" | "us"): StockSnapshot {
  const byId = quoteByInstrument(snapshot);
  const stocks = definitions.flatMap((definition) => {
    const quote = byId.get(definition.id);
    if (!quote) return [];
    const previous = isPositiveFinite(quote.previousClose) ? quote.previousClose : undefined;
    // A change derived from a supplied previous close is transparent and exact;
    // without that input we omit it instead of publishing a fictitious zero.
    const change = isFiniteNumber(quote.change) ? quote.change : previous === undefined ? undefined : quote.price - previous;
    const pct = isFiniteNumber(quote.changePercent)
      ? quote.changePercent
      : previous === undefined || change === undefined || previous <= 0 ? undefined : (change / previous) * 100;
    // Provider omissions remain omitted. In particular, quote.price is never
    // copied into O/H/L or volume just to make a card look populated.
    return [{
      instrumentId: definition.id,
      sym: definition.sym,
      name: definition.name,
      sector: definition.sector,
      price: quote.price,
      ...(previous === undefined ? {} : { prevClose: previous }),
      ...(change === undefined ? {} : { chg: change }),
      ...(pct === undefined ? {} : { chgPct: pct }),
      ...(isNonNegativeFinite(quote.volume) ? { vol: quote.volume } : {}),
      ...(isPositiveFinite(quote.high) ? { high: quote.high } : {}),
      ...(isPositiveFinite(quote.low) ? { low: quote.low } : {}),
      ...(isPositiveFinite(quote.open) ? { open: quote.open } : {}),
      ts: quote.asOf,
      source: quote.sourceName,
      delayedMinutes: quote.delayedMinutes,
      freshness: quote.freshness,
    } satisfies StockQuote];
  });
  const source = [...new Set(stocks.map((stock) => stock.source).filter(Boolean))].join(" + ") || "غير متاح";
  const delays = stocks.map((stock) => stock.delayedMinutes).filter((value): value is number => typeof value === "number");
  const freshness = [...new Set(stocks.map((stock) => stock.freshness).filter(Boolean))];
  return {
    ts: snapshot.fetchedAt,
    fetchedAt: snapshot.fetchedAt,
    stale: snapshot.stale,
    source,
    unavailable: stocks.length === 0,
    delayedMinutes: delays.length ? Math.max(...delays) : undefined,
    freshness: freshness.length === 1 ? freshness[0] : freshness.length ? "unknown" : undefined,
    stocks,
    /* Only rows the licensed providers did not price get a TradingView widget
     * entry, so the UI never doubles a platform quote with a vendor one. */
    tvSymbols: definitions.flatMap((definition) => {
      if (byId.has(definition.id)) return [];
      const tv = tvSymbolForInstrument(definition.id);
      return tv ? [{ s: tv, d: definition.sym }] : [];
    }),
  };
}

async function buildStockSnapshot(market: "egx" | "us"): Promise<StockSnapshot> {
  const definitions = market === "egx" ? EGX_STOCKS : US_STOCKS;
  const snapshot = await marketService().getStocks(market, definitions);
  const data = toStockSnapshot(snapshot, definitions, market);
  if (market === "egx") stocksCache = data;
  else usStocksCache = data;
  return data;
}

/** Existing internal contract: returns EGX rows or null when no row was ever verified. */
export async function getStocksSnapshot(): Promise<StockQuote[] | null> {
  if (!stocksInFlight) stocksInFlight = buildStockSnapshot("egx").finally(() => { stocksInFlight = null; });
  const snapshot = await stocksInFlight;
  return snapshot.stocks.length ? snapshot.stocks : null;
}

router.get("/stocks", async (_req: Request, res: Response) => {
  try {
    const data = await buildStockSnapshot("egx");
    res.json({ status: "ok", ...data });
  } catch (error) {
    logger.error({ err: error }, "EGX licensed stock data failed");
    if (stocksCache) res.json({ status: "ok", ...stocksCache, stale: true });
    else res.status(503).json({ status: "error", message: "بيانات أسهم EGX غير متاحة حاليًا" });
  }
});

router.get("/us-stocks", async (_req: Request, res: Response) => {
  try {
    if (!usStocksInFlight) usStocksInFlight = buildStockSnapshot("us").finally(() => { usStocksInFlight = null; });
    const data = await usStocksInFlight;
    res.json({ status: "ok", ...data });
  } catch (error) {
    logger.error({ err: error }, "US licensed stock data failed");
    if (usStocksCache) res.json({ status: "ok", ...usStocksCache, stale: true });
    else res.status(503).json({ status: "error", message: "بيانات الأسهم العالمية غير متاحة حاليًا" });
  }
});

const IMPACT_META: Record<CalendarEvent["impact"], { ar: string; color: string }> = {
  high: { ar: "عالي", color: "#ef4444" },
  medium: { ar: "متوسط", color: "#f59e0b" },
  low: { ar: "منخفض", color: "#0ea5e9" },
  unknown: { ar: "—", color: "#64748b" },
};

function formatCairoTime(timestamp: number): string {
  const date = new Date(timestamp);
  return new Intl.DateTimeFormat("ar-EG", {
    timeZone: "Africa/Cairo",
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function toCalendarPayload(events: CalendarEvent[], fetchedAt: number, stale: boolean): CalendarPayload {
  const mapped = events.map((event) => {
    const impact = IMPACT_META[event.impact];
    return {
      ev: event.titleAr || event.title,
      evEn: event.title,
      t: formatCairoTime(event.at),
      tISO: new Date(event.at).toISOString(),
      imp: impact.ar,
      c: impact.color,
      country: event.country,
      countryAr: event.countryAr,
      flag: event.flag,
      forecast: event.forecast || "",
      previous: event.previous || "",
      source: event.sourceName,
      fetchedAt,
      delayedMinutes: event.delayedMinutes,
      freshness: event.freshness,
    } satisfies CalEvent;
  });
  const delays = mapped.map((event) => event.delayedMinutes).filter((value): value is number => typeof value === "number");
  const qualities = [...new Set(mapped.map((event) => event.freshness).filter(Boolean))];
  return {
    status: "ok",
    ts: fetchedAt,
    fetchedAt,
    stale,
    unavailable: mapped.length === 0,
    events: mapped,
    source: mapped[0]?.source || "غير متاح",
    delayedMinutes: delays.length ? Math.max(...delays) : undefined,
    freshness: qualities.length === 1 ? qualities[0] : qualities.length ? "unknown" : undefined,
  };
}

async function buildCalendarSnapshot(): Promise<CalendarPayload> {
  const snapshot = await marketService().getCalendar();
  const data = toCalendarPayload(snapshot.events, snapshot.fetchedAt, snapshot.stale);
  calCache = data;
  return data;
}

export async function getCalendarSnapshot(): Promise<{ status: "ok"; events: CalEvent[] } | null> {
  if (!calendarInFlight) calendarInFlight = buildCalendarSnapshot().finally(() => { calendarInFlight = null; });
  const snapshot = await calendarInFlight;
  return { status: "ok", events: snapshot.events };
}

router.get("/calendar", async (_req: Request, res: Response) => {
  try {
    const data = await buildCalendarSnapshot();
    res.json(data);
  } catch (error) {
    logger.error({ err: error }, "licensed calendar data failed");
    if (calCache) res.json({ ...calCache, stale: true });
    else res.status(503).json({ status: "error", message: "بيانات التقويم الاقتصادي غير متاحة حاليًا" });
  }
});

/** Public transparency page payload: source identities, status and quality only. */
router.get("/sources", async (_req: Request, res: Response) => {
  const health = await marketService().healthStatus();
  res.json({
    status: "ok",
    updatedAt: Date.now(),
    cache: health.cache,
    providers: marketService().descriptors(),
    health: health.providers,
    disclaimer: "البيانات المعروضة للاطلاع العام وليست توصية استثمارية. لا تظهر المنصة سعرًا عندما لا تكون حقوق المصدر/اتصاله مؤكدة.",
  });
});

router.get("/health", async (_req: Request, res: Response) => {
  const health = await marketService().healthStatus();
  res.json({
    status: "ok",
    ts: Date.now(),
    cache: health.cache,
    providers: health.providers,
    data: {
      markets: marketsCache ? { fetchedAt: marketsCache.ts, stale: marketsCache.freshness.stale } : null,
      egxStocks: stocksCache ? { fetchedAt: stocksCache.fetchedAt, stale: stocksCache.stale, count: stocksCache.stocks.length } : null,
      usStocks: usStocksCache ? { fetchedAt: usStocksCache.fetchedAt, stale: usStocksCache.stale, count: usStocksCache.stocks.length } : null,
      calendar: calCache ? { fetchedAt: calCache.fetchedAt, stale: calCache.stale, count: calCache.events.length } : null,
    },
  });
});

function cronAuthorized(req: Request): boolean {
  const secret = (process.env["MARKET_SNAPSHOT_CRON_SECRET"] || "").trim();
  if (!secret) return false;
  const supplied = String(req.get("x-cron-secret") || req.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const a = Buffer.from(secret);
  const b = Buffer.from(supplied);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Intentionally unscheduled here. A Vercel/worker scheduler may call it only
 * after DB migration, backup verification, a provider contract and explicit
 * write opt-in are all complete. It rejects every request when no cron secret
 * is configured, so adding this code alone cannot write production history.
 */
router.post("/internal/daily-snapshot", async (req: Request, res: Response) => {
  if (!cronAuthorized(req)) {
    res.status(404).json({ status: "error", message: "not found" });
    return;
  }
  try {
    const result = await runMarketDailySnapshot();
    res.status(result.status === "skipped" ? 409 : 200).json(result);
  } catch (error) {
    logger.error({ err: error }, "market daily snapshot job failed");
    res.status(503).json({ status: "error", message: "تعذّر حفظ لقطة السوق اليومية" });
  }
});

export default router;
