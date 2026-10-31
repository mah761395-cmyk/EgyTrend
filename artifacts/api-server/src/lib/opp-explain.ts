/**
 * Opportunity detail explanation.
 *
 * This module turns ONE stored opportunity row (plus its stored signal
 * payload and the optional live status the list already computes) into the
 * organized sections of the detail page. Honesty rules, enforced here so no
 * renderer can bypass them:
 *
 *  - every number in the output is copied verbatim from the stored row or
 *    its stored signal payload — no market access, no computation of new
 *    prices, targets, stops or indicator values;
 *  - a section with no stored data is flagged `present: false` / `masked`
 *    and the page renders "غير متاحة" instead of inventing content;
 *  - the plain-language narrative quotes only stored values and ends with
 *    the mandatory "conditions, never a promise of profit" line;
 *  - structured signal data is honored only on a row whose sector carries
 *    the server's [SIGNAL] marker — prose cards can never claim a signal
 *    (the same rule the client enforces).
 */

export type StoredSignalFactor = { id: string; labelAr: string; points: number };

export type StoredSignal = {
  signalType: string;
  signalTypeAr: string;
  /** The stored one-sentence reason the signal exists (may be empty). */
  reasonAr: string;
  name: string | null;
  symbol: string | null;
  price: number | null;
  priceAsOf: number | null;
  priceTimeBasis: "fetch" | "source";
  changePercent: number | null;
  strength: number;
  strengthLabelAr: string;
  factors: StoredSignalFactor[];
  entryLow: number;
  entryHigh: number;
  entryNoteAr: string;
  stopLoss: number;
  target1: number;
  target2: number;
  rewardRisk: number | null;
  timeframeAr: string;
  scenarioPositiveAr: string;
  scenarioNegativeAr: string;
  dataSources: Array<{ name: string; asOf: number | null; basis: "fetch" | "history" | "source" }>;
};

export type OppLiveUpdate = {
  statusNow?: string | null;
  noteAr?: string | null;
  price?: number | null;
  priceAsOf?: number | null;
  priceTimeBasis?: string | null;
} | null;

export type OppExplanation = {
  /** True when the row is VIP-masked for this reader: sections carry no data. */
  masked: boolean;
  /** The stored reason the signal exists (null when no reason was stored). */
  reason: string | null;
  /** Deterministic plain-language summary — stored values only. */
  narrative: string[];
  identity: {
    name: string | null;
    symbol: string | null;
    sector: string | null;
    market: string | null;
    /** Latest verified price (live status); null when none was verified. */
    currentPrice: number | null;
    currentPriceAsOf: number | null;
    currentPriceBasis: "fetch" | "source" | null;
    /** Price stored at signal creation time; null when absent. */
    createdPrice: number | null;
    createdPriceAsOf: number | null;
    createdPriceBasis: "fetch" | "source" | null;
    changePercent: number | null;
  };
  technical: {
    present: boolean;
    strength: number | null;
    strengthLabelAr: string | null;
    factors: StoredSignalFactor[];
    entryLow: number | null;
    entryHigh: number | null;
    entryNoteAr: string | null;
    stopLoss: number | null;
    target1: number | null;
    target2: number | null;
    rewardRisk: number | null;
    timeframeAr: string | null;
  };
  fundamental: { present: false; note: string };
  news: {
    present: boolean;
    items: Array<{ labelAr: string; points: number; direction: "positive" | "negative" }>;
    note: string;
  };
  risks: { riskLevel: number; scenarioNegativeAr: string | null };
  scenarios: { positive: string | null; negative: string | null };
  sources: {
    present: boolean;
    items: Array<{ name: string; asOf: number | null; basis: "fetch" | "history" | "source" }>;
    liveAsOf: number | null;
    liveBasis: "fetch" | "source" | null;
    savedAt: string | null;
    note: string;
  };
  disclaimer: string;
};

