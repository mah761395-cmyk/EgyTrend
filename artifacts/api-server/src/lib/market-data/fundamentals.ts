/**
 * Secondary, fully fail-soft market fundamentals for the EGX screener.
 *
 * Two independent sources, kept deliberately outside the main scan path so a
 * failure (or a missing value) here can never take the price screener down:
 *
 *  1. Cash dividends (trailing 12 months, per share) from Yahoo Finance's
 *     public v8 chart endpoint with `events=dividends` — the same endpoint
 *     family the market board already uses, no credentials, crumb-less.
 *     EGX tickers map to the `.CA` (Cairo) Yahoo suffix.
 *
 *  2. P/E (مضاعف الربحية) and coupon yield (العائد على الكوبون) from the
 *     official EGX page "MarketPECompanies" — a server-rendered table for
 *     "الشركات ذات الأنشطة المتخصصة" only. Coverage is partial and said so
 *     in every response; rows the page does not carry simply get no value.
 *
 * Honesty rules (same as the rest of the data layer):
 *  - a symbol the source could not answer for is `unavailable`, never 0,
 *  - a real "no dividend in 12 months" is ttm 0 with status ok (the source
 *    answered, it just had no dividend events),
 *  - P/E/DY are attributed per row (egxName) and the response states the
 *    page's partial coverage instead of pretending full market coverage.
 */
import { EGX_STOCKS } from "./catalog";
import { loadCached, type JsonCache } from "./cache";
import type { ResilientHttpClient } from "./http";

/* ─────────────────────────── shared helpers ─────────────────────────── */

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.replace(/,/g, "").trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

const YAHOO_BROWSER_HEADERS = {
  Accept: "application/json",
  /* Yahoo's public endpoint rejects non-browser user agents; the market
   * board provider already documents this, so dividends use the same one. */
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
};

/** Sanitize an EGX ticker as accepted by this API: A-Z0-9 only, 1..16. */
export function sanitizeEgxSymbol(raw: string): string | null {
  const sym = raw.trim().toUpperCase();
  if (!/^[A-Z0-9]{1,16}$/.test(sym)) return null;
  return sym;
}

/* ─────────────────────── 1) Yahoo dividends ─────────────────────────── */

const YAHOO_DIVIDENDS_RANGE_MS = 365 * 86_400_000;

export type ParsedDividends = {
  /** Trailing-12-month cash dividends per share (listing currency, EGP for EGX).
   * 0 is a real "no dividend in the window" answer, not a failure. */
  ttm: number;
  /** Amount of the most recent dividend event (0 when none in the window). */
  lastAmount: number;
  /** Ex-dividend date (ms epoch) of the most recent event; null when none. */
  lastDate: number | null;
  /** Number of dividend events inside the window. */
  count: number;
};

type YahooChartDividendPayload = {
  chart?: {
    result?: Array<{
      events?: {
        dividends?: Record<string, { amount?: unknown; date?: unknown }>;
      };
    }>;
  };
  error?: unknown;
};

/**
 * Parse a Yahoo v8 chart payload (range=1y, events=dividends).
 *
 * Returns null ONLY when the payload is not a usable chart result at all
 * (network-adjacent garbage, "chart error" body) — callers treat that as
 * "source did not answer" (unavailable, retryable). A usable chart result
 * with no dividend events is a real zero and returns { ttm: 0, ... }.
 */
export function parseYahooDividends(payload: unknown, nowMs: number): ParsedDividends | null {
  if (!payload || typeof payload !== "object") return null;
  const result = (payload as YahooChartDividendPayload).chart?.result?.[0];
  if (!result || typeof result !== "object") return null;

  const rawEvents = result.events?.dividends;
  const events: Array<{ amount: number; exDateMs: number }> = [];
  if (rawEvents && typeof rawEvents === "object") {
    for (const [key, value] of Object.entries(rawEvents)) {
      const exDateMs = Number(key);
      if (!Number.isFinite(exDateMs) || exDateMs <= 0) continue;
      const amount = finiteNumber(value?.amount);
      // Yahoo timestamps are seconds; normalize defensively.
      const ex = exDateMs < 10_000_000_000 ? exDateMs * 1_000 : exDateMs;
      if (amount === undefined || amount <= 0) continue;
      // Keep the window honest even if the vendor widens the range param.
      if (ex < nowMs - YAHOO_DIVIDENDS_RANGE_MS) continue;
      if (ex > nowMs + 86_400_000) continue; // no future ex-dates
      events.push({ amount, exDateMs: ex });
    }
  }
  events.sort((a, b) => a.exDateMs - b.exDateMs);
  const ttm = Math.round(events.reduce((sum, event) => sum + event.amount, 0) * 100) / 100;
  const last = events[events.length - 1];
  return {
    ttm,
    lastAmount: last ? last.amount : 0,
    lastDate: last ? last.exDateMs : null,
    count: events.length,
  };
}

