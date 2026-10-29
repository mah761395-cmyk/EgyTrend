/**
 * Opportunity signal engine (TASK M).
 *
 * Pure, deterministic, and explainable: it turns VERIFIED daily bars (the
 * persisted, single-source-per-instrument OHLC store) plus ONE live board
 * quote into at most one signal per instrument. Every number it publishes is
 * an arithmetic derivation of inputs that carry their own source and
 * timestamp — nothing is inferred, forecast, or backfilled, and the engine
 * never says a profit is possible: it states conditions, levels and the
 * data they were computed from.
 *
 * Hard gates (the engine returns null — an opportunity must never be built
 * on stale, missing or unreliable data):
 *  - fewer than 21 verified daily bars,
 *  - the newest bar older than 4 Cairo days (the store has fallen behind),
 *  - no live quote, or the quote's session state is "stale",
 *  - a stop loss that does not sit below the entry zone (no measurable
 *    risk, no publishable setup),
 *  - volume fields are optional: absent volume simply removes the volume
 *    factor, it is never assumed.
 */

export type OppOhlcBar = {
  tradingDate: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number | null;
};

export type OppLiveQuote = {
  instrumentId: string;
  symbol: string;
  name: string;
  currency?: string;
  price: number;
  changePercent?: number | null;
  /** Provider timestamp in epoch ms (the value's reference time). */
  asOf: number;
  /** "source" = provider publish time, "fetch" = server fetch time. */
  timeBasis: "source" | "fetch";
  /** Session-aware state from the board: live | closed | stale. */
  state?: "live" | "closed" | "stale";
  sourceName: string;
};

export type OppNewsHit = {
  title: string;
  sourceName: string;
  publishedAt: number;
  link?: string;
  impact: "positive" | "negative" | "neutral";
};

export type SignalFactor = {
  /** Stable identifier, e.g. "trend_sma20". */
  id: string;
  /** Human-readable factor, Arabic, with its numbers. */
  labelAr: string;
  /** Points contributed to the strength score (may be negative). */
  points: number;
};

export type OppSignalType = "breakout" | "rebound" | "uptrend";

export type OpportunitySignal = {
  instrumentId: string;
  symbol: string;
  name: string;
  currency?: string;
  /** Legacy-compatible display mapping. */
  assetType: "stock" | "etf" | "crypto" | "commodity";
  market: "egypt" | "us" | "gulf" | "crypto" | "global";
  signalType: OppSignalType;
  signalTypeAr: string;
  /** Why this signal exists at all — one plain sentence. */
  reasonAr: string;
  /** Current price (live quote) and when that value is from. */
  price: number;
  priceAsOf: number;
  priceTimeBasis: "source" | "fetch";
  changePercent?: number;
  /** 0–100, clamped away from the absolute extremes: no certainty. */
  strength: number;
  strengthLabelAr: string;
  factors: SignalFactor[];
  entry: { low: number; high: number; noteAr: string };
  stopLoss: number;
  targets: { t1: number; t2: number };
  rewardRisk: number;
  timeframeAr: string;
  scenarioPositiveAr: string;
  scenarioNegativeAr: string;
  /** Exactly the sources behind this card's numbers. */
  dataSources: Array<{ name: string; asOf: number; basis: "source" | "fetch" | "history" }>;
  /** Stable dedupe key: one active signal per instrument+type+day. */
  dedupeKey: string;
  createdAt: number;
  /** The latest verified bar this signal was computed from. */
  historyAsOf: number;
  historySource: string;
};

export type OppSignalInput = {
  bars: OppOhlcBar[];
  quote: OppLiveQuote | null;
  historySource: string;
  historyAsOf: number;
  newsHits?: OppNewsHit[];
  /** Cairo calendar day (YYYY-MM-DD) for the dedupe key. */
  cairoDay: string;
  now?: number;
};

const MIN_BARS = 21;
const MAX_BAR_AGE_DAYS = 4;
const SMA_PERIOD = 20;
const RSI_PERIOD = 14;
const NEWS_MAX_AGE_MS = 24 * 3_600_000;

const TYPE_AR: Record<OppSignalType, string> = {
  breakout: "اختراق قمة 20 يوم",
  rebound: "ارتداد من تشبع بيعي",
  uptrend: "اتجاه صاعد",
};

const TIMEFRAME_AR: Record<OppSignalType, string> = {
  breakout: "قصير (أيام)",
  rebound: "قصير إلى متوسط",
  uptrend: "متوسط (أسابيع)",
};

/* ── small numeric helpers (pure) ─────────────────────────────────── */

function mean(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function stdev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((sum, v) => sum + (v - m) * (v - m), 0) / values.length);
}

