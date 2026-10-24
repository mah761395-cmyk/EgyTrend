import { Router, type IRouter, type Request, type Response } from "express";
import { logger } from "../lib/logger";
import { EGX_AR_NAMES } from "../lib/egx-names";
import {
  isDeadQuote,
  newestAsOf,
  partitionUsableQuotes,
  quoteAge,
  resolveAsOf,
  tvDelayMinutes,
} from "../lib/market-freshness";

const router: IRouter = Router();

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const COMMON_HEADERS: Record<string, string> = {
  "User-Agent": UA,
  Accept: "*/*",
  "Accept-Language": "en-US,en;q=0.9",
};

const FINNHUB_KEY = process.env.FINNHUB_API_KEY ?? "";
const AV_KEY = process.env.ALPHA_VANTAGE_API_KEY ?? "";

type Quote = {
  n: string;
  v: string;
  c: string;
  up: boolean;
  s?: string;
  clickable?: boolean;
};

/* ─── Generic fetch helpers ─── */

async function fetchText(url: string, timeoutMs = 8000): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: COMMON_HEADERS, signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

function parseNumber(s: string): number {
  const n = parseFloat(String(s).replace(/[, ]/g, ""));
  return Number.isFinite(n) ? n : NaN;
}

function fmtNumber(n: number, opts: { decimals?: number; commas?: boolean } = {}) {
  const decimals = opts.decimals ?? 2;
  const commas = opts.commas ?? true;
  const fixed = n.toFixed(decimals);
  if (!commas) return fixed;
  const [intPart, decPart] = fixed.split(".");
  const withCommas = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return decPart ? `${withCommas}.${decPart}` : withCommas;
}

function fmtPct(p: number): string {
  const sign = p >= 0 ? "+" : "";
  return `${sign}${p.toFixed(2)}%`;
}

/* ═══════════════════════════════════════════════════
   LAYER 1: Finnhub  (stocks + crypto — realtime)
   ═══════════════════════════════════════════════════ */

type FinnhubQuote = {
  c: number;  // current price
  d: number;  // change
  dp: number; // change %
  h: number;  // high
  l: number;  // low
  o: number;  // open
  pc: number; // previous close
  t: number;  // timestamp
};

async function fetchFinnhub(symbol: string): Promise<FinnhubQuote | null> {
  if (!FINNHUB_KEY) return null;
  try {
    const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${FINNHUB_KEY}`;
    const text = await fetchText(url, 8000);
    const data = JSON.parse(text) as FinnhubQuote & { error?: string };
    if (data.error || !data.c || data.c === 0) return null;
    return data;
  } catch (e) {
    logger.warn({ symbol, err: (e as Error).message }, "finnhub fetch failed");
    return null;
  }
}

/* ═══════════════════════════════════════════════════
   LAYER 2: Alpha Vantage  (forex — 6hr cache)
   Conserves the 25 req/day free limit aggressively.
   ═══════════════════════════════════════════════════ */

type AVRate = { rate: number; bid: number; ask: number; ts: string };
const avForexCache: Map<string, { ts: number; data: AVRate }> = new Map();
const AV_FOREX_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

async function fetchAVForex(from: string, to: string): Promise<AVRate | null> {
  if (!AV_KEY) return null;
  const key = `${from}/${to}`;
  const cached = avForexCache.get(key);
  if (cached && Date.now() - cached.ts < AV_FOREX_TTL_MS) return cached.data;
  try {
    const url = `https://www.alphavantage.co/query?function=CURRENCY_EXCHANGE_RATE&from_currency=${from}&to_currency=${to}&apikey=${AV_KEY}`;
    const text = await fetchText(url, 12000);
    const json = JSON.parse(text) as Record<string, unknown>;
    // Detect rate-limit / info messages
    if (json["Information"] || json["Note"]) {
      logger.warn({ key }, "alpha vantage rate limit hit — using stale cache if available");
      return cached?.data ?? null;
    }
    const block = json["Realtime Currency Exchange Rate"] as Record<string, string> | undefined;
    if (!block) return null;
    const rate = parseNumber(block["5. Exchange Rate"]);
    if (!Number.isFinite(rate)) return null;
    const data: AVRate = {
      rate,
      bid: parseNumber(block["8. Bid Price"]),
      ask: parseNumber(block["9. Ask Price"]),
      ts: block["6. Last Refreshed"] ?? "",
    };
    avForexCache.set(key, { ts: Date.now(), data });
    return data;
  } catch (e) {
    logger.warn({ key, err: (e as Error).message }, "alpha vantage forex fetch failed");
    return cached?.data ?? null; // return stale rather than null
  }
}

// Warm all 4 forex pairs sequentially (respects AV 1 req/sec free limit).
// Called once on server start and then every 6 hours.
async function warmAVForexCache(): Promise<void> {
  const pairs: Array<[string, string]> = [
    ["USD", "EGP"], ["EUR", "EGP"], ["GBP", "EGP"], ["SAR", "EGP"],
  ];
  for (const [from, to] of pairs) {
    await fetchAVForex(from, to);
    await new Promise((r) => setTimeout(r, 1200)); // 1.2s gap → safe under 1 req/sec
  }
  logger.info("AV forex cache warmed");
}

// Fire-and-forget on startup, then refresh every 6 hours
setTimeout(() => {
  warmAVForexCache().catch((e) => logger.warn({ err: (e as Error).message }, "AV warm failed"));
}, 500);
setInterval(() => {
  warmAVForexCache().catch((e) => logger.warn({ err: (e as Error).message }, "AV refresh failed"));
}, AV_FOREX_TTL_MS);

/* ═══════════════════════════════════════════════════
   LAYER 3: Legacy scrapers (fallbacks)
   ═══════════════════════════════════════════════════ */

async function fetchGoogleFinance(symbol: string): Promise<{ price: number; prev: number } | null> {
  try {
    const enc = symbol.replace(/:/g, "%3A");
    const html = await fetchText(`https://www.google.com/finance/quote/${enc}`, 9000);
    const priceMatch = html.match(/data-last-price="([^"]+)"/);
    const prevMatch = html.match(/P6K39c[^>]*>([^<]+)/);
    if (!priceMatch) return null;
    const price = parseNumber(priceMatch[1]);
    const prev = prevMatch ? parseNumber(prevMatch[1]) : NaN;
    if (!Number.isFinite(price)) return null;
    return { price, prev: Number.isFinite(prev) ? prev : price };
  } catch (e) {
    logger.warn({ symbol, err: (e as Error).message }, "google finance fetch failed");
    return null;
  }
}

// Stooq is blocked in this environment — kept as a no-op stub so type references compile.
// All commodity/index fallbacks go through Google Finance instead.
async function fetchStooq(_symbol: string): Promise<{ price: number; open: number } | null> {
  return null;
}

/* ─── Yahoo Finance (primary for indices / forex / commodities — no API key) ───
 * `yf` is the shared yahoo-finance2 client declared in the stocks section below;
 * it is initialized at module load, before any request handler runs. */

async function fetchYahooIndexQuote(
  symbol: string,
): Promise<{ price: number; pct: number; asOf: number } | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const q = (await yf.quote(symbol, {}, { validateResult: false })) as any;
    const price = Number(q?.regularMarketPrice);
    if (!Number.isFinite(price) || price === 0) return null;
    /* The provider's own market time decides whether this is a current price.
     * Yahoo keeps answering for symbols it stopped updating (all EGX tickers on
     * this endpoint are frozen at July 2024), so a frozen quote must be refused
     * here instead of becoming an "index value" on the board. */
    /* The board shows an index value without its own timestamp, so it must be
     * strictly current: anything past the weekend window is dropped instead of
     * being labelled "EGX30" as if it were today's close. */
    const asOf = Number(q?.regularMarketTime) * 1000;
    const age = quoteAge(asOf);
    if (age.stale) {
      logger.warn({ symbol, asOf, reason: age.reason }, "yahoo index quote rejected as not current");
      return null;
    }
    const pctDirect = Number(q?.regularMarketChangePercent);
    const prev = Number(q?.regularMarketPreviousClose);
    const pct = Number.isFinite(pctDirect)
      ? pctDirect
      : Number.isFinite(prev) && prev > 0
        ? ((price - prev) / prev) * 100
        : 0;
    return { price, pct, asOf: Number.isFinite(asOf) && asOf > 0 ? asOf : Date.now() };
  } catch (e) {
    logger.warn({ symbol, err: (e as Error).message }, "yahoo quote failed");
    return null;
  }
}

/* Reuses the staggered mapper declared with the stocks section below
 * (function declarations hoist, so this is safe at call time). */

/* Reuses nothing — maps sequentially with a small delay between calls so the
 * burst of Yahoo requests stays politely rate-limited. */
