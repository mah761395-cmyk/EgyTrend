/* ─── EgyTrend Local AI Analyst ────────────────────────────────────────
 * Rule-based Arabic financial analyst that runs fully local when no
 * Anthropic key is configured. It answers from REAL live data (its own
 * /api/markets, /api/markets/stocks, /api/news endpoints) so VIP users
 * get useful analysis without any external API key. When ANTHROPIC_API_KEY
 * is present, ai.ts uses Claude instead and this engine stays idle.
 * ──────────────────────────────────────────────────────────────────── */

import { logger } from "./logger";

type ChatMsg = { role: "user" | "assistant"; content: string };

/* ─── Live data fetch (internal endpoints, short cache) ─── */

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

/* Per-dataset caches: a slow/failed fetch of one dataset (news can take >8s
 * on a cold cache with 23 feeds) must not blank out the others, and a failed
 * dataset must be retried on the next request instead of staying missing for
 * a whole TTL window. */
const MARKETS_TTL_MS = 60_000;
const NEWS_TTL_MS = 180_000;
const NEWS_TIMEOUT_MS = 25_000;
let marketsCache: { ts: number; data?: MarketsPayload } = { ts: 0 };
let stocksCache: { ts: number; data?: StocksPayload } = { ts: 0 };
let newsCache: { ts: number; data?: NewsPayload } = { ts: 0 };

async function getJson<T>(url: string, timeoutMs = 8000): Promise<T | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