const DISCLAIMER =
  "هذه قراءة تحليلية مشروطة بالمستويات الموضحة — ليست توصية استثمارية ولا ضمانًا لأي ربح.";

const NOT_AVAILABLE = "غير متاحة";

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function text(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim().slice(0, max);
  return t.length ? t : null;
}

/**
 * Whitelist parse of the stored signal jsonb. The same field-by-field gates
 * the client applies: anything missing or malformed means "no structured
 * signal" — the page then shows the honest "not available" sections.
 */
export function parseStoredSignal(raw: unknown, sector: string | null): StoredSignal | null {
  if (!raw || typeof raw !== "object") return null;
  if (!/^\[SIGNAL\]/.test(String(sector || ""))) return null;
  const s = raw as Record<string, unknown>;
  if (!["breakout", "rebound", "uptrend"].includes(String(s.signalType || ""))) return null;
  const strength = num(s.strength);
  const stop = num(s.stopLoss);
  const t1 = num((s.targets as { t1?: unknown })?.t1);
  const t2 = num((s.targets as { t2?: unknown })?.t2);
  const el = num((s.entry as { low?: unknown })?.low);
  const eh = num((s.entry as { high?: unknown })?.high);
  if (strength === null || stop === null || t1 === null || t2 === null) return null;
  if (el === null || eh === null || el <= 0 || eh <= 0 || stop <= 0) return null;
  const factorsRaw = Array.isArray(s.factors) ? s.factors : [];
  const factors: StoredSignalFactor[] = [];
  for (const f of factorsRaw.slice(0, 12)) {
    if (!f || typeof f !== "object") continue;
    const labelAr = text((f as Record<string, unknown>).labelAr, 300);
    if (!labelAr) continue;
    factors.push({
      id: text((f as Record<string, unknown>).id, 60) || "",
      labelAr,
      points: num((f as Record<string, unknown>).points) ?? 0,
    });
  }
  const dataSources: StoredSignal["dataSources"] = [];
  if (Array.isArray(s.dataSources)) {
    for (const d of s.dataSources.slice(0, 6)) {
      if (!d || typeof d !== "object") continue;
      const basis = d.basis === "fetch" ? "fetch" : d.basis === "history" ? "history" : "source";
      dataSources.push({
        name: text(d.name, 120) || "غير متاح",
        asOf: num(d.asOf),
        basis,
      });
    }
  }
  return {
    signalType: String(s.signalType),
    signalTypeAr: text(s.signalTypeAr, 80) || "",
    reasonAr: text(s.reasonAr, 400) || "",
    name: text(s.name, 160),
    symbol: text(s.symbol, 16),
    price: num(s.price),
    priceAsOf: num(s.priceAsOf),
    priceTimeBasis: s.priceTimeBasis === "fetch" ? "fetch" : "source",
    changePercent: num(s.changePercent),
    strength: Math.min(100, Math.max(0, strength)),
    strengthLabelAr: text(s.strengthLabelAr, 40) || "",
    factors,
    entryLow: el,
    entryHigh: eh,
    entryNoteAr: text((s.entry as { noteAr?: unknown })?.noteAr, 200) || "",
    stopLoss: stop,
    target1: t1,
    target2: t2,
    rewardRisk: num(s.rewardRisk),
    timeframeAr: text(s.timeframeAr, 60) || "",
    scenarioPositiveAr: text(s.scenarioPositiveAr, 600) || "",
    scenarioNegativeAr: text(s.scenarioNegativeAr, 600) || "",
    dataSources,
  };
}

function stripMarkerPrefix(value: string | null): string | null {
  if (!value) return null;
  const cleaned = value.replace(/^\[(?:AUTO|AI|SIGNAL)\]\s*/, "").trim();
  return cleaned.length ? cleaned : null;
}