async function mapStaggeredQuotes<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  delayMs = 150,
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i++) {
    results.push(await fn(items[i]));
    if (i + 1 < items.length) await new Promise((r) => setTimeout(r, delayMs));
  }
  return results;
}

async function fetchEGX30(): Promise<{ price: number; pctChange: number; source: string } | null> {
  // 1) Yahoo Finance (^CASE30) — only accepted with a current provider time
  const y = await fetchYahooIndexQuote("^CASE30");
  if (y) return { price: y.price, pctChange: y.pct, source: "Yahoo Finance" };
  // 2) TradingEconomics scraper (fallback)
  try {
    const html = await fetchText("https://tradingeconomics.com/egypt/stock-market", 10000);
    const priceMatch = html.match(/<td id="p">([0-9.,]+)/);
    const sentence = html.match(
      /EGX 30,?\s*(rose to|fell to|edged up to|edged down to|gained|lost|increased to|decreased to|climbed to|dropped to|advanced to|slipped to|stood at)\s*([0-9.,]+)\s*points[^.]{0,200}/i,
    );
    let price = NaN;
    if (priceMatch) price = parseNumber(priceMatch[1]);
    if (!Number.isFinite(price) && sentence) price = parseNumber(sentence[2]);
    if (!Number.isFinite(price)) return null;
    let pct = NaN;
    if (sentence) {
      const pctMatch = sentence[0].match(/(gaining|losing|rising|falling|up|down)\s*([0-9.]+)%/i);
      if (pctMatch) {
        const negative = /losing|falling|down/.test(pctMatch[1].toLowerCase());
        pct = negative ? -parseFloat(pctMatch[2]) : parseFloat(pctMatch[2]);
      }
    }
    if (!Number.isFinite(pct)) {
      const altPct = html.match(/EGX 30[^<]*?([+\-]?[0-9]+\.[0-9]+)%\s*from the previous/i);
      if (altPct) pct = parseFloat(altPct[1]);
    }
    if (!Number.isFinite(pct)) pct = 0;
    /* Scraped page content has no provider timestamp, so the source is named
     * instead of pretending the value is a live Yahoo quote. */
    return { price, pctChange: pct, source: "TradingEconomics" };
  } catch (e) {
    logger.warn({ err: (e as Error).message }, "EGX30 fetch failed");
    return null;
  }
}

/* ═══════════════════════════════════════════════════
   MARKET SECTIONS
   ═══════════════════════════════════════════════════ */

/* ── Global Indices via Finnhub ETF proxies ── */

// For indices, Finnhub ETF proxies give accurate % change but wrong absolute values.
// Strategy: use Finnhub dp% for the change display, and Google Finance / Stooq for
// the real index price. If scrapers fail, show the ETF price but label it as such.
type IndexDef = {
  n: string;
  s: string;
  yahoo?: string;         // Yahoo Finance spot index symbol — preferred
  finnhub: string;        // ETF on Finnhub — used for % change only
  google?: string;        // Google Finance — fallback for real index price
  stooq?: string;         // Stooq — fallback for real index price
  finnhubIsSpot?: boolean; // true when Finnhub symbol IS the spot index (not ETF)
};

const GLOBAL_INDICES: IndexDef[] = [
  { n: "S&P 500",  s: "أمريكي",   yahoo: "^GSPC", finnhub: "SPY",  google: ".INX:INDEXSP",      stooq: "^spx" },
  { n: "NASDAQ",   s: "تقني",     yahoo: "^IXIC", finnhub: "QQQ",  google: ".IXIC:INDEXNASDAQ", stooq: "^ndq" },
  { n: "DAX",      s: "ألماني",   yahoo: "^GDAXI", finnhub: "EWG",  google: "DAX:INDEXDB",       stooq: "^dax" },
  { n: "FTSE 100", s: "بريطاني",  yahoo: "^FTSE", finnhub: "EWU",  google: "UKX:INDEXFTSE",     stooq: "^ftm" },
];

async function buildIndexQuote(def: IndexDef): Promise<Quote | null> {
  // 1) Yahoo Finance — real index points + real % change, no key needed
  if (def.yahoo) {
    const y = await fetchYahooIndexQuote(def.yahoo);
    if (y) {
      return { n: def.n, v: fmtNumber(y.price, { decimals: 2, commas: true }), c: fmtPct(y.pct), up: y.pct >= 0, s: def.s };
    }
  }
  // 2) Fetch Finnhub ETF for % change AND scrapers for real price — in parallel
  const [fh, googleData, stooqData] = await Promise.all([
    fetchFinnhub(def.finnhub),
    def.google ? fetchGoogleFinance(def.google) : Promise.resolve(null),
    def.stooq ? fetchStooq(def.stooq) : Promise.resolve(null),
  ]);

  // Prefer scraper price (real index points), use Finnhub % change when available
  if (googleData) {
    const scrapePct = googleData.prev > 0 ? ((googleData.price - googleData.prev) / googleData.prev) * 100 : 0;
    const pct = fh ? fh.dp : scrapePct; // Finnhub % is more accurate (real-time)
    return { n: def.n, v: fmtNumber(googleData.price, { decimals: 2, commas: true }), c: fmtPct(pct), up: pct >= 0, s: def.s };
  }
  if (stooqData) {
    const scrapePct = stooqData.open > 0 ? ((stooqData.price - stooqData.open) / stooqData.open) * 100 : 0;
    const pct = fh ? fh.dp : scrapePct;
    return { n: def.n, v: fmtNumber(stooqData.price, { decimals: 2, commas: true }), c: fmtPct(pct), up: pct >= 0, s: def.s };
  }
  // Last resort: ETF price from Finnhub (price will be ETF value, not index points)
  if (fh) {
    return { n: def.n, v: fmtNumber(fh.c, { decimals: 2, commas: true }), c: fmtPct(fh.dp), up: fh.dp >= 0, s: def.s };
  }
  return null;
}

/* ── Forex via Alpha Vantage (6hr cache) + Google/Stooq fallback ── */

type FxDef = { n: string; s: string; from: string; to: string; yahoo?: string; google?: string; stooq?: string; viaUsd?: boolean };

const FX_PAIRS: FxDef[] = [
  { n: "USD/EGP", s: "دولار/جنيه",    from: "USD", to: "EGP", yahoo: "USDEGP=X", google: "USD-EGP", stooq: "usdegp" },
  { n: "EUR/EGP", s: "يورو/جنيه",     from: "EUR", to: "EGP", yahoo: "EUREGP=X", google: "EUR-EGP", stooq: "euregp" },
  { n: "GBP/EGP", s: "إسترليني/جنيه", from: "GBP", to: "EGP", yahoo: "GBPEGP=X", google: "GBP-EGP", stooq: "gbpegp" },
  { n: "SAR/EGP", s: "ريال/جنيه",     from: "SAR", to: "EGP", yahoo: "USDEGP=X", viaUsd: true, google: "SAR-EGP" },
];

const SAR_PER_USD = 3.75; // SAR is USD-pegged

async function buildFxQuote(def: FxDef): Promise<Quote | null> {
  // 1) Yahoo Finance (realtime, no key; SAR/EGP derived from USD/EGP × peg)
  if (def.yahoo) {
    const y = await fetchYahooIndexQuote(def.yahoo);
    if (y) {
      const rate = def.viaUsd ? y.price / SAR_PER_USD : y.price;
      const pct = def.viaUsd ? y.pct : y.pct; // peg keeps % identical to USD/EGP
      return { n: def.n, v: fmtNumber(rate, { decimals: 2, commas: false }), c: fmtPct(pct), up: pct >= 0, s: def.s };
    }
  }
  // 2) Alpha Vantage (realtime, 6hr cached)
  const av = await fetchAVForex(def.from, def.to);
  if (av) {
    // AV doesn't give previous close, compute implied % from bid/ask midpoint vs rate
    const pct = av.bid > 0 && av.ask > 0
      ? ((av.rate - (av.bid + av.ask) / 2) / ((av.bid + av.ask) / 2)) * 100
      : 0;
    return { n: def.n, v: fmtNumber(av.rate, { decimals: 2, commas: false }), c: fmtPct(pct), up: pct >= 0, s: def.s };
  }
  // 2) Google Finance
  if (def.google) {
    const g = await fetchGoogleFinance(def.google);
    if (g) {
      const pct = g.prev > 0 ? ((g.price - g.prev) / g.prev) * 100 : 0;
      return { n: def.n, v: fmtNumber(g.price, { decimals: 2, commas: false }), c: fmtPct(pct), up: pct >= 0, s: def.s };
    }
  }
  // 3) Stooq
  if (def.stooq) {
    const sq = await fetchStooq(def.stooq);
    if (sq) {
      const pct = sq.open > 0 ? ((sq.price - sq.open) / sq.open) * 100 : 0;
      return { n: def.n, v: fmtNumber(sq.price, { decimals: 2, commas: false }), c: fmtPct(pct), up: pct >= 0, s: def.s };
    }
  }
  return null;
}

