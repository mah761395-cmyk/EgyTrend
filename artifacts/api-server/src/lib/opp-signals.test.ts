import assert from "node:assert/strict";
import test from "node:test";
import { buildOppSignal, type OppLiveQuote, type OppOhlcBar, type OppSignalInput } from "./opp-signals";

/**
 * TASK M (M3): the pure opportunity signal engine.
 *
 * Pins the explainability contract: every signal is an arithmetic reading of
 * verified bars + one live quote; every gate fails closed (no signal on
 * stale, thin or old data); levels are always ordered (stop < entry <
 * targets); the strength stays inside 5–95 (never a certainty); and factors,
 * scenarios and sources are present with their numbers.
 */

const NOW = Date.UTC(2026, 9, 28, 12, 0, 0); // Wed 2026-10-28 12:00 UTC

function isoDay(offsetFromNowDays: number): string {
  return new Date(NOW + offsetFromNowDays * 86_400_000).toISOString().slice(0, 10);
}

function barsFromCloses(closes: number[], opts: { volume?: number[] | null } = {}): OppOhlcBar[] {
  return closes.map((close, i) => {
    const barsCount = closes.length;
    const volume = opts.volume ? (opts.volume[i] ?? null) : null;
    return {
      tradingDate: isoDay(i - (barsCount - 1)),
      open: close,
      high: close * 1.01,
      low: close * 0.99,
      close,
      ...(volume !== null ? { volume } : {}),
    };
  });
}

function quote(price: number, state: OppLiveQuote["state"] = "live"): OppLiveQuote {
  return {
    instrumentId: "stock:egx:COMI",
    symbol: "COMI",
    name: "البنك التجاري الدولي",
    currency: "EGP",
    price,
    asOf: NOW - 3_600_000,
    timeBasis: "source",
    state,
    sourceName: "Test Source",
  };
}

function input(closes: number[], price: number, extra: Partial<OppSignalInput> = {}): OppSignalInput {
  return {
    bars: extra.bars ?? barsFromCloses(closes),
    quote: extra.quote !== undefined ? extra.quote : quote(price),
    historySource: "Test History",
    historyAsOf: NOW - 86_400_000,
    cairoDay: isoDay(0),
    now: NOW,
    ...(extra.newsHits ? { newsHits: extra.newsHits } : {}),
  };
}

function rising(n: number, from: number, step: number): number[] {
  return Array.from({ length: n }, (_, i) => from + i * step);
}

test("uptrend: price above a rising 20-day average produces an explainable uptrend card", () => {
  const closes = rising(30, 100, 0.7);
  const price = closes[closes.length - 1]! + 0.5;
  const signal = buildOppSignal(input(closes, price));
  assert.ok(signal, "an uptrend signal must be produced");
  assert.equal(signal.signalType, "uptrend");
  assert.equal(signal.signalTypeAr, "اتجاه صاعد");
  assert.ok(signal.reasonAr.includes("متوسط 20 يوم"), "the reason must name the evidence");
  const core = signal.factors.find((f) => f.id === "uptrend_core");
  assert.ok(core, "the core factor must exist with its numbers");
  assert.ok(core!.points >= 20);
  assert.equal(signal.market, "egypt");
  assert.equal(signal.assetType, "stock");
  assert.equal(signal.price, price);
  assert.equal(signal.priceAsOf, NOW - 3_600_000);
  assert.equal(signal.priceTimeBasis, "source");
  assert.ok(signal.entry.low < signal.entry.high);
  assert.ok(signal.stopLoss < signal.entry.high, "the stop must sit below the entry zone");
  assert.ok(signal.targets.t1 > signal.price && signal.targets.t2 > signal.targets.t1);
  assert.ok(signal.rewardRisk > 0);
  assert.ok(signal.strength >= 5 && signal.strength <= 95, "strength is bounded away from certainties");
  assert.ok(signal.scenarioPositiveAr.length > 20 && signal.scenarioNegativeAr.length > 20);
  assert.ok(signal.scenarioNegativeAr.includes("لا ضمان"), "the negative scenario must state there is no guarantee");
  assert.equal(signal.dataSources.length, 2, "history + live source, nothing else");
  assert.equal(signal.dedupeKey, `stock:egx:COMI:uptrend:${isoDay(0)}`);
  assert.equal(signal.timeframeAr, "متوسط (أسابيع)");
});