function livePriceFields(live: OppLiveUpdate): {
  price: number | null;
  asOf: number | null;
  basis: "fetch" | "source" | null;
} {
  if (!live) return { price: null, asOf: null, basis: null };
  const price = num(live.price);
  if (price === null) return { price: null, asOf: num(live.priceAsOf), basis: null };
  return {
    price,
    asOf: num(live.priceAsOf),
    basis: live.priceTimeBasis === "fetch" ? "fetch" : live.priceTimeBasis === "source" ? "source" : null,
  };
}

/**
 * Builds the detail-page explanation for one (possibly masked) row.
 * `row` is the row AS MASKED FOR THE READER: when VIP content is masked the
 * signal/details are null and this function returns `masked: true` with no
 * data — the page shows the VIP lock exactly like the list.
 */
export function buildOppExplanation(
  row: {
    title: string;
    summary: string;
    details?: string | null;
    sector?: string | null;
    market?: string | null;
    riskLevel?: number | null;
    vipOnly?: boolean;
    signal?: unknown;
    createdAt?: Date | string | null;
    status?: string | null;
  },
  ctx: { liveUpdate?: OppLiveUpdate; origin?: "db" | "live" | null } = {},
): OppExplanation {
  const signal = parseStoredSignal(row.signal, row.sector ?? null);
  const masked = !signal && !row.details && /^SIGNAL|^\[SIGNAL\]/.test(String(row.sector || ""));
  const sector = stripMarkerPrefix(row.sector ?? null);
  const live = livePriceFields(ctx.liveUpdate ?? null);
  const riskLevel = Math.min(5, Math.max(1, Math.round(Number(row.riskLevel) || 3)));

  const savedAt = row.createdAt ? new Date(row.createdAt).toISOString() : null;
  const createdAtMs = row.createdAt ? Date.parse(String(row.createdAt)) : null;

  /* ── identity ───────────────────────────────────────────────────────── */
  const identity = {
    name: signal?.name ?? null,
    symbol: signal?.symbol ?? null,
    sector,
    market: text(row.market, 50),
    currentPrice: live.price,
    currentPriceAsOf: live.asOf,
    currentPriceBasis: live.basis,
    createdPrice: signal?.price ?? null,
    createdPriceAsOf: signal?.priceAsOf ?? null,
    createdPriceBasis: signal ? (signal.priceTimeBasis as "fetch" | "source" | null) : null,
    changePercent: signal?.changePercent ?? null,
  };

  /* ── technical ──────────────────────────────────────────────────────── */
  const technical = {
    present: Boolean(signal),
    strength: signal?.strength ?? null,
    strengthLabelAr: signal?.strengthLabelAr ?? null,
    factors: signal?.factors ?? [],
    entryLow: signal?.entryLow ?? null,
    entryHigh: signal?.entryHigh ?? null,
    entryNoteAr: signal?.entryNoteAr ?? null,
    stopLoss: signal?.stopLoss ?? null,
    target1: signal?.target1 ?? null,
    target2: signal?.target2 ?? null,
    rewardRisk: signal?.rewardRisk ?? null,
    timeframeAr: signal?.timeframeAr ?? null,
  };

  /* ── news (stored as signal factors; nothing else is claimed) ───────── */
  const newsItems = (signal?.factors ?? [])
    .filter((f) => f.id === "news_positive" || f.id === "news_negative")
    .map((f) => ({
      labelAr: f.labelAr,
      points: f.points,
      direction: (f.id === "news_negative" ? "negative" : "positive") as "positive" | "negative",
    }));
  const news = {
    present: newsItems.length > 0,
    items: newsItems,
    note: newsItems.length
      ? "خبر مرتبط محفظ ضمن عوامل الإشارة — الاتجاه حسب كلمات الخبر المحفوظة."
      : "لا توجد أخبار مرتبطة محفوظة ضمن هذه الفرصة.",
  };

  /* ── risks & scenarios ──────────────────────────────────────────────── */
  const risks = {
    riskLevel,
    scenarioNegativeAr: signal?.scenarioNegativeAr || null,
  };
  const scenarios = {
    positive: signal?.scenarioPositiveAr || null,
    negative: signal?.scenarioNegativeAr || null,
  };

  /* ── sources ────────────────────────────────────────────────────────── */
  const sources = {
    present: (signal?.dataSources.length ?? 0) > 0 || Number.isFinite(createdAtMs || NaN),
    items: signal?.dataSources ?? [],
    liveAsOf: live.asOf,
    liveBasis: live.basis,
    savedAt,
    note:
      ctx.origin === "live"
        ? "عنصر لقطة حية غير محفوظ — يُعاد بناؤه من بيانات السوق وقت الطلب."
        : "آخر تحديث = وقت الإنشاء المحفوظ مع أي قراءة حية أعلاه.",
  };

  /* ── deterministic narrative (stored values only) ───────────────────── */
  const narrative: string[] = [];
  if (signal) {
    const who = [signal.name, signal.symbol].filter(Boolean).join(" (") + (signal.name && signal.symbol ? ")" : "");
    narrative.push(
      `ظهرت هذه الفرصة كنمط «${signal.signalTypeAr || signal.signalType}» على ${who || "أداة تتبعها المنصة"} — القوة ${signal.strength}/100 (${signal.strengthLabelAr || "بدون تصنيف"}).`,
    );
    if (signal.reasonAr && text(signal.reasonAr, 400)) {
      narrative.push(`السبب المحفوظ لظهورها: ${text(signal.reasonAr, 400)}`);
    }
    if (signal.factors.length) {
      narrative.push(`العوامل المحفوظة (${signal.factors.length}): ${signal.factors.slice(0, 5).map((f) => f.labelAr).join("؛ ")}.`);
    }
    narrative.push(
      `المستويات المحفوظة: منطقة دخول ${signal.entryLow} – ${signal.entryHigh}، وقف الخسارة ${signal.stopLoss}، الهدف الأول ${signal.target1}، الهدف الثاني ${signal.target2}${signal.rewardRisk !== null ? `، والعائد للمخاطرة ${signal.rewardRisk}` : ""}${signal.timeframeAr ? `، والأفق ${signal.timeframeAr}` : ""}.`,
    );
    if (signal.price !== null) {
      narrative.push(`سعر الإشارة المحفوظ عند الإنشاء: ${signal.price} (${signal.priceTimeBasis === "fetch" ? "وقت الجلب" : "وقت المصدر"}).`);
    }
    if (live.price !== null) {
      narrative.push(`آخر سعر حية موثق للقراءة: ${live.price}.`);
    }
  } else if (masked) {
    narrative.push("محتوى هذا العنصر لأعضاء VIP فقط — التفاصيل والمؤشرات محجوبة لغير المشترك.");
  } else {
    narrative.push(
      "هذا العنصر لقطة وصفية لا تحمل إشارة منظمة محفوظة — المستويات والمؤشرات والأهداف غير متاحة له.",
    );
    if (text(row.summary, 300)) {
      narrative.push(`الملخص المحفوظ: ${text(row.summary, 300)}`);
    }
  }
  if (Number.isFinite(createdAtMs || NaN)) {
    narrative.push(`أنشئت الفرصة بتاريخ ${new Date(createdAtMs!).toUTCString()}.`);
  }
  narrative.push(DISCLAIMER);

  return {
    masked,
    reason: signal ? (signal.reasonAr || null) : null,
    narrative,
    identity,
    technical,
    fundamental: {
      present: false,
      note: "لا توجد بيانات أساسية (أرباح أو تقييم) محفوظة ضمن هذه الفرصة حاليًا.",
    },
    news,
    risks,
    scenarios,
    sources,
    disclaimer: DISCLAIMER,
  };
}

export const OPP_EXPLAIN_NOT_AVAILABLE = NOT_AVAILABLE;
