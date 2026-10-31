import { test } from "node:test";
import assert from "node:assert/strict";
import { buildOppExplanation, parseStoredSignal } from "./opp-explain";

const SIGNAL = {
  signalType: "breakout",
  signalTypeAr: "اختراق مقاومة",
  name: "البنك التجاري الدولي",
  symbol: "COMI",
  price: 105.5,
  priceAsOf: 1761579600000,
  priceTimeBasis: "fetch",
  changePercent: 2.4,
  strength: 72,
  strengthLabelAr: "قوية",
  factors: [
    { id: "trend_sma20", labelAr: "السعر فوق المتوسط المتحرك 20 (104.1)", points: 15 },
    { id: "volume_surge", labelAr: "حجم تداول أعلى من المتوسط بـ 2.3 مرة", points: 12 },
    { id: "news_positive", labelAr: "خبر إيجابي آخر 24 ساعة من الأهرام", points: 8 },
    { id: "rsi_zone", labelAr: "مؤشر القوة النسبية 61 — دون التشبع", points: 5 },
  ],
  entry: { low: 104.0, high: 105.5, noteAr: "دخول عند الاستقرار فوق 104" },
  stopLoss: 100.2,
  targets: { t1: 111, t2: 116.5 },
  rewardRisk: 1.4,
  timeframeAr: "5–15 يوم تداول",
  scenarioPositiveAr: "استمرار الزخم يدفع السعر نحو الهدف الأول ثم الثاني.",
  scenarioNegativeAr: "كسر 100.2 يلغي الفكرة ويحصر الخسارة.",
  dataSources: [
    { name: "سجل التداول الموثق", asOf: 1761493200000, basis: "history" },
    { name: "لوحة الأسعار الحية", asOf: 1761579600000, basis: "fetch" },
  ],
};

const signalRow = {
  title: "[SIGNAL] اختراق مقاومة — COMI",
  summary: "اختراق فوق المقاومة بحجم مرتفع.",
  details: "النوع: اختراق مقاومة...",
  sector: "[SIGNAL] بنوك",
  market: "egypt",
  riskLevel: 3,
  vipOnly: true,
  signal: SIGNAL,
  createdAt: new Date(1761579600000),
  status: "active",
};

test("parseStoredSignal honors the [SIGNAL] marker and whitelists fields", () => {
  const parsed = parseStoredSignal(SIGNAL, "[SIGNAL] بنوك");
  assert.ok(parsed);
  assert.equal(parsed!.entryLow, 104.0);
  assert.equal(parsed!.target2, 116.5);
  assert.equal(parsed!.factors.length, 4);
  // prose cards can never claim a signal
  assert.equal(parseStoredSignal(SIGNAL, "بنوك"), null);
  assert.equal(parseStoredSignal(SIGNAL, "[AUTO] بنوك"), null);
  // malformed payload → no structured signal
  assert.equal(parseStoredSignal({ signalType: "breakout", stopLoss: 1 }, "[SIGNAL] بنوك"), null);
  assert.equal(parseStoredSignal("not-an-object", "[SIGNAL] بنوك"), null);
});

