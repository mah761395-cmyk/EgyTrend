/* ═══════════════════════════════════════════════════════════════════
   EgyTrend AI Tool Layer
   ───────────────────────────────────────────────────────────────────
   The AI engine (Gemini) never invents data: every number it may quote
   comes from one of these tools, which read the SAME in-process caches
   the public routes serve (markets / stocks / news / calendar) plus the
   opportunities table and the caller's own context (portfolio/alerts).

   Rules:
   - No mock/fake data anywhere. Missing dataset → { ok:false, ... }
     with an explicit Arabic reason the model must relay verbatim.
   - Results are bounded (top-N) to keep the model context small
     (Free Tier cost control).
   - All tools are READ-ONLY. Nothing here mutates user data.
   ─────────────────────────────────────────────────────────────────── */

import { logger } from "./logger";
import { getMarketsSnapshot, getStocksSnapshot, getCalendarSnapshot, type StockQuote } from "../routes/markets";
import { getNewsSnapshot } from "../routes/news";
import { resolveEgxAlias } from "./egx-names";

/* ─── Arabic text normalization (matching only — never mutates display) ── */
export function normAr(s: string): string {
  return String(s || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "") // tashkeel + tatweel
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

type ToolResult = { ok: boolean; [k: string]: unknown };

const UNAVAILABLE = (what: string): ToolResult => ({
  ok: false,
  error: `لا تتوفر بيانات ${what} حاليًا في النظام — لم أتمكن من الوصول إلى بيانات حديثة لهذا الطلب.`,
});

function hasFiniteChange(stock: StockQuote): stock is StockQuote & { chgPct: number } {
  return typeof stock.chgPct === "number" && Number.isFinite(stock.chgPct);
}

/* ─── 1. get_market_data ─────────────────────────────────────────────── */
export async function getMarketData(args: { group?: string } = {}): Promise<ToolResult> {
  try {
    const snap = await getMarketsSnapshot();
    if (!snap) return UNAVAILABLE("الأسواق (مؤشرات/عملات/سلع)");
    const g = String(args.group || "all");
    const m = snap.data.markets;
    const out: Record<string, unknown> = {};
    if (g === "all" || g === "eg") out["eg"] = m.eg;
    if (g === "all" || g === "gl") out["gl"] = m.gl;
    if (g === "all" || g === "cm") out["cm"] = m.cm;
    if (g === "all" || g === "cr") out["cr"] = m.cr;
    return { ok: true, asOf: new Date(snap.data.ts).toISOString(), stale: !!snap.stale, markets: out };
  } catch (e) {
    logger.warn({ err: (e as Error).message }, "tool get_market_data failed");
    return UNAVAILABLE("الأسواق");
  }
}

/* ─── 2. get_market_indices ──────────────────────────────────────────── */
export async function getMarketIndices(): Promise<ToolResult> {
  try {
    const snap = await getMarketsSnapshot();
    if (!snap) return UNAVAILABLE("المؤشرات الرئيسية");
    const m = snap.data.markets;
    return {
      ok: true,
      asOf: new Date(snap.data.ts).toISOString(),
      egypt: m.eg,
      global: m.gl.slice(0, 8),
    };
  } catch (e) {
    logger.warn({ err: (e as Error).message }, "tool get_market_indices failed");
    return UNAVAILABLE("المؤشرات");
  }
}

/* ─── 3. get_stock_data ──────────────────────────────────────────────
   Resolve by exact symbol (COMI / comi.CA) first, then by Arabic/English
   name substring ("مدينة نصر" → MNHD, "جهينة" → JUFO). Returns the FULL
   quote for ≤3 matches; with no query returns top movers as an overview. */
export async function getStockData(args: { query?: string; limit?: number }): Promise<ToolResult> {
  try {
    const stocks = await getStocksSnapshot();
    if (!stocks || !stocks.length) return UNAVAILABLE("بيانات الأسهم");
    const q = String(args.query || "").trim();
    const limit = Math.min(Math.max(Number(args.limit) || 3, 1), 10);

    if (!q) {
      const sorted = [...stocks].filter(hasFiniteChange);
      const up = [...sorted].sort((a, b) => b.chgPct - a.chgPct).slice(0, 5);
      const dn = [...sorted].sort((a, b) => a.chgPct - b.chgPct).slice(0, 5);
      return { ok: true, scope: "top_movers", up, down: dn, total: stocks.length };
    }

    const qu = q.toUpperCase().replace(/\.CA$/, "");
    const nq = normAr(q);
    const nqTokens = nq.split(" ").filter((t) => t.length >= 3);

    const exact = stocks.filter((s) => s.sym.toUpperCase() === qu || s.sym.toUpperCase() === qu + ".CA");
    let hits = exact;
    if (!hits.length) {
      /* Colloquial / renamed / Latin spellings («مدينة مصر», «موبكو», «كريدي
       * أجريكول») resolve through the alias table onto the live symbol —
       * the live feed often has no Arabic label for those listings. */
      const aliasSym = resolveEgxAlias(q);
      if (aliasSym) hits = stocks.filter((s) => s.sym.toUpperCase() === aliasSym);
    }
    if (!hits.length) {
      hits = stocks.filter((s) => {
        const ns = normAr(s.name);
        if (ns.includes(nq)) return true;
        return nqTokens.length > 0 && nqTokens.every((t) => ns.includes(t));
      });
    }
    if (!hits.length) {
      return {
        ok: false,
        error: `لم أجد سهمًا يطابق «${q}» في بيانات البورصة المصرية المتاحة.`,
        hint: "اسأل المستخدم عن الرمز الصحيح (مثال: COMI أو JUFO أو MASR).",
      };
    }
    return { ok: true, query: q, matches: hits.slice(0, limit), matchCount: hits.length };
  } catch (e) {
    logger.warn({ err: (e as Error).message }, "tool get_stock_data failed");
    return UNAVAILABLE("بيانات الأسهم");
  }
}

/* ─── 4. get_news ──────────────────────────────────────────────────────
   Keyword search across ALL live feed titles (+description). With no
   query it returns the latest headlines. Arabic-normalized matching so
   «أخبار مدينة نصر» matches «مدينة نصر» headlines regardless of hamza. */
type NewsHit = { title: string; source: string; pubDate?: string; link?: string };

export async function getNews(args: { query?: string; limit?: number } = {}): Promise<ToolResult> {
  try {
    const snap = await getNewsSnapshot();
    if (!snap || !snap.feeds.length) return UNAVAILABLE("الأخبار");
    const limit = Math.min(Math.max(Number(args.limit) || 8, 1), 20);
    const q = normAr(args.query || "");
    const qTokens = q.split(" ").filter((t) => t.length >= 3);

    const hits: NewsHit[] = [];
    let scanned = 0;
    for (const f of snap.feeds) {
      const src = f.meta?.name || "";
      for (const it of f.items || []) {
        scanned += 1;
        if (hits.length >= limit) break;
        if (!q) {
          hits.push({ title: it.title, source: src, pubDate: it.pubDate, link: it.link });
          continue;
        }
        const hay = normAr(`${it.title} ${it.description || ""}`);
        if (qTokens.some((t) => hay.includes(t))) {
          hits.push({ title: it.title, source: src, pubDate: it.pubDate, link: it.link });
        }
      }
      if (hits.length >= limit) break;
    }

    if (!q) {
      return { ok: true, scope: "latest", headlines: hits, scanned, feedCount: snap.feeds.length };
    }
    if (!hits.length) {
      return {
        ok: true,
        scope: "search",
        query: args.query,
        headlines: [],
        scanned,
        feedCount: snap.feeds.length,
        note: `لم أجد أي خبر مطابق لـ «${args.query}» بين ${scanned} عنوانًا من ${snap.feeds.length} مصادر — قل ذلك صراحةً بدل اختراع أخبار.`,
      };
    }
    return { ok: true, scope: "search", query: args.query, headlines: hits, scanned, feedCount: snap.feeds.length };
  } catch (e) {
    logger.warn({ err: (e as Error).message }, "tool get_news failed");
    return UNAVAILABLE("الأخبار");
  }
}

/* ─── 5. get_company_news ──────────────────────────────────────────────
   Resolves the company to its ticker via the live stock list first (so
   «مدينة نصر» → MNHD), then searches headlines for BOTH the requested
   name and the resolved company name/ticker. */
export async function getCompanyNews(args: { company: string; limit?: number }): Promise<ToolResult> {
  const company = String(args.company || "").trim();
  if (!company) return { ok: false, error: "اسم الشركة مطلوب." };

  const stockRes = await getStockData({ query: company, limit: 1 });
  const resolved = stockRes.ok && Array.isArray(stockRes.matches) && stockRes.matches.length
    ? (stockRes.matches[0] as StockQuote)
    : null;

  const terms = [company];
  if (resolved) {
    terms.push(resolved.name, resolved.sym);
    const words = normAr(resolved.name).split(" ").filter((w) => w.length >= 4);
    terms.push(...words);
  }

  const limit = Math.min(Math.max(Number(args.limit) || 8, 1), 15);
  const seen = new Set<string>();
  const merged: NewsHit[] = [];
  let scanned = 0;
  let feedCount = 0;

  for (const term of terms) {
    if (merged.length >= limit) break;
    const r = await getNews({ query: term, limit: limit - merged.length });
    if (!r.ok) return r;
    scanned = Math.max(scanned, Number(r.scanned) || 0);
    feedCount = Number(r.feedCount) || feedCount;
    for (const h of (r.headlines as NewsHit[]) || []) {
      const key = normAr(h.title);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(h);
      if (merged.length >= limit) break;
    }
  }

  const stockBrief = resolved
    ? {
        sym: resolved.sym,
        name: resolved.name,
        sector: resolved.sector,
        price: resolved.price,
        chgPct: resolved.chgPct,
        pe: resolved.pe ?? null,
        vol: resolved.vol ?? null,
      }
    : null;

  if (!merged.length) {
    return {
      ok: true,
      company,
      resolvedStock: stockBrief,
      headlines: [],
      scanned,
      feedCount,
      note: `لا توجد أخبار منشورة حاليًا عن «${company}» في آخر العناوين (${scanned} عنوانًا من ${feedCount} مصدرًا). اذكر ذلك صراحة.`,
    };
  }
  return { ok: true, company, resolvedStock: stockBrief, headlines: merged, scanned, feedCount };
}

/* ─── 6. get_economic_calendar ────────────────────────────────────────
   Reads the shared calendar cache the /api/markets/calendar route uses.
   If it was never built in this process, builds it once (bounded). */
type CalEvent = {
  ev: string; evEn: string; t: string; tISO: string;
  imp: string; c: string; country: string; countryAr: string;
  flag: string; forecast: string; previous: string;
};

export async function getEconomicCalendar(args: { limit?: number } = {}): Promise<ToolResult> {
  try {
    const snap = await getCalendarSnapshot();
    if (!snap || !snap.events.length) {
      return UNAVAILABLE("التقويم الاقتصادي (لم يُبنَ بعد في هذه الجلسة — أعد المحاولة بعد لحظات)");
    }
    const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 20);
    return { ok: true, events: snap.events.slice(0, limit) };
  } catch (e) {
    logger.warn({ err: (e as Error).message }, "tool get_economic_calendar failed");
    return UNAVAILABLE("التقويم الاقتصادي");
  }
}

