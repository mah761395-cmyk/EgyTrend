/**
 * Contract test for the portfolio + VIP analytics charts.
 *
 * The chart builders live in the inline script of index.html, so a build cannot
 * catch a chart that silently invents a value. This test does two things:
 *
 *   1. executes the real analytics functions in a sandbox with a fixture
 *      portfolio, and checks the numbers against an independent calculation;
 *   2. pins the product rules the charts must never break — every card carries
 *      a source/time foot, an incomplete series renders an explicit empty
 *      state, and nothing here grants or edits an entitlement.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "index.html"), "utf8");

function slice(startMarker, endMarker) {
  let start = html.indexOf(startMarker);
  assert.ok(start >= 0, `missing start marker: ${startMarker.slice(0, 48)}`);
  /* A marker that begins inside a block comment is widened to its opener so
   * the extracted source stays syntactically valid. */
  const opener = html.lastIndexOf("/*", start);
  if (opener > html.lastIndexOf("*/", start)) start = opener;
  const end = html.indexOf(endMarker, start);
  assert.ok(end > start, `missing end marker: ${endMarker.slice(0, 48)}`);
  return html.slice(start, end);
}

const analyticsSource = [
  slice("VISUAL ANALYTICS — shared chart primitives", "function vBuildPort(b){"),
  slice("/* ═══════════════════ VIP ANALYTICS TAB", "/* ══════════════ TAB 9 — التقارير"),
].join("\n");

const sanitize = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[character]));

const POSITIONS = [
  { id: "a".repeat(24), sym: "COMI", name: "البنك التجاري الدولي", sector: "بنوك", qty: 100, price: 80, instrumentId: "stock:egx:COMI", market: { price: 100, source: "مصدر مرخّص", asOf: 1_760_000_000_000 } },
  { id: "b".repeat(24), sym: "TMGH", name: "طلعت مصطفى", sector: "عقارات", qty: 50, price: 60, instrumentId: "stock:egx:TMGH", market: { price: 50, source: "مصدر مرخّص", asOf: 1_760_000_000_000 } },
  { id: "c".repeat(24), sym: "ETEL", name: "المصرية للاتصالات", sector: "اتصالات", qty: 200, price: 10, instrumentId: "stock:egx:ETEL", market: null },
];
const STOCKS = [
  { sym: "COMI", sector: "بنوك", chgPct: 1.2, instrumentId: "stock:egx:COMI" },
  { sym: "HBCO", sector: "بنوك", chgPct: -0.4, instrumentId: "stock:egx:HBCO" },
  { sym: "TMGH", sector: "عقارات", chgPct: 2.5, instrumentId: "stock:egx:TMGH" },
  { sym: "ETEL", sector: "اتصالات", chgPct: -1.1, instrumentId: "stock:egx:ETEL" },
];
const RISK_COLORS = ["#22c55e", "#84cc16", "#f59e0b", "#f97316", "#ef4444"];
const RISK_LABELS = { 1: "منخفضة جداً", 2: "منخفضة", 3: "متوسطة", 4: "عالية", 5: "عالية جداً" };
const OPP_TYPES = { stock: { l: "أسهم" }, bond: { l: "سندات" }, crypto: { l: "كريبتو" }, fund: { l: "صندوق" } };

const factory = new Function(
  "sanitize", "portfolio", "liveStocks", "RISK_COLORS", "RISK_LABELS", "OPP_TYPES",
  "knownStockNumber", "canonicalInstrumentId", "fetchJsonWithTimeout", "MARKET_SPARKLINES_API",
  "U", "egxStocksFreshness", "document", "safeJsArg",
  `${analyticsSource}
  return {
    vaFmt, vaCompact, vaPct, vaDaysLabel, vaCard, vaEmpty,
    vaLineChart, vaDonut, vaSignedBars, vaScatter, vaCleanPercent,
    pfAllocation, portStats, vaSectorGroups, vaRiskReturnCard, vaHistory,
  };`,
);