/* ── Commodities via Finnhub ETF proxies + Stooq fallback ──
   ETF → spot conversion factors (approximate, updated periodically):
   GLD  ≈ 1/10 oz gold    → multiply by ~10.00 to get $/oz
   USO  ≈ tracks WTI crude → multiply by ~8.00 to approximate brent $/bbl
   SLV  ≈ 1 oz silver      → multiply by ~1.00
   HG/copper: no clean ETF, use Stooq directly
── */

type CommodityDef = {
  n: string;
  s: string;
  yahoo?: string;         // Yahoo futures symbol — preferred (real spot/futures price)
  finnhub?: string;
  finnhubFactor?: number; // multiply ETF price by this to get spot
  stooq?: string | string[];
  google?: string;
  prefix?: string;
  suffix?: string;
  decimals?: number;
  commas?: boolean;
};

// ETF conversion factors (calibrated against spot May-2026):
//   GLD  ~$414 → gold spot ~$3,300  → factor ≈ 7.97
//   BNO  ~$55  → Brent spot ~$65    → factor ≈ 1.18
//   SLV  ~$68  → silver spot ~$33   → factor ≈ 0.483
// These are approximate and drift slowly; Google Finance is kept as price fallback.
const COMMODITIES: CommodityDef[] = [
  { n: "ذهب",      s: "أوقية",  yahoo: "GC=F", finnhub: "GLD", finnhubFactor: 7.97,  google: "XAUUSD:CURRENCY", prefix: "$", decimals: 2, commas: true },
  { n: "نفط برنت", s: "برميل",  yahoo: "BZ=F", finnhub: "BNO", finnhubFactor: 1.18,  google: "BZ00:NYMEX",      prefix: "$", decimals: 2, commas: false },
  { n: "فضة",      s: "أوقية",  yahoo: "SI=F", finnhub: "SLV", finnhubFactor: 0.483, google: "XAGUSD:CURRENCY", prefix: "$", decimals: 2, commas: false },
  { n: "نحاس",     s: "رطل",    yahoo: "HG=F",                       google: "HG00:COMEX",      prefix: "$", decimals: 2, commas: false },
];

async function buildCommodityQuote(def: CommodityDef): Promise<Quote | null> {
  // 1) Yahoo Finance futures (real price + %, no key, no conversion factors)
  if (def.yahoo) {
    const y = await fetchYahooIndexQuote(def.yahoo);
    if (y) {
      const v = `${def.prefix ?? ""}${fmtNumber(y.price, { decimals: def.decimals ?? 2, commas: def.commas ?? true })}${def.suffix ?? ""}`;
      return { n: def.n, v, c: fmtPct(y.pct), up: y.pct >= 0, s: def.s };
    }
  }
  // 2) Finnhub ETF (realtime %, calibrated spot price)
  if (def.finnhub) {
    const fh = await fetchFinnhub(def.finnhub);
    if (fh) {
      const factor = def.finnhubFactor ?? 1;
      const price = fh.c * factor;
      const v = `${def.prefix ?? ""}${fmtNumber(price, { decimals: def.decimals ?? 2, commas: def.commas ?? true })}${def.suffix ?? ""}`;
      return { n: def.n, v, c: fmtPct(fh.dp), up: fh.dp >= 0, s: def.s };
    }
  }
  // 3) Google Finance (fallback — real spot price)
  if (def.google) {
    const g = await fetchGoogleFinance(def.google);
    if (g) {
      const pct = g.prev > 0 ? ((g.price - g.prev) / g.prev) * 100 : 0;
      const v = `${def.prefix ?? ""}${fmtNumber(g.price, { decimals: def.decimals ?? 2, commas: def.commas ?? true })}${def.suffix ?? ""}`;
      return { n: def.n, v, c: fmtPct(pct), up: pct >= 0, s: def.s };
    }
  }
  return null;
}

/* ── Crypto via Finnhub (Binance pairs) ── */

type CryptoSpec = { n: string; s: string; finnhub: string };

const CRYPTO_LIST: CryptoSpec[] = [
  { n: "BTC", s: "بيتكوين",  finnhub: "BINANCE:BTCUSDT" },
  { n: "ETH", s: "إيثريوم",  finnhub: "BINANCE:ETHUSDT" },
  { n: "SOL", s: "سولانا",   finnhub: "BINANCE:SOLUSDT" },
  { n: "XRP", s: "ريبل",     finnhub: "BINANCE:XRPUSDT" },
];

async function buildCryptoQuote(spec: CryptoSpec): Promise<Quote> {
  const fh = await fetchFinnhub(spec.finnhub);
  if (fh) {
    const price = fh.c;
    const v = price >= 1000
      ? `$${(price / 1000).toFixed(1)}K`
      : price >= 1
        ? `$${price.toFixed(2)}`
        : `$${price.toFixed(4)}`;
    return { n: spec.n, v, c: fmtPct(fh.dp), up: fh.dp >= 0, s: spec.s };
  }
  // Fallback: CoinGecko (no key required)
  try {
    const ids: Record<string, string> = {
      "BINANCE:BTCUSDT": "bitcoin", "BINANCE:ETHUSDT": "ethereum",
      "BINANCE:BNBUSDT": "binancecoin", "BINANCE:XRPUSDT": "ripple",
      "BINANCE:SOLUSDT": "solana",
    };
    const id = ids[spec.finnhub];
    if (!id) throw new Error("no id");
    const text = await fetchText(
      `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd&include_24hr_change=true`,
      9000,
    );
    const data = JSON.parse(text) as Record<string, { usd?: number; usd_24h_change?: number }>;
    const price = data[id]?.usd ?? NaN;
    const pct = data[id]?.usd_24h_change ?? 0;
    if (!Number.isFinite(price)) throw new Error("no price");
    const v = price >= 1000 ? `$${(price / 1000).toFixed(1)}K` : price >= 1 ? `$${price.toFixed(2)}` : `$${price.toFixed(4)}`;
    return { n: spec.n, v, c: fmtPct(pct), up: pct >= 0, s: spec.s };
  } catch {
    return { n: spec.n, v: "—", c: "—", up: true, s: spec.s };
  }
}

/* ═══════════════════════════════════════════════════
   MARKETS CACHE + BUILDER
   ═══════════════════════════════════════════════════ */

type MarketsPayload = {
  status: "ok";
  ts: number;
  sources: { indices: string; forex: string; commodities: string; crypto: string };
  markets: { eg: Quote[]; gl: Quote[]; cm: Quote[]; cr: Quote[] };
  ticker: Quote[];
};

let marketsCache: { ts: number; data: MarketsPayload } | null = null;
const MARKETS_TTL_MS = 60 * 1000; // 1 minute

async function buildMarketsPayload(): Promise<MarketsPayload> {
  // EGX30 first (one Yahoo call), then stagger the rest to stay under Yahoo burst limits
  const egx30Raw = await fetchEGX30();
  const [fxResults, glResults, cmResults, crResults] = await Promise.all([
    mapStaggeredQuotes(FX_PAIRS, buildFxQuote, 120),
    mapStaggeredQuotes(GLOBAL_INDICES, buildIndexQuote, 120),
    mapStaggeredQuotes(COMMODITIES, buildCommodityQuote, 120),
    Promise.all(CRYPTO_LIST.map(buildCryptoQuote)),
  ]);

  const egx30: Quote | null = egx30Raw
    ? { n: "EGX30", v: fmtNumber(egx30Raw.price, { decimals: 2, commas: true }), c: fmtPct(egx30Raw.pctChange), up: egx30Raw.pctChange >= 0, s: "مؤشر رئيسي", clickable: true }
    : null;

  const fx = fxResults.filter((x): x is Quote => x !== null);
  const gl = glResults.filter((x): x is Quote => x !== null);
  const cm = cmResults.filter((x): x is Quote => x !== null);
  const cr = crResults;

  const eg: Quote[] = [];
  if (egx30) eg.push(egx30);
  eg.push(...fx.slice(0, 3));

  const ticker: Quote[] = [];
  if (egx30) ticker.push(egx30);
  if (fx[0]) ticker.push(fx[0]);
  if (cm[0]) ticker.push(cm[0]);
  if (cm[1]) ticker.push(cm[1]);
  if (gl[0]) ticker.push(gl[0]);
  if (cr[0]) ticker.push(cr[0]);
  if (cr[1]) ticker.push(cr[1]);

  // Track which sources actually responded
  const hasFinnhub = !!FINNHUB_KEY && gl.length > 0;
  const hasAV = !!AV_KEY && fx.length > 0;

  return {
    status: "ok",
    ts: Date.now(),
    sources: {
      indices: egx30Raw?.source === "TradingEconomics"
        ? "TradingEconomics (EGX30) + Yahoo Finance"
        : "Yahoo Finance",
      forex: hasAV ? "Yahoo Finance + Alpha Vantage" : "Yahoo Finance",
      commodities: "Yahoo Finance",
      crypto: hasFinnhub ? "Finnhub/Binance" : "CoinGecko",
    },
    markets: { eg, gl, cm, cr },
    ticker,
  };
}