/* ─── 7. get_screener_results ──────────────────────────────────────────
   Real screening over the live EGX stock snapshot with the SAME filter
   semantics the frontend screener uses. "فوق المقاومة" has no server-side
   resistance data, so we expose honest proxies: above previous close,
   near 52-week high — and the model must say which one it used. */
export type ScreenerArgs = {
  sector?: string;
  perf?: "up" | "dn" | "up3" | "dn3" | "up5";
  priceMin?: number;
  priceMax?: number;
  volMin?: number;
  peMin?: number;
  peMax?: number;
  divMin?: number;
  eps?: "pos" | "neg";
  mktCap?: "mega" | "large" | "mid" | "small";
  abovePrevClose?: boolean;
  near52wHighPct?: number; // price within X% of 52w high (e.g. 3 = top 3%)
  sortBy?: "chgPct" | "price" | "vol" | "pe" | "mktCapM" | "divYield";
  sortDir?: "asc" | "desc";
  limit?: number;
};

export async function getScreenerResults(args: ScreenerArgs = {}): Promise<ToolResult> {
  try {
    const stocks = await getStocksSnapshot();
    if (!stocks || !stocks.length) return UNAVAILABLE("بيانات الأسهم للـ Screener");

    let out = [...stocks];
    const applied: string[] = [];

    if (args.sector) {
      out = out.filter((s) => s.sector === args.sector);
      applied.push(`sector=${args.sector}`);
    }
    if (args.perf) {
      const map: Record<string, (s: StockQuote) => boolean> = {
        up: (s) => hasFiniteChange(s) && s.chgPct > 0,
        dn: (s) => hasFiniteChange(s) && s.chgPct < 0,
        up3: (s) => hasFiniteChange(s) && s.chgPct >= 3,
        dn3: (s) => hasFiniteChange(s) && s.chgPct <= -3,
        up5: (s) => hasFiniteChange(s) && s.chgPct >= 5,
      };
      const f = map[args.perf];
      if (f) { out = out.filter(f); applied.push(`perf=${args.perf}`); }
    }
    if (typeof args.priceMin === "number") { out = out.filter((s) => s.price >= args.priceMin!); applied.push(`price>=${args.priceMin}`); }
    if (typeof args.priceMax === "number") { out = out.filter((s) => s.price <= args.priceMax!); applied.push(`price<=${args.priceMax}`); }
    if (typeof args.volMin === "number") { out = out.filter((s) => typeof s.vol === "number" && s.vol >= args.volMin!); applied.push(`vol>=${args.volMin}`); }
    if (typeof args.peMin === "number") { out = out.filter((s) => s.pe && s.pe > 0 && s.pe >= args.peMin!); applied.push(`pe>=${args.peMin}`); }
    if (typeof args.peMax === "number") { out = out.filter((s) => s.pe && s.pe > 0 && s.pe <= args.peMax!); applied.push(`pe<=${args.peMax}`); }
    if (typeof args.divMin === "number") { out = out.filter((s) => typeof s.divYield === "number" && s.divYield >= args.divMin!); applied.push(`divYield>=${args.divMin}`); }
    if (args.eps === "pos") { out = out.filter((s) => typeof s.eps === "number" && s.eps > 0); applied.push("eps>0"); }
    if (args.eps === "neg") { out = out.filter((s) => typeof s.eps === "number" && s.eps <= 0); applied.push("eps<=0"); }
    if (args.mktCap) {
      const bands: Record<string, (m: number) => boolean> = {
        mega: (m) => m >= 100000,
        large: (m) => m >= 10000 && m < 100000,
        mid: (m) => m >= 1000 && m < 10000,
        small: (m) => m < 1000,
      };
      const f = bands[args.mktCap];
      if (f) { out = out.filter((s) => typeof s.mktCapM === "number" && f(s.mktCapM!)); applied.push(`mktCap=${args.mktCap}`); }
    }
    if (args.abovePrevClose) { out = out.filter((s) => typeof s.prevClose === "number" && s.price > s.prevClose); applied.push("price>prevClose (فوق إغلاق أمس)"); }
    if (typeof args.near52wHighPct === "number" && args.near52wHighPct > 0) {
      const pct = args.near52wHighPct;
      out = out.filter((s) => s.high52w && s.price >= s.high52w * (1 - pct / 100));
      applied.push(`price within ${pct}% of 52w high`);
    }

    const sortKey = args.sortBy || "chgPct";
    const dir = args.sortDir === "asc" ? 1 : -1;
    out.sort((a, b) => {
      const av = (a[sortKey] ?? -Infinity) as number;
      const bv = (b[sortKey] ?? -Infinity) as number;
      return dir * (bv - av);
    });

    const limit = Math.min(Math.max(Number(args.limit) || 12, 1), 25);
    const total = out.length;
    const rows = out.slice(0, limit).map((s) => ({
      sym: s.sym, name: s.name, sector: s.sector,
      price: s.price, chgPct: s.chgPct, vol: s.vol,
      pe: s.pe ?? null, divYield: s.divYield ?? null,
      mktCapM: s.mktCapM ?? null, high52w: s.high52w ?? null, low52w: s.low52w ?? null,
    }));

    if (!total) {
      return {
        ok: true, results: [], total: 0, appliedFilters: applied,
        note: "لا توجد أسهم مطابقة لهذه الفلاتر في البيانات الحالية — قل ذلك صراحة ولا تقترح أسهمًا لم تظهر.",
      };
    }
    return {
      ok: true, results: rows, total, returned: rows.length,
      appliedFilters: applied, universe: `EGX live snapshot (${stocks.length} stocks)`,
      resistanceNote: "لا يتوفر مستوى مقاومة محسوب في البيانات — استُخدم بديل حقيقي: السعر فوق إغلاق أمس / الاقتراب من أعلى 52 أسبوعًا. اذكر זאת للمستخدم إذا طُلب ذلك.",
    };
  } catch (e) {
    logger.warn({ err: (e as Error).message }, "tool get_screener_results failed");
    return UNAVAILABLE("بيانات الـ Screener");
  }
}

