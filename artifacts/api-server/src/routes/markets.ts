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

type Quote = {
  n: string;
  v: string;
  c: string;
  up: boolean;
  s?: string;
  clickable?: boolean;
};

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
  const n = parseFloat(s.replace(/[, ]/g, ""));
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

/* ─── Google Finance scraper ─── */

async function fetchGoogleFinance(symbol: string): Promise<{
  price: number;
  prev: number;
} | null> {
  try {
    const enc = symbol.replace(/:/g, "%3A");
    const html = await fetchText(
      `https://www.google.com/finance/quote/${enc}`,
      9000,
    );
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

/* ─── Stooq CSV scraper ─── */

async function fetchStooq(symbol: string): Promise<{
  price: number;
  open: number;
} | null> {
  try {
    const csv = await fetchText(
      `https://stooq.com/q/l/?s=${encodeURIComponent(symbol)}&f=sd2t2ohlc&h&e=csv`,
      8000,
    );
    const lines = csv.trim().split(/\r?\n/);
    if (lines.length < 2) return null;
    const cols = lines[1].split(",");
    if (cols.length < 7) return null;
    if (cols[1] === "N/D" || cols[3] === "N/D" || cols[6] === "N/D") return null;
    const open = parseNumber(cols[3]);
    const close = parseNumber(cols[6]);
    if (!Number.isFinite(close)) return null;
    return { price: close, open: Number.isFinite(open) ? open : close };
  } catch (e) {
    logger.warn({ symbol, err: (e as Error).message }, "stooq fetch failed");
    return null;
  }
}

/* ─── EGX30 from TradingEconomics scraper ─── */

async function fetchEGX30(): Promise<{ price: number; pctChange: number } | null> {
  try {
    const html = await fetchText(
      "https://tradingeconomics.com/egypt/stock-market",
      10000,
    );
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
      const pctMatch = sentence[0].match(
        /(gaining|losing|rising|falling|up|down)\s*([0-9.]+)%/i,
      );
      if (pctMatch) {
        const direction = pctMatch[1].toLowerCase();
        const val = parseFloat(pctMatch[2]);
        const negative = /losing|falling|down/.test(direction);
        pct = negative ? -val : val;
      }
    }
    if (!Number.isFinite(pct)) {
      // Try a generic "X% from previous" pattern
      const altPct = html.match(
        /EGX 30[^<]*?([+\-]?[0-9]+\.[0-9]+)%\s*from the previous/i,
      );
      if (altPct) pct = parseFloat(altPct[1]);
    }
    if (!Number.isFinite(pct)) pct = 0;
    return { price, pctChange: pct };
  } catch (e) {
    logger.warn({ err: (e as Error).message }, "EGX30 fetch failed");
    return null;
  }
}

/* ─── Crypto from CoinGecko ─── */

type CryptoSpec = { id: string; n: string; s: string };
const CRYPTO_LIST: CryptoSpec[] = [
  { id: "bitcoin", n: "BTC", s: "بيتكوين" },
  { id: "ethereum", n: "ETH", s: "إيثريوم" },
  { id: "binancecoin", n: "BNB", s: "بينانس" },
  { id: "ripple", n: "XRP", s: "ريبل" },
];

async function fetchCrypto(): Promise<Quote[]> {
  try {
    const ids = CRYPTO_LIST.map((c) => c.id).join(",");
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`;
    const text = await fetchText(url, 9000);
    const data = JSON.parse(text) as Record<
      string,
      { usd?: number; usd_24h_change?: number }
    >;
    return CRYPTO_LIST.map((c) => {
      const d = data[c.id];
      const price = d?.usd ?? NaN;
      const pct = d?.usd_24h_change ?? 0;
      const v = !Number.isFinite(price)
        ? "—"
        : price >= 1000
          ? `$${(price / 1000).toFixed(1)}K`
          : price >= 1
            ? `$${price.toFixed(2)}`
            : `$${price.toFixed(4)}`;
      return {
        n: c.n,
        v,
        c: fmtPct(pct),
        up: pct >= 0,
        s: c.s,
      };
    });
  } catch (e) {
    logger.warn({ err: (e as Error).message }, "crypto fetch failed");
    return CRYPTO_LIST.map((c) => ({
      n: c.n,
      v: "—",
      c: "—",
      up: true,
      s: c.s,
    }));
  }
}

/* ─── Item builders ─── */

type QuoteItem = {
  n: string;
  s: string;
  google?: string;
  stooq?: string | string[]; // single or list of fallbacks
  decimals?: number;
  commas?: boolean;
  prefix?: string;
  suffix?: string;
};

function formatQuote(
  it: QuoteItem,
  price: number,
  pct: number,
  prevPrice: number | null,
): Quote {
  const decimals = it.decimals ?? 2;
  const commas = it.commas ?? true;
  // If we don't have a real previous-close-derived pct (prev was 0/NaN),
  // guard against showing a wildly wrong number.
  const pctSafe = Number.isFinite(pct) ? pct : 0;
  const value = `${it.prefix ?? ""}${fmtNumber(price, { decimals, commas })}${it.suffix ?? ""}`;
  return {
    n: it.n,
    v: value,
    c: fmtPct(pctSafe),
    up: pctSafe >= 0,
    s: it.s,
  };
}

async function buildQuote(it: QuoteItem): Promise<Quote | null> {
  // 1) Try Google Finance first (gives proper previous-close-based change%)
  if (it.google) {
    const g = await fetchGoogleFinance(it.google);
    if (g) {
      const pct = g.prev > 0 ? ((g.price - g.prev) / g.prev) * 100 : 0;
      return formatQuote(it, g.price, pct, g.prev);
    }
  }
  // 2) Fall back to Stooq intraday OHLC (open->close)
  if (it.stooq) {
    const symbols = Array.isArray(it.stooq) ? it.stooq : [it.stooq];
    for (const sym of symbols) {
      const s = await fetchStooq(sym);
      if (s) {
        const pct = s.open > 0 ? ((s.price - s.open) / s.open) * 100 : 0;
        return formatQuote(it, s.price, pct, s.open);
      }
    }
  }
  return null;
}

/* ─── Definitions ─── */

const GLOBAL_INDICES: QuoteItem[] = [
  { n: "S&P 500", s: "أمريكي", google: ".INX:INDEXSP", stooq: "^spx", decimals: 2, commas: true },
  { n: "NASDAQ", s: "تقني", google: ".IXIC:INDEXNASDAQ", stooq: "^ndq", decimals: 2, commas: true },
  { n: "DAX", s: "ألماني", google: "DAX:INDEXDB", stooq: "^dax", decimals: 2, commas: true },
  { n: "FTSE", s: "بريطاني", google: "UKX:INDEXFTSE", stooq: "^ftm", decimals: 2, commas: true },
];

const FX_PAIRS: QuoteItem[] = [
  { n: "USD/EGP", s: "دولار/جنيه", google: "USD-EGP", stooq: "usdegp", decimals: 2, commas: false },
  { n: "EUR/EGP", s: "يورو/جنيه", google: "EUR-EGP", stooq: "euregp", decimals: 2, commas: false },
  { n: "GBP/EGP", s: "إسترليني/جنيه", google: "GBP-EGP", stooq: "gbpegp", decimals: 2, commas: false },
  { n: "SAR/EGP", s: "ريال/جنيه", google: "SAR-EGP", decimals: 2, commas: false },
];

const COMMODITIES: QuoteItem[] = [
  { n: "ذهب", s: "أوقية", stooq: "xauusd", prefix: "$", decimals: 2, commas: true },
  { n: "نفط برنت", s: "برميل", stooq: ["bz.f", "cl.f"], prefix: "$", decimals: 2, commas: false },
  { n: "فضة", s: "أوقية", stooq: "xagusd", prefix: "$", decimals: 2, commas: false },
  { n: "نحاس", s: "رطل", stooq: ["hg.f", "hgusd"], prefix: "$", decimals: 2, commas: false },
];

/* ─── Cache ─── */

type MarketsPayload = {
  status: "ok";
  ts: number;
  markets: { eg: Quote[]; gl: Quote[]; cm: Quote[]; cr: Quote[] };
  ticker: Quote[];
};

let marketsCache: { ts: number; data: MarketsPayload } | null = null;
const MARKETS_TTL_MS = 60 * 1000;

async function buildMarketsPayload(): Promise<MarketsPayload> {
  // Fetch everything in parallel
  const [egx30Raw, fxQ, glQ, cmQ, crypto] = await Promise.all([
    fetchEGX30(),
    Promise.all(FX_PAIRS.map(buildQuote)),
    Promise.all(GLOBAL_INDICES.map(buildQuote)),
    Promise.all(COMMODITIES.map(buildQuote)),
    fetchCrypto(),
  ]);

  const egx30: Quote | null = egx30Raw
    ? {
        n: "EGX30",
        v: fmtNumber(egx30Raw.price, { decimals: 2, commas: true }),
        c: fmtPct(egx30Raw.pctChange),
        up: egx30Raw.pctChange >= 0,
        s: "مؤشر رئيسي",
        clickable: true,
      }
    : null;

  const fx = fxQ.filter((x): x is Quote => x !== null);
  const gl = glQ.filter((x): x is Quote => x !== null);
  const cm = cmQ.filter((x): x is Quote => x !== null);
  const cr = crypto;

  // Egypt section: EGX30 first, then top 3 forex pairs
  const eg: Quote[] = [];
  if (egx30) eg.push(egx30);
  eg.push(...fx.slice(0, 3));

  // Ticker: pick best items
  const ticker: Quote[] = [];
  if (egx30) ticker.push(egx30);
  if (fx[0]) ticker.push(fx[0]); // USD/EGP
  if (cm[0]) ticker.push(cm[0]); // gold
  if (cm[1]) ticker.push(cm[1]); // brent
  if (gl[0]) ticker.push(gl[0]); // S&P
  if (cr[0]) ticker.push(cr[0]); // BTC
  if (cr[1]) ticker.push(cr[1]); // ETH

  return {
    status: "ok",
    ts: Date.now(),
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
      // Serve stale on failure
      res.json({ ...marketsCache.data, stale: true });
    } else {
      res.status(503).json({ status: "error", message: "markets unavailable" });
    }
  }
});

/* ─── Economic Calendar ─── */

type FFEvent = {
  title: string;
  country: string;
  date: string;
  impact: string;
  forecast: string;
  previous: string;
};

type CalEvent = {
  ev: string; // Arabic event title
  evEn: string; // original English title
  t: string; // Arabic localized date+time
  tISO: string; // ISO timestamp
  imp: string; // Arabic impact label
  c: string; // colour hex
  country: string; // ISO currency code
  countryAr: string;
  flag: string;
  forecast: string;
  previous: string;
};

const COUNTRY_INFO: Record<string, { ar: string; flag: string }> = {
  USD: { ar: "الولايات المتحدة", flag: "🇺🇸" },
  EUR: { ar: "منطقة اليورو", flag: "🇪🇺" },
  GBP: { ar: "المملكة المتحدة", flag: "🇬🇧" },
  JPY: { ar: "اليابان", flag: "🇯🇵" },
  CHF: { ar: "سويسرا", flag: "🇨🇭" },
  CAD: { ar: "كندا", flag: "🇨🇦" },
  AUD: { ar: "أستراليا", flag: "🇦🇺" },
  NZD: { ar: "نيوزيلندا", flag: "🇳🇿" },
  CNY: { ar: "الصين", flag: "🇨🇳" },
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

const ARABIC_WEEKDAYS = [
  "الأحد",
  "الإثنين",
  "الثلاثاء",
  "الأربعاء",
  "الخميس",
  "الجمعة",
  "السبت",
];

function fmtArabicDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  // Display in Cairo time (UTC+2 / +3 with DST). We use a fixed +02:00 offset
  // (Egypt is on EET year-round historically). Convert by adjusting timestamp.
  const cairo = new Date(d.getTime() + 2 * 60 * 60 * 1000);
  const day = ARABIC_WEEKDAYS[cairo.getUTCDay()];
  const hh = String(cairo.getUTCHours()).padStart(2, "0");
  const mm = String(cairo.getUTCMinutes()).padStart(2, "0");
  return `${day} ${hh}:${mm}`;
}

function impactInfo(imp: string): { ar: string; c: string; rank: number } {
  const lower = (imp || "").toLowerCase();
  if (lower === "high") return { ar: "عالي", c: "#ef4444", rank: 3 };
  if (lower === "medium") return { ar: "متوسط", c: "#f59e0b", rank: 2 };
  if (lower === "low") return { ar: "منخفض", c: "#0ea5e9", rank: 1 };
  return { ar: "—", c: "#64748b", rank: 0 };
}

let calCache: { ts: number; data: { status: "ok"; events: CalEvent[] } } | null =
  null;
const CAL_TTL_MS = 30 * 60 * 1000;

async function buildCalendarPayload(): Promise<{
  status: "ok";
  events: CalEvent[];
}> {
  const text = await fetchText(
    "https://nfs.faireconomy.media/ff_calendar_thisweek.json",
    12000,
  );
  const raw = JSON.parse(text) as FFEvent[];
  const now = Date.now();

  const events: CalEvent[] = raw
    .filter((e) => {
      if (!e || !e.title || !e.date || !e.country) return false;
      const imp = (e.impact || "").toLowerCase();
      if (!(imp === "high" || imp === "medium")) return false;
      if (!COUNTRY_INFO[e.country]) return false;
      const t = new Date(e.date).getTime();
      // Include events from last 6 hours through next 7 days
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