function simpleMovingAverageLast(closes: number[], period: number): number | null {
  if (closes.length < period) return null;
  return mean(closes.slice(-period));
}

/** Wilder RSI series over closes; null when there are not enough closes. */
function rsiSeries(closes: number[], period = RSI_PERIOD): number[] | null {
  if (closes.length <= period) return null;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i += 1) {
    const change = closes[i]! - closes[i - 1]!;
    gains += Math.max(change, 0);
    losses += Math.max(-change, 0);
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  const out = [rsiValue(avgGain, avgLoss)];
  for (let i = period + 1; i < closes.length; i += 1) {
    const change = closes[i]! - closes[i - 1]!;
    avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
    out.push(rsiValue(avgGain, avgLoss));
  }
  return out;
}

function rsiValue(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) return 100;
  if (avgGain === 0) return 0;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function num(value: number, digits = 2): string {
  return new Intl.NumberFormat("ar-EG", { maximumFractionDigits: digits }).format(value);
}

/* ── the engine ───────────────────────────────────────────────────── */

export function buildOppSignal(input: OppSignalInput): OpportunitySignal | null {
  const { bars, quote, historySource, historyAsOf, newsHits = [], cairoDay, now = Date.now() } = input;

  /* Gate 1: the bar set must be a real, recent, single-instrument series. */
  if (!bars || bars.length < MIN_BARS) return null;
  const dates = bars.map((b) => b.tradingDate);
  if (new Set(dates).size !== dates.length) return null;
  const sorted = [...bars].sort((a, b) => a.tradingDate.localeCompare(b.tradingDate));
  const newest = sorted[sorted.length - 1]!;
  if (now - parseDay(newest.tradingDate) > MAX_BAR_AGE_DAYS * 86_400_000) return null;
  if (!sorted.every((b) => [b.open, b.high, b.low, b.close].every((v) => Number.isFinite(v) && v > 0))) return null;

  /* Gate 2: a live quote that is not genuinely stale. */
  if (!quote || !(quote.price > 0)) return null;
  if (quote.state === "stale") return null;

  const closes = sorted.map((b) => b.close);
  const highs = sorted.map((b) => b.high);
  const lows = sorted.map((b) => b.low);
  const vols = sorted.map((b) => (typeof b.volume === "number" && Number.isFinite(b.volume) && b.volume >= 0 ? b.volume : null));
  const hasVolume = vols.slice(-20).every((v) => v !== null);
  const avgVolume20 = hasVolume ? mean(vols.slice(-20) as number[]) : null;

  const price = quote.price;
  const sma20 = simpleMovingAverageLast(closes, SMA_PERIOD);
  if (sma20 === null) return null;
  const sma20Prev5 = closes.length >= SMA_PERIOD + 5 ? mean(closes.slice(-(SMA_PERIOD + 5), -5)) : null;
  const rsi = rsiSeries(closes);
  const latestRsi = rsi ? rsi[rsi.length - 1]! : null;
  const rsi3Ago = rsi && rsi.length >= 3 ? rsi[rsi.length - 3]! : null;
  const minRsi3 = rsi && rsi.length >= 3 ? Math.min(rsi[rsi.length - 3]!, rsi[rsi.length - 2]!, rsi[rsi.length - 1]!) : null;

  const h20 = Math.max(...highs.slice(-20));
  const l20 = Math.min(...lows.slice(-20));
  const swingLow5 = Math.min(...lows.slice(-5));
  const volBuffer = 1.5 * stdev(closes.slice(-10));

  const signal = detectSignal({
    price, closes, sma20, sma20Prev5, minRsi3, h20,
  });
  if (!signal) return null;

  const factors: SignalFactor[] = [];
  let strength = 0;
  const addFactor = (id: string, labelAr: string, points: number): void => {
    factors.push({ id, labelAr, points: Math.round(points * 10) / 10 });
    strength += points;
  };

  const trendAbove = price > sma20;
  if (trendAbove) {
    addFactor("trend_sma20", `السعر فوق متوسط 20 يوم (${num(price)} > ${num(sma20)})`, 10);
  } else {
    addFactor("trend_sma20", `السعر تحت متوسط 20 يوم (${num(price)} < ${num(sma20)})`, -5);
  }
  if (sma20Prev5 !== null && sma20 > sma20Prev5) {
    addFactor("trend_slope", "متوسط 20 يوم صاعد مقارنة قبل 5 أيام", 8);
  }

  if (hasVolume && avgVolume20 && avgVolume20 > 0) {
    const latestVol = vols[vols.length - 1] as number;
    const ratio = latestVol / avgVolume20;
    if (ratio >= 1.5) {
      addFactor("volume_confirm", `حجم آخر جلسة ${num(ratio, 1)}× متوسط 20 يوم — تأكيد بالسوق`, 12);
    } else if (ratio < 0.6) {
      addFactor("volume_thin", `حجم آخر جلسة ${num(ratio, 1)}× المتوسط — سيولة هزيلة تُضعف القراءة`, -8);
    }
  }

  if (latestRsi !== null) {
    if (latestRsi >= 80) addFactor("rsi_overbought", `RSI(14) عند ${num(latestRsi, 0)} — تشبع شرائي`, -10);
    else if (latestRsi <= 30) addFactor("rsi_oversold", `RSI(14) عند ${num(latestRsi, 0)} — تشبع بيعي`, 5);
    else if (latestRsi >= 50 && latestRsi < 70 && signal.signalType === "uptrend") {
      addFactor("rsi_momentum", `RSI(14) عند ${num(latestRsi, 0)} — زخم متوازن`, 8);
    }
  }

  /* News: only verified, recent, attributed items move the score. */
  const freshNews = newsHits
    .filter((n) => n.impact !== "neutral" && now - n.publishedAt <= NEWS_MAX_AGE_MS)
    .sort((a, b) => b.publishedAt - a.publishedAt)
    .slice(0, 2);
  for (const item of freshNews) {
    if (item.impact === "positive") {
      addFactor("news_positive", `خبر إيجابي آخر 24 ساعة من ${item.sourceName}`, 8);
    } else {
      addFactor("news_negative", `خبر سلبي آخر 24 ساعة من ${item.sourceName} — يضغط على الفكرة`, -12);
    }
  }

  /* Per-signal core, then levels. */
  let entryLow: number;
  let entryHigh: number;
  let entryNoteAr: string;
  let stop: number;
  let t1: number;
  let t2: number;
  let reasonAr: string;

  if (signal.signalType === "breakout") {
    addFactor("breakout_core", `إغلاق فوق أعلى قمة 20 يوم (${num(price)} > ${num(signal.h20)})`, 30);
    entryLow = Math.min(signal.h20, price);
    entryHigh = price;
    entryNoteAr = `منطقة الاختراق/الارتداد لقمه 20 يوم (${num(signal.h20)})`;
    stop = Math.min(swingLow5, signal.h20) - volBuffer;
    const risk = entryHigh - stop;
    t1 = entryHigh + risk;
    t2 = entryHigh + 2 * risk;
    reasonAr = `سجّل ${quote.symbol} إغلاقًا فوق أعلى قمة في آخر 20 جلسة (${num(signal.h20)})، وهو نمط اختراق يُتابع عادةً عند الارتداد لمنطقة القمه.`;
  } else if (signal.signalType === "rebound") {
    const depth = (minRsi3 ?? 30) <= 30 ? 30 - (minRsi3 ?? 30) : 0;
    addFactor("rebound_core", `ارتداد بعد تشبع بيعي (أدنى RSI آخر 3 جلسات ${num(minRsi3 ?? 30, 0)} ثم شمعة صاعدة)`, 28 + depth);
    entryLow = Math.min(...lows.slice(-3));
    entryHigh = price;
    entryNoteAr = `منطقة قاع التشبع (${num(Math.min(...lows.slice(-3)))}) حتى السعر الحالي`;
    stop = Math.min(l20, Math.min(...lows.slice(-10))) - volBuffer;
    t1 = Math.max(sma20, price + (price - stop) * 0.75);
    t2 = Math.max(signal.h20, t1 + (t1 - stop) * 0.5);
    reasonAr = `كان ${quote.symbol} في منطقة تشبع بيعي (RSI(14) ≤ 30 خلال آخر 3 جلسات) ثم أغلق أعلى من جلسته السابقة — نمط ارتداد يُتابع بحذر داخل الاتجاه العام.`;
  } else {
    const distance = sma20 > 0 ? ((price - sma20) / sma20) * 100 : 0;
    addFactor("uptrend_core", `اتجاه صاعد: السعر فوق متوسط 20 يوم بـ ${num(distance, 1)}٪ والمتوسط صاعد`, 25);
    entryLow = sma20;
    entryHigh = price;
    entryNoteAr = `ارتداد متوسط 20 يوم (${num(sma20)}) حتى السعر الحالي`;
    stop = Math.max(sma20 * 0.985, swingLow5 - volBuffer);
    const risk = entryHigh - stop;
    t1 = Math.max(signal.h20, entryHigh + 0.75 * risk);
    t2 = entryHigh + 1.5 * risk;
    reasonAr = `يتحرك ${quote.symbol} فوق متوسط 20 يوم الصاعد (${num(sma20)}) — نمط اتجاه يُتابع عند التصحيحات نحو المتوسط.`;
  }

  /* Gate 3: no measurable risk, no card. */
  if (!(stop > 0) || stop >= entryHigh) return null;
  const entryMid = (entryLow + entryHigh) / 2;
  const rewardRisk = (t1 - entryMid) / (entryMid - stop);
  if (!(rewardRisk > 0)) return null;

  strength = Math.round(Math.min(95, Math.max(5, strength)));

  const dataSources = [
    { name: historySource, asOf: historyAsOf, basis: "history" as const },
    { name: quote.sourceName, asOf: quote.asOf, basis: quote.timeBasis },
    ...freshNews.map((n) => ({ name: n.sourceName, asOf: n.publishedAt, basis: "source" as const })),
  ];

  return {
    instrumentId: quote.instrumentId,
    symbol: quote.symbol,
    name: quote.name,
    currency: quote.currency,
    assetType: assetTypeFor(quote.instrumentId),
    market: marketFor(quote.instrumentId),
    signalType: signal.signalType,
    signalTypeAr: TYPE_AR[signal.signalType],
    reasonAr,
    price,
    priceAsOf: quote.asOf,
    priceTimeBasis: quote.timeBasis,
    ...(typeof quote.changePercent === "number" && Number.isFinite(quote.changePercent) ? { changePercent: quote.changePercent } : {}),
    strength,
    strengthLabelAr: strengthLabel(strength),
    factors,
    entry: { low: round4(entryLow), high: round4(entryHigh), noteAr: entryNoteAr },
    stopLoss: round4(stop),
    targets: { t1: round4(t1), t2: round4(t2) },
    rewardRisk: Math.round(rewardRisk * 100) / 100,
    timeframeAr: TIMEFRAME_AR[signal.signalType],
    scenarioPositiveAr: `إذا حافظ السعر على ${num(entryLow)} وتجاوز ${num(signal.h20)}، فإن الهدف الأول ${num(t1)} ثم ${num(t2)} بناءً على قياس الحركة الحالية.`,
    scenarioNegativeAr: `إذا كسر السعر ${num(stop)} فإن الفكرة ملغاة؛ المخاطرة من منتصف المنطقة ${num((entryMid - stop) / entryMid * 100, 1)}٪ — لا ضمان لأي نتيجة.`,
    dataSources,
    dedupeKey: `${quote.instrumentId}:${signal.signalType}:${cairoDay}`,
    createdAt: now,
    historyAsOf,
    historySource,
  };
}

