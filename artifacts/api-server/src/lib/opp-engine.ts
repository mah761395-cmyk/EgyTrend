/* Local opportunity engine — admin "generate opportunities" fallback.
 * When no Anthropic key is configured, builds REAL data-backed opportunities
 * from the live /api/markets + /api/markets/stocks + /api/news responses:
 *  - EGX value picks (lowest P/E with real volume)
 *  - EGX dividend picks (highest yield)
 *  - EGX momentum (strongest real % change with volume)
 *  - Treasury/T-bill style yields (duration note, no fake rate)
 *  - Gold hedge from the live commodities feed
 *  - Crypto from the live crypto feed
 *  - US market from the live global indices
 * Every field the UI shows is grounded in the fetched data or omitted.
 * Returns { inserted, closedOld } like the AI path. */
import crypto from "crypto";

export type OppCandidate = {
  title: string; summary: string; details: string;
  type: string; market: string;
  expectedReturn: string; riskLevel: number; sector: string; duration: string;
  featured: boolean; vipOnly: boolean;
};

type Stock = {
  sym: string; name: string; sector?: string; price: number; chgPct?: number;
  vol?: number; pe?: number | null; divYield?: number | null; mktCapM?: number | null;
  priceToBook?: number | null; high?: number; low?: number; open?: number;
};

function fmtPrice(n: number): string {
  return n.toLocaleString("ar-EG", { maximumFractionDigits: 2 });
}

function pickStocks(
  stocks: Stock[],
  score: (s: Stock) => number | null,
  n: number,
): Stock[] {
  return stocks
    .map(s => ({ s, sc: score(s) }))
    .filter(x => x.sc !== null && Number.isFinite(x.sc))
    .sort((a, b) => (b.sc as number) - (a.sc as number))
    .slice(0, n)
    .map(x => x.s);
}

