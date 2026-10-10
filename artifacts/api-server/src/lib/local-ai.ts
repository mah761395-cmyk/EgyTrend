/* ─── EgyTrend Local AI Analyst ────────────────────────────────────────
 * Rule-based Arabic financial analyst that runs fully local when no
 * Anthropic key is configured. It answers from REAL live data (its own
 * /api/markets, /api/markets/stocks, /api/news endpoints) so VIP users
 * get useful analysis without any external API key. When ANTHROPIC_API_KEY
 * is present, ai.ts uses Claude instead and this engine stays idle.
 * ──────────────────────────────────────────────────────────────────── */

import { logger } from "./logger";
import { getMarketsSnapshot, getStocksSnapshot } from "../routes/markets";
import { getNewsSnapshot } from "../routes/news";
import { normAr } from "./ai-tools";
import { buildLocalOpportunities } from "./opp-engine";

type ChatMsg = { role: "user" | "assistant"; content: string };

/* ─── Live data (IN-PROCESS — shared with the API routes) ───────────────
 * This used to fetch http://localhost:${PORT}/api/… — that only works in
 * long-running mode. On Vercel (serverless) nothing listens on a port, so
 * every fetch failed, all three datasets stayed empty, and the assistant
 * answered «بيانات السوق/الأسهم غير متاحة». We now read the very same
 * caches the /api/markets and /api/news routes populate, in this process.
 * ───────────────────────────────────────────────────────────────────── */

type MarketsPayload = {
  markets?: Record<string, Array<{ n: string; v: string; c: string; up: boolean; s?: string }>>;
  sources?: Record<string, string>;
};

type StocksPayload = {
  stocks?: Array<{
    sym: string; name: string; price: number; chgPct: number;
    pe?: number; mktCapM?: number; vol?: number; sector?: string;
  }>;
};

type NewsPayload = {
  feeds?: Array<{ meta?: { name?: string }; items?: Array<{ title: string }> }>;
};

/* Budgets: the reply must beat Vercel's 60s function cap with room to spare.
 * A timed-out dataset keeps loading in the background and warms the shared
 * cache, so the NEXT request already has it. */
const MARKETS_WAIT_MS = 9_000;
const STOCKS_WAIT_MS = 9_000;
const NEWS_WAIT_MS = 6_000;

function withTimeout<T>(p: Promise<T | null>, ms: number): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    let settled = false;
    const t = setTimeout(() => {
      if (!settled) { settled = true; resolve(null); }
    }, ms);
    const finish = (v: T | null) => {
      if (!settled) { settled = true; clearTimeout(t); resolve(v); }
    };
    p.then(finish, () => finish(null));
  });
}

type Live = { markets?: MarketsPayload; stocks?: StocksPayload; news?: NewsPayload };

/* All three datasets start loading concurrently. Only what the chosen reply
 * needs is awaited (bounded); the rest keeps loading in the background and
 * warms the shared cache for the next message. */
async function getLive(question: string): Promise<{ live: Live; intent: Intent }> {
  const marketsP = withTimeout(
    getMarketsSnapshot().then((s) => (s ? (s.data as unknown as MarketsPayload) : null)),
    MARKETS_WAIT_MS,
  );
  const stocksP = withTimeout(
    getStocksSnapshot().then((s) => (s ? ({ stocks: s } as StocksPayload) : null)),
    STOCKS_WAIT_MS,
  );
  /* News path: read the shared in-process snapshot the /api/news route
   * serves (same cache, zero HTTP round-trip — works on serverless where
   * no localhost listener exists and no external self-fetch can time out). */
  const newsP = withTimeout(
    getNewsSnapshot().then((snap) => (snap ? ({ feeds: snap.feeds } as NewsPayload) : null)),
    NEWS_WAIT_MS,
  );

  const [mk, st, news] = await Promise.all([marketsP, stocksP, newsP]);
  const live: Live = { markets: mk ?? undefined, stocks: st ?? undefined, news: news ?? undefined };
  const intent = detectIntent(question, live.stocks?.stocks);
  return { live, intent };
}

/* ─── News text search (over the live feeds we already hold) ───
 * Lets the assistant answer queries like «ما أخبار مدينة نصر؟» by running
 * a lightweight keyword search over the titles we fetched from the live
 * RSS/API sources — no external service, no mock data. */

/* Tokenized + Arabic-normalized search: «إيه أخبار مدينة نصر؟» matches a
 * «مدينة نصر» headline regardless of hamza/alef variants, question words,
 * or word order. Matches on ANY meaningful token (≥3 chars after norm). */
const STOPWORDS = new Set([
  "ايه", "اخبار", "خبر", "اخبار", "الاخبار", "عن", "الي", "في", "من", "ما", "هل", "اللي",
  "حول", "بخصوص", "عايز", "ابغى", "ابي", "ايهما", "لي", "لدي", "اليوم", "النهارده", "النهرده",
  "السوق", "المصرية", "مصر", "-news", "news", "what", "the", "and", "for",
]);