/* Result carries `stale` so the route keeps its original contract:
 * fresh build → plain payload, failed build + old cache → payload + stale. */
type SnapshotResult = { data: MarketsPayload; stale?: boolean } | null;

async function loadMarketsPayload(): Promise<SnapshotResult> {
  try {
    const data = await buildMarketsPayload();
    marketsCache = { ts: Date.now(), data };
    return { data };
  } catch (e) {
    logger.error({ err: (e as Error).message }, "markets build failed");
    return marketsCache ? { data: marketsCache.data, stale: true } : null;
  }
}

let marketsBuildInFlight: Promise<SnapshotResult> | null = null;

/* In-process snapshot for the local AI engine (and any other caller inside
 * this process). On serverless there is NO localhost HTTP listener to call,
 * so the AI engine must read the same cache the routes use instead of
 * fetching /api/markets over the network. Concurrent callers share one
 * in-flight build; stale data beats no data. */
export function getMarketsSnapshot(): Promise<SnapshotResult> {
  if (marketsCache && Date.now() - marketsCache.ts < MARKETS_TTL_MS) {
    return Promise.resolve({ data: marketsCache.data });
  }
  if (!marketsBuildInFlight) {
    marketsBuildInFlight = loadMarketsPayload().finally(() => {
      marketsBuildInFlight = null;
    });
  }
  return marketsBuildInFlight;
}

router.get("/", async (_req: Request, res: Response) => {
  const now = Date.now();
  if (marketsCache && now - marketsCache.ts < MARKETS_TTL_MS) {
    res.json(marketsCache.data);
    return;
  }
  const snap = await getMarketsSnapshot();
  if (snap) {
    res.json(snap.stale ? { ...snap.data, stale: true } : snap.data);
    return;
  }
  res.status(503).json({ status: "error", message: "markets unavailable" });
});

/* ═══════════════════════════════════════════════════
   ECONOMIC CALENDAR  (ForexFactory — unchanged)
   ═══════════════════════════════════════════════════ */

type FFEvent = { title: string; country: string; date: string; impact: string; forecast: string; previous: string };
type CalEvent = { ev: string; evEn: string; t: string; tISO: string; imp: string; c: string; country: string; countryAr: string; flag: string; forecast: string; previous: string };

const COUNTRY_INFO: Record<string, { ar: string; flag: string }> = {
  USD: { ar: "الولايات المتحدة", flag: "🇺🇸" },
  EUR: { ar: "منطقة اليورو",    flag: "🇪🇺" },
  GBP: { ar: "المملكة المتحدة", flag: "🇬🇧" },
  JPY: { ar: "اليابان",        flag: "🇯🇵" },
  CHF: { ar: "سويسرا",         flag: "🇨🇭" },
  CAD: { ar: "كندا",           flag: "🇨🇦" },
  AUD: { ar: "أستراليا",       flag: "🇦🇺" },
  NZD: { ar: "نيوزيلندا",      flag: "🇳🇿" },
  CNY: { ar: "الصين",          flag: "🇨🇳" },
};

const EVENT_TRANSLATIONS: Array<[RegExp, string]> = [
  [/Federal Funds Rate|FOMC Statement|FOMC Press Conference|FOMC Meeting/i, "قرار الفائدة الأمريكية (الفيدرالي)"],
  [/Non-Farm Employment Change|Non-Farm Payrolls|NFP/i, "بيانات الوظائف الأمريكية (NFP)"],
  [/Unemployment Rate/i, "معدل البطالة"],
  [/Average Hourly Earnings/i, "متوسط الأجور بالساعة"],
  [/CPI m\/m|CPI y\/y|Consumer Price Index|^CPI|Inflation/i, "مؤشر التضخم (CPI)"],
  [/Core CPI/i, "التضخم الأساسي (Core CPI)"],
  [/PPI/i, "مؤشر أسعار المنتجين (PPI)"],
  [/PCE Price Index/i, "مؤشر نفقات الاستهلاك (PCE)"],
  [/GDP|Gross Domestic Product/i, "الناتج المحلي الإجمالي (GDP)"],
  [/Retail Sales/i, "مبيعات التجزئة"],
  [/Industrial Production/i, "الإنتاج الصناعي"],
  [/Manufacturing PMI/i, "PMI الصناعي"],
  [/Services PMI|Non-Manufacturing PMI/i, "PMI قطاع الخدمات"],
  [/Composite PMI/i, "PMI المركب"],
  [/Consumer Confidence/i, "ثقة المستهلك"],
  [/Building Permits/i, "تصاريح البناء"],
  [/Housing Starts/i, "بدء بناء المنازل"],
  [/Existing Home Sales/i, "مبيعات المنازل القائمة"],
  [/New Home Sales/i, "مبيعات المنازل الجديدة"],
  [/Crude Oil Inventories/i, "مخزونات النفط الأمريكي"],
  [/Initial Jobless Claims|Unemployment Claims/i, "طلبات إعانة البطالة"],
  [/Trade Balance/i, "الميزان التجاري"],
  [/Current Account/i, "ميزان الحساب الجاري"],
  [/Main Refinancing Rate|ECB.*Rate|ECB.*Press/i, "اجتماع البنك المركزي الأوروبي (ECB)"],
  [/Bank of England|BoE.*Rate|MPC/i, "اجتماع بنك إنجلترا (BoE)"],
  [/BoJ|Bank of Japan/i, "اجتماع بنك اليابان (BoJ)"],
  [/SNB|Swiss National Bank/i, "اجتماع البنك الوطني السويسري"],
  [/RBA|Reserve Bank of Australia/i, "اجتماع بنك الاحتياطي الأسترالي"],
  [/BoC|Bank of Canada/i, "اجتماع بنك كندا"],
  [/Fed Chair|Powell Speaks|Fed Speaks/i, "خطاب رئيس الفيدرالي"],
  [/Trump Speaks/i, "كلمة الرئيس الأمريكي"],
  [/President Speaks/i, "كلمة رئاسية"],
  [/JOLTS|Job Openings/i, "تقرير فرص العمل (JOLTS)"],
  [/ADP/i, "تقرير ADP للتوظيف الخاص"],
];

function translateEvent(en: string): string {
  for (const [re, ar] of EVENT_TRANSLATIONS) {
    if (re.test(en)) return ar;
  }
  return en;
}

const ARABIC_WEEKDAYS = ["الأحد", "الإثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];

function fmtArabicDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const cairo = new Date(d.getTime() + 2 * 60 * 60 * 1000);
  const day = ARABIC_WEEKDAYS[cairo.getUTCDay()];
  const hh = String(cairo.getUTCHours()).padStart(2, "0");
  const mm = String(cairo.getUTCMinutes()).padStart(2, "0");
  return `${day} ${hh}:${mm}`;
}

function impactInfo(imp: string): { ar: string; c: string; rank: number } {
  const lower = (imp || "").toLowerCase();
  if (lower === "high")   return { ar: "عالي",    c: "#ef4444", rank: 3 };
  if (lower === "medium") return { ar: "متوسط",   c: "#f59e0b", rank: 2 };
  if (lower === "low")    return { ar: "منخفض",   c: "#0ea5e9", rank: 1 };
  return { ar: "—", c: "#64748b", rank: 0 };
}

let calCache: { ts: number; data: { status: "ok"; events: CalEvent[] } } | null = null;
const CAL_TTL_MS = 30 * 60 * 1000;

async function buildCalendarPayload(): Promise<{ status: "ok"; events: CalEvent[] }> {
  const text = await fetchText("https://nfs.faireconomy.media/ff_calendar_thisweek.json", 12000);
  const raw = JSON.parse(text) as FFEvent[];
  const now = Date.now();

  const events: CalEvent[] = raw
    .filter((e) => {
      if (!e?.title || !e.date || !e.country) return false;
      const imp = (e.impact || "").toLowerCase();
      if (!(imp === "high" || imp === "medium")) return false;
      if (!COUNTRY_INFO[e.country]) return false;
      const t = new Date(e.date).getTime();
      return Number.isFinite(t) && t > now - 6 * 60 * 60 * 1000;
    })
    .map((e) => {
      const inf = impactInfo(e.impact);
      const country = COUNTRY_INFO[e.country];
      return {
        ev: translateEvent(e.title),
        evEn: e.title,
        t: fmtArabicDateTime(e.date),
        tISO: e.date,
        imp: inf.ar,
        c: inf.c,
        country: e.country,
        countryAr: country.ar,
        flag: country.flag,
        forecast: e.forecast || "",
        previous: e.previous || "",
      };
    })
    .sort((a, b) => new Date(a.tISO).getTime() - new Date(b.tISO).getTime())
    .slice(0, 12);

  return { status: "ok", events };
}