/* ─── 8. get_portfolio ─────────────────────────────────────────────────
   ONLY the caller's own portfolio, supplied in the request context by
   the frontend (localStorage). Prices/P&L are re-computed HERE from the
   live snapshot — the model never does arithmetic on money. Returns an
   explicit message when the client didn't send a portfolio. */
export type PortItem = { sym: string; price: number; qty: number };

export async function getPortfolio(args: { items?: PortItem[] }): Promise<ToolResult> {
  const items = Array.isArray(args.items) ? args.items.slice(0, 50) : [];
  if (!items.length) {
    return {
      ok: false,
      error: "لم تُرسل محفظة استثمارية مع هذا الطلب — لا أستطيع تحليل محفظة لا أملك بياناتها. اطلب من المستخدم فتح تبويب «محفظتي» وإضافة أسهمه أولًا.",
    };
  }
  try {
    const stocks = await getStocksSnapshot();
    const rows = items.map((p) => {
      const live = stocks?.find((s) => s.sym === p.sym || s.sym === p.sym + ".CA") || null;
      const qty = Number(p.qty) || 0;
      const cost = (Number(p.price) || 0) * qty;
      const value = live ? live.price * qty : null;
      return {
        sym: p.sym,
        qty,
        buyPrice: Number(p.price) || 0,
        liveName: live?.name ?? null,
        currentPrice: live?.price ?? null,
        dayChgPct: live?.chgPct ?? null,
        cost,
        value,
        pnl: value !== null ? value - cost : null,
        pnlPct: value !== null && cost > 0 ? ((value - cost) / cost) * 100 : null,
        liveFound: !!live,
      };
    });
    const withVal = rows.filter((r) => r.value !== null);
    const totalCost = withVal.reduce((n, r) => n + r.cost, 0);
    const totalValue = withVal.reduce((n, r) => n + (r.value as number), 0);
    return {
      ok: true,
      rows,
      totals: {
        totalCost,
        totalValue,
        pnl: totalValue - totalCost,
        pnlPct: totalCost > 0 ? ((totalValue - totalCost) / totalCost) * 100 : null,
        valuedCount: withVal.length,
        missingCount: rows.length - withVal.length,
      },
      note: "الأرقام محسوبة في الخادم من الأسعار الحية — استخدمها كما هي دون إعادة حساب.",
    };
  } catch (e) {
    logger.warn({ err: (e as Error).message }, "tool get_portfolio failed");
    return UNAVAILABLE("بيانات المحفظة من المصدر");
  }
}

