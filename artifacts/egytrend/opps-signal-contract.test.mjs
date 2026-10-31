/**
 * Contract test for the opportunity signal UI (TASK M — M5).
 *
 * The client extends the EXISTING /api/opportunities contract, never
 * replaces it: descriptive cards keep rendering exactly as before, and the
 * structured signal payload is an additive, field-by-field whitelisted
 * upgrade. These tests pin:
 *  - the three lifecycle states (realized/expired/cancelled) are accepted
 *    and the legacy three keep working;
 *  - a structured payload is only trusted on a [SIGNAL]-marked card with a
 *    complete numeric shape — anything malformed becomes prose, not a card;
 *  - the outcome history is rendered as a separate, kept section (rows are
 *    never hidden after they resolve);
 *  - the time-basis rule is the same as the markets board: a timestamp is
 *    labelled "source time" or "fetch time", never one as the other;
 *  - the no-guarantee wording is present in the signal detail body;
 *  - VIP masking: a null payload renders nothing structured (the server is
 *    the masking authority; the renderer must not re-invent it).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "index.html"), "utf8");
const oppsTs = readFileSync(join(here, "..", "api-server", "src", "routes", "opportunities.ts"), "utf8");

function functionBody(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.ok(start !== -1, `index.html must define ${name}`);
  let depth = 0;
  for (let i = html.indexOf("{", start); i < html.length; i += 1) {
    const ch = html[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return html.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

/* Evaluate normalizeOpportunity exactly as shipped, with its real
 * dependencies extracted the same way. */
function makeNormalizer() {
  const deps = {
    OPP_TYPES: { stock: 1, crypto: 1, commodity: 1, etf: 1 },
    OPP_MARKETS: { egypt: 1, us: 1, gulf: 1, crypto: 1, global: 1 },
    sanitize: (v) => String(v),
    autoObservationProvenance: functionBody("autoObservationProvenance"),
    normalizeOpportunity: functionBody("normalizeOpportunity"),
  };
  const factory = new Function(
    "OPP_TYPES", "OPP_MARKETS", "sanitize",
    `${deps.autoObservationProvenance}\n${deps.normalizeOpportunity}\nreturn normalizeOpportunity;`,
  );
  return factory(deps.OPP_TYPES, deps.OPP_MARKETS, deps.sanitize);
}

function baseRow(over = {}) {
  return {
    id: "opp-001",
    title: "بطاقة اختبار",
    summary: "ملخص مختصر",
    type: "crypto",
    market: "crypto",
    status: "active",
    riskLevel: 3,
    sector: "[SIGNAL] uptrend",
    ...over,
  };
}

const fullSignal = {
  signalType: "uptrend",
  signalTypeAr: "اتجاه صاعد",
  price: 110000,
  priceAsOf: 1793300000000,
  priceTimeBasis: "source",
  changePercent: 0.6,
  strength: 74,
  strengthLabelAr: "قوي",
  factors: [{ labelAr: "سعر فوق متوسط 20", points: 10 }, { labelAr: "متوسط صاعد", points: 8 }],
  entry: { low: 105800, high: 110000, noteAr: "ارتداد المتوسط" },
  stopLoss: 105278,
  targets: { t1: 113541, t2: 117083 },
  rewardRisk: 1.4,
  timeframeAr: "متوسط (أسابيع)",
  scenarioPositiveAr: "إذا حافظ السعر على 105800...",
  scenarioNegativeAr: "إذا كسر السعر 105278 فإن الفكرة ملغاة — لا ضمان لأي نتيجة.",
  dataSources: [
    { name: "سجل التداول اليومي", asOf: 1793200000000, basis: "history" },
    { name: "Signal Board", asOf: 1793300000000, basis: "source" },
  ],
};