/* In-process calendar snapshot for the AI tool layer (same cache the route
 * serves). On serverless there is NO localhost listener, and a self-HTTPS
 * fetch can time out on cold starts — read the cache directly instead. */
let calBuildInFlight: Promise<{ status: "ok"; events: CalEvent[] } | null> | null = null;
export function getCalendarSnapshot(): Promise<{ status: "ok"; events: CalEvent[] } | null> {
  if (calCache && Date.now() - calCache.ts < CAL_TTL_MS) {
    return Promise.resolve(calCache.data);
  }
  if (!calBuildInFlight) {
    calBuildInFlight = (async () => {
      try {
        const data = await buildCalendarPayload();
        calCache = { ts: Date.now(), data };
        return data;
      } catch (e) {
        logger.error({ err: (e as Error).message }, "calendar snapshot build failed");
        return calCache ? calCache.data : null;
      }
    })().finally(() => {
      calBuildInFlight = null;
    });
  }
  return calBuildInFlight;
}

router.get("/calendar", async (_req: Request, res: Response) => {
  const now = Date.now();
  if (calCache && now - calCache.ts < CAL_TTL_MS) {
    res.json(calCache.data);
    return;
  }
  try {
    const data = await buildCalendarPayload();
    calCache = { ts: now, data };
    res.json(data);
  } catch (e) {
    logger.error({ err: (e as Error).message }, "calendar build failed");
    if (calCache) {
      res.json({ ...calCache.data, stale: true });
    } else {
      res.status(503).json({ status: "error", message: "calendar unavailable" });
    }
  }
});

/* ═══════════════════════════════════════════════════
   STOCKS — Yahoo Finance  (EGX + US, no API key needed)
   Quotes: 3-min cache  |  Batched in groups of 25
   ═══════════════════════════════════════════════════ */

type StockDef = { sym: string; yahoo: string; name: string; sector: string };

/* Curated names below were re-verified against TradingView's symbol identity
 * (English description) for each ticker — several entries had been attached
 * to the WRONG company (GBCO is GB Corp, not Gulf Investment; CCAP is Qalaa,
 * not Cairo Housing; ISPH is Ibnsina Pharma; OLFI is Obour Land; ASCM is
 * ASEC Mining; ORWE is Oriental Weavers; AMOC is Alexandria Mineral Oils;
 * ACGC is Arab Cotton Ginning; MCQE is Misr Cement Qena; SPIN is Alexandria
 * Spinning; KABO is El Nasr Clothing; CIEB is Crédit Agricole). Wrong labels
 * made the AI name the wrong company for those tickers. */
/* Arabic display name for an EGX symbol: the curated EGX_DEFS name wins
 * (it carries the colloquial name users search for), then the generated
 * Arabic label, then the raw feed description. */
function egxName(sym: string, curated?: string): string {
  return curated || EGX_AR_NAMES[sym] || sym;
}

/* ─── EGX Stocks (~65 most-liquid listings) ─── */
const EGX_DEFS: StockDef[] = [
  // بنوك
  /* COMI.CA is the EGX ticker of Commercial International Bank (verified
   * against Yahoo meta), NOT Banque du Caire — the old label made the AI
   * report the wrong company for «التجاري الدولي». */
  { sym:"COMI",  yahoo:"COMI.CA",  name:"البنك التجاري الدولي",        sector:"بنوك"       },
  { sym:"HBCO",  yahoo:"HBCO.CA",  name:"HSBC مصر",                    sector:"بنوك"       },
  { sym:"ADIB",  yahoo:"ADIB.CA",  name:"مصرف أبوظبي الإسلامي",        sector:"بنوك"       },
  { sym:"AIBC",  yahoo:"AIBC.CA",  name:"بنك الاستثمار العربي",         sector:"بنوك"       },
  { sym:"ABCB",  yahoo:"ABCB.CA",  name:"بنك ABC مصر",                 sector:"بنوك"       },
  { sym:"EDBE",  yahoo:"EDBE.CA",  name:"بنك تنمية الصادرات",           sector:"بنوك"       },
  { sym:"MCQE",  yahoo:"MCQE.CA",  name:"مصر للأسمنت - قنا",           sector:"مواد بناء"  },
  /* TradingView's EGX symbol is FWRY (FAWRY.CA is a dead ticker), so this
   * entry never matched the live row and «فوري» had no Arabic name to hit. */
  { sym:"FWRY",  yahoo:"FWRY.CA",  name:"فوري للتكنولوجيا",             sector:"تقنية"      },
  // مالية
  { sym:"HRHO",  yahoo:"HRHO.CA",  name:"هيرميس القابضة",              sector:"مالية"      },
  { sym:"GBCO",  yahoo:"GBCO.CA",  name:"جي بي اوتو (جي بي كورب)",      sector:"صناعة"      },
  { sym:"SFAP",  yahoo:"SFAP.CA",  name:"مصر للتأمين",                 sector:"مالية"      },
  { sym:"CIEB",  yahoo:"CIEB.CA",  name:"كريدي أجريكول مصر",           sector:"بنوك"       },
  { sym:"IDKO",  yahoo:"IDKO.CA",  name:"إيدكو للغاز",                 sector:"مالية"      },
  // تقنية
  { sym:"EFIH",  yahoo:"EFIH.CA",  name:"إي فاينانس",                  sector:"تقنية"      },
  { sym:"OTLQ",  yahoo:"OTLQ.CA",  name:"أوراسكوم TMT",                sector:"تقنية"      },
  // اتصالات
  { sym:"ETEL",  yahoo:"ETEL.CA",  name:"المصرية للاتصالات",           sector:"اتصالات"    },
  { sym:"GGHE",  yahoo:"GGHE.CA",  name:"جلوبال تيليكوم",              sector:"اتصالات"    },
  { sym:"MTEL",  yahoo:"MTEL.CA",  name:"أورنج مصر",                   sector:"اتصالات"    },
  // عقارات
  { sym:"OCDI",  yahoo:"OCDI.CA",  name:"سوديك",                      sector:"عقارات"     },
  { sym:"TMGH",  yahoo:"TMGH.CA",  name:"طلعت مصطفى",                 sector:"عقارات"     },
  /* MNHD.CA is gone: the company (Madinet Nasr Housing) rebranded to
   * Madinet Masr and the EGX ticker moved to MASR, so «مدينة مصر» had no
   * row to match and the AI answered «لا تتوفر بيانات». */
  { sym:"MASR",  yahoo:"MASR.CA",  name:"مدينة مصر للإسكان (مدينة نصر)", sector:"عقارات"    },
  { sym:"PHDC",  yahoo:"PHDC.CA",  name:"بالم هيلز",                   sector:"عقارات"     },
  { sym:"HELI",  yahoo:"HELI.CA",  name:"مصر الجديدة للإسكان والتعمير", sector:"عقارات"     },
  { sym:"CIRA",  yahoo:"CIRA.CA",  name:"القاهرة للاستثمار والتعمير",   sector:"عقارات"     },
  { sym:"CCAP",  yahoo:"CCAP.CA",  name:"القلعة للاستشارات المالية",    sector:"مالية"      },
  // صناعة
  { sym:"ABUK",  yahoo:"ABUK.CA",  name:"أبوقير للأسمدة",              sector:"صناعة"      },
  { sym:"SWDY",  yahoo:"SWDY.CA",  name:"السويدي إليكتريك",             sector:"صناعة"      },
  { sym:"ESRS",  yahoo:"ESRS.CA",  name:"عز للصلب",                    sector:"صناعة"      },
  { sym:"AMOC",  yahoo:"AMOC.CA",  name:"أموك (الإسكندرية للزيوت المعدنية)", sector:"طاقة"  },
  { sym:"ACGC",  yahoo:"ACGC.CA",  name:"العربية لحليج الأقطان",        sector:"صناعة"      },
  { sym:"SKPC",  yahoo:"SKPC.CA",  name:"سيدي كرير للبتروكيماويات",    sector:"صناعة"      },
  { sym:"ORWE",  yahoo:"ORWE.CA",  name:"النساجون الشرقيون",            sector:"صناعة"      },
  { sym:"ARPH",  yahoo:"ARPH.CA",  name:"العربية للأوراق",              sector:"صناعة"      },
  { sym:"SPIN",  yahoo:"SPIN.CA",  name:"سبينالكس (الإسكندرية للغزل والنسيج)", sector:"صناعة" },
  { sym:"KABO",  yahoo:"KABO.CA",  name:"كابو (النصر للملابس والمنسوجات)", sector:"صناعة"   },
  // صحة
  { sym:"CLHO",  yahoo:"CLHO.CA",  name:"كليوباترا للمستشفيات",         sector:"صحة"        },
  { sym:"ISPH",  yahoo:"ISPH.CA",  name:"ابن سينا فارما",               sector:"صحة"        },
  { sym:"ACDP",  yahoo:"ACDP.CA",  name:"أكوردا إيجيبت",               sector:"صحة"        },
  { sym:"BMWO",  yahoo:"BMWO.CA",  name:"بيوميديكال للرعاية",           sector:"صحة"        },
  // أدوية
  { sym:"PHAR",  yahoo:"PHAR.CA",  name:"إيبي فارما",                  sector:"أدوية"      },
  { sym:"EGCH",  yahoo:"EGCH.CA",  name:"إيجيبت للصناعات الكيماوية",   sector:"أدوية"      },
  // غذائية
  { sym:"EAST",  yahoo:"EAST.CA",  name:"الشرق للدخان",               sector:"غذائية"     },
  { sym:"JUFO",  yahoo:"JUFO.CA",  name:"جهينة للأغذية",               sector:"غذائية"     },
  { sym:"EFID",  yahoo:"EFID.CA",  name:"إيديتا للصناعات الغذائية",    sector:"غذائية"     },
  { sym:"POUL",  yahoo:"POUL.CA",  name:"القاهرة للدواجن",             sector:"غذائية"     },
  { sym:"DOMT",  yahoo:"DOMT.CA",  name:"دومتي (العربية للأغذية)",     sector:"غذائية"     },
  { sym:"OLFI",  yahoo:"OLFI.CA",  name:"عبور لاند للصناعات الغذائية",  sector:"غذائية"     },
  /* AMER.CA = Amer Group Holding (عامر جروب) on the EGX. It is not
   * Americana, which is not listed in Cairo — the wrong label made
   * «حلل سهم عامر جروب» answer «لا تتوفر بيانات». */
  { sym:"AMER",  yahoo:"AMER.CA",  name:"عامر جروب",                   sector:"استثمار"    },
  // مواد بناء
  { sym:"ASCM",  yahoo:"ASCM.CA",  name:"أسيك للتعدين",                 sector:"مواد بناء"  },
  { sym:"ARCO",  yahoo:"ARCO.CA",  name:"العربية للمقاولات",           sector:"مواد بناء"  },
  { sym:"HELB",  yahoo:"HELB.CA",  name:"هيلنان للفنادق",              sector:"مواد بناء"  },
  { sym:"KAHA",  yahoo:"KAHA.CA",  name:"قها للمحاصيل الغذائية",       sector:"غذائية"     },
  // طاقة
  { sym:"SCOM",  yahoo:"SCOM.CA",  name:"سيدي كرير للصناعات",          sector:"طاقة"       },
  { sym:"AMCO",  yahoo:"AMCO.CA",  name:"أموك للطاقة",                 sector:"طاقة"       },
];