/* ─── 9. get_alerts ────────────────────────────────────────────────────
   Client-supplied notification list (the user's own device store).
   Not personal beyond what the user already sees in their alerts tab. */
export type AlertItem = { title?: string; body?: string; ts?: number; icon?: string };

export async function getAlerts(args: { items?: AlertItem[]; limit?: number }): Promise<ToolResult> {
  const items = Array.isArray(args.items) ? args.items : [];
  const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 25);
  if (!items.length) {
    return {
      ok: true,
      alerts: [],
      note: "لا توجد تنبيهات محفوظة على جهاز المستخدم حاليًا.",
    };
  }
  return {
    ok: true,
    alerts: items.slice(0, limit).map((a) => ({
      title: String(a.title || "").slice(0, 200),
      body: String(a.body || "").slice(0, 300),
      ts: typeof a.ts === "number" ? new Date(a.ts).toISOString() : null,
      icon: String(a.icon || "🔔").slice(0, 6),
    })),
  };
}

/* ─── 10. get_opportunities ────────────────────────────────────────────
   Source-backed descriptive observation cards from the same deterministic
   engine used by the admin. No DB writes, rankings, target returns, or
   trading recommendations occur here. */
export async function getOpportunities(args: { limit?: number } = {}): Promise<ToolResult> {
  try {
    const [mkRes, stRes, newsRes] = await Promise.allSettled([
      getMarketsSnapshot(),
      getStocksSnapshot(),
      getNewsSnapshot(),
    ]);
    const mk = mkRes.status === "fulfilled" ? mkRes.value : null;
    const st = stRes.status === "fulfilled" ? stRes.value : null;
    const news = newsRes.status === "fulfilled" ? newsRes.value : null;

    if (!mk && !st) return UNAVAILABLE("بيانات عناصر متابعة السوق (الأسواق والأسهم)");
    if (!st || !st.length) return UNAVAILABLE("بيانات الأسهم لإنشاء لقطات وصفية");

    const newsTitles: string[] = [];
    if (news) {
      for (const f of news.feeds.slice(0, 6)) {
        for (const it of (f.items || []).slice(0, 3)) newsTitles.push(it.title);
        if (newsTitles.length >= 10) break;
      }
    }

    const { buildLocalOpportunities } = await import("./opp-engine");
    const today = new Date().toLocaleDateString("ar-EG");
    const candidates = buildLocalOpportunities(
      mk ? (mk.data as unknown as Record<string, unknown>) : null,
      st as unknown as Parameters<typeof buildLocalOpportunities>[1],
      newsTitles,
      today,
    );
    const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 10);
    const out = candidates.slice(0, limit);
    if (!out.length) {
      return {
        ok: true,
        opportunities: [],
        note: "لا توجد لقطات وصفية يمكن التحقق منها حاليًا — لا تخترع بديلًا أو توصية.",
      };
    }
    return {
      ok: true,
      opportunities: out,
      basis: "بطاقات وصفية من حقول سوق/أسهم ذات مصدر ووقت مصدر صالحين؛ ليست توصيات أو ترتيبًا استثماريًا.",
      hasNews: newsTitles.length > 0,
      hasMarkets: !!mk,
    };
  } catch (e) {
    logger.warn({ err: (e as Error).message }, "tool get_opportunities failed");
    return UNAVAILABLE("بيانات الفرص");
  }
}