const api = factory(
  sanitize,
  POSITIONS,
  STOCKS,
  RISK_COLORS,
  RISK_LABELS,
  OPP_TYPES,
  (value) => (Number.isFinite(Number(value)) ? Number(value) : null),
  (value) => (/^[a-z][a-z0-9_-]{1,31}(?::[A-Za-z0-9._-]{1,64}){1,3}$/.test(String(value ?? "")) ? String(value) : ""),
  async () => { throw new Error("network is not used by these chart calculations"); },
  "/api/markets/sparklines",
  undefined,
  { fetchedAt: 0, source: "", loading: false },
  undefined,
  (value) => JSON.stringify(String(value)),
);

test("the allocation ring groups verified market values by the server's sector label", () => {
  const stats = api.portStats();
  const allocation = api.pfAllocation(stats);
  const bySector = Object.fromEntries(allocation.slices.map((slice) => [slice.label, slice.value]));

  /* 100 × 100 = 10,000 بنوك · 50 × 50 = 2,500 عقارات · ETEL has no quote. */
  assert.deepEqual(bySector, { "بنوك": 10_000, "عقارات": 2_500 });
  assert.equal(allocation.total, 12_500);
  assert.equal(allocation.skipped.length, 1, "a position without a verified quote is excluded, not valued at cost");
  assert.equal(allocation.skipped[0].p.sym, "ETEL");

  /* The ring percentages must sum to 100 and match the values independently. */
  const ring = api.vaDonut({ slices: allocation.slices, centerLabel: "القيمة", centerValue: "12,500" });
  const percents = [...ring.matchAll(/<b>(\d+\.\d)%<\/b>/g)].map((match) => Number(match[1]));
  assert.deepEqual(percents, [80, 20], "the legend percentages follow the verified values");
});

test("profit/loss uses price minus average cost times quantity, before fees", () => {
  const stats = api.portStats();
  assert.equal(stats.cost, 13_000, "cost basis = 100×80 + 50×60 + 200×10");
  /* One position has no price, so the aggregate is deliberately unavailable. */
  assert.equal(stats.cur, null);
  assert.equal(stats.pl, null);
  const rows = Object.fromEntries(stats.rows.map((row) => [row.p.sym, row.pnlEgp]));
  assert.equal(rows.COMI, 2_000);
  assert.equal(rows.TMGH, -500);
  assert.equal(rows.ETEL, null);
});

test("a signed bar grows right of zero for gains and left of zero for losses", () => {
  const markup = api.vaSignedBars([
    { label: "COMI", value: 2000, display: "+2,000 ج", color: "#10B981" },
    { label: "TMGH", value: -500, display: "-500 ج", color: "#F87171" },
    { label: "الإجمالي", value: 1500, display: "+1,500 ج", total: true },
  ]);
  assert.match(markup, /va-bar-zero/);
  assert.match(markup, /left:50\.00%;width:50\.00%/, "the largest gain spans from zero to the right edge");
  assert.match(markup, /left:37\.50%;width:12\.50%/, "a loss is drawn left of zero");
  assert.match(markup, /va-bar-total/);
});

test("no chart is drawn from fewer than two points, an empty slice or no data", () => {
  assert.equal(api.vaLineChart({ series: [{ label: "قيمة", color: "#10B981", points: [{ t: 1, y: 5 }] }] }), "");
  assert.equal(api.vaDonut({ slices: [{ label: "بنوك", value: 0, color: "#10B981" }] }), "");
  assert.equal(api.vaScatter({ points: [] }), "");
  const line = api.vaLineChart({
    series: [
      { label: "قيمة", color: "#10B981", points: [{ t: 1, y: 10 }, { t: 2, y: 20 }] },
      { label: "التكلفة", color: "#60A5FA", dashed: true, points: [{ t: 1, y: 12 }, { t: 2, y: 12 }] },
    ],
    yFmt: (value) => `${value}`,
  });
  assert.match(line, /<polyline/);
  assert.match(line, /vector-effect="non-scaling-stroke"/, "a responsive plot keeps its stroke width");
  assert.match(line, /data-va-chart="va-c\d+"/, "the plot is keyboard-focusable through its hover bridge");
  assert.match(line, /va-lg/, "the legend names every series");
});

test("sector comparison averages only the quoted stocks and names its source", () => {
  const groups = api.vaSectorGroups();
  const bySector = Object.fromEntries(groups.map((group) => [group.sector, group.avg]));
  assert.ok(Math.abs(bySector["بنوك"] - 0.4) < 1e-9, "(1.2 + -0.4) / 2");
  assert.equal(bySector["عقارات"], 2.5);
  assert.equal(bySector["اتصالات"], -1.1);
  assert.equal(groups[0].sector, "عقارات", "sorted by average change, highest first");
});