/* ─── US Stocks (~60 S&P 500 heavyweights) ─── */
const US_DEFS: StockDef[] = [
  // Technology
  { sym:"AAPL",  yahoo:"AAPL",  name:"Apple",                    sector:"Technology"  },
  { sym:"MSFT",  yahoo:"MSFT",  name:"Microsoft",                sector:"Technology"  },
  { sym:"NVDA",  yahoo:"NVDA",  name:"NVIDIA",                   sector:"Technology"  },
  { sym:"GOOGL", yahoo:"GOOGL", name:"Alphabet (Google)",        sector:"Technology"  },
  { sym:"META",  yahoo:"META",  name:"Meta Platforms",           sector:"Technology"  },
  { sym:"AVGO",  yahoo:"AVGO",  name:"Broadcom",                 sector:"Technology"  },
  { sym:"ADBE",  yahoo:"ADBE",  name:"Adobe",                    sector:"Technology"  },
  { sym:"CRM",   yahoo:"CRM",   name:"Salesforce",               sector:"Technology"  },
  { sym:"ORCL",  yahoo:"ORCL",  name:"Oracle",                   sector:"Technology"  },
  { sym:"QCOM",  yahoo:"QCOM",  name:"Qualcomm",                 sector:"Technology"  },
  { sym:"AMD",   yahoo:"AMD",   name:"AMD",                      sector:"Technology"  },
  { sym:"INTC",  yahoo:"INTC",  name:"Intel",                    sector:"Technology"  },
  { sym:"CSCO",  yahoo:"CSCO",  name:"Cisco",                    sector:"Technology"  },
  { sym:"IBM",   yahoo:"IBM",   name:"IBM",                      sector:"Technology"  },
  { sym:"NFLX",  yahoo:"NFLX",  name:"Netflix",                  sector:"Technology"  },
  // Consumer
  { sym:"AMZN",  yahoo:"AMZN",  name:"Amazon",                   sector:"Consumer"    },
  { sym:"TSLA",  yahoo:"TSLA",  name:"Tesla",                    sector:"Consumer"    },
  { sym:"WMT",   yahoo:"WMT",   name:"Walmart",                  sector:"Consumer"    },
  { sym:"HD",    yahoo:"HD",    name:"Home Depot",               sector:"Consumer"    },
  { sym:"MCD",   yahoo:"MCD",   name:"McDonald's",               sector:"Consumer"    },
  { sym:"NKE",   yahoo:"NKE",   name:"Nike",                     sector:"Consumer"    },
  { sym:"SBUX",  yahoo:"SBUX",  name:"Starbucks",                sector:"Consumer"    },
  { sym:"COST",  yahoo:"COST",  name:"Costco",                   sector:"Consumer"    },
  { sym:"DIS",   yahoo:"DIS",   name:"Walt Disney",              sector:"Consumer"    },
  { sym:"LOW",   yahoo:"LOW",   name:"Lowe's",                   sector:"Consumer"    },
  { sym:"TGT",   yahoo:"TGT",   name:"Target",                   sector:"Consumer"    },
  // Finance
  { sym:"BRK-B", yahoo:"BRK-B", name:"Berkshire Hathaway",      sector:"Finance"     },
  { sym:"JPM",   yahoo:"JPM",   name:"JPMorgan Chase",           sector:"Finance"     },
  { sym:"V",     yahoo:"V",     name:"Visa",                     sector:"Finance"     },
  { sym:"MA",    yahoo:"MA",    name:"Mastercard",               sector:"Finance"     },
  { sym:"BAC",   yahoo:"BAC",   name:"Bank of America",          sector:"Finance"     },
  { sym:"GS",    yahoo:"GS",    name:"Goldman Sachs",            sector:"Finance"     },
  { sym:"MS",    yahoo:"MS",    name:"Morgan Stanley",           sector:"Finance"     },
  { sym:"AXP",   yahoo:"AXP",   name:"American Express",         sector:"Finance"     },
  { sym:"C",     yahoo:"C",     name:"Citigroup",                sector:"Finance"     },
  { sym:"PYPL",  yahoo:"PYPL",  name:"PayPal",                   sector:"Finance"     },
  // Healthcare
  { sym:"UNH",   yahoo:"UNH",   name:"UnitedHealth Group",       sector:"Healthcare"  },
  { sym:"LLY",   yahoo:"LLY",   name:"Eli Lilly",                sector:"Healthcare"  },
  { sym:"JNJ",   yahoo:"JNJ",   name:"Johnson & Johnson",        sector:"Healthcare"  },
  { sym:"ABBV",  yahoo:"ABBV",  name:"AbbVie",                   sector:"Healthcare"  },
  { sym:"MRK",   yahoo:"MRK",   name:"Merck",                    sector:"Healthcare"  },
  { sym:"TMO",   yahoo:"TMO",   name:"Thermo Fisher",            sector:"Healthcare"  },
  { sym:"PFE",   yahoo:"PFE",   name:"Pfizer",                   sector:"Healthcare"  },
  { sym:"ABT",   yahoo:"ABT",   name:"Abbott Labs",              sector:"Healthcare"  },
  { sym:"BMY",   yahoo:"BMY",   name:"Bristol-Myers Squibb",     sector:"Healthcare"  },
  // Staples & Energy
  { sym:"PG",    yahoo:"PG",    name:"Procter & Gamble",         sector:"Consumer"    },
  { sym:"KO",    yahoo:"KO",    name:"Coca-Cola",                sector:"Consumer"    },
  { sym:"PEP",   yahoo:"PEP",   name:"PepsiCo",                  sector:"Consumer"    },
  { sym:"XOM",   yahoo:"XOM",   name:"ExxonMobil",               sector:"Energy"      },
  { sym:"CVX",   yahoo:"CVX",   name:"Chevron",                  sector:"Energy"      },
  // Industrials & Telecom
  { sym:"BA",    yahoo:"BA",    name:"Boeing",                   sector:"Industrials" },
  { sym:"CAT",   yahoo:"CAT",   name:"Caterpillar",              sector:"Industrials" },
  { sym:"HON",   yahoo:"HON",   name:"Honeywell",                sector:"Industrials" },
  { sym:"GE",    yahoo:"GE",    name:"GE Aerospace",             sector:"Industrials" },
  { sym:"F",     yahoo:"F",     name:"Ford Motor",               sector:"Industrials" },
  { sym:"GM",    yahoo:"GM",    name:"General Motors",           sector:"Industrials" },
  { sym:"T",     yahoo:"T",     name:"AT&T",                     sector:"Telecom"     },
  { sym:"VZ",    yahoo:"VZ",    name:"Verizon",                  sector:"Telecom"     },
];

