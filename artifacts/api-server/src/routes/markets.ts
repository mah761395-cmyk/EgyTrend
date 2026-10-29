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
import { classifyQuote, sessionForInstrument } from "../lib/market-data/freshness";
import type { TvScanRow } from "../lib/market-data/providers";
import { getMarketHistorySnapshot, getMarketSparklines, parseHistoryRange, runMarketDailySnapshot } from "../lib/market-data/history";
import { currentUser, isActivePrivilegedAdmin, hasVipFeature } from "../lib/userAuth";
import { buildDividendsResponse, buildValuationsResponse, sanitizeEgxSymbol } from "../lib/market-data/fundamentals";
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
  /**
   * What `asOf` actually IS, so the UI never presents a server fetch time as
   * the source's publish time:
   *   "source" — the provider published this timestamp (market time, daily
   *              reference update time, last_updated_at),
   *   "fetch"  — the source gives no machine-readable timestamp, so `asOf` is
   *              the server's fetch time and must be labelled as such.
   */
  timeBasis?: "source" | "fetch";
  /** Session-aware state: live market | closed with today's/last close | stale. */
  state?: "live" | "closed" | "stale";
  stateLabel?: string;
  /** The close time the "closed" label refers to (ms epoch), for tooltips. */
  refTime?: number;
};

/**
 * The day's change percent for a board quote. Providers publish either an
 * explicit `changePercent` or the previous session's close; the second form is
 * derived with the exact same arithmetic the stock lists use. When neither
 * input exists the change stays absent (rendered "—") — a missing value is
 * never invented as 0.
 */
export function deriveChangePercent(quote: {
  price: number;
  changePercent?: number;
  previousClose?: number;
}): number | null {
  if (typeof quote.changePercent === "number" && Number.isFinite(quote.changePercent)) {
    return quote.changePercent;
  }
  const prev = quote.previousClose;
  if (typeof prev === "number" && Number.isFinite(prev) && prev > 0) {
    return ((quote.price - prev) / prev) * 100;
  }
  return null;
}

type SectionFreshness = {
  sources: string;
  unavailable: boolean;
  fetchedAt?: number;
  delayedMinutes?: number;
  freshness?: "real-time" | "delayed" | "end-of-day" | "unknown";
  /** Worst state across the section's rows (stale > closed > live). */
  state?: "live" | "closed" | "stale";
  stateLabel?: string;
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
  /** Omitted (noData=true) when the source has no row for this symbol —
   * the row stays visible so counters never under-report the market. */
  price?: number;
  /** True for curated rows the source cannot price (e.g. no listing row). */
  noData?: boolean;
  /** Omitted when the licensed provider did not supply the field. */
  prevClose?: number;
  chg?: number;
  chgPct?: number;
  vol?: number;
  /** Traded value of the day in the market base currency (EGP for EGX). */
  amount?: number;
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
  /** Session-aware state: live | closed (final close shown) | stale. */
  state?: "live" | "closed" | "stale";
  stateLabel?: string;
  refTime?: number;
};

type StockSnapshot = {
  ts: number;
  fetchedAt: number;
  stale: boolean;
  source: string;
  unavailable: boolean;
  /** Rows carrying a real source price (excludes explicit no-data rows). */
  pricedCount?: number;
  delayedMinutes?: number;
  freshness?: "real-time" | "delayed" | "end-of-day" | "unknown";
  /** Worst state across the listed stocks. */
  state?: "live" | "closed" | "stale";
  stateLabel?: string;
  /** Human note about the source's latency/data characteristics, in the UI
   * language. Rendered verbatim so the client never invents a freshness
   * claim for a market whose data is delayed or session-bound. */
  sourceNote?: string;
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
  /** Why the snapshot is empty: the client can say "source not enabled on
   * the server" instead of a vague "unavailable". */
  reason?: "no_configured_provider" | "source_empty";
};

/** An empty calendar snapshot (source not configured, upstream silent) must
 * never erase the last verified snapshot: serve that one, clearly stale. */
export function preserveCalendarSuccess(prev: CalendarPayload | null, next: CalendarPayload): CalendarPayload {
  if (next.events.length) return next;
  if (prev && prev.events.length) return { ...prev, stale: true, unavailable: false };
  return next;
}

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