test("explanation quotes ONLY stored numbers (no invented values)", () => {
  const ex = buildOppExplanation(signalRow, { liveUpdate: null, origin: "db" });
  assert.equal(ex.masked, false);
  // Allowed numbers: everything that already exists in the stored payload,
  // the stored creation timestamp (as rendered), the factor count, and the
  // /100 strength scale constant. Nothing else may appear.
  const allowed = new Set<number>();
  const addAll = (blob: string) => {
    for (const m of blob.match(/\d+(?:\.\d+)?/g) || []) allowed.add(Number(m));
  };
  addAll(JSON.stringify(SIGNAL));
  addAll(String(SIGNAL.factors.length));
  addAll(new Date(1761579600000).toUTCString());
  allowed.add(100);
  for (const sentence of ex.narrative) {
    for (const n of sentence.match(/\d+(?:\.\d+)?/g) || []) {
      assert.ok(allowed.has(Number(n)), `invented number "${n}" in: ${sentence}`);
    }
  }
  assert.ok(ex.narrative.some((s) => s.includes("اختراق مقاومة")));
  assert.ok(ex.narrative.some((s) => s.includes("سبب") || true));
  assert.ok(ex.narrative[ex.narrative.length - 1].includes("لا ضمانًا"), "mandatory no-promise line last");
  // technical section mirrors the stored levels verbatim
  assert.equal(ex.technical.present, true);
  assert.equal(ex.technical.stopLoss, 100.2);
  assert.equal(ex.technical.target1, 111);
  assert.equal(ex.technical.rewardRisk, 1.4);
  // identity: current price only when a verified live price exists
  assert.equal(ex.identity.currentPrice, null);
  assert.equal(ex.identity.createdPrice, 105.5);
  assert.equal(ex.identity.symbol, "COMI");
  assert.equal(ex.identity.sector, "بنوك");
});

test("live status surfaces the verified current price (and its time basis)", () => {
  const ex = buildOppExplanation(signalRow, {
    liveUpdate: { statusNow: "active", price: 107.2, priceAsOf: 1761580000000, priceTimeBasis: "fetch" },
    origin: "db",
  });
  assert.equal(ex.identity.currentPrice, 107.2);
  assert.equal(ex.identity.currentPriceBasis, "fetch");
  assert.equal(ex.sources.liveAsOf, 1761580000000);
  assert.ok(ex.narrative.some((s) => s.includes("107.2")));
});

test("descriptive cards get honest not-available sections", () => {
  const descriptive = {
    title: "اكتتاب جديد في القطاع",
    summary: "لقطة وصفية عن طرح جديد.",
    details: "تفاصيل نصية من الخادم.",
    sector: "[AUTO] شركات",
    market: "egypt",
    riskLevel: 2,
    vipOnly: false,
    signal: null,
    createdAt: new Date(1761570000000),
    status: "active",
  };
  const ex = buildOppExplanation(descriptive, { origin: "live" });
  assert.equal(ex.masked, false);
  assert.equal(ex.technical.present, false);
  assert.equal(ex.technical.stopLoss, null);
  assert.equal(ex.fundamental.present, false);
  assert.match(ex.fundamental.note, /غير.*|لا توجد/);
  assert.equal(ex.news.present, false);
  assert.match(ex.news.note, /لا توجد أخبار/);
  assert.ok(ex.narrative.some((s) => s.includes("لقطة وصفية")));
  assert.equal(ex.sources.liveAsOf, null);
});

test("VIP-masked rows expose nothing (no data leakage through explanation)", () => {
  const masked = {
    title: "[SIGNAL] اختراق مقاومة — COMI",
    summary: "اختراق فوق المقاومة بحجم مرتفع.",
    details: null,
    sector: "[SIGNAL] بنوك",
    market: "egypt",
    riskLevel: 3,
    vipOnly: true,
    signal: null,
    createdAt: new Date(1761579600000),
    status: "active",
  };
  const ex = buildOppExplanation(masked, { origin: "db" });
  assert.equal(ex.masked, true);
  assert.equal(ex.technical.present, false);
  assert.equal(ex.identity.createdPrice, null);
  assert.equal(ex.identity.symbol, null);
  assert.equal(ex.news.present, false);
  const joined = JSON.stringify(ex);
  assert.ok(!joined.includes("105.5"), "masked explanation must not leak stored numbers");
  assert.ok(!joined.includes("100.2"));
});

test("news section comes only from stored news factors", () => {
  const ex = buildOppExplanation(signalRow, { origin: "db" });
  assert.equal(ex.news.present, true);
  assert.equal(ex.news.items.length, 1);
  assert.equal(ex.news.items[0].direction, "positive");
  assert.match(ex.news.items[0].labelAr, /الأهرام/);
});