test("the legacy three statuses keep working; the three lifecycle states are accepted", () => {
  const normalize = makeNormalizer();
  assert.equal(normalize(baseRow({ status: "active" })).status, "active");
  assert.equal(normalize(baseRow({ status: "coming" })).status, "coming");
  assert.equal(normalize(baseRow({ status: "closed" })).status, "closed");
  assert.equal(normalize(baseRow({ status: "realized" })).status, "realized");
  assert.equal(normalize(baseRow({ status: "expired" })).status, "expired");
  assert.equal(normalize(baseRow({ status: "cancelled" })).status, "cancelled");
  assert.equal(normalize(baseRow({ status: "bogus-state" })).status, "active", "unknown values fall back exactly as before");
});

test("a complete signal payload on a [SIGNAL] card is whitelisted into the row", () => {
  const normalize = makeNormalizer();
  const row = normalize(baseRow({ signal: fullSignal, result: null, realizedAt: null }));
  assert.equal(row.isSignalCard, true);
  assert.ok(row.signal, "the structured payload survives normalization");
  assert.equal(row.signal.signalType, "uptrend");
  assert.equal(row.signal.strength, 74);
  assert.equal(row.signal.entryLow, 105800);
  assert.equal(row.signal.stopLoss, 105278);
  assert.equal(row.signal.target1, 113541);
  assert.equal(row.signal.target2, 117083);
  assert.equal(row.signal.factors.length, 2);
  assert.equal(row.signal.dataSources.length, 2);
  assert.equal(row.signal.priceTimeBasis, "source");
  assert.equal(row.autoObservation, true, "[SIGNAL] cards take the sourced-observation treatment");
});

test("a signal payload without the [SIGNAL] marker is dropped (prose cards can never claim a signal)", () => {
  const normalize = makeNormalizer();
  const row = normalize(baseRow({ sector: "تقنية", signal: fullSignal }));
  assert.equal(row.isSignalCard, false);
  assert.equal(row.signal, null);
});

test("an incomplete or malformed payload becomes prose, never a broken card", () => {
  const normalize = makeNormalizer();
  const drop = (over) => {
    const row = normalize(baseRow(over));
    assert.equal(row.signal, null, JSON.stringify(over));
  };
  drop({ signal: null });
  drop({ signal: "uptrend" });
  drop({ signal: { ...fullSignal, stopLoss: undefined } });
  drop({ signal: { ...fullSignal, targets: { t1: "113541" } } });
  drop({ signal: { ...fullSignal, entry: { low: 0, high: 110000 } } });
  drop({ signal: { ...fullSignal, signalType: "pump" } });
  /* Out-of-scale values are clamped to the 0–100 display scale (the server
   * itself only emits 5–95) — the card stays valid, the number stays honest. */
  const clamped = normalize(baseRow({ signal: { ...fullSignal, strength: 999 } }));
  assert.equal(clamped.signal?.strength, 100, "an out-of-scale strength clamps to 100, it is never dropped silently");
  /* The row itself stays valid: title/summary render, status untouched. */
  const row = normalize(baseRow({ signal: "garbage" }));
  assert.ok(row.title && row.summary);
  assert.equal(row.status, "active");
});

test("liveUpdate is whitelisted too and bounded to the three real states", () => {
  const normalize = makeNormalizer();
  const ok = normalize(baseRow({ liveUpdate: { statusNow: "active", noteAr: "ساري", price: 110000, priceAsOf: 1793300000000, priceTimeBasis: "fetch" } }));
  assert.equal(ok.liveUpdate.statusNow, "active");
  assert.equal(ok.liveUpdate.price, 110000);
  assert.equal(ok.liveUpdate.priceTimeBasis, "fetch");
  assert.equal(normalize(baseRow({ liveUpdate: { statusNow: "moon" } })).liveUpdate, null);
  assert.equal(normalize(baseRow({ liveUpdate: "x" })).liveUpdate, null);
});

test("terminal states keep their result vocabulary and the crossing time", () => {
  const normalize = makeNormalizer();
  const row = normalize(baseRow({ status: "realized", result: "target_hit", realizedAt: 1793310000000 }));
  assert.equal(row.result, "target_hit");
  assert.equal(row.realizedAt, 1793310000000);
  assert.equal(normalize(baseRow({ result: "lucky" })).result, null, "no other result strings exist");
});