type DetectedSignal = {
  signalType: OppSignalType;
  h20: number;
};

function detectSignal(ctx: {
  price: number;
  closes: number[];
  sma20: number;
  sma20Prev5: number | null;
  minRsi3: number | null;
  h20: number;
}): DetectedSignal | null {
  const { price, closes, sma20, sma20Prev5, minRsi3, h20 } = ctx;
  const prevClose = closes[closes.length - 2]!;

  /* Breakout: the latest close clears the previous 20-day high. */
  if (price > h20 && h20 > 0) {
    return { signalType: "breakout", h20 };
  }
  /* Rebound: RSI was oversold within the last 3 sessions and the latest
   * close recovered above the previous close. */
  if (minRsi3 !== null && minRsi3 <= 30 && price > prevClose) {
    return { signalType: "rebound", h20 };
  }
  /* Uptrend: price above a rising 20-day average and holding above the
   * close of 5 sessions ago. */
  if (sma20Prev5 !== null && price > sma20 && sma20 > sma20Prev5 && price > closes[closes.length - 6]!) {
    return { signalType: "uptrend", h20 };
  }
  return null;
}

function strengthLabel(strength: number): string {
  if (strength >= 70) return "قوي";
  if (strength >= 40) return "متوسط";
  return "ضعيف";
}

function assetTypeFor(instrumentId: string): OpportunitySignal["assetType"] {
  if (instrumentId.startsWith("stock:")) return "stock";
  if (instrumentId.startsWith("crypto:")) return "crypto";
  if (instrumentId.startsWith("commodity:")) return "commodity";
  if (instrumentId.startsWith("index:")) return "etf";
  return "stock";
}

function marketFor(instrumentId: string): OpportunitySignal["market"] {
  if (instrumentId.startsWith("stock:egx:")) return "egypt";
  if (instrumentId.startsWith("stock:us:")) return "us";
  if (instrumentId.startsWith("crypto:")) return "crypto";
  if (instrumentId.startsWith("fx:") || instrumentId.startsWith("commodity:")) return "global";
  if (instrumentId.startsWith("index:")) return "global";
  if (instrumentId.startsWith("egx:")) return "egypt";
  return "global";
}

function parseDay(day: string): number {
  const parsed = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(parsed) ? parsed : 0;
}