function formatChange(quote: CanonicalQuote): { text: string; up: boolean; flat: boolean } {
  const change = deriveChangePercent(quote);
  if (change === null) return { text: "—", up: true, flat: true };
  return { text: `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`, up: change >= 0, flat: false };
}

function toDisplayQuote(instrument: MarketInstrument, quote: CanonicalQuote): Quote {
  const change = formatChange(quote);
  return {
    id: instrument.id,
    n: instrument.name,
    v: formatPrice(instrument, quote),
    c: change.text,
    up: change.up,
    flat: change.flat,
    s: instrument.subtitle,
    source: quote.sourceName,
    clickable: instrument.id === "egx:EGX30",
    asOf: quote.asOf,
    delayedMinutes: quote.delayedMinutes,
    freshness: quote.freshness,
    timeBasis: quote.sourceAsOfUnknown ? "fetch" : "source",
    ...quoteState(instrument.id, quote),
  };
}

/**
 * Session-aware freshness for one row: a closed market showing its final
 * close is NOT stale. FX rows are end-of-day by design and get the daily
 * label instead of "بيانات قديمة".
 */
function quoteState(instrumentId: string, quote: CanonicalQuote): Pick<Quote, "state" | "stateLabel" | "refTime"> {
  const session = sessionForInstrument(instrumentId);
  if (!session) {
    return { state: "closed", stateLabel: "تحديث يومي", refTime: quote.asOf };
  }
  const { state, labelAr, refTime } = classifyQuote(
    { asOf: quote.asOf, sourceAsOfUnknown: quote.sourceAsOfUnknown, delayedMinutes: quote.delayedMinutes },
    session,
    Date.now(),
  );
  const stateLabel = state === "closed" && quote.freshness === "end-of-day" ? "تحديث يومي" : labelAr;
  return { state, stateLabel, refTime };
}