export type StockQuote = {
  sym: string; name: string; sector: string;
  price: number; prevClose: number; chg: number; chgPct: number;
  vol: number; high: number; low: number; open: number;
  mktCapM?: number;
  pe?: number; forwardPE?: number; divYield?: number; eps?: number;
  bookValue?: number; priceToBook?: number; sharesM?: number;
  high52w?: number; low52w?: number;
  /** When this server obtained the value (cache/board time). */
  ts: number;
  /** The provider's own market time for the value, epoch ms. Never invented. */
  asOf?: number;
  /** Declared contractual delay of the feed, when the provider states it. */
  delayedMinutes?: number;
};

/* yahoo-finance2 v3 — default export is the YahooFinance class; must use `new`. */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const YFClass = require("yahoo-finance2").default as new(opts?: Record<string, unknown>) => {
  quote: (symbol: string, queryOptions?: Record<string, unknown>, moduleOptions?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  chart: (symbol: string, queryOptions?: Record<string, unknown>, moduleOptions?: Record<string, unknown>) => Promise<{ quotes?: Array<{ volume?: number | null; date?: unknown }>; meta?: Record<string, unknown> }>;
};
const yf = new YFClass({ suppressNotices: ["yahooSurvey"] });

/* The Yahoo quote endpoint omits regularMarketVolume for EGX (Egyptian Exchange)
 * tickers entirely. The chart endpoint DOES return real daily volume bars.
 * Results are cached per symbol for 30 min — one lightweight 7-day chart call
 * per stock per refresh cycle, bounded by the same allSettled + batch flow as
 * quotes (v3 chart API uses epoch period1/period2, not range strings). */
const volCache = new Map<string, { ts: number; vol: number | null }>();
const VOL_TTL_MS = 30 * 60 * 1000;
const VOL_TIMEOUT_MS = 7000;

async function fetchYahooVolume(yahooSym: string): Promise<number | null> {
  const cached = volCache.get(yahooSym);
  if (cached && Date.now() - cached.ts < VOL_TTL_MS) return cached.vol;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), VOL_TIMEOUT_MS);
  try {
    const p2 = Math.floor(Date.now() / 1000);
    const p1 = p2 - 7 * 86400;
    const r = await yf.chart(yahooSym, { period1: p1, period2: p2, interval: "1d" }, { validateResult: false, signal: ctrl.signal });
    const bars = (r?.quotes || []).filter((b) => b && b.volume != null);
    const last = bars.length ? bars[bars.length - 1] : null;
    const vol = last && typeof last.volume === "number" ? last.volume : null;
    volCache.set(yahooSym, { ts: Date.now(), vol });
    return vol;
  } catch (e) {
    /* network/abort/validation failure — cache the miss briefly to avoid hammering */
    logger.warn({ sym: yahooSym, err: (e as Error).message }, "yf2 chart volume fetch failed");
    volCache.set(yahooSym, { ts: Date.now() - VOL_TTL_MS + 60_000, vol: null });
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function fetchYahooQuote(def: StockDef): Promise<StockQuote | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const q = await yf.quote(def.yahoo, {}, { validateResult: false }) as any;
    if (!q || !q.regularMarketPrice || q.regularMarketPrice === 0) return null;
    const price  = q.regularMarketPrice;
    const prev   = q.regularMarketPreviousClose ?? price;
    const chg    = price - prev;
    const chgPct = prev > 0 ? (chg / prev) * 100 : 0;
    /* No provider time means no proof of freshness: the quote is refused
     * rather than stamped with the time we happened to receive it. */
    const asOf = Number(q.regularMarketTime) * 1000;
    if (isDeadQuote(asOf)) {
      logger.warn({ sym: def.sym, asOf }, "yf2 quote rejected as no longer maintained");
      return null;
    }
    let vol = q.regularMarketVolume ?? 0;
    /* EGX tickers never carry volume on the quote endpoint — fill from the
     * chart endpoint's real daily bars (cached). Never fabricate: if Yahoo
     * has none there either, it stays 0 and the UI shows "—". */
    if (!vol && def.yahoo.endsWith(".CA")) {
      vol = (await fetchYahooVolume(def.yahoo)) ?? 0;
    }
    return {
      sym:        def.sym,
      name:       def.name,
      sector:     def.sector,
      price,
      prevClose:  prev,
      chg,
      chgPct,
      vol:        vol,
      high:       q.regularMarketDayHigh ?? price,
      low:        q.regularMarketDayLow  ?? price,
      open:       q.regularMarketOpen    ?? price,
      mktCapM:    q.marketCap ? Math.round(q.marketCap / 1_000_000) : undefined,
      pe:         q.trailingPE ?? undefined,
      forwardPE:  q.forwardPE ?? undefined,
      divYield:   q.trailingAnnualDividendYield != null ? q.trailingAnnualDividendYield * 100 : undefined,
      eps:        q.epsTrailingTwelveMonths ?? undefined,
      bookValue:  q.bookValue ?? undefined,
      priceToBook:q.priceToBook ?? undefined,
      sharesM:    q.sharesOutstanding ? Math.round(q.sharesOutstanding / 1_000_000) : undefined,
      high52w:    q.fiftyTwoWeekHigh ?? undefined,
      low52w:     q.fiftyTwoWeekLow  ?? undefined,
      ts:         Date.now(),
      asOf,
      delayedMinutes: 0,
    };
  } catch (e) {
    logger.warn({ sym: def.sym, err: (e as Error).message }, "yf2 quote failed");
    return null;
  }
}

/* Batch fetching — avoid Yahoo Finance rate limits */
async function fetchStocksBatched(defs: StockDef[], batchSize = 25, delayMs = 400): Promise<StockQuote[]> {
  const results: StockQuote[] = [];
  for (let i = 0; i < defs.length; i += batchSize) {
    const batch = defs.slice(i, i + batchSize);
    const settled = await Promise.allSettled(batch.map(fetchYahooQuote));
    settled.forEach(r => { if (r.status === "fulfilled" && r.value) results.push(r.value); });
    if (i + batchSize < defs.length) await new Promise(r => setTimeout(r, delayMs));
  }
  return results;
}

let stocksCache:   { ts: number; stocks: StockQuote[] } | null = null;
let usStocksCache: { ts: number; stocks: StockQuote[] } | null = null;

/* ─── TradingView Egypt scanner — real-time full EGX universe ────
 * Yahoo's quote endpoint serves STALE prices for many EGX tickers
 * (verified: EGAL quote 14.05 vs chart/TV ~357; COMI 81.2 vs 128)
 * and caps coverage at ~32 names. The TV scanner returns ~296 live
 * equities with price/volume/cap/PE/div/52w — values cross-checked
 * against Yahoo chart closes. Falls back to the Yahoo flow below on
 * any failure (cached 3 min, single gentle call per refresh). */
const TV_COLS = ["name","description","close","change","change_abs","open","high","low","volume","market_cap_basic","sector","price_earnings_ttm","earnings_per_share_basic_ttm","dividends_yield","price_book_ratio","price_52_week_high","price_52_week_low","update_mode","update_time"];

