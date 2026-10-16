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
  markets?: Record<string, Array<{
    n: string; v: string; c: string; up: boolean; s?: string;
    source?: string; asOf?: number; delayedMinutes?: number;
  }>>;
  sources?: Record<string, string>;
};

type StocksPayload = {
  stocks?: Array<{
    sym: string; name: string; price: number; chgPct: number;
    pe?: number; mktCapM?: number; vol?: number; sector?: string;
    source?: string; ts?: number;
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
  /* طلب عناصر المتابعة يرد بلقطات وصفية موثّقة فقط. */
  if (tn.includes("فرص") || tn.includes("opportunit")) return "opportunities";
  /* سؤال عن علاقة/تأثير عامل سوقي: يرد ببيانات متاحة وحدودها، لا بتحليل سببي.
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

function hasVerifiedQuotes(markets: MarketsPayload | undefined): boolean {
  return Boolean(markets?.markets && Object.values(markets.markets).some((rows) => Array.isArray(rows) && rows.length > 0));
}

function greetingReply(): string {
  return [
    "أهلاً بك! أنا مساعد بيانات EgyTrend 🤖",
    "",
    "أصف فقط البيانات التي تصل من الخادم بمصدرها، وأوضح النقص أو التأخر.",
    "• عند غياب مصدر مرخّص سأقول «غير متاح» بدل تخمين رقم أو توصية.",
    "• لا أختار أصلًا للشراء أو البيع ولا أتوقع اتجاهًا أو عائدًا.",
    "",
    "اسألني مثلاً:",
    "«إيه حالة السوق النهاردة؟»",
    "«لخّص بيانات سهم COMI»",
    "«إيه البيانات المتاحة عن الذهب والدولار؟»",
  ].join("\n");
}

function marketReply(live: { markets?: MarketsPayload; news?: NewsPayload; stocks?: StocksPayload }): string {
  const markets = live.markets?.markets;
  if (!markets || !hasVerifiedQuotes(live.markets)) return fallbackReply(live, "بيانات الأسواق");
  const lines: string[] = ["📊 **لقطة بيانات الأسواق المتاحة**", ""];
  const groups: Array<[string, NonNullable<MarketsPayload["markets"]>[keyof MarketsPayload["markets"]]]> = [
    ["🇪🇬 السوق المصري", markets.eg || []],
    ["🌍 الأسواق العالمية", markets.gl || []],
    ["🥇 السلع", markets.cm || []],
    ["₿ الأصول الرقمية", markets.cr || []],
  ];
  for (const [label, quotes] of groups) {
    if (!quotes.length) continue;
    lines.push(`**${label}:**`);
    for (const quote of quotes.slice(0, 4)) {
      lines.push(`• ${quote.n}: ${quote.v} (${quote.c || "—"}) · المصدر: ${quote.source || "غير متاح"}`);
    }
    lines.push("");
  }
  lines.push("⚠️ هذه لقطة وصفية؛ لا تثبت سبب الحركة ولا تمثل توصية أو توقعًا.");
  return lines.join("\n");
}

/* Shown only when a dataset genuinely could not be loaded in time. It leads
 * with what we DO have instead of a bare «غير متاحة», which read like a
 * broken site to users. */
function fallbackReply(_live: Live, what: string): string {
  return [
    `📡 ${what} غير متاحة حاليًا من مصدر موثّق.`,
    "لن أعرض رقمًا بديلًا أو أستنتج نتيجة من بيانات ناقصة.",
    "افتح صفحة «مصادر بيانات الأسواق» لمعرفة حالة المصدر، ثم أعد المحاولة عند توافره.",
  ].join("\n");
}

function stockReply(
  question: string,
  live: { stocks?: StocksPayload; news?: NewsPayload },
): string {
  const stocks = live.stocks?.stocks;
  if (!stocks?.length) return fallbackReply(live, "بيانات الأسهم");
  const hits = resolveStockMentions(question, stocks);
  if (!hits.length) {
    const tickerLike = (question.match(/\b[A-Za-z]{3,12}\b/g) || [])
      .filter((ticker) => /^[A-Z]+$/.test(ticker) && !/^(USD|EGP|EGX|AI|ETF|IPO|PE|NEWS|OK|VIP)$/.test(ticker));
    return tickerLike.length
      ? `📊 لم أجد سهمًا بالرمز «${tickerLike[0]}» في القائمة المتاحة حاليًا. تحقّق من الرمز أو اكتب اسم الشركة.`
      : "📊 اذكر رمز السهم أو اسمه لعرض الحقول والمصدر المتاحين، من دون تقييم أو توصية.";
  }
  const lines: string[] = [];
  for (const stock of hits) {
    const change = Number.isFinite(stock.chgPct)
      ? `${stock.chgPct! >= 0 ? "+" : ""}${stock.chgPct!.toFixed(2)}%`
      : "غير متاح";
    lines.push(`📊 **بيانات ${stock.sym} — ${stock.name}**`, "");
    lines.push(`• السعر المعروض: ${stock.price.toFixed(2)} ج`);
    lines.push(`• التغير المسجل: ${change}`);
    lines.push(`• المصدر: ${stock.source || "غير متاح"}`);
    if (typeof stock.pe === "number" && Number.isFinite(stock.pe)) lines.push(`• P/E المرسل من المصدر: ${stock.pe.toFixed(1)}`);
    if (typeof stock.mktCapM === "number" && Number.isFinite(stock.mktCapM)) lines.push(`• القيمة السوقية المرسلة: ${stock.mktCapM.toLocaleString("ar-EG")} مليون ج`);
    if (typeof stock.vol === "number" && Number.isFinite(stock.vol)) lines.push(`• حجم التداول المرسل: ${stock.vol.toLocaleString("ar-EG")}`);
    lines.push("• لا تثبت هذه الحقول سبب الحركة أو ملاءمة السهم لقرار شخصي.", "");
  }
  lines.push("⚠️ هذا ملخص وصفي للبيانات المتاحة، وليس توصية شراء أو بيع أو احتفاظ.");
  return lines.join("\n");
}

function adviceReply(live: { markets?: MarketsPayload; stocks?: StocksPayload }): string {
  const markets = live.markets?.markets;
  const lines = [
    "🧭 لا أقدّم اختيارًا شخصيًا للشراء أو البيع أو توزيعًا للمحفظة.",
    "يمكنني بدلًا من ذلك وصف الأسعار والحقول المتاحة ومصادرها، أو شرح مصطلح مالي بصورة عامة.",
  ];
  const sample = [
    ...(markets?.eg || []),
    ...(markets?.cm || []),
  ].slice(0, 3);
  if (sample.length) {
    lines.push("", "**أمثلة من البيانات المتاحة:**");
    for (const quote of sample) lines.push(`• ${quote.n}: ${quote.v} (${quote.c || "—"}) · المصدر: ${quote.source || "غير متاح"}`);
  } else if (!live.stocks?.stocks?.length) {
    lines.push("", "ولا توجد الآن بيانات موثّقة كافية لعرضها.");
  }
  lines.push("", "⚠️ راجع المصدر الأصلي ومختصًا مرخصًا إذا كنت تحتاج نصيحة ملائمة لظروفك.");
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
      lines.push("", `🔎 بحث في عناوين ${feeds.length} مصدرًا متاحًا ومعتمدًا.`);
      return lines.join("\n");
    }
    /* No match → say it honestly instead of dumping unrelated headlines. */
    const lines = [
      `⚠️ **لا توجد أخبار منشورة حاليًا عن ${label}** في آخر العناوين من ${feeds.length} مصدرًا متاحًا.`, 
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
  lines.push("لتحليل محفظتك بالتفصيل: أضف أسهمك من تبويب «حسابي ← محفظتي» مع سعر الشراء وعدد الأسهم. لن يُحسب الأداء إلا عند توافر أسعار موثّقة من المصدر.");
  return lines.join("\n");
}

function generalReply(live: { markets?: MarketsPayload }): string {
  return [
    "🤖 يمكنني مساعدتك في:",
    "",
    "• **حالة السوق:** اسأل «إيه حالة السوق؟»",
    "• **تحليل سهم:** اذكر الرمز مثل «حلّل COMI»",
    "• **قراءة تعليمية:** اسأل عن عوامل الذهب أو الدولار بدل طلب توصية شخصية.",
    "• **آخر الأخبار:** اسأل «أهم الأخبار النهاردة»",
    "",
    "لن أذكر رقمًا أو أقدّم إشارة تداول إذا لم تكن بيانات المصدر الموثّقة متاحة.",
    hasVerifiedQuotes(live.markets)
      ? `\n📊 من المصدر المتاح: EGX30 ${live.markets?.markets?.eg?.[0]?.v || "—"} (${fmtPct(live.markets?.markets?.eg?.[0]?.c || "")})`
      : "", 
  ].join("\n");
}

/* ─── Article analysis (news reader «حلّل الآن») ───────────────────────
 * The local fallback is deliberately a source-bound explainer. It must not
 * infer affected securities, causality, rankings, or a future price path from
 * a headline and a short licensed snippet. */
function articleAnalysisReply(question: string, live: Live): string {
  const grab = (re: RegExp) => (question.match(re) || [])[1]?.trim() || "";
  const title = grab(/العنوان:\s*(.+)/);
  const src = grab(/المصدر:\s*(.+)/);
  const summary = grab(/الخلاصة:\s*([\s\S]*?)(?:\n\s*\n|\nالمطلوب|$)/);
  const lines: string[] = ["📰 **شرح الخبر**"];
  if (title) lines.push(`**${title}**`);
  if (src) lines.push(`🔎 المصدر: ${src}`);
  if (summary) lines.push("", "1️⃣ **الخلاصة الواردة**", summary.slice(0, 420));
  else lines.push("", "1️⃣ **الخلاصة الواردة**", "لا تتوفر خلاصة كافية في المدخل.");

  lines.push("", "2️⃣ **ما يذكره النص**");
  lines.push("• يقتصر هذا الشرح على العنوان والخلاصة أعلاه؛ لا يضيف شركات أو أصولًا أو وقائع غير مذكورة.");

  const markets = live.markets?.markets;
  if (hasVerifiedQuotes(live.markets) && markets) {
    lines.push("", "3️⃣ **لقطة سوق منفصلة عن الخبر**");
    for (const quote of (markets.eg || []).slice(0, 3)) {
      lines.push(`• ${quote.n}: ${quote.v} (${quote.c || "—"}) · المصدر: ${quote.source || "غير متاح"}`);
    }
    lines.push("• هذه الأرقام تعرض لقطة مستقلة ولا تثبت أن الخبر سبب أي حركة.");
  } else {
    lines.push("", "3️⃣ **لقطة السوق**", "• لا توجد أسعار موثّقة متاحة لعرضها بجانب الخبر.");
  }

  lines.push("", "4️⃣ **حدود الشرح**");
  lines.push("• العنوان والملخص لا يثبتان سبب حركة سعر أو أثرًا ماليًا أو اتجاهًا مستقبليًا.");
  lines.push("• راجع المصدر الأصلي والإفصاحات الرسمية للحصول على التفاصيل والسياق الكامل.");
  lines.push("", "⚠️ هذا شرح معلوماتي للنص، وليس توصية شراء أو بيع أو تقييمًا استثماريًا.");
  return lines.join("\n");
}

/* ─── عناصر متابعة وصفية ───────────────────────────────────────────── */
function opportunitiesReply(live: Live): string {
  const stocks = live.stocks?.stocks || [];
  if (!stocks.length) return fallbackReply(live, "عناصر متابعة السوق");
  let cards: ReturnType<typeof buildLocalOpportunities> = [];
  try {
    cards = buildLocalOpportunities(
      live.markets as unknown,
      stocks as Parameters<typeof buildLocalOpportunities>[1],
      [],
      new Date().toLocaleDateString("ar-EG"),
    );
  } catch (error) {
    logger.warn({ err: error }, "market observation reply build failed");
  }
  if (!cards.length) {
    return [
      "💡 لا توجد لقطات وصفية يمكن التحقق منها حاليًا.",
      "يلزم مصدر مرخّص ووقت مصدر صالح لكل بطاقة؛ لن ننشئ بديلًا أو توصية عند غياب ذلك.",
      "",
      "جرّب: «إيه حالة السوق؟» أو «إيه البيانات المتاحة عن الذهب؟»",
    ].join("\n");
  }
  const lines = ["💡 **لقطات وصفية من بيانات المصدر المتاحة**", ""];
  for (const card of cards.slice(0, 5)) {
    lines.push(`• **${card.title}**`);
    lines.push(`  ${card.summary}`);
    lines.push(`  المصدر: ${card.source} · وقت المصدر: ${new Intl.DateTimeFormat("ar-EG", { timeZone: "Africa/Cairo", dateStyle: "medium", timeStyle: "short" }).format(new Date(card.sourceAsOf))}`);
    lines.push("");
  }
  lines.push("⚠️ هذه لقطات وصفية، وليست ترتيبًا استثماريًا أو توصية أو توقع عائد.");
  return lines.join("\n");
}

/* ─── سؤال عن عامل سوقي: وصف البيانات لا السببية ─────────────────── */
function impactReply(question: string, live: Live): string {
  const markets = live.markets?.markets;
  if (!markets || !hasVerifiedQuotes(live.markets)) return fallbackReply(live, "بيانات الأسواق");
  const q = normAr(question);
  const rows = [
    ...(markets.eg || []),
    ...(markets.cm || []),
    ...(markets.gl || []),
    ...(markets.cr || []),
  ];
  const matching = rows.filter((row) => {
    const name = normAr(`${row.n || ""} ${row.s || ""}`);
    return (/(ذهب|gold)/.test(q) && /(ذهب|gold)/.test(name))
      || (/(دولار|dollar|usd)/.test(q) && /(دولار|usd)/.test(name))
      || (/(نفط|بترول|oil|برنت)/.test(q) && /(نفط|برنت|oil)/.test(name))
      || (/(بيتكوين|bitcoin|btc|كريبتو)/.test(q) && /(btc|بيتكوين|كريبتو)/.test(name));
  });
  const lines = ["🧭 **بيانات مرتبطة بالسؤال**", ""];
  const shown = matching.length ? matching : rows.slice(0, 5);
  for (const row of shown.slice(0, 5)) {
    lines.push(`• ${row.n}: ${row.v} (${row.c || "—"}) · المصدر: ${row.source || "غير متاح"}`);
  }
  lines.push("", "**ما الذي لا تثبته هذه اللقطة؟**");
  lines.push("• لا تثبت سبب الحركة أو علاقة سببية بين عامل اقتصادي وسعر أصل.");
  lines.push("• لا تكفي لاتخاذ قرار شخصي أو توقع اتجاه مستقبلي.");
  lines.push("• راجع المصدر الأصلي والبيانات الأوسع إذا احتجت سياقًا إضافيًا.");
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