test("breakout: a close above the 20-day high produces a breakout with the high as the retest zone", () => {
  /* 25 sessions oscillating 100–105, then a print above the top. */
  const closes: number[] = [];
  for (let i = 0; i < 25; i += 1) closes.push(100 + ((i * 7) % 6) * 1.0);
  const price = 108;
  const signal = buildOppSignal(input(closes, price));
  assert.ok(signal, "the breakout must be detected");
  assert.equal(signal.signalType, "breakout");
  const h20 = Math.max(...closes.slice(-20).map((c) => c * 1.01));
  assert.equal(signal.entry.low, Math.round(Math.min(h20, price) * 10_000) / 10_000);
  assert.ok(signal.stopLoss < h20, "the stop is below the broken level");
  assert.ok(signal.targets.t1 > price);
  assert.ok(signal.reasonAr.includes("20"));
});

test("rebound: oversold RSI then a green close produces a rebound, not an uptrend", () => {
  const closes: number[] = [];
  for (let i = 0; i < 23; i += 1) closes.push(130 - i * 1.2); // steady decline → RSI near 0
  closes.push(closes[closes.length - 1]! - 0.8); // the wash-low session
  closes.push(closes[closes.length - 1]! + 1.5); // the recovery session
  const price = closes[closes.length - 1]! + 0.4;
  const signal = buildOppSignal(input(closes, price));
  assert.ok(signal, "the rebound must be detected");
  assert.equal(signal.signalType, "rebound");
  assert.ok(signal.factors.some((f) => f.id === "rebound_core" && /RSI/.test(f.labelAr)));
  assert.equal(signal.timeframeAr, "قصير إلى متوسط");
});

test("no pattern: a flat series produces no signal at all", () => {
  const closes = Array.from({ length: 30 }, () => 100);
  assert.equal(buildOppSignal(input(closes, 100)), null);
});

test("gate: a stale live quote never produces a signal", () => {
  const closes = rising(30, 100, 0.7);
  const price = closes[closes.length - 1]! + 0.5;
  assert.equal(buildOppSignal(input(closes, price, { quote: quote(price, "stale") })), null);
});

test("gate: an empty quote (no live price) never produces a signal", () => {
  const closes = rising(30, 100, 0.7);
  assert.equal(buildOppSignal(input(closes, 0, { quote: null })), null);
});

test("gate: a bar set older than 4 Cairo days fails closed", () => {
  const closes = rising(30, 100, 0.7);
  const staleBars = closes.map((close, i) => ({
    ...barsFromCloses(closes)[i]!,
    tradingDate: isoDay(i - (closes.length - 1) - 6), // whole series 6 days old
  }));
  const price = closes[closes.length - 1]! + 0.5;
  assert.equal(buildOppSignal(input(closes, price, { bars: staleBars })), null);
});

test("gate: fewer than 21 bars fails closed", () => {
  const closes = rising(20, 100, 0.7);
  assert.equal(buildOppSignal(input(closes, 120)), null);
});

test("gate: duplicated trading dates fail closed", () => {
  const closes = rising(30, 100, 0.7);
  const bars = barsFromCloses(closes);
  bars[29] = { ...bars[29]!, tradingDate: bars[28]!.tradingDate };
  const price = closes[closes.length - 1]! + 0.5;
  assert.equal(buildOppSignal(input(closes, price, { bars })), null);
});

