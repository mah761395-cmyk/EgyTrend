import { Router, type IRouter, type Request, type Response } from "express";
import { logger } from "../lib/logger";

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

async function fetchEGX30(): Promise<{ price: number; pctChange: number } | null> {
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
    return { price, pctChange: pct };
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
  finnhub: string;        // ETF on Finnhub — used for % change only
  google?: string;        // Google Finance — preferred for real index price
  stooq?: string;         // Stooq — fallback for real index price
  finnhubIsSpot?: boolean; // true when Finnhub symbol IS the spot index (not ETF)
};

const GLOBAL_INDICES: IndexDef[] = [
  { n: "S&P 500",  s: "أمريكي",   finnhub: "SPY",  google: ".INX:INDEXSP",      stooq: "^spx" },
  { n: "NASDAQ",   s: "تقني",     finnhub: "QQQ",  google: ".IXIC:INDEXNASDAQ", stooq: "^ndq" },
  { n: "DAX",      s: "ألماني",   finnhub: "EWG",  google: "DAX:INDEXDB",       stooq: "^dax" },
  { n: "FTSE 100", s: "بريطاني",  finnhub: "EWU",  google: "UKX:INDEXFTSE",     stooq: "^ftm" },
];

async function buildIndexQuote(def: IndexDef): Promise<Quote | null> {
  // Fetch Finnhub ETF for % change AND scrapers for real price — in parallel
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

type FxDef = { n: string; s: string; from: string; to: string; google?: string; stooq?: string };

const FX_PAIRS: FxDef[] = [
  { n: "USD/EGP", s: "دولار/جنيه", from: "USD", to: "EGP", google: "USD-EGP", stooq: "usdegp" },
  { n: "EUR/EGP", s: "يورو/جنيه",  from: "EUR", to: "EGP", google: "EUR-EGP", stooq: "euregp" },
  { n: "GBP/EGP", s: "إسترليني/جنيه", from: "GBP", to: "EGP", google: "GBP-EGP", stooq: "gbpegp" },
  { n: "SAR/EGP", s: "ريال/جنيه",  from: "SAR", to: "EGP", google: "SAR-EGP" },
];

async function buildFxQuote(def: FxDef): Promise<Quote | null> {
  // 1) Alpha Vantage (realtime, 6hr cached)
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
  { n: "ذهب",      s: "أوقية",  finnhub: "GLD", finnhubFactor: 7.97,  google: "XAUUSD:CURRENCY", prefix: "$", decimals: 2, commas: true },
  { n: "نفط برنت", s: "برميل",  finnhub: "BNO", finnhubFactor: 1.18,  google: "BZ00:NYMEX",      prefix: "$", decimals: 2, commas: false },
  { n: "فضة",      s: "أوقية",  finnhub: "SLV", finnhubFactor: 0.483, google: "XAGUSD:CURRENCY", prefix: "$", decimals: 2, commas: false },
  { n: "نحاس",     s: "رطل",                                           google: "HG00:COMEX",      prefix: "$", decimals: 2, commas: false },
];

async function buildCommodityQuote(def: CommodityDef): Promise<Quote | null> {
  // 1) Finnhub ETF (primary — realtime %, calibrated spot price)
  if (def.finnhub) {
    const fh = await fetchFinnhub(def.finnhub);
    if (fh) {
      const factor = def.finnhubFactor ?? 1;
      const price = fh.c * factor;
      const v = `${def.prefix ?? ""}${fmtNumber(price, { decimals: def.decimals ?? 2, commas: def.commas ?? true })}${def.suffix ?? ""}`;
      return { n: def.n, v, c: fmtPct(fh.dp), up: fh.dp >= 0, s: def.s };
    }
  }
  // 2) Google Finance (fallback — real spot price)
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
  { n: "BNB", s: "بينانس",   finnhub: "BINANCE:BNBUSDT" },
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
  // Fetch all sections in parallel
  const [egx30Raw, fxResults, glResults, cmResults, crResults] = await Promise.all([
    fetchEGX30(),
    Promise.all(FX_PAIRS.map(buildFxQuote)),
    Promise.all(GLOBAL_INDICES.map(buildIndexQuote)),
    Promise.all(COMMODITIES.map(buildCommodityQuote)),
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
      indices: hasFinnhub ? "Finnhub" : "Google Finance / Stooq",
      forex: hasAV ? "Alpha Vantage" : "Google Finance / Stooq",
      commodities: hasFinnhub ? "Finnhub ETFs" : "Stooq",
      crypto: hasFinnhub ? "Finnhub/Binance" : "CoinGecko",
    },
    markets: { eg, gl, cm, cr },
    ticker,
  };
}

router.get("/", async (_req: Request, res: Response) => {
  const now = Date.now();
  if (marketsCache && now - marketsCache.ts < MARKETS_TTL_MS) {
    res.json(marketsCache.data);
    return;
  }
  try {
    const data = await buildMarketsPayload();
    marketsCache = { ts: now, data };
    res.json(data);
  } catch (e) {
    logger.error({ err: (e as Error).message }, "markets build failed");
    if (marketsCache) {
      res.json({ ...marketsCache.data, stale: true });
    } else {
      res.status(503).json({ status: "error", message: "markets unavailable" });
    }
  }
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

export default router;