function yahooDividendsUrl(symbol: string): string {
  return `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}.CA?range=1y&interval=1mo&events=dividends`;
}

export type DividendRow = {
  sym: string;
  status: "ok" | "unavailable";
  ttm?: number;
  lastAmount?: number;
  lastDate?: number;
  fromCache?: boolean;
  stale?: boolean;
};

export type DividendsResponse = {
  status: "ok";
  fetchedAt: number;
  windowDays: 365;
  currency: "EGP";
  source: string;
  dividends: DividendRow[];
};

const DIVIDENDS_CACHE_TTL_MS = 6 * 60 * 60_000;
const DIVIDENDS_STALE_MS = 24 * 60 * 60_000;

/**
 * Batched, per-symbol fail-soft dividend lookup. Each symbol is cached for 6h
 * (real zeros included — they ARE the source's answer) and only symbols with
 * a cache miss hit Yahoo, paced by the http client's rate gate. A per-symbol
 * failure never fails the batch: that symbol is reported `unavailable`.
 * `deadlineMs` bounds the whole batch so a slow vendor can never exceed the
 * serverless duration budget — the remaining symbols come back unavailable
 * and the next call retries them (the cache fills progressively).
 */
export async function buildDividendsResponse(
  symbols: string[],
  deps: {
    http: ResilientHttpClient;
    cache: JsonCache;
    now?: () => number;
    deadlineMs?: number;
  },
): Promise<DividendsResponse> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const deadline = startedAt + (deps.deadlineMs ?? 45_000);
  const dividends: DividendRow[] = [];
  const seen = new Set<string>();

  for (const rawSym of symbols) {
    const sym = sanitizeEgxSymbol(rawSym) ?? rawSym.toUpperCase();
    if (seen.has(sym)) continue;
    seen.add(sym);

    if (now() > deadline) {
      dividends.push({ sym, status: "unavailable" });
      continue;
    }
    const key = `egytrend:market:dividends:v1:${sym}`;
    try {
      const cached = await loadCached<ParsedDividends>(
        deps.cache,
        key,
        DIVIDENDS_CACHE_TTL_MS,
        DIVIDENDS_STALE_MS,
        async () => {
          const payload = await deps.http.getJson<unknown>(yahooDividendsUrl(sym), {
            providerId: "yahoo-dividends",
            timeoutMs: 8_000,
            attempts: 2,
            minIntervalMs: 350,
            headers: YAHOO_BROWSER_HEADERS,
          });
          const parsed = parseYahooDividends(payload, now());
          if (parsed === null) {
            // Unusable answer: do NOT cache it, so the next call retries.
            throw new Error("yahoo dividends payload unusable");
          }
          return parsed;
        },
      );
      dividends.push({
        sym,
        status: "ok",
        ttm: cached.value.ttm,
        lastAmount: cached.value.lastAmount,
        lastDate: cached.value.lastDate ?? undefined,
        fromCache: cached.cacheHit,
        stale: cached.stale,
      });
    } catch {
      dividends.push({ sym, status: "unavailable" });
    }
  }

  return {
    status: "ok",
    fetchedAt: now(),
    windowDays: 365,
    currency: "EGP",
    source: "Yahoo Finance (بيانات عامة — التوزيعات المعلنة خلال آخر 12 شهرًا)",
    dividends,
  };
}

/* ───────────────── 2) EGX official P/E + coupon yield ───────────────── */

const EGX_PE_URL = "https://www.egx.com.eg/ar/MarketPECompanies.aspx";

/** The EGX site rejects the backend's bot user agent (the request must look
 * like a normal browser, exactly like the Yahoo path above); a 403 here
 * used to surface as the screener's P/E column and P/E + dividend filters
 * being dead. */
const EGX_BROWSER_HEADERS = {
  Accept: "text/html",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
};

export type EgxValuationRow = {
  name: string;
  /** مضاعف الربحية (P/E); 0 means the company reported no positive earnings. */
  pe: number;
  /** العائد على الكوبون (DY) in percent. */
  dy: number;
};