test("the list renders a kept outcome-history section; resolved rows are dimmed, not removed", () => {
  const render = functionBody("renderOpps");
  assert.ok(render.includes("السجل والنتائج"), "the history section header exists");
  assert.ok(render.includes("history.map(cardHtml)"), "terminal rows are rendered in the history section");
  assert.ok(render.includes(`statusBadge?" dimmed":""`), "terminal cards are visually marked as results");
});

test("the opportunity detail page states no-guarantee wording and the time-basis labels", () => {
  /* The detail page is now section-based (oppDetailSections): stored levels,
   * stored indicators, and the mandatory disclaimer. */
  const sections = functionBody("oppDetailSections");
  assert.ok(sections.includes("المستويات (الدخول والأهداف والوقف)"), "the levels section exists (entry/stop/targets)");
  assert.ok(sections.includes("التحليل الفني والمؤشرات (قيم فعلية محفوظة)"), "indicators are labelled as stored actual values");
  assert.ok(sections.includes("السعر الحالي (موثق)"), "the current price line is marked as verified");
  assert.ok(sections.includes("تُعاد بناؤها من بيانات السوق وقت الطلب"), "a live-origin row is labelled as rebuilt from market data");
  const fmt = functionBody("oppFmtTime");
  assert.ok(fmt.includes('basis==="fetch"?"وقت الجلب":"وقت المصدر"'), "a timestamp is always labelled source-vs-fetch time");
  /* The no-guarantee line rides in the server explanation AND is pinned here. */
  assert.ok(html.includes("لا ضمانًا لأي ربح"), "the UI copy carries the no-guarantee wording");
  assert.ok(sections.includes("ex.disclaimer"), "the server-built disclaimer is rendered");
});

test("VIP masking is a server concern: the renderer consumes null payloads without inventing content", () => {
  const normalize = makeNormalizer();
  /* What a masked (non-VIP) response looks like: the structured fields are
   * simply absent. The card must still render from its prose fields. */
  const row = normalize(baseRow({ sector: "[SIGNAL] uptrend", signal: null, liveUpdate: null, details: null }));
  assert.equal(row.signal, null);
  assert.equal(row.liveUpdate, null);
  assert.ok(row.title, "the title remains visible for the upsell view");
  /* The server masks exactly these three fields for non-VIP readers. */
  assert.ok(oppsTs.includes("{ ...o, details: null, signal: null, liveUpdate: null }"), "server mask strips details+signal+liveUpdate");
});

test("the server never writes a projected return on new cards", () => {
  assert.ok(oppsTs.includes("expectedReturn: null"), "new cards keep expectedReturn null");
  assert.ok(!/expectedReturn:\s*(?!null)[A-Za-z_$]/.test(oppsTs.split("runGenerationPipeline")[1] || ""), "the pipeline never assigns a return value");
});

test("dedupe key format is pinned client-visible: instrument:type:cairo-day", () => {
  assert.ok(oppsTs.includes("dedupeKey"), "the server carries the dedupe key");
  const signalsTs = readFileSync(join(here, "..", "api-server", "src", "lib", "opp-signals.ts"), "utf8");
  assert.ok(signalsTs.includes("dedupeKey: `${quote.instrumentId}:${signal.signalType}:${cairoDay}`"));
});

test("no market-data provider endpoint or key reaches the opportunity UI", () => {
  /* The opportunities page talks to /api/opportunities only. */
  const oppSection = html.slice(html.indexOf('fetch("/api/opportunities"'));
  const end = oppSection.indexOf("function setOppFilter");
  assert.ok(end > 0);
  const section = oppSection.slice(0, end);
  assert.ok(!/er-api|query\.yahoo|coingecko|twelvedata|x-api-key/i.test(section), "no third-party market endpoint in the opps client code");
});