/* ═══════════════════════════════════════════════════════════════════
   Tool registry — JSON-Schema declarations for the model (Gemini
   functionDeclarations format) + the executor map used by the engine.
   ═══════════════════════════════════════════════════════════════════ */

export const TOOL_DECLARATIONS: Array<{ name: string; description: string; parameters: Record<string, unknown> }> = [
  {
    name: "get_market_data",
    description: "جلب بيانات الأسواق المتاحة من المصدر: المؤشرات والعملات والسلع والأصول الرقمية، مع حالة المصدر عند توافرها.",
    parameters: {
      type: "object",
      properties: {
        group: { type: "string", enum: ["all", "eg", "gl", "cm", "cr"], description: "مجموعة الأسواق المطلوبة، الافتراضي all" },
      },
    },
  },
  {
    name: "get_market_indices",
    description: "جلب المؤشرات الرئيسية المتاحة (مثل EGX30 والمؤشرات العالمية) مع نسب التغير المرسلة من المصدر.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "get_stock_data",
    description: "جلب بيانات سهم محدد بالرمز (COMI) أو الاسم (مدينة نصر، جهينة). بلا معاملات يعيد أبرز المتحركات. استخدمه لأي تحليل سهم محدد.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "رمز السهم أو اسم الشركة" },
        limit: { type: "integer", description: "أقصى عدد نتائج، الافتراضي 3" },
      },
    },
  },
  {
    name: "get_news",
    description: "بحث في العناوين الإخبارية المتاحة من المصادر المعتمدة. بلا معاملات يعيد آخر العناوين.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "كلمات البحث (مثال: مدينة نصر، أسعار الفائدة)" },
        limit: { type: "integer", description: "أقصى عدد عناوين، الافتراضي 8" },
      },
    },
  },
  {
    name: "get_company_news",
    description: "أخبار شركة محددة: يحلّل اسم الشركة إلى رمز السهم ثم يبحث في العناوين. استخدمه لسؤال «أخبار شركة فلان».",
    parameters: {
      type: "object",
      properties: {
        company: { type: "string", description: "اسم الشركة (مثال: مدينة نصر للإسكان)" },
        limit: { type: "integer", description: "أقصى عدد عناوين، الافتراضي 8" },
      },
      required: ["company"],
    },
  },
  {
    name: "get_economic_calendar",
    description: "التقويم الاقتصادي للأحداث القادمة (عالي/متوسط الأثر) مع الدول والتنبؤات والسابق.",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "integer", description: "أقصى عدد أحداث، الافتراضي 10" },
      },
    },
  },
  {
    name: "get_screener_results",
    description: "فلترة على حقول أسهم EGX المتاحة من المصدر. لا يوجد مستوى مقاومة محسوب؛ لا تستخدم بدائل كتوصية أو إشارة تداول.",
    parameters: {
      type: "object",
      properties: {
        sector: { type: "string", description: "القطاع (بنوك، عقارات، غذائية، صناعة، مالية، تقنية، اتصالات، أدوية...)" },
        perf: { type: "string", enum: ["up", "dn", "up3", "dn3", "up5"], description: "شرط الأداء اليومي" },
        priceMin: { type: "number", description: "أدنى سعر" },
        priceMax: { type: "number", description: "أقصى سعر" },
        volMin: { type: "number", description: "أدنى حجم تداول" },
        peMin: { type: "number", description: "أدنى P/E" },
        peMax: { type: "number", description: "أقصى P/E" },
        divMin: { type: "number", description: "أدنى عائد توزيعات %" },
        eps: { type: "string", enum: ["pos", "neg"], description: "إشارة EPS" },
        mktCap: { type: "string", enum: ["mega", "large", "mid", "small"], description: "شريحة القيمة السوقية" },
        abovePrevClose: { type: "boolean", description: "الأسهم التي سعرها فوق إغلاق أمس" },
        near52wHighPct: { type: "number", description: "الأسهم ضمن N% من أعلى سعر في 52 أسبوعًا" },
        sortBy: { type: "string", enum: ["chgPct", "price", "vol", "pe", "mktCapM", "divYield"], description: "عمود الفرز" },
        sortDir: { type: "string", enum: ["asc", "desc"], description: "اتجاه الفرز" },
        limit: { type: "integer", description: "أقصى عدد نتائج، الافتراضي 12" },
      },
    },
  },
  {
    name: "get_portfolio",
    description: "محفظة المستخدم الحالية (تمررها الواجهة) مع فرق حسابي فقط عند توافر سعر موثّق من الخادم. استخدمه لسؤال يخص محفظة المستخدم.",
    parameters: {
      type: "object",
      properties: {
        items: {
          type: "array",
          description: "أسطر المحفظة {sym, price (سعر الشراء), qty}",
          items: {
            type: "object",
            properties: {
              sym: { type: "string" },
              price: { type: "number" },
              qty: { type: "number" },
            },
            required: ["sym", "price", "qty"],
          },
        },
      },
    },
  },
  {
    name: "get_alerts",
    description: "تنبيهات المستخدم الحالية من جهازه (تُمرَّر من الواجهة). استخدمه لسؤال «إيه تنبيهاتي؟».",
    parameters: {
      type: "object",
      properties: {
        items: {
          type: "array",
          description: "عناصر التنبيهات {title, body, ts, icon}",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              body: { type: "string" },
              ts: { type: "number" },
              icon: { type: "string" },
            },
          },
        },
        limit: { type: "integer", description: "أقصى عدد، الافتراضي 10" },
      },
    },
  },
  {
    name: "get_opportunities",
    description: "لقطات سوق وصفية من حقول مصدرها ووقتها صالحان. استخدمه لسؤال عن البيانات المتاحة، ولا تصفها كفرص شراء أو ترتيب استثماري.",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "integer", description: "أقصى عدد بطاقات وصفية، الافتراضي 5" },
      },
    },
  },
];

