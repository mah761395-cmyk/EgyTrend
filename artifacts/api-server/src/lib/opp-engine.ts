/*
 * Source-backed market observations used by the legacy “opportunities” surface.
 *
 * This module intentionally does not rank investments, estimate returns, choose
 * allocations, or emit buy/sell language. It turns only verified snapshot
 * fields into bounded, descriptive cards. A missing source or source timestamp
 * produces no card.
 */
export type OppCandidate = {
  title: string;
  summary: string;
  details: string;
  type: string;
  market: string;
  /** Kept optional for backward-compatible DB callers; auto cards never set it. */
  expectedReturn?: string;
  /** Legacy schema requires 1–5. Auto cards use 3 but the UI must not label it as a risk assessment. */
  riskLevel: number;
  sector: string;
  duration?: string;
  featured: false;
  vipOnly: false;
  /** Licensed origin for the observed fields; not a generic "live" marker. */
  source: string;
  /** Provider timestamp in epoch milliseconds; never a server fetch time. */
  sourceAsOf: number;
};

type Stock = {
  sym: string;
  name: string;
  sector?: string;
  price: number;
  chgPct?: number;
  source?: string;
  ts?: number;
};

type MarketRow = {
  n?: string;
  v?: string;
  c?: string;
  source?: string;
  asOf?: number;
  delayedMinutes?: number;
};

function verifiedSource(value: unknown): string | null {
  const source = typeof value === "string" ? value.trim() : "";
  return source && source !== "غير متاح" ? source.slice(0, 160) : null;
}

function sourceTimestamp(value: unknown): number | null {
  const timestamp = typeof value === "number" ? value : Number(value);
  // A plausible UTC epoch avoids rebranding 0, a parse error, or a server
  // cache time as a provider-origin timestamp.
  if (!Number.isFinite(timestamp) || timestamp < Date.UTC(2000, 0, 1) || timestamp > 8.64e15) return null;
  return Math.round(timestamp);
}

function finite(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function numberText(value: number, digits = 2): string {
  return new Intl.NumberFormat("ar-EG", {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(value);
}

function quoteTime(timestamp: number): string {
  return new Intl.DateTimeFormat("ar-EG", {
    timeZone: "Africa/Cairo",
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(timestamp));
}

function observation(options: {
  title: string;
  summary: string;
  detail: string;
  type: string;
  market: string;
  sector: string;
  source: string;
  sourceAsOf: number;
}): OppCandidate {
  const sourceTime = new Date(options.sourceAsOf).toISOString();
  return {
    title: options.title.slice(0, 300),
    summary: options.summary.slice(0, 1500),
    // Stable provenance lines preserve source transparency for cards that are
    // persisted through the legacy schema (which has no source columns).
    details: [
      `المصدر: ${options.source}`,
      `وقت المصدر (UTC): ${sourceTime}`,
      options.detail,
      "لا تمثل البطاقة توصية أو توقعًا. راجع المصدر وحالة التأخر قبل أي قرار شخصي.",
    ].join("\n").slice(0, 8000),
    type: options.type,
    market: options.market,
    riskLevel: 3,
    // Persistence routes add the [AUTO] provenance marker when they write;
    // keeping this candidate plain avoids a duplicated marker.
    sector: options.sector.slice(0, 100),
    featured: false,
    vipOnly: false,
    source: options.source,
    sourceAsOf: options.sourceAsOf,
  };
}

/**
 * Creates descriptive cards from already-licensed, in-process snapshots.
 * It performs no network or database work and does not make a card when the
 * source/quote required for that card is absent. Input order is preserved;
 * this is a display list, not a recommendation or investment ranking.
 */
export function buildLocalOpportunities(
  markets: unknown,
  stocks: Stock[],
  _newsTitles: string[],
  today: string,
): OppCandidate[] {
  const output: OppCandidate[] = [];

  for (const stock of stocks) {
    if (output.filter((card) => card.type === "stock").length >= 3) break;
    const source = verifiedSource(stock.source);
    const asOf = sourceTimestamp(stock.ts);
    const price = finite(stock.price);
    const change = finite(stock.chgPct);
    if (!source || asOf === null || price === null || price <= 0 || change === null) continue;
    const direction = change >= 0 ? "ارتفاع" : "انخفاض";
    output.push(observation({
      title: `ملاحظة سوق: ${String(stock.name || stock.sym).slice(0, 180)} (${String(stock.sym).slice(0, 30)})`,
      summary: `السعر المعروض ${numberText(price)}، والتغير المسجل ${change >= 0 ? "+" : ""}${numberText(change)}٪ وفق ${source}.`,
      detail: `هذه بطاقة وصفية آلية بتاريخ ${today}: سُجّل ${direction} قدره ${change >= 0 ? "+" : ""}${numberText(change)}٪ في اللقطة المتاحة (${quoteTime(asOf)}). لا تفسر البطاقة سبب الحركة.`,
      type: "stock",
      market: "egypt",
      sector: stock.sector || "أسهم",
      source,
      sourceAsOf: asOf,
    }));
  }

  const root = markets && typeof markets === "object"
    ? markets as { markets?: Record<string, unknown> }
    : {};
  const marketGroups: Array<{ key: string; market: string; type: string; sector: string }> = [
    { key: "cm", market: "global", type: "commodity", sector: "سلع" },
    { key: "cr", market: "crypto", type: "crypto", sector: "أصول رقمية" },
    { key: "gl", market: "us", type: "etf", sector: "مؤشرات عالمية" },
  ];
  for (const group of marketGroups) {
    const rows = Array.isArray(root.markets?.[group.key])
      ? root.markets![group.key] as MarketRow[]
      : [];
    const row = rows.find((item) => verifiedSource(item?.source)
      && sourceTimestamp(item?.asOf) !== null && String(item?.v || "").trim());
    if (!row) continue;
    const source = verifiedSource(row.source);
    const asOf = sourceTimestamp(row.asOf);
    if (!source || asOf === null) continue;
    const delay = typeof row.delayedMinutes === "number" && row.delayedMinutes > 0
      ? ` · مؤجل ${Math.round(row.delayedMinutes)} د`
      : "";
    output.push(observation({
      title: `ملاحظة سوق: ${String(row.n || "أصل").slice(0, 100)}`,
      summary: `القيمة المعروضة ${String(row.v || "").slice(0, 80)} والتغير المسجل ${String(row.c || "—").slice(0, 40)} وفق ${source}.`,
      detail: `لقطة وصفية آلية بتاريخ ${today} تعرض رقمًا وتغيرًا كما وردا من المصدر (${quoteTime(asOf)})${delay}.`,
      type: group.type,
      market: group.market,
      sector: group.sector,
      source,
      sourceAsOf: asOf,
    }));
  }

  return output;
}