async function fetchTVStocks(): Promise<StockQuote[] | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const body = {
      filter: [{ left: "type", operation: "equal", right: "stock" }],
      markets: ["egypt"],
      symbols: { query: { types: [] }, tickers: [] },
      columns: TV_COLS,
      sort: { sortBy: "market_cap_basic", sortOrder: "desc" },
      range: [0, 500],
    };
    const r = await fetch("https://scanner.tradingview.com/egypt/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!r.ok) { logger.warn({ status: r.status }, "TV EGX scan non-ok"); return null; }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const j = await r.json() as any;
    const rows: Array<{ s: string; d: unknown[] }> = j?.data || [];
    if (!rows.length) return null;
    const meta = new Map(EGX_DEFS.map(d => [d.sym, d]));
    const seen = new Set<string>();
    const out: StockQuote[] = [];
    const fetchedAt = Date.now();
    for (const row of rows) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const o: Record<string, any> = {};
      TV_COLS.forEach((c, i) => { o[c] = row.d[i]; });
      const sym = String(o.name || "").replace(/^EGX:/, "").trim();
      const price = Number(o.close);
      if (!sym || !price || price <= 0 || seen.has(sym)) continue;
      seen.add(sym);
      const def = meta.get(sym);
      const chgAbs = Number(o.change_abs) || 0;
      const chgPct = Number(o.change) || 0;
      const cap = Number(o.market_cap_basic) || 0;
      /* The scanner states its contractual delay (EGX: delayed_streaming_900)
       * AND the provider's own last-update time. The timestamp is what proves a
       * price is current; the delay only explains the lag, and when the mode is
       * unrecognised it yields no fallback timestamp at all. */
      const delayedMinutes = tvDelayMinutes(o.update_mode);
      const asOf = resolveAsOf(o.update_time, fetchedAt, delayedMinutes);
      out.push({
        sym,
        name:        egxName(sym, def?.name) || String(o.description || sym),
        sector:      def?.sector || (o.sector ? String(o.sector) : "أخرى"),
        price,
        prevClose:   price - chgAbs,
        chg:         chgAbs,
        chgPct,
        vol:         Number(o.volume) || 0,
        high:        Number(o.high) || price,
        low:         Number(o.low) || price,
        open:        Number(o.open) || price,
        mktCapM:     cap ? Math.round(cap / 1_000_000) : undefined,
        pe:          Number(o.price_earnings_ttm) || undefined,
        forwardPE:   undefined,
        divYield:    Number(o.dividends_yield) || undefined,
        eps:         Number(o.earnings_per_share_basic_ttm) || undefined,
        bookValue:   undefined,
        priceToBook: Number(o.price_book_ratio) || undefined,
        sharesM:     cap && price ? Math.round(cap / price / 1_000_000) : undefined,
        high52w:     Number(o.price_52_week_high) || undefined,
        low52w:      Number(o.price_52_week_low) || undefined,
        ts:          fetchedAt,
        asOf,
        delayedMinutes,
      });
    }
    const { usable, rejected } = partitionUsableQuotes(out, fetchedAt);
    if (rejected.length) {
      logger.warn({ rejected: rejected.length, of: out.length }, "TV EGX rows rejected: provider stopped updating them");
    }
    return usable.length ? usable : null;
  } catch (e) {
    logger.warn({ err: (e as Error).message }, "TV EGX scan failed — using Yahoo fallback");
    return null;
  } finally {
    clearTimeout(t);
  }
}
const STOCKS_TTL_MS    = 3 * 60 * 1000; // 3 minutes
const US_STOCKS_TTL_MS = 5 * 60 * 1000; // 5 minutes

let stocksBuildInFlight: Promise<StockQuote[] | null> | null = null;

/* In-process EGX stocks snapshot — same cache/route the AI engine reads
 * directly (no HTTP round-trip, works on serverless where nothing listens). */
export function getStocksSnapshot(): Promise<StockQuote[] | null> {
  if (stocksCache && Date.now() - stocksCache.ts < STOCKS_TTL_MS) {
    return Promise.resolve(stocksCache.stocks);
  }
  if (!stocksBuildInFlight) {
    stocksBuildInFlight = (async () => {
      try {
        const tvStocks = await fetchTVStocks();
        const raw = tvStocks ?? await fetchStocksBatched(EGX_DEFS);
        /* Second guard for the Yahoo fallback path, which builds its own rows. */
        const { usable, rejected } = partitionUsableQuotes(raw, Date.now());
        if (rejected.length) {
          logger.warn({ rejected: rejected.length, of: raw.length }, "EGX rows rejected: provider stopped updating them");
        }
        if (!usable.length) return stocksCache ? stocksCache.stocks : null;
        stocksCache = { ts: Date.now(), stocks: usable };
        return usable;
      } catch (e) {
        logger.error({ err: (e as Error).message }, "egx-stocks build failed");
        return stocksCache ? stocksCache.stocks : null;
      }
    })().finally(() => {
      stocksBuildInFlight = null;
    });
  }
  return stocksBuildInFlight;
}

router.get("/stocks", async (_req: Request, res: Response) => {
  const now = Date.now();
  if (stocksCache && now - stocksCache.ts < STOCKS_TTL_MS) {
    res.json({ status: "ok", ...stocksPayload(stocksCache.stocks, stocksCache.ts, now) });
    return;
  }
  const stocks = await getStocksSnapshot();
  if (stocks) {
    res.json({ status: "ok", ...stocksPayload(stocks, stocksCache?.ts ?? now, now) });
    return;
  }
  res.status(503).json({ status: "error", message: "EGX stocks data unavailable" });
});

/* Prices carry the provider's own market time so the client can label them.
 * `ts` remains "when this server last built the snapshot"; `dataAsOf` is the
 * newest provider time inside it, and the delay is what the feed declares. */
function stocksPayload(stocks: StockQuote[], cachedAt: number, now: number) {
  const dataAsOf = newestAsOf(stocks);
  const delay = stocks[0]?.delayedMinutes;
  /* Two independent reasons to warn: the provider's data time is old, or this
   * snapshot is older than its refresh window (a rebuild kept failing). */
  const cacheAged = now - cachedAt > STOCKS_TTL_MS;
  const fresh = dataAsOf !== null && !quoteAge(dataAsOf, now).stale && !cacheAged;
  return {
    ts: cachedAt,
    dataAsOf,
    delayedMinutes: delay,
    fresh,
    ...(fresh ? {} : { stale: true }),
    stocks,
  };
}

router.get("/us-stocks", async (_req: Request, res: Response) => {
  const now = Date.now();
  const usPayload = (stocks: StockQuote[], at: number) => ({
    status: "ok" as const,
    ...stocksPayload(stocks, at, now),
  });
  if (usStocksCache && now - usStocksCache.ts < US_STOCKS_TTL_MS) {
    res.json(usPayload(usStocksCache.stocks, usStocksCache.ts));
    return;
  }
  try {
    const { usable } = partitionUsableQuotes(await fetchStocksBatched(US_DEFS, 20, 500), now);
    usStocksCache = { ts: now, stocks: usable };
    res.json(usPayload(usable, now));
  } catch (e) {
    logger.error({ err: (e as Error).message }, "us-stocks build failed");
    if (usStocksCache) {
      res.json({ ...usPayload(usStocksCache.stocks, usStocksCache.ts), stale: true, fresh: false });
    } else {
      res.status(503).json({ status: "error", message: "US stocks data unavailable" });
    }
  }
});

/* ═══════════════════════════════════════════════════
   HEALTH / DATA QUALITY MONITOR
   Returns freshness and data source status so the admin
   dashboard (or an external uptime check) can detect stale data.
   ═══════════════════════════════════════════════════ */

router.get("/health", (_req: Request, res: Response) => {
  const now = Date.now();
  const marketsAge = marketsCache ? Math.round((now - marketsCache.ts) / 1000) : null;
  const stocksAge  = stocksCache  ? Math.round((now - stocksCache.ts)  / 1000) : null;
  const calAge     = calCache     ? Math.round((now - calCache.ts)     / 1000) : null;

  const ok = (age: number | null, ttlMs: number) =>
    age === null ? "no_data" : age < ttlMs / 1000 * 2 ? "fresh" : "stale";

  res.json({
    status: "ok",
    ts: now,
    sources: {
      markets: {
        status: ok(marketsAge, MARKETS_TTL_MS),
        ageSeconds: marketsAge,
        ttlSeconds: MARKETS_TTL_MS / 1000,
        data: marketsCache
          ? { sections: Object.keys(marketsCache.data.markets) }
          : null,
      },
      stocks: {
        status: ok(stocksAge, STOCKS_TTL_MS),
        ageSeconds: stocksAge,
        ttlSeconds: STOCKS_TTL_MS / 1000,
        count: stocksCache?.stocks.length ?? 0,
        /* Provider market time is what proves the prices themselves are current. */
        dataAsOf: stocksCache ? newestAsOf(stocksCache.stocks) : null,
        delayedMinutes: stocksCache?.stocks[0]?.delayedMinutes ?? null,
      },
      calendar: {
        status: ok(calAge, CAL_TTL_MS),
        ageSeconds: calAge,
        ttlSeconds: CAL_TTL_MS / 1000,
        count: calCache?.data.events.length ?? 0,
      },
    },
    keys: {
      finnhub: !!FINNHUB_KEY,
      alphaVantage: !!AV_KEY,
    },
  });
});

export default router;
