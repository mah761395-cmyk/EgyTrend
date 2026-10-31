/**
 * Contract test for the shared visual-analytics primitives and the simple
 * portfolio's allocation bar.
 *
 * The chart builders live in the inline script of index.html, so a build cannot
 * catch a chart that silently invents a value. This test does two things:
 *
 *   1. executes the real analytics functions in a sandbox with a fixture
 *      portfolio, and checks the numbers against an independent calculation;
 *   2. pins the product rules the charts must never break — an incomplete
 *      series renders an explicit empty state, unpriced positions are flagged
 *      (never silently valued), and nothing here grants or edits an
 *      entitlement.
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

/* Shared primitives + the simple-portfolio renderers (declarations only —
 * evaluated, never invoked, except the functions under test). */
const analyticsSource =
  slice("VISUAL ANALYTICS — shared chart primitives", "function cairoTodayStr(){" );

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
  "U", "egxStocksFreshness", "document", "safeJsArg", "ltrChange",
  `${analyticsSource}
  return {
    vaFmt, vaCompact, vaPct, vaDaysLabel, vaCard, vaEmpty,
    vaLineChart, vaDonut, vaSignedBars,
    portStats, nfpAllocHtml,
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
  (value) => String(value ?? ""),
);

test("the allocation bar values priced positions at verified quotes and flags cost-drawn rows", () => {
  const bar = api.nfpAllocHtml(POSITIONS, { cash: 0 });
  assert.match(bar, /nfp-alloc-bar/, "the bar is drawn");
  assert.ok(bar.includes("10,000 ج"), "COMI valued at the verified quote (100 × 100)");
  assert.ok(bar.includes("2,500 ج"), "TMGH valued at the verified quote (50 × 50)");
  assert.ok(bar.includes("2,000 ج"), "ETEL shown at its recorded cost (200 × 10)");
  assert.match(bar, /بلا سعر — معروض بالتكلفة/, "the unpriced position is flagged as cost-drawn");
  assert.match(bar, /nfp-alloc-cost/, "cost-drawn segments get a distinct style");
  assert.match(bar, /حصة كل جزء من محفظتك \(14,500 ج\.م\)/, "one clearly-labelled base sums all segments");

  const withCash = api.nfpAllocHtml(POSITIONS, { cash: 500 });
  assert.match(withCash, /النقدية/, "cash appears as its own segment");
  assert.match(withCash, /حصة كل جزء من محفظتك \(15,000 ج\.م\)/, "cash is included in the labelled base");
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

  /* The simple portfolio names its price source (with time) in the hero and
     says so explicitly when no source is available. */
  assert.match(analyticsSource, /heroSourceLine\(\)/, "hero carries the named source line");
  assert.match(analyticsSource, /لا توجد مراكز قائمة بسعر سوق الآن/, "honest note when no quote source exists");
  assert.match(analyticsSource, /مصدر الأسعار غير متاح حاليًا/, "honest note when the feed is unavailable");
});

test("chart code never fabricates values and never grants an entitlement", () => {
  assert.ok(!/Math\.random/.test(analyticsSource), "no randomised or demo series");
  assert.ok(!/localStorage/.test(analyticsSource), "chart state is not persisted as entitlement");
  assert.ok(!/\.plan\s*=(?!=)/.test(analyticsSource), "the client never writes a plan");
  assert.ok(!/vipExpiresAt\s*=(?!=)/.test(analyticsSource), "the client never writes an expiry");
  /* While any held position lacks a verified quote the P/L is hidden (not
   * partially computed) and unpriced segments are flagged, not invented. */
  assert.match(analyticsSource, /un===null/, "P/L hidden while a position is unpriced");
  assert.match(analyticsSource, /بلا سعر/, "unpriced states are explicitly labelled");
  assert.match(analyticsSource, /nfp-alloc-cost/, "cost-drawn allocation segments are styled as such");
});