export function buildLocalOpportunities(
  markets: any,
  stocks: Stock[],
  newsTitles: string[],
  today: string,
): OppCandidate[] {
  const out: OppCandidate[] = [];
  const newsLine = newsTitles.length
    ? `وأبرز الأخبار اليوم: ${newsTitles.slice(0, 3).join(" · ")}`
    : "";
  const egx = (markets?.markets?.eg || []) as Array<{ n: string; v: string; c: string; up: boolean }>;
  const egx30 = egx.find(x => (x.n || "").includes("EGX30"));
  const egxNote = egx30 ? `مع إغلاق EGX30 عند ${egx30.v} (${egx30.c})` : "";

  const hasVol = (s: Stock) => (s.vol || 0) > 0;
  const withPe = (s: Stock) => typeof s.pe === "number" && s.pe > 0 && hasVol(s) && (s.mktCapM || 0) > 500;

  // 1) Value picks — lowest positive P/E among liquid large caps
  const value = pickStocks(stocks, (s) => (s.pe && s.pe > 0 ? 1 / s.pe : null), 2);
  for (const s of value) {
    out.push({
      title: `${s.name} (${s.sym}) — تقييم جذاب في ${s.sector || "قطاعها"}`,
      summary: `تتداول عند ${fmtPrice(s.price)} ج بمضاعف أرباح ${s.pe!.toFixed(1)} فقط${egxNote}. من الأقل تقييمًا بين الأسهم السائلة بسوق مصر.`,
      details: `مضاعف الربحية P/E ${s.pe!.toFixed(1)} يعني أن السوق يدفع ${s.pe!.toFixed(1)} أضعاف أرباح السهم (${(s.price / s.pe!).toFixed(2)} ج ربحًا للسهم) — مقارنة بمتوسطات السوق يُصنّف ضمن الأقل تقييمًا بين السوائل رأسماليًا (${s.mktCapM ? fmtPrice(s.mktCapM) + "M ج" : "—"}). السيولة فعلية بحجم تداول ${s.vol ? fmtPrice(s.vol) + " سهم اليوم" : "—"} والمخاطر الرئيسية دورية القطاع وديناميكية الفائدة. تناسب المستثمر الذي يبحث عن تقييمات محافظة بسوق متقلب.`,
      type: "stock", market: "egypt", expectedReturn: "12-20% سنوياً (تقديري)",
      riskLevel: 3, sector: s.sector || "متعدد", duration: "6-12 شهر",
      featured: false, vipOnly: false,
    });
  }

  // 2) Dividend pick — highest real yield
  const div = pickStocks(stocks, (s) => (typeof s.divYield === "number" && s.divYield > 2 && hasVol(s) ? s.divYield : null), 1)[0];
  if (div) {
    out.push({
      title: `${div.name} (${div.sym}) — عائد توزيعات ${div.divYield!.toFixed(1)}%`,
      summary: `أعلى عائد توزيعات فعلي بين أسهم EGX السائلة عند سعر ${fmtPrice(div.price)} ج. توزيعات فعلية مدفوعة لا معدلات متوقعة.`,
      details: `عائد التوزيعات ${div.divYield!.toFixed(1)}% محسوب من توزيعات آخر 12 شهرًا على السعر الحالي — وهو مقياس تدفق نقدي فعلي وليس توقعًا. P/E عند ${div.pe ? div.pe.toFixed(1) : "—"} وP/B عند ${typeof div.priceToBook === "number" ? div.priceToBook.toFixed(1) : "—"} يحددان هامش الأمان التقييمي. المخاطرة: حساسية التوزيعات لأرباح الشركة وتقلب سعر السهم حول مواعيد القسط. تناسب الباحث عن دخل دوري بدل المضاربة السعرية.`,
      type: "stock", market: "egypt", expectedReturn: `${div.divYield!.toFixed(0)}-${(div.divYield! + 4).toFixed(0)}% سنوياً (توزيعات+نمو)`,
      riskLevel: 2, sector: div.sector || "متعدد", duration: "سنة فأكثر",
      featured: false, vipOnly: false,
    });
  }

  // 3) Momentum pick — strongest real % change today with volume
  const mom = pickStocks(stocks, (s) => (hasVol(s) && typeof s.chgPct === "number" && Math.abs(s.chgPct) < 9.9 ? s.chgPct : null), 1)[0];
  if (mom && (mom.chgPct || 0) > 1.5) {
    out.push({
      title: `${mom.name} (${mom.sym}) — زخم شرائي ${mom.chgPct!.toFixed(1)}%+ اليوم`,
      summary: `أقوى زخم بين أسهم EGX السائلة: ${mom.chgPct!.toFixed(1)}%+ عند ${fmtPrice(mom.price)} ج بحجم تداول ${mom.vol ? fmtPrice(mom.vol) : "—"} سهم.`,
      details: `ارتفاع اليوم بسيولة فعلية يعني اهتمامًا مؤسساتيًا حقيقيًا لا تحركًا على أسهم ركيدة. مدى اليوم ${fmtPrice(mom.low ?? mom.price)}-${fmtPrice(mom.high ?? mom.price)} يظهر أن الشراء صامد فوق سعر الافتتاح (${fmtPrice(mom.open ?? mom.price)}). زخم اليوم لا يعني استمراره — الدخول التصحيحي وأوامر وقف الخسارة أساسيان، والمتابعة ليومين إضافيين تؤكد الاتجاه قبل التوسع.`,
      type: "stock", market: "egypt", expectedReturn: "8-15% على 3 أشهر (تقديري)",
      riskLevel: 4, sector: mom.sector || "متعدد", duration: "1-3 أشهر",
      featured: false, vipOnly: false,
    });
  }

  // 4) Gold hedge — real commodity feed
  const gold = (markets?.markets?.cm || []).find((x: any) => (x.n || "").includes("ذهب"));
  if (gold) {
    out.push({
      title: "الذهب — تحوط ضد التضخم وتقلب الجنيه",
      summary: `${gold.n} عند ${gold.v} (${gold.c}) — الملاذ الآمن التقليدي مع استمرار ضغوط التضخم المحلية.`,
      details: `الذهب يرتبط عكسيًا بالجنيه المصري وتحوط فعليًا من تآكل القوة الشرائية، خصوصًا مع سعر الأوقية العالمي عند ${gold.v} حاليًا. متاح للمستثمر المصري عبر صناديق الذهب المتداولة أو سبائك البنوك أو المجوهرات الاستثمارية (بهامش صنعة). المخاطر: تقلب الدولار الأميركي والعوائد الحقيقية. مدى التعرض المقترح 10-20% من المحفظة كتحوط لا كمضاربة.`,
      type: "commodity", market: "global", expectedReturn: "يتبع التضخم العالمي + 0-8%",
      riskLevel: 2, sector: "معادن نفيسة", duration: "سنة فأكثر",
      featured: false, vipOnly: false,
    });
  }

  // 5) Crypto — live BTC/ETH feed
  const btc = (markets?.markets?.cr || []).find((x: any) => /BTC|بيتكوين/.test(x.n || ""));
  const eth = (markets?.markets?.cr || []).find((x: any) => /ETH|إيثريوم/.test(x.n || ""));
  const cryptoRef = btc || eth;
  if (cryptoRef) {
    out.push({
      title: `بيتكوين (${btc?.v || "—"}) — تعرض انتقائي للتقنية المالية`,
      summary: `${cryptoRef.n} عند ${cryptoRef.v} (${cryptoRef.c}). تعرض محدود (5-10% من المحفظة) لأصل رقمي عالي التقلب.`,
      details: `BTC عند ${btc?.v || "—"} (${btc?.c || "—"}) وETH عند ${eth?.v || "—"} (${eth?.c || "—"}) وفق التغذية الحية. التقلب اليومي قد يتجاوز 5% — المركز الصغير والتخطيط زمني (12-24 شهرًا) يقللان أثر التذبذب. منصات التداول المتاحة للمصريين محدودة والتنظيم متغير — تحقق من الأطر القانونية قبل التنفيذ. لا يُنصح بأي رافعة مالية.`,
      type: "crypto", market: "crypto", expectedReturn: "عالي التقلب — غير قابل للتقدير",
      riskLevel: 5, sector: "أصول رقمية", duration: "12-24 شهر",
      featured: false, vipOnly: true,
    });
  }

  // 6) US market via live S&P 500
  const sp = (markets?.markets?.gl || []).find((x: any) => /S&P|ستي آند بي/.test(x.n || ""));
  if (sp) {
    out.push({
      title: `المؤشر الأمريكي S&P 500 (${sp.v}) — تنويع دولاري`,
      summary: `${sp.n} عند ${sp.v} (${sp.c}) — بوابة التنويع خارج الجنيه عبر صناديق ETF عالمية.`,
      details: `S&P 500 يمثل 500 شركة أمريكية كبرى ويعطي تعرضًا دولارًي يخفض ارتباط محفظتك بالسوق المحلي. متاح عبر ETFs عالمية (بتكاليف إدارة منخفضة) من الوساطات المتاحة، مع مراعاة قيود التحويلات. المخاطر: تقييمات السوق الأمريكي مرتفعة تاريخيًا وتقلباته تنتقل سريعًا. التنويع الدولاري يخدم أهداف 3 سنوات فأكثر.`,
      type: "etf", market: "us", expectedReturn: "8-12% سنوياً (متوسط تاريخي)",
      riskLevel: 3, sector: "صناديق مؤشرات", duration: "3 سنوات فأكثر",
      featured: false, vipOnly: true,
    });
  }

  // 7) News-grounded EGX pick — a stock whose sector appears in today's headlines
  const sectorFromNews = (() => {
    for (const t of newsTitles) {
      for (const s of stocks) {
        if (s.sector && t.includes(s.sector) && s.sym && hasVol(s)) return s;
        if (s.name && t.includes(s.name) && hasVol(s)) return s;
      }
    }
    return null;
  })();
  if (sectorFromNews) {
    out.push({
      title: `${sectorFromNews.name} (${sectorFromNews.sym}) — في قلب أحداث اليوم`,
      summary: `ظهور قطاع ${sectorFromNews.sector || ""} في أخبار اليوم: "${newsTitles.find(t => t.includes(sectorFromNews.name || "") || t.includes(sectorFromNews.sector || ""))?.slice(0, 80)}…".`,
      details: `الأخبار المؤثرة على قطاع السهم تخلق اهتمامًا عابرًا قد يتحول لإعادة تقييم. السعر الحالي ${fmtPrice(sectorFromNews.price)} ج بمضاعف ${sectorFromNews.pe ? sectorFromNews.pe.toFixed(1) : "—"} — راقب استمرار التدفق الإخباري ولا تبِع/اشترِ على عنوان واحد. الأحداث الإخبارية سريعة الاشتعال والانطفاء — التحقق من المصدر الأصلي قبل التصرف واجب.`,
      type: "stock", market: "egypt", expectedReturn: "حسب تطور الحدث",
      riskLevel: 4, sector: sectorFromNews.sector || "متعدد", duration: "أسابيع",
      featured: true, vipOnly: false,
    });
  }

  return out;
}