/* Tokenize normalized Arabic text (drop stopwords + ≤2-char tokens). */
function tokenize(terms: string): string[] {
  return normAr(terms)
    .split(" ")
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

/* Generic words that appear in many company names — they must NOT be used to
 * identify a company (otherwise «نصر» would match anything). */
const NAME_GENERIC = new Set([
  "للاسكان", "والتعمير", "الاسكان", "التعمير", "ش", "م", "مم", "مصر", "المصريه", "المصرية",
  "القابضه", "القابضة", "بنك", "البنك", "الشركه", "الشركة", "للاغذيه", "الاغذيه", "الاغذية",
  "للصناعه", "الصناعه", "الصناعة", "العالميه", "العالمية", "والاستثمار", "الاستثمار",
  "المجموعه", "المجموعة", "هولدنج", "جروب", "group", "holding", "bank", "company", "co",
  "foods", "industries", "for", "and", "the",
]);

function coreTokens(name: string): string[] {
  return normAr(name).split(" ").filter((t) => t.length >= 3 && !NAME_GENERIC.has(t));
}

/* Arabic/English aliases → ticker. The live EGX feed returns MIXED names
 * (some English, some Arabic), so «فوري» must resolve to FWRY even when the
 * quoted name is English. A missing ticker is simply skipped. */
const AR_ALIAS: Array<[RegExp, string]> = [
  [/مدينه نصر|مدينة نصر|madinet nasr/i, "MNHD"],
  [/جهينه|جهينة|juhayna/i, "JUFO"],
  [/التجارى الدولى|التجاري الدولي|cib/i, "COMI"],
  [/هيرمس|هيرميس|efg hermes/i, "HRHO"],
  [/فورى|فوري|fawry/i, "FWRY"],
  [/السويدى|السويدي|elsewedy/i, "SWDY"],
  [/طلعت مصطفى|talaat moustafa/i, "TMGH"],
  [/ابو قير|أبو قير|abou kir|abuk/i, "ABUK"],
  [/المصرى الدولى|المصري الدولي|orascom/i, "ORWE"],
  [/عبور|obour/i, "OBRI"],
];

/* Resolve the company/stocks a question is really about. Ticker match wins;
 * otherwise ALL significant name tokens (or ≥2 when the name has several)
 * must be present — so «مدينة نصر» → MNHD while a stray «نصر» never matches
 * an unrelated company (the old single-token match caused false hits). */
function resolveStockMentions(
  text: string,
  stocks: NonNullable<StocksPayload["stocks"]>,
): Array<NonNullable<StocksPayload["stocks"]>[number]> {
  const tu = text.toUpperCase();
  const tn = normAr(text);
  const seen = new Set<string>();
  const hits: Array<NonNullable<StocksPayload["stocks"]>[number]> = [];
  const add = (s: NonNullable<StocksPayload["stocks"]>[number]) => {
    if (!seen.has(s.sym)) { seen.add(s.sym); hits.push(s); }
  };
  for (const s of stocks) if (s.sym && tu.includes(s.sym.toUpperCase())) add(s);
  if (hits.length) return hits.slice(0, 4);
  const rawLower = text.toLowerCase();
  for (const [re, sym] of AR_ALIAS) {
    if (re.test(text) || re.test(rawLower) || re.test(tn)) {
      const s = stocks.find((st) => st.sym.toUpperCase() === sym);
      if (s) add(s);
    }
  }
  if (hits.length) return hits.slice(0, 4);
  for (const s of stocks) {
    const core = coreTokens(s.name);
    if (!core.length) continue;
    const score = core.filter((t) => tn.includes(t)).length;
    if (score >= Math.min(2, core.length)) add(s);
  }
  return hits.slice(0, 4);
}

/* Headline search over normalized tokens. mode="all" requires every token
 * (used for company names — «مدينة نصر» must NOT be satisfied by a headline
 * that only says «المدينة»); mode="any" is a relaxed recall pass. */
function searchNews(
  feeds: NonNullable<NewsPayload["feeds"]>,
  tokens: string[],
  n = 6,
  mode: "all" | "any" = "all",
): Array<{ title: string; src: string }> {
  if (!tokens.length) return [];
  const out: Array<{ title: string; src: string }> = [];
  for (const f of feeds) {
    const src = f.meta?.name || "";
    for (const it of f.items || []) {
      const hay = normAr(it.title);
      const ok = mode === "all" ? tokens.every((t) => hay.includes(t)) : tokens.some((t) => hay.includes(t));
      if (ok) {
        out.push({ title: it.title, src });
        if (out.length >= n) return out;
      }
    }
  }
  return out;
}

/* Latest headlines across all feeds (used for market-wide news questions). */
function latestNews(feeds: NonNullable<NewsPayload["feeds"]>, n = 8): string[] {
  const lines: string[] = [];
  for (const f of feeds) {
    for (const it of f.items || []) {
      lines.push(`• ${it.title.slice(0, 100)} — ${f.meta?.name || ""}`);
      if (lines.length >= n) return lines;
    }
  }
  return lines;
}

/* ─── Arabic formatting helpers ─── */

function dirOf(c: string): string {
  if (c.startsWith("+")) return "بصعود";
  if (c.startsWith("-") || c.startsWith("−")) return "بتراجع";
  return "باستقرار";
}

function fmtPct(c: string): string {
  return c.replace("+", "+").replace("-", "−");
}

function topMovers(stocks: NonNullable<StocksPayload["stocks"]>) {
  const sorted = [...stocks].filter((s) => Number.isFinite(s.chgPct));
  const up = [...sorted].sort((a, b) => b.chgPct - a.chgPct).slice(0, 3);
  const dn = [...sorted].sort((a, b) => a.chgPct - b.chgPct).slice(0, 3);
  return { up, dn };
}

function cheapestByPE(stocks: NonNullable<StocksPayload["stocks"]>, n = 3) {
  return [...stocks]
    .filter((s) => s.pe && s.pe > 0)
    .sort((a, b) => (a.pe ?? 1e9) - (b.pe ?? 1e9))
    .slice(0, n);
}

/* ─── Intent detection ─── */

type Intent = "greeting" | "article" | "market" | "stock" | "advice" | "news" | "portfolio" | "opportunities" | "impact" | "general";

function detectIntent(text: string, stocks?: NonNullable<StocksPayload["stocks"]>): Intent {
  // greetings (check directly on the raw text, no normalization, so Arabic
  // hamza / alef variants behave the same in every Node.js environment)
  if (text.trim().indexOf("مرحبا") !== -1
      || text.trim().indexOf("السلام") !== -1
      || text.trim().indexOf("اهلا") !== -1
      || text.trim().indexOf("أهلا") !== -1
      || text.trim().indexOf("هاي") !== -1
      || text.trim().indexOf("hello") !== -1
      || text.trim().indexOf("hi") !== -1
      || text.trim().indexOf("ازيك") !== -1
      || text.trim().indexOf("إزيك") !== -1
  ) return "greeting";
  /* Article analysis from the news reader («حلّل هذا الخبر» + المصدر/العنوان/
   * الخلاصة). It must win over every keyword rule below — otherwise the
   * article's own words («الأسهم»، «توصية») route it to the stock-movers list
   * or the generic menu and the user sees a reply that ignores the article. */
  if (text.indexOf("حلل هذا الخبر") !== -1 || text.indexOf("حلّل هذا الخبر") !== -1
      || (text.indexOf("العنوان:") !== -1 && text.indexOf("الخلاصة:") !== -1)) return "article";
  if (text.indexOf("محفظتي") !== -1 || text.indexOf("محفظت") !== -1 || text.indexOf("portfolio") !== -1) return "portfolio";
  const tn = normAr(text);
  /* فرص تداول — تُبنى من البيانات الحية بدل قائمة منيو ثابتة. */
  if (tn.includes("فرص") || tn.includes("opportunit")) return "opportunities";
  /* سؤال «تأثير X على Y» — يحتاج تحليلًا سببيًا لا لقطة أسعار فقط.
   * (لا نستخدم «اذا» المجردة لأنها تطابق «لماذا».) */
  if (tn.includes("تاثير") || tn.includes("impact")
      || /اذا (ارتفع|انخفض|رفع|خفض|زاد|قل|هبط|صعد)/.test(tn)) return "impact";
  const wantsAdvice = text.indexOf("اشتري") !== -1 || text.indexOf("أشتري") !== -1
    || text.indexOf("ابيع") !== -1 || text.indexOf("أبيع") !== -1
    || text.indexOf("هل اشتري") !== -1 || text.indexOf("نصيحة") !== -1
    || text.indexOf("تنصحني") !== -1 || text.indexOf("توصية") !== -1
    || text.indexOf("ادخال") !== -1 || text.indexOf("دخول") !== -1
    || tn.includes("استثمار") || tn.includes("استثمر") || tn.includes("افضل استثمار");
  if (wantsAdvice) return "advice";
  /* An explicit ticker mention (e.g. "COMI") means the user wants that
   * stock analyzed — this beats generic market keywords that can appear
   * inside a long analysis prompt's embedded context. */
  const tu = text.toUpperCase();
  const symMentioned = !!stocks?.some((s) => s.sym && tu.indexOf(s.sym) !== -1);
  if (symMentioned) return "stock";
  /* الأخبار / news — normalized (NFKC + hamza/alef unify) so «أخبار»
   * matches on every Node.js build and every input spelling (اخبار/إخبار). */
  if (tn.includes('اخبار') || tn.includes('خبر') || tn.includes('news')
      || tn.includes('شريد') || tn.includes('جرجت'))
    return 'news';
  if (text.indexOf("السوق") !== -1 || text.indexOf("المؤشر") !== -1
      || text.indexOf("دولار") !== -1 || text.indexOf("ذهب") !== -1
      || text.indexOf("بيتكوين") !== -1 || text.indexOf("btc") !== -1
      || text.indexOf("egx") !== -1 || text.indexOf("اسواق") !== -1
      || text.indexOf("أسواق") !== -1 || text.indexOf("عملة") !== -1
      || text.indexOf("فائدة") !== -1 || text.indexOf("حالة السوق") !== -1
  ) return "market";
  if (text.indexOf("سهم") !== -1 || text.indexOf("اسهم") !== -1 || text.indexOf("أسهم") !== -1
      || text.indexOf("بورصة") !== -1 || text.indexOf("شركة") !== -1
      || text.indexOf("comi") !== -1 || text.indexOf("abuk") !== -1
      || text.indexOf("tmgh") !== -1 || text.indexOf("hrni") !== -1
      || text.indexOf("adib") !== -1 || text.indexOf("orwe") !== -1
  ) return "stock";
  return "general";
}

/* ─── Response builders (all grounded in live data) ─── */

function greetingReply(): string {
  return [
    "أهلاً بك! أنا محرر EgyTrend الذكي 🤖",
    "",
    "أعمل الآن بالوضع المحلي وأحلل بيانات السوق الحقيقية المحدّثة:",
    "• مؤشر EGX30 وأسهم البورصة المصرية",
    "• الدولار والعملات والذهب والنفط",
    "• الكريبتو وأهم الأخبار اليومية",
    "",
    "اسألني مثلاً:",
    "«إيه حالة السوق النهاردة؟»",
    "«حلّل سهم COMI»",
    "«هل أشتري ذهب ولا دولار؟»",
  ].join("\n");
}

function marketReply(live: { markets?: MarketsPayload; news?: NewsPayload; stocks?: StocksPayload }): string {
  const m = live.markets?.markets;
  if (!m) return fallbackReply(live, "بيانات الأسواق");
  const lines: string[] = ["📊 **نظرة سريعة على الأسواق الآن**", ""];
  const eg = m.eg || [];
  if (eg.length) {
    lines.push("🇪🇬 **السوق المصري:**");
    for (const q of eg.slice(0, 4)) lines.push(`• ${q.n}: ${q.v} (${fmtPct(q.c)}) ${dirOf(q.c)}`);
    lines.push("");
  }
  const gl = m.gl || [];
  if (gl.length) {
    lines.push("🌍 **الأسواق العالمية:**");
    lines.push(gl.map((q) => `${q.n} ${q.v} (${fmtPct(q.c)})`).join(" · "));
    lines.push("");
  }
  const cm = m.cm || [];
  if (cm.length) {
    lines.push("🥇 **السلع:** " + cm.map((q) => `${q.n} ${q.v} (${fmtPct(q.c)})`).join(" · "));
    lines.push("");
  }
  const cr = m.cr || [];
  if (cr.length) {
    lines.push("₿ **الكريبتو:** " + cr.map((q) => `${q.n} ${q.v} (${fmtPct(q.c)})`).join(" · "));
    lines.push("");
  }
  const egx = eg.find((q) => q.n === "EGX30");
  if (egx) {
    const down = egx.c.startsWith("-");
    lines.push(down
      ? `💡 **الخلاصة:** المؤشر المصري ${dirOf(egx.c)} — يُفضّل الحذر والانتظار حتى استقرار الحركة، مع مراقبة أسهم البنوك والصناعات الدفاعية.`
      : `💡 **الخلاصة:** المؤشر المصري ${dirOf(egx.c)} — الزخم الإيجابي مدعوم بسيولة جيدة، مع التركيز على القطاعات القائدة للصعود.`);
  }
  return lines.join("\n");
}

/* Shown only when a dataset genuinely could not be loaded in time. It leads
 * with what we DO have instead of a bare «غير متاحة», which read like a
 * broken site to users. */
function fallbackReply(live: Live, what: string): string {
  const stocks = live.stocks?.stocks;
  const m = live.markets?.markets;
  const lines: string[] = [`⏳ ${what} قيد التحديث الآن — أعد الإرسال بعد لحظات.`];
  if (m?.eg?.length) {
    lines.push("", "أقرب ما نملكه لحظياً:");
    for (const q of m.eg.slice(0, 3)) lines.push(`• ${q.n}: ${q.v} (${fmtPct(q.c)}) ${dirOf(q.c)}`);
  } else if (stocks?.length) {
    const { up, dn } = topMovers(stocks);
    lines.push("", "أقرب ما نملكه لحظياً:");
    if (up[0]) lines.push(`• الأكثر صعوداً: ${up[0].sym} ${up[0].price.toFixed(2)} ج (+${up[0].chgPct.toFixed(2)}%)`);
    if (dn[0]) lines.push(`• الأكثر تراجعاً: ${dn[0].sym} ${dn[0].price.toFixed(2)} ج (${dn[0].chgPct.toFixed(2)}%)`);
  } else {
    lines.push("(أول تحميل في اليوم قد يأخذ ثوانٍ).");
  }
  return lines.join("\n");
}

function stockReply(
  question: string,
  live: { stocks?: StocksPayload; news?: NewsPayload },
): string {
  const stocks = live.stocks?.stocks;
  if (!stocks || !stocks.length) return fallbackReply(live, "بيانات الأسهم");
  const hits = resolveStockMentions(question, stocks);
  if (!hits.length) {
    /* An explicit ticker-like token that matches nothing must be reported
     * honestly — never silently answered with an unrelated movers list. */
    const tickerLike = (question.match(/\b[A-Za-z]{3,12}\b/g) || [])
      .filter((t) => /^[A-Z]+$/.test(t) && !/^(USD|EGP|EGX|AI|ETF|IPO|PE|NEWS|OK|VIP)$/.test(t));
    if (tickerLike.length) {
      return [
        `📊 لم أجد سهمًا بالرمز «${tickerLike[0]}» في بيانات البورصة المصرية المتاحة حالياً.`,
        "تحقّق من الرمز (مثال: COMI · JUFO · HRHO) أو اكتب اسم الشركة بالعربي.",
      ].join("\n");
    }
    const { up, dn } = topMovers(stocks);
    const lines = ["📈 **أبرز تحركات الأسهم الآن:**", ""];
    if (up.length) lines.push("🟢 **الأكثر صعوداً:**");
    for (const s of up) lines.push(`• ${s.sym} (${s.name}): ${s.price.toFixed(2)} ج (${s.chgPct >= 0 ? "+" : ""}${s.chgPct.toFixed(2)}%)${s.pe ? ` · P/E ${s.pe.toFixed(1)}` : ""}`);
    lines.push("");
    if (dn.length) lines.push("🔴 **الأكثر تراجعاً:**");
    for (const s of dn) lines.push(`• ${s.sym} (${s.name}): ${s.price.toFixed(2)} ج (${s.chgPct >= 0 ? "+" : ""}${s.chgPct.toFixed(2)}%)${s.pe ? ` · P/E ${s.pe.toFixed(1)}` : ""}`);
    lines.push("", "💡 اذكر رمز السهم (مثل COMI أو ABUK) لتحليل مفصّل له.");
    return lines.join("\n");
  }
  const lines: string[] = [];
  for (const s of hits) {
    lines.push(`📊 **تحليل ${s.sym} — ${s.name}**`, "");
    lines.push(`• السعر الحالي: ${s.price.toFixed(2)} ج`);
    lines.push(`• التغير اليوم: ${s.chgPct >= 0 ? "+" : ""}${s.chgPct.toFixed(2)}% ${dirOf(s.chgPct >= 0 ? "+" : "-")}`);
    if (s.pe) {
      const cheap = s.pe < 8 ? "رخيص نسبياً" : s.pe < 15 ? "معتدل" : "مرتفع نسبياً";
      lines.push(`• معامل الربحية P/E: ${s.pe.toFixed(1)} (${cheap})`);
    }
    if (s.mktCapM) lines.push(`• القيمة السوقية: ${s.mktCapM >= 1000 ? (s.mktCapM / 1000).toFixed(1) + " مليار" : s.mktCapM + " مليون"} ج`);
    if (s.vol) lines.push(`• حجم التداول: ${s.vol.toLocaleString("ar-EG")} سهم`);
    lines.push("");
    if (s.chgPct >= 2) lines.push("💡 **القراءة:** زخم شرائي قوي اليوم — من الأفضل انتظار تراجع بسيط للدخول، مع وقف خسارة تحت قاع اليوم.");
    else if (s.chgPct <= -2) lines.push("💡 **القراءة:** ضغط بيعي واضح — يُفضّل الانتظار حتى يظهر استقرار أو انعكاس قبل أي قرار شراء.");
    else lines.push("💡 **القراءة:** حركة هادئة ضمن النطاق — مناسبة للتراكم التدريجي لمن يتبنى رؤية طويلة المدى.");
    lines.push("", "⚠️ تحليل تعليمي مبني على البيانات الحية وليس توصية استثمارية.");
    lines.push("");
  }
  return lines.join("\n");
}

function adviceReply(live: { markets?: MarketsPayload; stocks?: StocksPayload }): string {
  const m = live.markets?.markets;
  const lines: string[] = ["🧭 **قراءة سريعة لاتخاذ القرار:**", ""];
  const egx = m?.eg?.find((q) => q.n === "EGX30");
  const usd = m?.eg?.find((q) => q.n === "USD/EGP");
  const gold = m?.cm?.find((q) => q.n === "ذهب");
  if (egx) lines.push(`• البورصة: EGX30 عند ${egx.v} (${fmtPct(egx.c)}) — ${dirOf(egx.c)}`);
  if (usd) lines.push(`• الدولار: ${usd.v} جنيه (${fmtPct(usd.c)})`);
  if (gold) lines.push(`• الذهب: ${gold.v} للأوقية (${fmtPct(gold.c)})`);
  lines.push("");
  const stocks = live.stocks?.stocks;
  if (stocks) {
    const cheap = cheapestByPE(stocks);
    if (cheap.length) {
      lines.push("💰 **أرخص الأسهم تقييماً (P/E منخفض):**");
      for (const s of cheap) lines.push(`• ${s.sym} (${s.name}): P/E ${s.pe?.toFixed(1)} · سعر ${s.price.toFixed(2)} ج`);
      lines.push("");
    }
  }
  lines.push("**قاعدة عامة:** التنويع بين البورصة والذهب وأدوات الدين يقلل المخاطر، ولا تُدخل بمال لا تتحمل خسارته.");
  lines.push("", "⚠️ هذا تحليل تعليمي وليس توصية استثمارية ملزمة.");
  return lines.join("\n");
}

function newsReply(live: { news?: NewsPayload; markets?: MarketsPayload; stocks?: StocksPayload }, question?: string): string {
  const feeds = live.news?.feeds;
  if (!feeds || !feeds.length) return fallbackReply(live, "الأخبار");

  /* Resolve a company first so «أخبار مدينة نصر» searches by the company's
   * real name tokens (AND) instead of loose single-word matches. */
  const resolved = question ? resolveStockMentions(question, live.stocks?.stocks || [])[0] : null;
  const qn = normAr(question || "");

  /* Market-wide news questions («أهم أخبار EGX/السوق») → latest headlines. */
  if (!resolved && question && /egx|السوق|البورصه|الاسهم|مصر|اقتصاد/.test(qn)) {
    return ["📰 **أهم الأخبار الآن:**", "", ...latestNews(feeds, 8)].join("\n");
  }

  const terms = resolved ? coreTokens(resolved.name).join(" ")
    : (question && /[أ-يa-zA-Z0-9]/.test(question) ? question : null);
  if (terms) {
    const tokens = tokenize(terms);
    /* STRICT AND matching only: a loose single-token pass is exactly what
     * returned unrelated headlines before («مدينة نصر» → «الجهات المدينة»).
     * When nothing matches we say so honestly instead of guessing. */
    const hits = searchNews(feeds, tokens, 6, "all");
    const dispTerms = terms.replace(/[؟?]/g, "")
      .replace(/^(إيه|ايه|ما|ماذا|هاتلي|هات|عايز|قل لي)\s+/, "")
      .replace(/^(أخبار|اخبار)\s+/, "")
      .trim() || terms;
    const label = resolved ? `${resolved.name} (${resolved.sym})` : `«${dispTerms}»`;
    if (hits.length) {
      const lines = [`📰 **أخبار ${label}:**`, ""];
      for (const h of hits) lines.push(`• ${h.title} — ${h.src}`);
      lines.push("", `🔎 بحث في عناوين ${feeds.length} مصدرًا حيًّا.`);
      return lines.join("\n");
    }
    /* No match → say it honestly instead of dumping unrelated headlines. */
    const lines = [
      `⚠️ **لا توجد أخبار منشورة حاليًا عن ${label}** في آخر العناوين من ${feeds.length} مصدرًا.`,
      "قد يكون الخبر غير منشور بعد — أو جرّب كلمات بحث مختلفة.",
      "",
      "📰 آخر العناوين للمتابعة:",
      ...latestNews(feeds, 6),
    ];
    return lines.join("\n");
  }

  return ["📰 **أهم الأخبار الآن:**", "", ...latestNews(feeds, 8)].join("\n");
}

function portfolioReply(question: string, live: { stocks?: StocksPayload }): string {
  const stocks = live.stocks?.stocks;
  // Try to parse lines like "COMI 100 55.5" or symbols mentioned
  const mentioned = stocks ? resolveStockMentions(question, stocks) : [];
  const lines: string[] = ["💼 **متابعة المحفظة:**", ""];
  if (mentioned.length) {
    for (const s of mentioned) {
      lines.push(`• ${s.sym} (${s.name}): السعر الحالي ${s.price.toFixed(2)} ج · التغير اليوم ${s.chgPct >= 0 ? "+" : ""}${s.chgPct.toFixed(2)}%`);
    }
    lines.push("");
  }
  lines.push("لتحليل محفظتك بالتفصيل: أضف أسهمك من تبويب «حسابي ← محفظتي» مع سعر الشراء وعدد الأسهم، ثم اضغط «تحليل المحفظة» — سأقيّم الأداء والتوزيع والمخاطر بناءً على الأسعار الحية.");
  return lines.join("\n");
}

function generalReply(live: { markets?: MarketsPayload }): string {
  return [
    "🤖 يمكنني مساعدتك في:",
    "",
    "• **حالة السوق:** اسأل «إيه حالة السوق؟»",
    "• **تحليل سهم:** اذكر الرمز مثل «حلّل COMI»",
    "• **قرار استثماري:** اسأل «هل أشتري ذهب ولا دولار؟»",
    "• **آخر الأخبار:** اسأل «أهم الأخبار النهاردة»",
    "",
    "كل الإجابات مبنية على بيانات السوق الحقيقية المحدّثة لحظياً.",
    live.markets?.markets?.eg?.length
      ? `\n📊 الآن: EGX30 ${live.markets.markets.eg[0]?.v} (${fmtPct(live.markets.markets.eg[0]?.c || "")}) · USD/EGP ${live.markets.markets.eg[1]?.v || "—"}`
      : "",
  ].join("\n");
}

/* ─── Article analysis (news reader «حلّل الآن») ───────────────────────
 * Rule-based but grounded: the article text is matched against a sector
 * table and answered with the live quotes we already hold, so the reply
 * actually covers the story instead of falling back to a menu or a
 * top-movers list (which is what users saw as «مش بتشغل»). */

const ARTICLE_HINTS: Array<{ re: RegExp; sector?: string; line: string }> = [
  { re: /بنك|ائتمان|قروض|سعر الفائدة|البنك المركزي|تمويل/i, sector: "بنوك",
    line: "قطاع البنوك يتأثر مباشرةً: سعر الفائدة والائتمان يحدّدان هوامش الربح وحجم التمويل." },
  { re: /عقار|إسكان|أراضٍ|مطورين|طلعت مصطفى|بالم هيلز|سوديك|هيرو/i, sector: "عقارات",
    line: "قطاع العقارات: الترخيص والتسهيلات والطلب العقاري تتحرّك بها دخل شركات المطورين." },
  { re: /اتصالات|مشغل|فودافون|أورنج|موبايل/i, sector: "اتصالات",
    line: "قطاع الاتصالات: أي تعديل في الأسعار أو الضريبة ينعكس فوراً على الإيرادات." },
  { re: /أدوية|دواء|صيدل|استهلاك دواء/i, sector: "أدوية",
    line: "قطاع الأدوية: تسعير الدواء والتهيئة الصناعية يحدّدان التكلفة — أي تغيير يظهر في هوامش الربح." },
  { re: /غذائية|أغذية|غذاء|تضخم|غلاء|أسعار/i, sector: "غذائية",
    line: "الغذائية والسلع الاستهلاكية: التضخم يرفع التكلفة وقد يضغط على الهوامش إن لم تُعدّل الأسعار." },
  { re: /فوري|رقمنة|دفع إلكتروني|تكنولوجيا|برمجة|ذكاء اصطناعي/i, sector: "تقنية",
    line: "قطاع التقنية والدفع الإلكتروني: التوسع الرقمي يدعم الإيرادات المتكررة." },
  { re: /أسمنت|حديد|مواد بناء|مقاولات|تحت البنية|مشروعات وطنية/i, sector: "مواد بناء",
    line: "مواد البناء والمقاولات: الإنفاق الحكومي والمشروعات الكبرى تُحرك الطلب." },
  { re: /تأمين/i, sector: "مالية",
    line: "التأمين: عائدات محافظ الاستثمار المرتبطة بالفائدة تؤثر في أرباح القطاع." },
  { re: /تصدير|استيراد|ميزان تجاري|دولار|سعر صرف|جمارك/i,
    line: "سعر الصرف والتجارة: تحرّك الدولار ينعكس على تكلفة الاستيراد وأرباح الشركات المصدِّرة." },
  { re: /ذهب|صاغة|عيار/i,
    line: "الذهب: سعر الجنيه الذهب محلياً يتبع أونصة الذهب بالدولار ثم سعر الصرف." },
  { re: /نفط|برنت|غاز|طاقة/i,
    line: "النفط والطاقة: البرنت ينعكس على أسهم الطاقة وتكاليف النقل والصناعة." },
  { re: /بيتكوين|كريبتو|عملات رقمية|إيثريوم/i,
    line: "الكريبتو: تقلب عالي ويتأثر بمشاعر السوق العالمية وتدفقات الصناديق." },
];

const POS_WORDS = "ارتفاع|صعود|ارتقاء|زيادة|نمو|مكاسب|تفاؤل|استثمار|صفقة|اعتماد|خفض الفائدة|تسهيلات|إنعاش|توسعة|موافقة|إطلاق|توظيف|صادرات";
const NEG_WORDS = "هبوط|تراجع|انخفاض|خسارة|عجز|أزمة|تحذير|ضغط|إضراب|رفع الفائدة|عقوبة|مطالبة|تدهور|انكماش|غرامة|قضية|اعتقال|توقّف|منع|إفلام|ديون";

type Direction = { icon: string; label: string; note: string };

function directionOf(text: string): Direction {
  const pos = (text.match(new RegExp(POS_WORDS, "g")) || []).length;
  const neg = (text.match(new RegExp(NEG_WORDS, "g")) || []).length;
  if (pos > neg) {
    return { icon: "📈", label: "إيجابي",
      note: "لغة الخبر تسودها الإشارات الإيجابية (نمو/استثمار/اعتماد)، ما يرجّح دعم سعري للقطاعات المذكورة." };
  }
  if (neg > pos) {
    return { icon: "📉", label: "سلبي",
      note: "لغة الخبر تسودها الإشارات السلبية (تراجع/ضغط/مطالبات)، ما يرجّح حذراً تجاه القطاعات المذكورة." };
  }
  return { icon: "➖", label: "محايد",
    note: "الخبر محايد أو لم تتضح إشارته بعد — الأثر سيظهر عند صدور أرقام مؤكدة." };
}

function peerLine(s: NonNullable<StocksPayload["stocks"]>[number]): string {
  const dir = s.chgPct >= 0 ? "+" : "";
  return `   ‣ ${s.sym} (${s.name}): ${s.price.toFixed(2)} ج · ${dir}${s.chgPct.toFixed(2)}%${s.pe ? ` · P/E ${s.pe.toFixed(1)}` : ""}`;
}

function articleAnalysisReply(question: string, live: Live): string {
  const grab = (re: RegExp) => (question.match(re) || [])[1]?.trim() || "";
  const title = grab(/العنوان:\s*(.+)/);
  const src = grab(/المصدر:\s*(.+)/);
  const summary = grab(/الخلاصة:\s*([\s\S]*?)(?:\n\s*\n|\nالمطلوب|$)/);
  const corpus = [title, summary].filter(Boolean).join("\n");

  const lines: string[] = [];
  lines.push("📰 **تحليل الخبر**");
  if (title) lines.push(`**${title}**`);
  if (src) lines.push(`🔎 المصدر: ${src}`, "");
  if (summary) {
    lines.push("1️⃣ **الخلاصة الفورية**");
    lines.push(summary.slice(0, 420), "");
  }

  const dir = directionOf(corpus);
  lines.push(`${dir.icon} **اتجاه التأثير: ${dir.label}**`);
  lines.push(dir.note, "");

  /* Live market context — what the numbers say right now */
  const m = live.markets?.markets;
  lines.push("3️⃣ **وضع السوق الآن (بيانات حية)**");
  if (m?.eg?.length || m?.cm?.length || m?.cr?.length) {
    for (const q of (m.eg || []).slice(0, 3)) lines.push(`• ${q.n}: ${q.v} (${fmtPct(q.c)}) ${dirOf(q.c)}`);
    const gold = (m.cm || []).find((q) => /ذهب/.test(q.n));
    if (gold) lines.push(`• الذهب: ${gold.v} للأوقية (${fmtPct(gold.c)}) ${dirOf(gold.c)}`);
    const btc = (m.cr || []).find((q) => q.n === "BTC");
    if (btc) lines.push(`• Bitcoin: ${btc.v} (${fmtPct(btc.c)}) ${dirOf(btc.c)}`);
    lines.push("");
  }

  /* Which parts of the economy the story touches — with live quotes */
  const hits = ARTICLE_HINTS.filter((h) => h.re.test(corpus));
  const stocks = live.stocks?.stocks ?? [];
  lines.push("2️⃣ **القطاعات والأسهم المتأثرة**");
  if (hits.length) {
    for (const h of hits.slice(0, 5)) {
      lines.push(`• ${h.line}`);
      if (h.sector && stocks.length) {
        const peers = stocks
          .filter((s) => s.sector === h.sector)
          .sort((a, b) => (b.mktCapM ?? 0) - (a.mktCapM ?? 0))
          .slice(0, 3);
        for (const p of peers) lines.push(peerLine(p));
      }
    }
    lines.push("");
  } else {
    lines.push("• لم يذكر الخبر قطاعاً محدداً — الأثر سيعمّ السوق إذا استمرت القصة.", "");
  }

  if (!m?.eg?.length && !stocks.length) {
    /* Data never arrived — do not pretend it did. */
    return [
      ...lines,
      "⏳ ملاحظة: أسعار السوق الحية قيد التحديث الآن، لذا التحليل أعلاه مبني على نص الخبر فقط — أعد الضغط بعد لحظات للأسعار.",
    ].join("\n");
  }

  lines.push("4️⃣ **المخاطر التي يجب مراعاتها**");
  lines.push(dir.label === "سلبي"
    ? "• لا تتصدّر القسم المتأثر قبل تأكيد الرقم/القرار من المصدر نفسه.\n• وزّع الدخول على دفعات بدل شراء دفعة واحدة.\n• اضبط وقف خسارة تحت مستوى دعم واضح للسهم."
    : dir.label === "إيجابي"
      ? "• الإيجابية قد تكون مسعّرة سلفاً — احذر «اشترِ الخبر» بعد ارتفاع سعرها.\n• راجع أرقام الربحية قبل الدخول (P/E المذكور أعلاه).\n• الأثر يحتاج تأكيداً من أرقام رسمية قادمة."
      : "• لا تبنِ قراراً على خبر واحد بلا أرقام مؤكدة.\n• راقب ردّ فعل السوق في الجلسات القادمة.\n• تجنّب المضاربة السريعة على معلومات ناقصة.",
  "");

  lines.push("5️⃣ **خلاصة القرار**");
  lines.push(
    dir.label === "سلبي"
      ? "• موقف انتظار للقطاع المذكور حتى يظهر استقرار.\n• الأفضلية حالياً للسيولة والنقد بعيداً عن المخاطرة."
      : dir.label === "إيجابي"
        ? "• يُفضّل متابعة الدخول التدريجي على القطاعات المذكورة.\n• ركّز على الشركات ذات الربحية المنخفضة P/E والسيولة الجيدة."
        : "• لا توجد إشارة كافية للدخول الآن — انتظر تأكيداً.\n• استمر في متابعة أرقام السوق من تبويب «الأسواق».",
    "",
    "⚠️ تحليل تعليمي مبني على نص الخبر والبيانات الحية — وليس توصية استثمارية. قراراتك على مسؤوليتك.",
  );

  return lines.join("\n");
}

/* ─── فرص تداول — مبنية على البيانات الحية بدل قائمة ثابتة ─── */

function opportunitiesReply(live: Live): string {
  const stocks = live.stocks?.stocks || [];
  if (!stocks.length) return fallbackReply(live, "بيانات الفرص");
  const newsTitles: string[] = [];
  for (const f of live.news?.feeds || []) {
    for (const it of f.items || []) { newsTitles.push(it.title); if (newsTitles.length >= 10) break; }
    if (newsTitles.length >= 10) break;
  }
  let cands: ReturnType<typeof buildLocalOpportunities> = [];
  try {
    cands = buildLocalOpportunities(
      live.markets as any, stocks as any, newsTitles,
      new Date().toLocaleDateString("ar-EG"),
    );
  } catch (e) { logger.warn({ err: e }, "opportunitiesReply build failed"); }
  if (!cands.length) {
    return [
      "💡 لم أجد فرصة واضحة وفق البيانات الحالية.",
      "هذا يعني أن الظروف الحالية لا تُظهر إعدادًا قويًا (تقييم/زخم/توزيعات) — ولن أخترع فرصًا غير موجودة.",
      "",
      "جرّب: «إيه أرخص الأسهم؟» أو «إيه حالة السوق؟»",
    ].join("\n");
  }
  const lines = ["💡 **فرص مبنية على بيانات السوق الحية**", ""];
  for (const c of cands.slice(0, 5)) {
    const rl = Math.max(1, Math.min(5, c.riskLevel));
    const risk = "★".repeat(rl) + "☆".repeat(5 - rl);
    lines.push(`• **${c.title}**`);
    lines.push(`  ${c.summary}`);
    lines.push(`  العائد المتوقع: ${c.expectedReturn} · المخاطرة: ${risk} · المدة: ${c.duration}`);
    lines.push("");
  }
  lines.push("⚠️ محسوبة من محرك EgyTrend على بيانات حية (تقييم/زخم/توزيعات/سلع/كريبتو) — وليست توصية استثمارية.");
  return lines.join("\n");
}

/* ─── تحليل تأثير عامل على السوق — قراءة سببية بأرقام حية ─── */

function impactReply(question: string, live: Live): string {
  const m = live.markets?.markets;
  if (!m) return fallbackReply(live, "بيانات الأسواق");
  const q = normAr(question);
  const eg = m.eg || [];
  const egx = eg.find((x) => /EGX30/.test(x.n));
  const usd = eg.find((x) => /USD/.test(x.n));
  const cm = m.cm || [];
  const gold = cm.find((x) => /ذهب/.test(x.n));
  const brent = cm.find((x) => /برنت|نفط|خام/.test(x.n));

  const lines: string[] = ["🧠 **تحليل التأثير**", ""];
  const snap: string[] = [];
  if (egx) snap.push(`EGX30 ${egx.v} (${fmtPct(egx.c)})`);
  if (usd) snap.push(`دولار ${usd.v} (${fmtPct(usd.c)})`);
  if (gold) snap.push(`${gold.n} ${gold.v} (${fmtPct(gold.c)})`);
  if (brent) snap.push(`${brent.n} ${brent.v} (${fmtPct(brent.c)})`);
  if (snap.length) { lines.push("**الأرقام الآن:** " + snap.join(" · "), ""); }

  const aboutGold = /ذهب|gold/.test(q);
  const aboutRate = /فايده|interest|فيدرال|fed/.test(q);
  const aboutOil = /نفط|بترول|oil|برنت/.test(q);
  const aboutUsd = /دولار|dollar|usd/.test(q);

  if (aboutGold) {
    lines.push("**لماذا يهم الذهب السوق المصري؟**");
    lines.push("• الذهب يُسعَّر بالأوقية بالدولار، وسعره بالجنيه = سعر الأوقية × سعر الصرف — فيتحرك مع الدولار لا مع EGX.");
    lines.push("• ارتفاع الذهب عادةً يعني طلبًا على الملاذ الآمن أو توقعات تضخم/ضعف عملة، فيُحوّل المستثمر المحلي جزءًا من السيولة إلى الذهب بدل الأسهم.");
    lines.push("• التأثير على EGX غير مباشر: ضعف الجنيه يرفع تكلفة الاستيراد على الشركات المستوردة، بينما شركات مرتبطة بالذهب/التعدين قد تستفيد.");
    lines.push("");
    lines.push("**القراءة الحالية:** " + (gold ? `الذهب عند ${gold.v} (${fmtPct(gold.c)})${usd ? ` والدولار ${usd.v}` : ""}.` : "بيانات الذهب غير متاحة لحظيًا."));
  } else if (aboutRate) {
    lines.push("**لماذا تهم الفائدة الأمريكية؟**");
    lines.push("• رفع الفائدة يقوّي الدولار عالميًا، ما يضغط عادةً على الذهب والأصول عالية المخاطر.");
    lines.push("• في مصر، الفائدة المرتفعة محليًا تجعل أدوات الدين منافسًا قويًا للأسهم (خروج سيولة من EGX)، وترفع تكلفة الاقتراض على الشركات.");
    lines.push("• صعود الدولار يرفع تكلفة الاستيراد ويضغط على الشركات المستوردة، ويدعم المصدّرين.");
    lines.push("");
    lines.push("**القراءة الحالية:** " + (usd ? `الدولار عند ${usd.v} (${fmtPct(usd.c)})` : "الدولار غير متاح لحظيًا") + (egx ? ` وEGX30 عند ${egx.v} (${fmtPct(egx.c)}).` : "."));
  } else if (aboutOil) {
    lines.push("**لماذا يهم النفط؟**");
    lines.push("• مصر مستورد صافٍ للطاقة؛ ارتفاع النفط يرفع تكاليف النقل والصناعة ويضغط على هوامش الشركات الصناعية.");
    lines.push("• في المقابل يدعم اقتصادات الخليج وأسهم الطاقة عالميًا.");
    lines.push("");
    lines.push("**القراءة الحالية:** " + (brent ? `${brent.n} عند ${brent.v} (${fmtPct(brent.c)}).` : "بيانات النفط غير متاحة لحظيًا."));
  } else if (aboutUsd) {
    lines.push("**لماذا يهم الدولار؟**");
    lines.push("• ارتفاع الدولار يرفع تكلفة الاستيراد، يضغط على الشركات المستوردة، ويدعم المصدّرين والسياحة.");
    lines.push("• يؤثر على تقييم الأصول الدولارية (الذهب، ETFs العالمية) بالجنيه.");
    lines.push("");
    lines.push("**القراءة الحالية:** " + (usd ? `الدولار ${usd.v} (${fmtPct(usd.c)}).` : "الدولار غير متاح لحظيًا."));
  } else {
    lines.push("حدّد العامل الذي تريد تحليل تأثيره (الذهب، الفائدة، الدولار، النفط) لأعطيك قراءة سببية مبنية على الأرقام الحية.");
  }

  lines.push("", "⚠️ تحليل تعليمي مبني على بيانات حية — وليس توصية استثمارية.");
  return lines.join("\n");
}

/* ─── Public entry point ─── */

export async function localAiChat(messages: ChatMsg[]): Promise<string> {
  const userMsgs = messages.filter((m) => m.role === "user");
  const last = userMsgs[userMsgs.length - 1]?.content || "";
  /* Follow-up continuity: the local engine used to read ONLY the last user
   * message, so «طيب وإيه وضعها؟» lost its subject. When the last message
   * looks like a follow-up, merge the previous question so intent + entity
   * resolution still find the topic (JUFO، الذهب …). */
  const prev = userMsgs.length >= 2 ? userMsgs[userMsgs.length - 2].content : "";
  const isFollowUp = !!prev && (last.trim().length <= 18
    || /وضعها|وضعه|ده |دا |نفسه|نفسها|طيب|طب |كمان|عنها|عنه/.test(last));
  const subject = isFollowUp ? `${prev} ${last}`.trim() : last;
  try {
    const { live, intent } = await getLive(subject);
    switch (intent) {
      case "greeting": return greetingReply();
      case "article": return articleAnalysisReply(subject, live);
      case "market": return marketReply(live);
      case "stock": return stockReply(subject, live);
      case "advice": return adviceReply(live);
      case "news": return newsReply(live, subject);
      case "portfolio": return portfolioReply(subject, live);
      case "opportunities": return opportunitiesReply(live);
      case "impact": return impactReply(subject, live);
      default: return generalReply(live);
    }
  } catch (e) {
    logger.warn({ err: e }, "localAiChat failed");
    return "⚠️ حدث خطأ في تحليل البيانات — حاول مرة أخرى بعد لحظات.";
  }
}