/* Execute a tool call coming from the model. Context (portfolio/alerts)
 * is the CALLER's own data, injected from the request — never another
 * user's. Unknown tool → explicit error the model must report. */
export async function runTool(
  name: string,
  args: Record<string, unknown>,
  ctx: { portfolio?: PortItem[]; alerts?: AlertItem[] } = {},
): Promise<ToolResult> {
  const a = args || {};
  switch (name) {
    case "get_market_data":
      return getMarketData({ group: String(a.group || "all") });
    case "get_market_indices":
      return getMarketIndices();
    case "get_stock_data":
      return getStockData({ query: String(a.query || ""), limit: Number(a.limit) || 3 });
    case "get_news":
      return getNews({ query: String(a.query || ""), limit: Number(a.limit) || 8 });
    case "get_company_news":
      return getCompanyNews({ company: String(a.company || ""), limit: Number(a.limit) || 8 });
    case "get_economic_calendar":
      return getEconomicCalendar({ limit: Number(a.limit) || 10 });
    case "get_screener_results":
      return getScreenerResults(a as ScreenerArgs);
    case "get_portfolio":
      return getPortfolio({ items: ctx.portfolio || [] });
    case "get_alerts":
      return getAlerts({ items: ctx.alerts || [], limit: Number(a.limit) || 10 });
    case "get_opportunities":
      return getOpportunities({ limit: Number(a.limit) || 5 });
    default:
      return { ok: false, error: `أداة غير معروفة: ${name}` };
  }
}

export const TOOL_NAMES = TOOL_DECLARATIONS.map((t) => t.name);

/* ─── snapshot warm-up ─────────────────────────────────────────────────
   The tools above never hit the network directly: they read the same
   in-process snapshots the public routes serve. On a cold serverless
   instance that first read PAYS for the whole upstream fetch (news alone
   is ~28 feeds, up to 9s). Firing the builders when the request arrives
   overlaps that cost with the model's first round instead of adding it
   to the round that happens to call the tool first. Fire-and-forget:
   never throws, never awaited by the caller's critical path. */
export function warmSnapshots(): void {
  for (const p of [getMarketsSnapshot(), getStocksSnapshot(), getNewsSnapshot(), getCalendarSnapshot()]) {
    void Promise.resolve(p).catch(() => {
      /* warm-up is best-effort — the tool itself reports "no data" */
    });
  }
}