test("volume: a heavy breakout day confirms, a thin day weakens, absent volume is simply absent", () => {
  const closes: number[] = [];
  for (let i = 0; i < 25; i += 1) closes.push(100 + ((i * 7) % 6) * 1.0);
  const baseVolumes = Array.from({ length: 25 }, () => 1_000_000);
  const price = 108;

  const heavy = buildOppSignal(input(closes, price, {
    bars: barsFromCloses(closes, { volume: [...baseVolumes.slice(0, 24), 5_000_000] }),
  }));
  assert.ok(heavy);
  assert.ok(heavy.factors.some((f) => f.id === "volume_confirm"), "5× volume must confirm");

  const thin = buildOppSignal(input(closes, price, {
    bars: barsFromCloses(closes, { volume: [...baseVolumes.slice(0, 24), 300_000] }),
  }));
  assert.ok(thin);
  assert.ok(thin.factors.some((f) => f.id === "volume_thin"), "0.3× volume must weaken the card");

  const noVol = buildOppSignal(input(closes, price));
  assert.ok(noVol);
  assert.ok(!noVol.factors.some((f) => f.id.startsWith("volume_")), "absent volume is never assumed");
});

test("news: a fresh positive headline adds, a fresh negative one subtracts, old or neutral ones never touch the score", () => {
  const closes = rising(30, 100, 0.7);
  const price = closes[closes.length - 1]! + 0.5;
  const withPositive = buildOppSignal(input(closes, price, {
    newsHits: [{ title: "نتائج ربع سنوية تتجاوز التوقعات", sourceName: "Reuters", publishedAt: NOW - 2 * 3_600_000, impact: "positive" }],
  }));
  assert.ok(withPositive);
  assert.ok(withPositive.factors.some((f) => f.id === "news_positive" && f.points > 0));
  assert.ok(withPositive.dataSources.some((s) => s.name === "Reuters"), "the news source is listed on the card");

  const withNegative = buildOppSignal(input(closes, price, {
    newsHits: [{ title: "تحذير من تباطؤ الطلب", sourceName: "Reuters", publishedAt: NOW - 2 * 3_600_000, impact: "negative" }],
  }));
  assert.ok(withNegative);
  assert.ok(withNegative.factors.some((f) => f.id === "news_negative" && f.points < 0));

  const staleNews = buildOppSignal(input(closes, price, {
    newsHits: [{ title: "خبر قديم", sourceName: "Reuters", publishedAt: NOW - 48 * 3_600_000, impact: "positive" }],
  }));
  assert.ok(staleNews);
  assert.ok(!staleNews.factors.some((f) => f.id.startsWith("news_")), "a 48h-old headline must not move the score");

  const neutral = buildOppSignal(input(closes, price, {
    newsHits: [{ title: "خبر محايد", sourceName: "Reuters", publishedAt: NOW - 3_600_000, impact: "neutral" }],
  }));
  assert.ok(neutral);
  assert.ok(!neutral.factors.some((f) => f.id.startsWith("news_")));
});

test("invariants across signal types: levels ordered, reward positive, strength bounded", () => {
  const cases: Array<{ name: string; closes: number[]; price: number }> = [
    { name: "uptrend", closes: rising(30, 100, 0.7), price: rising(30, 100, 0.7)[29]! + 0.5 },
    { name: "breakout", closes: Array.from({ length: 25 }, (_, i) => 100 + ((i * 7) % 6)), price: 108 },
    { name: "rebound", closes: [...Array.from({ length: 23 }, (_, i) => 130 - i * 1.2), 99.2, 100.7, 101.1], price: 101.5 },
  ];
  for (const { name, closes, price } of cases) {
    const signal = buildOppSignal(input(closes, price));
    assert.ok(signal, `${name} case must produce a signal`);
    assert.ok(signal.stopLoss > 0 && signal.stopLoss < signal.entry.high, `${name}: stop below entry`);
    assert.ok(signal.entry.low > 0 && signal.entry.low < signal.entry.high, `${name}: sane entry zone`);
    assert.ok(signal.targets.t1 > 0 && signal.targets.t2 > signal.targets.t1, `${name}: ordered targets`);
    assert.ok(signal.rewardRisk > 0, `${name}: positive reward:risk`);
    assert.ok(signal.strength >= 5 && signal.strength <= 95, `${name}: bounded strength`);
    assert.ok(signal.factors.length >= 2, `${name}: at least the core + trend factors`);
  }
});