async function getLiveData(): Promise<{ markets?: MarketsPayload; stocks?: StocksPayload; news?: NewsPayload }> {
  const base = `http://localhost:${process.env.PORT || "8080"}/api`;
  const now = Date.now();
  const jobs: Array<Promise<void>> = [];

  if (now - marketsCache.ts >= MARKETS_TTL_MS || !marketsCache.data) {
    jobs.push(getJson<MarketsPayload>(`${base}/markets`).then((d) => {
      if (d) marketsCache = { ts: Date.now(), data: d };
    }));
  }
  if (now - stocksCache.ts >= MARKETS_TTL_MS || !stocksCache.data) {
    jobs.push(getJson<StocksPayload>(`${base}/markets/stocks`).then((d) => {
      if (d) stocksCache = { ts: Date.now(), data: d };
    }));
  }
  if (now - newsCache.ts >= NEWS_TTL_MS || !newsCache.data) {
    jobs.push(getJson<NewsPayload>(`${base}/news`, NEWS_TIMEOUT_MS).then((d) => {
      if (d) newsCache = { ts: Date.now(), data: d };
    }));
  }
  if (jobs.length) await Promise.all(jobs.map((p) => p.catch(() => {})));

  return {
    markets: marketsCache.data,
    stocks: stocksCache.data,
    news: newsCache.data,
  };
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

type Intent = "greeting" | "market" | "stock" | "advice" | "news" | "portfolio" | "general";

function detectIntent(text: string, stocks?: NonNullable<StocksPayload["stocks"]>): Intent {
  const t = text.toLowerCase();
  if (/^(مرحبا|السلام|اهلا|أهلا|هاي|hello|hi|ازيك|إزيك)/.test(t.trim())) return "greeting";
  if (/(محفظتي|محفظت|portfolio)/.test(t)) return "portfolio";
  const wantsAdvice = /(اشتري|أشتري|ابيع|أبيع|هل اشتري|نصيحة|تنصحني|توصية|ادخال|دخول)/.test(t);
  /* An explicit ticker mention (e.g. "COMI") means the user wants that
   * stock analyzed — this beats generic market keywords that can appear
   * inside a long analysis prompt's embedded context. */
  const tu = text.toUpperCase();
  const symMentioned = !!stocks?.some((s) => s.sym && tu.includes(s.sym));
  if (wantsAdvice) return "advice";
  if (symMentioned) return "stock";
  if (/(اخبار|أخبار|news|شريد|جرجت)/.test(t)) return "news";
  if (/(السوق|المؤشر|دولار|ذهب|بيتكوين|btc|egx|اسواق|أسواق|عملة|فائدة|حالة السوق)/.test(t)) return "market";
  if (/(سهم|اسهم|أسهم|بورصة|شركة|comi|abuk|tmgh|hrni|adib|orwe)/.test(t)) return "stock";
  return "general";
}

/* Any string that contains a ticker mention anywhere (used for both intent
 * detection and symbol extraction — scans the WHOLE prompt including any
 * embedded market context, so an analysis request naming "COMI" resolves
 * to COMI even if market news appear in the same text). */
function extractSymbols(text: string, stocks: NonNullable<StocksPayload["stocks"]>): Array<NonNullable<StocksPayload["stocks"]>[number]> {
  const tu = text.toUpperCase();
  const hits = stocks.filter(
    (s) => s.sym && tu.includes(s.sym) || (s.name && text.includes(s.name.split(" ")[0])),
  );
  return hits.slice(0, 4);
}

/* ─── Response builders (all grounded in live data) ─── */

function greetingReply(): string {
  return [
    "أهلاً بك! أنا محرر EgyTrend الذكي 🤖",
    "",
    "أعمل الآن بالوضع المحلي وأحلل بيانات السوق الحقيقية المحدّثة:",
    "• مؤشر EGX30 وأسهم البورصة المصرية",
    "• الدولار والعملات والذهب والنفط",
    "• الكريبتو وأهم 178 خبراً يومياً",
    "",
    "اسألني مثلاً:",
    "«إيه حالة السوق النهاردة؟»",
    "«حلّل سهم COMI»",
    "«هل أشتري ذهب ولا دولار؟»",
  ].join("\n");
}

function marketReply(live: { markets?: MarketsPayload; news?: NewsPayload }): string {
  const m = live.markets?.markets;
  if (!m) return "⚠️ بيانات السوق غير متاحة حالياً — حاول بعد دقيقة.";
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

function stockReply(
  question: string,
  live: { stocks?: StocksPayload; news?: NewsPayload },
): string {
  const stocks = live.stocks?.stocks;
  if (!stocks || !stocks.length) return "⚠️ بيانات الأسهم غير متاحة حالياً — حاول بعد دقيقة.";
  const hits = extractSymbols(question, stocks);
  if (!hits.length) {
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

function newsReply(live: { news?: NewsPayload }): string {
  const feeds = live.news?.feeds;
  if (!feeds || !feeds.length) return "⚠️ الأخبار غير متاحة حالياً — حاول بعد دقيقة.";
  const lines: string[] = ["📰 **أهم الأخبار الآن:**", ""];
  let count = 0;
  for (const f of feeds) {
    for (const it of f.items || []) {
      if (count >= 8) break;
      lines.push(`• ${it.title.slice(0, 100)} — ${f.meta?.name || ""}`);
      count++;
    }
    if (count >= 8) break;
  }
  return lines.join("\n");
}

function portfolioReply(question: string, live: { stocks?: StocksPayload }): string {
  const stocks = live.stocks?.stocks;
  // Try to parse lines like "COMI 100 55.5" or symbols mentioned
  const mentioned = stocks ? extractSymbols(question, stocks) : [];
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

/* ─── Public entry point ─── */

export async function localAiChat(messages: ChatMsg[]): Promise<string> {
  const last = [...messages].reverse().find((m) => m.role === "user");
  const question = last?.content || "";
  try {
    const live = await getLiveData();
    switch (detectIntent(question, live.stocks?.stocks)) {
      case "greeting": return greetingReply();
      case "market": return marketReply(live);
      case "stock": return stockReply(question, live);
      case "advice": return adviceReply(live);
      case "news": return newsReply(live);
      case "portfolio": return portfolioReply(question, live);
      default: return generalReply(live);
    }
  } catch (e) {
    logger.warn({ err: e }, "localAiChat failed");
    return "⚠️ حدث خطأ في تحليل البيانات — حاول مرة أخرى بعد لحظات.";
  }
}