const HTML_ENTITY_MAP: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith("#")) {
      const code = Number(entity.slice(1));
      return Number.isFinite(code) ? String.fromCodePoint(code) : " ";
    }
    return HTML_ENTITY_MAP[entity.toLowerCase()] ?? " ";
  });
}

function cellText(cell: string): string {
  return decodeEntities(cell.replace(/<[^>]*>/g, " "))
    .replace(/[\u060C\u061B\u061F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parse the EGX "P/E and coupon yield" page. The page is a classic ASPX
 * layout with several tables (nav, breadcrumbs, the data table, footer); the
 * data rows are exactly the 3-cell rows whose 2nd/3rd cells are plain
 * numbers. Everything else is ignored, so small layout drift degrades to
 * "fewer rows" (surfaced via coverage counts) instead of wrong values.
 */
export function parseEgxPeTable(html: string): EgxValuationRow[] {
  const rows: EgxValuationRow[] = [];
  const seenNames = new Set<string>();
  const numberCell = /^\d+(\.\d+)?$/;

  for (const trMatch of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...trMatch[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((cell) => cellText(cell[1]));
    if (cells.length !== 3) continue;
    const [name, peText, dyText] = cells;
    if (!numberCell.test(peText) || !numberCell.test(dyText)) continue;
    const cleanName = name.replace(/^-+|-+$/g, "").trim();
    if (cleanName.length < 3) continue;
    if (cleanName === "متوسط") continue; // the page's own average row
    if (/وثائق|صندوق|ETF/i.test(cleanName)) continue; // fund documents, not equities
    const key = normalizeArabicName(cleanName);
    if (!key || seenNames.has(key)) continue; // e.g. the "بالجنيه" CIB duplicate
    seenNames.add(key);
    rows.push({ name: cleanName, pe: Number(peText), dy: Number(dyText) });
  }
  return rows;
}

/**
 * Arabic name normalization for matching the page's formal company names
 * against the screener's (catalog) names: uniform alif/ya/taa marbuta
 * forms, no diacritics or tatweel, latin lowercased.
 */
export function normalizeArabicName(raw: string): string {
  return raw
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "") // diacritics + tatweel
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    /* Every separator (hyphen, dot, $, comma, quotes…) becomes whitespace so
     * "كابل - كابو" and "ام.م" tokenize the way a human reads them. */
    .replace(/[^؀-ۿa-zA-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/* Generic corporate words: shared by dozens of unrelated companies. They are
 * stripped before scoring so they cannot inflate a hit count ("بنك" alone can
 * never bind a name to a bank row, "للفنادق" never to a hotel row, …). */
const AR_FILLERS = new Set([
  "ال", "لل", "من", "في", "مصر", "المصريه", "القابضه", "القابض", "شركه",
  "الشركه", "شركات", "مساهمه", "مجموعه", "للاستثمار", "الاستثمار",
  "للاستثمارات", "للتنميه", "التنميه", "للتطوير", "التطوير", "للتعمير",
  "التعمير", "العقاريه", "العقاري", "العقار",
  // NOTE: "للاسكان"/"الاسكان" are deliberately NOT fillers — they are one of
  // the two identity tokens that bind MASR («مدينة مصر للإسكان») to its row,
  // and no other page row combines them with a brand token.
  "الماليه", "للماليه", "للمصرفيه", "للصناعه", "الصناعه", "للصناعات",
  "الصناعيه", "الصناعيه", "الغذائيه", "لغذائيه", "للاغذيه", "الكيماويه",
  "كيماويات", "الدوائيه", "للادويه", "الادويه", "للتامين", "التامين",
  "للتجاره", "التجاره", "للتمويل", "التمويلي", "للتاكجير", "الوطنيه",
  "العامه", "العربيه", "العربي", "الدوليه", "القاهره", "الاسكندريه",
  "المجموعه", "للخدمات", "الخدمات", "للوساطه", "لتداول", "السندات",
  "الزراعي", "الزراعيه", "البيئيه", "للانتاج", "للنقابات", "المهنيه",
  "العالميه", "للاداره", "الاستثمارات", "الاستشاره", "للاستشاره",
  // the catalog writes CCAP truncated — cover the exact codepoints
  "للاستشارات", "الاستشارات",
]);
/* Words that may count as a hit but can never be the DISTINCTIVE token that
 * makes a pair acceptable on their own. */
const AR_COMMON = new Set([
  ...AR_FILLERS,
  "البنك", "بنك", "مصرف", "المصرف", "للتامين", "للتجاره", "للتمويل",
  "للمقاولات", "الطاقه", "طاقة", "للفنادق", "للخدمات", "الاوراق",
]);
/* Sector suffixes that are meaningless for identity when a name already
 * carries a brand token ("جهينة للأغذية" matches on "جهينة" alone; without
 * this strip the generic suffix would demand a second hit that no row has). */
const AR_IDENTITY_STRIPS = new Set(["للاغذيه"]);

function nameTokens(raw: string, stripIdentitySuffixes: boolean): string[] {
  const normalized = normalizeArabicName(raw);
  const tokens = new Set<string>();
  for (let token of normalized.split(" ")) {
    if (token.length < 2) continue;
    // "والتعمير" / "والاستثمار" are "and the …": the waw of conjunction
    // belongs to the previous word, not the token. "وادي" is safe — only the
    // waw + definite-article pattern is stripped.
    if (token.startsWith("وال")) token = token.slice(1);
    if (token.length < 2) continue;
    if (AR_FILLERS.has(token)) continue;
    if (stripIdentitySuffixes && AR_IDENTITY_STRIPS.has(token)) continue;
    tokens.add(token);
  }
  return [...tokens];
}

function tokensMatch(a: string, b: string): boolean {
  if (a === b) return true;
  // Prefix/suffix containment guards against "التكنولوجيا" vs "للتكنولوجيا",
  // "للاسمنت" vs "اسمنت", etc. The shorter side must be long enough to be
  // meaningful (4+ chars) so "عز" cannot match "العز".
  if (Math.min(a.length, b.length) < 4) return false;
  return a.includes(b) || b.includes(a);
}

type MatchPair = {
  sym: string;
  row: EgxValuationRow;
  score: number; // hits / catalog tokens
  hits: number;
  reciprocal: number; // hits / egx row tokens
  distinct: boolean;
};

/**
 * Match EGX page rows to screener symbols, conservatively. A wrong P/E is
 * worse than no P/E, so a pair is accepted only when:
 *  - at least one matched token pair is distinctive (4+ chars, and neither
 *    side a generic corporate word) — "بنك" alone can never bind a name,
 *  - the catalog side scores >= 50% of its identity tokens, and either
 *    - 2+ identity tokens matched, or
 *    - the page name is essentially the catalog name (reciprocal overlap
 *      >= 0.9 with every identity token matched) — "جهينة" matches
 *      "جهينة للصناعات الغذائية" but not "اطلس للاستثمار والصناعات الغذائية",
 *    - or the catalog name has a single identity token and the page name
 *      is short and covered (reciprocal >= 0.3) — "سوديك" matches
 *      "…- سوديك" but not a 7-token brokerage name.
 * All pairs are then assigned greedily best-first so one page row can never
 * feed two symbols (e.g. the Sid-Krir petrochemicals row goes to SKPC —
 * 3 token hits — leaving SCOM honestly unmatched).
 */
export function matchEgxValuations(
  rows: EgxValuationRow[],
  symbols: ReadonlyArray<{ sym: string; name: string }>,
): Array<{ sym: string; row: EgxValuationRow }> {
  const pairs: MatchPair[] = [];
  const symbolNames = new Map(symbols.map((item) => [item.sym, item.name]));
  const catalogTokens = new Map<string, string[]>();

  for (const row of rows) {
    const en = nameTokens(row.name, false);
    if (!en.length) continue;
    // A ticker written inside the Arabic name is an explicit, unambiguous
    // match (e.g. "… العقاري SCCD").
    const latinTokens = en.filter((token) => /^[a-z0-9]{2,}$/.test(token));
    for (const symbol of symbols) {
      if (latinTokens.includes(symbol.sym.toLowerCase())) {
        pairs.push({ sym: symbol.sym, row, score: 1, hits: en.length, reciprocal: 1, distinct: true });
      }
    }
    for (const symbol of symbols) {
      let cn = catalogTokens.get(symbol.sym);
      if (!cn) {
        cn = nameTokens(symbolNames.get(symbol.sym) ?? "", true);
        catalogTokens.set(symbol.sym, cn);
      }
      if (!cn.length) continue;
      let hits = 0;
      let distinct = false;
      for (const c of cn) {
        const partner = en.find((e) => tokensMatch(c, e));
        if (!partner) continue;
        hits += 1;
        if (Math.max(c.length, partner.length) >= 4 && !AR_COMMON.has(c) && !AR_COMMON.has(partner)) {
          distinct = true;
        }
      }
      if (!hits || !distinct) continue;
      const reciprocal = hits / en.length;
      const score = hits / cn.length;
      if (score < 0.5) continue;
      const multiOk = hits >= 2;
      const fullCoverOk = hits === cn.length && reciprocal >= 0.9;
      const singleOk = cn.length === 1 && reciprocal >= 0.3;
      if (!multiOk && !fullCoverOk && !singleOk) continue;
      pairs.push({ sym: symbol.sym, row, score, hits, reciprocal, distinct });
    }
  }

  pairs.sort(
    (a, b) =>
      b.score - a.score ||
      b.hits - a.hits ||
      b.reciprocal - a.reciprocal ||
      b.row.name.length - a.row.name.length,
  );

  const usedSymbols = new Set<string>();
  const usedRows = new Set<string>();
  const out: Array<{ sym: string; row: EgxValuationRow }> = [];
  for (const pair of pairs) {
    if (usedSymbols.has(pair.sym)) continue;
    const rowKey = normalizeArabicName(pair.row.name);
    if (usedRows.has(rowKey)) continue;
    usedSymbols.add(pair.sym);
    usedRows.add(rowKey);
    out.push({ sym: pair.sym, row: pair.row });
  }
  return out;
}

export type ValuationRow = {
  sym: string;
  pe: number;
  dy: number;
  egxName: string;
  match: "name" | "ticker";
};

export type ValuationsResponse = {
  status: "ok";
  fetchedAt: number;
  stale: boolean;
  source: string;
  coverage: string;
  totalRows: number;
  matchedCount: number;
  rows: ValuationRow[];
};

const VALUATIONS_CACHE_TTL_MS = 6 * 60 * 60_000;
const VALUATIONS_STALE_MS = 24 * 60 * 60_000;

/**
 * Fetch + parse the official EGX page (6h cache, last-good served stale) and
 * match its rows to the requested symbols. Matching is per-request because it
 * is cheap; the fetched table itself is what is cached.
 */
export async function buildValuationsResponse(
  symbols: string[],
  deps: { http: ResilientHttpClient; cache: JsonCache; now?: () => number },
): Promise<ValuationsResponse> {
  const now = deps.now ?? Date.now;
  const cached = await loadCached<EgxValuationRow[]>(
    deps.cache,
    "egytrend:market:egx-pe:v1",
    VALUATIONS_CACHE_TTL_MS,
    VALUATIONS_STALE_MS,
    async () => {
      const html = await deps.http.getText(EGX_PE_URL, {
        providerId: "egx-pe-page",
        timeoutMs: 10_000,
        attempts: 2,
        minIntervalMs: 1_000,
        headers: EGX_BROWSER_HEADERS,
      });
      const rows = parseEgxPeTable(html);
      if (!rows.length) throw new Error("egx pe page parsed to zero rows");
      return rows;
    },
  );

  const requested = new Map<string, string>();
  for (const rawSym of symbols) {
    const sym = sanitizeEgxSymbol(rawSym);
    if (sym && !requested.has(sym)) requested.set(sym, sym);
  }
  // Symbols without a requested set (or with an empty one) fall back to the
  // curated catalog so the endpoint is meaningful on its own.
  const candidates = requested.size
    ? [...requested.keys()].map((sym) => {
        const curated = EGX_STOCKS.find((item) => item.sym === sym);
        return { sym, name: curated?.name ?? "" };
      })
    : EGX_STOCKS.map((item) => ({ sym: item.sym, name: item.name }));

  const matched = matchEgxValuations(cached.value, candidates);
  return {
    status: "ok",
    fetchedAt: now(),
    stale: cached.stale,
    source: "البورصة المصرية (EGX) — الصفحة الرسمية لمضاعف الربحية والعائد على الكوبون",
    coverage: "تغطية جزئية: الشركات ذات الأنشطة المتخصصة فقط",
    totalRows: cached.value.length,
    matchedCount: matched.length,
    rows: matched.map((item) => ({
      sym: item.sym,
      pe: item.row.pe,
      dy: item.row.dy,
      egxName: item.row.name,
      match: item.row.name.toLowerCase().includes(item.sym.toLowerCase()) ? "ticker" : "name",
    })),
  };
}