function sectionMeta(rows: Quote[], snapshot: QuoteSnapshot): SectionFreshness {
  const sourceNames = [...new Set(rows.map((row) => row.source).filter(Boolean))] as string[];
  const delayValues = rows.map((row) => row.delayedMinutes).filter((value): value is number => typeof value === "number");
  const qualities = [...new Set(rows.map((row) => row.freshness).filter(Boolean))];
  const states = rows.map((row) => row.state).filter((state): state is "live" | "closed" | "stale" => state === "live" || state === "closed" || state === "stale");
  const state = states.includes("stale") ? "stale" : states.includes("closed") ? "closed" : states.length ? "live" : undefined;
  return {
    sources: sourceNames.length ? sourceNames.join(" + ") : "غير متاح",
    unavailable: rows.length === 0,
    fetchedAt: snapshot.fetchedAt,
    delayedMinutes: delayValues.length ? Math.max(...delayValues) : undefined,
    freshness: qualities.length === 1 ? qualities[0] : qualities.length ? "unknown" : undefined,
    state,
    stateLabel: state === "stale" ? "⚠️ بيانات قديمة" : state === "closed" ? "إغلاق السوق" : undefined,
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
      /* Stale is now session-aware: it is true only when a displayed row's
       * own source quote is genuinely old for its market's session — not
       * merely because the market closed and a correct final close is shown. */
      stale: snapshot.stale || [...sections.eg, ...sections.gl, ...sections.cm, ...sections.cr].some((row) => row.state === "stale"),
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

/** The screener lists every stock the source prices, not just the curated
 * catalog, so history lookups accept the whole canonical `stock:<mkt>:<sym>`
 * namespace. The repository still returns only rows that exist — unknown
 * symbols fail closed with no data. */
function isKnownHistoryInstrumentId(instrumentId: string): boolean {
  return (
    HISTORY_INSTRUMENT_IDS.has(instrumentId) ||
    instrumentId.startsWith("stock:egx:") ||
    instrumentId.startsWith("stock:us:")
  );
}

/**
 * Read-only history endpoint. It never calls a provider or starts a snapshot;
 * if the opt-in daily store is unavailable it fails closed for the UI instead
 * of manufacturing a line from the current quote.
 */
router.get("/history/:instrumentId", async (req: Request, res: Response) => {
  const instrumentId = String(req.params["instrumentId"] || "").trim();
  if (!isKnownHistoryInstrumentId(instrumentId)) {
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
  const ids = requested.filter((id) => isKnownHistoryInstrumentId(id));
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
      ...quoteState(definition.id, quote),
    } satisfies StockQuote];
  });
  const source = [...new Set(stocks.map((stock) => stock.source).filter(Boolean))].join(" + ") || "غير متاح";
  const delays = stocks.map((stock) => stock.delayedMinutes).filter((value): value is number => typeof value === "number");
  const freshness = [...new Set(stocks.map((stock) => stock.freshness).filter(Boolean))];
  const states = stocks.map((stock) => stock.state).filter((state): state is "live" | "closed" | "stale" => state === "live" || state === "closed" || state === "stale");
  const state = states.includes("stale") ? "stale" : states.includes("closed") ? "closed" : states.length ? "live" : undefined;
  return {
    ts: snapshot.fetchedAt,
    fetchedAt: snapshot.fetchedAt,
    /* Session-aware: a closed exchange showing final closes is not stale. */
    stale: snapshot.stale || state === "stale",
    source,
    unavailable: stocks.length === 0,
    delayedMinutes: delays.length ? Math.max(...delays) : undefined,
    freshness: freshness.length === 1 ? freshness[0] : freshness.length ? "unknown" : undefined,
    state,
    stateLabel: state === "stale" ? "⚠️ بيانات قديمة" : state === "closed" ? "إغلاق السوق" : undefined,
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

/** Map the scanner's full Egypt list to the screener snapshot.
 *
 * The pre-fix build only priced the curated 54-symbol catalog and silently
 * dropped every curated symbol the source had no row for — the UI then
 * showed "37 stocks" with no explanation. Now:
 *  - every listed stock the source prices is a row (index rows excluded),
 *  - curated symbols keep their Arabic name/sector, the rest use the
 *    source's own labels,
 *  - curated symbols with no source row stay in the list explicitly
 *    unpriced (noData) instead of vanishing,
 *  - fields the source does not provide (P/E, dividend yield, 52-week)
 *    stay absent so the UI can show "not provided" instead of inventing.
 */
export function egxScanToStockSnapshot(scan: { rows: TvScanRow[]; fetchedAt: number; stale: boolean }): StockSnapshot {
  const catalogBySym = new Map(EGX_STOCKS.map((definition) => [definition.sym, definition]));
  const seen = new Set<string>();
  const stocks: StockQuote[] = [];
  for (const row of scan.rows) {
    /* Index rows (EGX30/EGX70/EGX100) are board data, not screener rows —
     * a screener row must never mix an index price with equity prices. */
    if (row.type !== "stock") continue;
    const price = isPositiveFinite(row.close) ? row.close : undefined;
    if (!price || seen.has(row.sym)) continue;
    const definition = catalogBySym.get(row.sym);
    seen.add(row.sym);
    const instrumentId = `stock:egx:${row.sym}`;
    const previous = row.changeAbs !== undefined ? price - row.changeAbs : undefined;
    // A change derived from a supplied previous close is transparent and
    // exact; without that input we omit it instead of publishing a fictitious zero.
    const change = isFiniteNumber(row.changeAbs) ? row.changeAbs : previous === undefined ? undefined : price - previous;
    const pct = isFiniteNumber(row.change)
      ? row.change
      : previous === undefined || change === undefined || previous <= 0 ? undefined : (change / previous) * 100;
    stocks.push({
      instrumentId,
      sym: row.sym,
      name: definition?.name || row.description || row.sym,
      sector: definition?.sector || row.sector || "",
      price,
      ...(previous === undefined ? {} : { prevClose: previous }),
      ...(change === undefined ? {} : { chg: change }),
      ...(pct === undefined ? {} : { chgPct: pct }),
      ...(isNonNegativeFinite(row.volume) ? { vol: row.volume } : {}),
      /* Traded value of the day, EGP — the scanner's extended "amount". */
      ...(isPositiveFinite(row.amount) ? { amount: row.amount } : {}),
      ...(isPositiveFinite(row.high) ? { high: row.high } : {}),
      ...(isPositiveFinite(row.low) ? { low: row.low } : {}),
      ...(isPositiveFinite(row.open) ? { open: row.open } : {}),
      // market_cap_basic arrives in EGP; the UI contract is millions.
      ...(isPositiveFinite(row.marketCap) ? { mktCapM: row.marketCap / 1_000_000 } : {}),
      /* Extended valuation fields: present only when the source's extended
       * column pass published them for this row. */
      ...(isFiniteNumber(row.pe) ? { pe: row.pe } : {}),
      ...(isFiniteNumber(row.divYield) ? { divYield: row.divYield } : {}),
      ...(isFiniteNumber(row.eps) ? { eps: row.eps } : {}),
      ...(isPositiveFinite(row.high52w) ? { high52w: row.high52w } : {}),
      ...(isPositiveFinite(row.low52w) ? { low52w: row.low52w } : {}),
      ts: scan.fetchedAt,
      source: "TradingView Scanner",
      freshness: "unknown",
      ...quoteState(instrumentId, {
        instrumentId,
        price,
        asOf: scan.fetchedAt,
        sourceAsOfUnknown: true,
        sourceId: "tradingview-scanner",
        sourceName: "TradingView Scanner",
        freshness: "unknown",
      } satisfies CanonicalQuote),
    });
  }
  /* Curated symbols the source has no row for (no listing page on the
   * vendor, verified 404) remain in the list, explicitly unpriced. */
  for (const definition of EGX_STOCKS) {
    if (seen.has(definition.sym)) continue;
    stocks.push({
      instrumentId: definition.id,
      sym: definition.sym,
      name: definition.name,
      sector: definition.sector,
      noData: true,
      ts: scan.fetchedAt,
      source: "غير متاح",
      freshness: "unknown",
    });
  }
  const priced = stocks.filter((stock) => !stock.noData);
  const states = priced
    .map((stock) => stock.state)
    .filter((state): state is "live" | "closed" | "stale" => state === "live" || state === "closed" || state === "stale");
  const state = states.includes("stale") ? "stale" : states.includes("closed") ? "closed" : states.length ? "live" : undefined;
  return {
    ts: scan.fetchedAt,
    fetchedAt: scan.fetchedAt,
    stale: scan.stale || state === "stale",
    source: priced.length ? "TradingView Scanner" : "غير متاح",
    unavailable: priced.length === 0,
    pricedCount: priced.length,
    state,
    stateLabel: state === "stale" ? "⚠️ بيانات قديمة" : state === "closed" ? "إغلاق السوق" : undefined,
    /* The Egypt scan exposes no per-row data timestamp and is not tick-live:
     * state it plainly instead of letting the UI call it "real-time". */
    sourceNote: priced.length
      ? "أسعار من ماسح TradingView للبورصة المصرية؛ قد تتأخر عن سعر التداول اللحظي، وبعد إغلاق الجلسة يعرض آخر سعر موثق."
      : undefined,
    stocks,
    /* The 17 no-data curated symbols have no vendor page, so no widget is
     * offered for them (tvSymbolForInstrument already resolves them to null). */
    tvSymbols: [],
  };
}

async function buildStockSnapshot(market: "egx" | "us"): Promise<StockSnapshot> {
  if (market === "egx") {
    // The screener is the source's full Egypt equity list, not the curated
    // subset: see egxScanToStockSnapshot. The scan shares the quotes'
    // freshness contract (3m TTL, stale up to 2h, fail-closed).
    const data = egxScanToStockSnapshot(await marketService().getEgxStockScan());
    stocksCache = data;
    return data;
  }
  const definitions = US_STOCKS;
  const snapshot = await marketService().getStocks(market, definitions);
  const data = toStockSnapshot(snapshot, definitions, market);
  usStocksCache = data;
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

/* ── Secondary fundamentals (fail-soft, decoupled from the price scan) ──
 * These enrich the EGX screener with fields the scanner does not publish for
 * this market. They are independent read-only endpoints: a failure here never
 * affects /stocks, and a missing value is reported as unavailable, never 0. */

/** Trailing-12-month cash dividends per share from the Yahoo public chart
 * endpoint (same family as the board's global indices, crumb-less). */
router.get("/dividends", async (req: Request, res: Response) => {
  const symbols = String(req.query["symbols"] ?? "")
    .split(",")
    .map((item) => sanitizeEgxSymbol(item))
    .filter((item): item is string => item !== null)
    .slice(0, 40);
  if (!symbols.length) {
    res.status(400).json({ status: "error", message: "حدد رموز EGX صالحة عبر ?symbols=" });
    return;
  }
  try {
    const { http, cache } = marketService().fundamentalsDeps();
    const data = await buildDividendsResponse(symbols, { http, cache });
    res.json(data);
  } catch (error) {
    logger.error({ err: error }, "EGX dividends lookup failed");
    res.status(503).json({ status: "error", message: "بيانات التوزيعات غير متاحة حاليًا" });
  }
});

/** P/E + coupon yield from the official EGX page (partial coverage — the
 * response states exactly which subset the page covers). */
router.get("/valuations", async (req: Request, res: Response) => {
  const symbols = String(req.query["symbols"] ?? "")
    .split(",")
    .map((item) => sanitizeEgxSymbol(item))
    .filter((item): item is string => item !== null)
    .slice(0, 300);
  try {
    const { http, cache } = marketService().fundamentalsDeps();
    const data = await buildValuationsResponse(symbols, { http, cache });
    res.json(data);
  } catch (error) {
    logger.error({ err: error }, "EGX valuation page lookup failed");
    res.status(503).json({ status: "error", message: "بيانات مضاعف الربحية غير متاحة حاليًا" });
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

function calendarProviderConfigured(): boolean {
  return marketService()
    .descriptors()
    .some(
      (descriptor) =>
        descriptor.state === "configured" &&
        (descriptor.coverage as readonly string[]).includes("calendar"),
    );
}

async function buildCalendarSnapshot(): Promise<CalendarPayload> {
  const snapshot = await marketService().getCalendar();
  const data = toCalendarPayload(snapshot.events, snapshot.fetchedAt, snapshot.stale);
  if (!data.events.length) {
    /* Truthful, loggable reason — never a key, never a vendor URL. */
    data.reason = calendarProviderConfigured() ? "source_empty" : "no_configured_provider";
    logger.warn({ reason: data.reason }, "calendar snapshot empty");
  }
  const out = preserveCalendarSuccess(calCache, data);
  if (data.events.length) calCache = data;
  return out;
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
      egxStocks: stocksCache ? { fetchedAt: stocksCache.fetchedAt, stale: stocksCache.stale, count: stocksCache.stocks.length, pricedCount: stocksCache.pricedCount ?? null } : null,
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
 * Vercel's cron scheduler issues a plain HTTP GET and cannot attach custom
 * headers, so the GET variant is recognized by the platform's own markers:
 * the vercel-cron user agent plus the x-vercel-cron-schedule header Vercel
 * injects on every scheduled request. The action itself is a harmless,
 * idempotent upsert (one row per source+instrument+day) and a no-op unless
 * the operator enabled write mode, so the credential it carries is the
 * platform identity, not a secret stored in vercel.json.
 */
function vercelCronAuthorized(req: Request): boolean {
  const userAgent = String(req.get("user-agent") || "").toLowerCase();
  const schedule = String(req.get("x-vercel-cron-schedule") || "").trim();
  return userAgent.startsWith("vercel-cron") && schedule.length > 0;
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

/**
 * Vercel Cron entry point (Hobby plan: at most once/day, UTC). The platform
 * calls this with GET; authorization uses the vercel-cron markers, see
 * vercelCronAuthorized. The job upserts one OHLC row per
 * source+instrument+day, so re-runs and cron imprecision are safe, and it
 * stays a no-op until MARKET_SNAPSHOT_WRITES_ENABLED=true is set in
 * production. The two schedules (see vercel.json) fire after the EGX close
 * (15:30 Cairo) and after the US close so final bars are captured.
 */
router.get("/internal/daily-snapshot", async (req: Request, res: Response) => {
  if (!vercelCronAuthorized(req)) {
    res.status(404).json({ status: "error", message: "not found" });
    return;
  }
  try {
    const result = await runMarketDailySnapshot();
    res.status(result.status === "skipped" ? 409 : 200).json(result);
  } catch (error) {
    logger.error({ err: error }, "market daily snapshot cron failed");
    res.status(503).json({ status: "error", message: "تعذّر حفظ لقطة السوق اليومية" });
  }
});

export default router;