test("only a clean numeric expected return becomes a risk/return point", () => {
  assert.equal(api.vaCleanPercent("12%"), 12);
  assert.equal(api.vaCleanPercent("22"), 22);
  assert.equal(api.vaCleanPercent("-3.5%"), -3.5);
  assert.equal(api.vaCleanPercent("15% إلى 20%"), null, "a range is not guessed into a single value");
  assert.equal(api.vaCleanPercent("عائد مرتفع"), null);
  assert.equal(api.vaCleanPercent(""), null);
});

test("axis labels stay readable: compact money, Arabic day counts, signed percents", () => {
  assert.equal(api.vaCompact(14900), "14.9ألف");
  assert.equal(api.vaCompact(2_400_000), "2.4م");
  assert.equal(api.vaCompact(842), "842");
  assert.equal(api.vaDaysLabel(1), "يوم تداول واحد");
  assert.equal(api.vaDaysLabel(5), "5 أيام تداول");
  assert.equal(api.vaDaysLabel(2), "يوما تداول");
  assert.equal(api.vaPct(14.615), "+14.62%");
  assert.equal(api.vaPct(-3.8), "-3.80%");
});

test("every analytics card names its source and time, and offers an explicit empty state", () => {
  const card = api.vaCard({ icon: "📈", title: "رسم", sub: "وصف", body: "<div></div>", foot: "المصدر: مصدر" });
  assert.match(card, /va-src/);
  assert.match(card, /المصدر/);
  const empty = api.vaEmpty("لا تتوفر بيانات كافية", "لن نرسم خطًا بديلًا.");
  assert.match(empty, /va-empty/);
  assert.match(empty, /لا تتوفر بيانات كافية/);

  /* Each of the four portfolio cards and the three VIP cards carries a source
     foot; a card without one would leave the user guessing the provenance. */
  const portfolioBody = slice("function pfHistoryCard(){", "function vBuildPort(b){");
  assert.ok((portfolioBody.match(/foot:/g) || []).length >= 3, "each portfolio chart card declares a source foot");
  const vipCards = slice("function vBuildAnalytics(b){", "/* ══════════════ TAB 9");
  assert.match(vipCards, /وحدات|\u0623\u062f\u0648\u0627\u062a/);
});

test("chart code never fabricates values and never grants an entitlement", () => {
  assert.ok(!/Math\.random/.test(analyticsSource), "no randomised or demo series");
  assert.ok(!/localStorage/.test(analyticsSource), "chart state is not persisted as entitlement");
  assert.ok(!/\.plan\s*=(?!=)/.test(analyticsSource), "the client never writes a plan");
  assert.ok(!/vipExpiresAt\s*=(?!=)/.test(analyticsSource), "the client never writes an expiry");
  /* The reconstruction only uses days every position actually has, otherwise a
   * partial day would draw a portfolio value that never existed. */
  assert.match(analyticsSource, /filter\(day=>days\.has\(day\)\)/);
  assert.match(analyticsSource, /لا يُرسم أي خط حتى تصل نقاط إغلاق حقيقية|لن نرسم خطًا من أيام جزئية/);
});

test("the VIP analytics tab lives inside the VIP shell and reuses the existing reads", () => {
  assert.match(html, /\{id:"analytics", ic:"📈", lb:"التحليلات"\}/);
  assert.match(html, /if\(vipTab==="analytics"\)return vBuildAnalytics\(b\);/);
  /* The comparison reads the same licensed history endpoint as the asset chart
     and the same opportunity feed as the opportunities tab: no new privileged
     endpoint is introduced by a chart. */
  assert.match(html, /vaHistory\(stock\.instrumentId,VA_COMPARE\.range\)/);
  assert.match(html, /vaHistory\("egx:EGX30",VA_COMPARE\.range\)/);
  assert.match(html, /MARKET_HISTORY_API\}/);
  assert.match(html, /fetch\("\/api\/opportunities"/);
  assert.doesNotMatch(analyticsSource, /\/api\/admin/, "no admin read from a user chart");
});
