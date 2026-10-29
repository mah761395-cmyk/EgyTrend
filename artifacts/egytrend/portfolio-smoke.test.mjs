/* Runtime smoke test (no browser available in this sandbox):
 * load the whole inline app script under a Proxy-based DOM stub, then invoke
 * the new portfolio render functions with synthetic, honestly-shaped data and
 * assert the produced HTML is sane. Catches runtime errors (undefined vars,
 * bad template refs, typos) that static checks cannot.
 */
import vm from "node:vm";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const scripts = [...html.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const app = scripts.find(s => s.length > 100000);
assert.ok(app, "main inline script found");

function makeEl() {
  /* textContent/innerHTML keep real state: the app's `sanitize` encodes via
   * the DOM (span.textContent → span.innerHTML), so the stub must emulate
   * that round-trip instead of returning "". */
  const state = { text: null, html: "" };
  const escapeHtml = v => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const handler = {
    get(t, prop) {
      if (prop === Symbol.toPrimitive) return () => "";
      if (prop === "textContent") return state.text ?? "";
      if (prop === "innerHTML") return state.text !== null ? escapeHtml(state.text) : state.html;
      if (prop === "value" || prop === "id") return "";
      if (prop === "classList") return { add() {}, remove() {}, toggle() {}, contains: () => false };
      if (prop === "style") return new Proxy({}, { get: () => "", set: () => true });
      if (prop === "dataset") return {};
      if (prop === "querySelectorAll" || prop === "children" || prop === "childNodes") return [];
      if (prop === "clientWidth" || prop === "offsetWidth" || prop === "offsetHeight") return 100;
      if (prop === "getBoundingClientRect") return () => ({ left: 0, top: 0, width: 100, height: 100 });
      if (prop === "querySelector") return () => makeEl();
      if (prop === "getAttribute" || prop === "getContext") return () => null;
      if (prop === "addEventListener" || prop === "removeEventListener" || prop === "focus" || prop === "blur" || prop === "click" || prop === "scrollIntoView" || prop === "append" || prop === "appendChild" || prop === "remove" || prop === "select" || prop === "setSelectionRange" || prop === "insertAdjacentHTML" || prop === "closest" || prop === "contains" || prop === "dispatchEvent") return () => {};
      return makeEl();
    },
    set(t, prop, value) {
      if (prop === "textContent") { state.text = String(value); state.html = ""; return true; }
      if (prop === "innerHTML") { state.html = String(value); state.text = null; return true; }
      return true;
    },
    apply() { return makeEl(); },
  };
  return new Proxy(function () {}, handler);
}

const documentStub = new Proxy({}, {
  get(t, prop) {
    if (prop === "getElementById" || prop === "createElement" || prop === "querySelector" || prop === "createTextNode") return () => makeEl();
    if (prop === "querySelectorAll" || prop === "getElementsByClassName" || prop === "getElementsByName" || prop === "elements") return () => [];
    if (prop === "addEventListener" || prop === "removeEventListener" || prop === "write" || prop === "cookie") return () => {};
    if (prop === "body" || prop === "documentElement" || prop === "head" || prop === "activeElement") return makeEl();
    return makeEl();
  },
  set() { return true; },
});

const sandbox = {
  document: documentStub,
  navigator: { userAgent: "node-smoke", language: "ar-EG", clipboard: { writeText: () => Promise.resolve() } },
  location: { href: "http://localhost/", origin: "http://localhost", host: "localhost", protocol: "http:", pathname: "/", search: "", hash: "" },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {}, clear() {} },
  fetch: () => new Promise(() => {}),
  AbortController,
  setTimeout, clearTimeout, setInterval, clearInterval,
  console,
  URL, URLSearchParams, Headers, Request, Response,
  crypto: { getRandomValues: (a) => a, randomUUID: () => "smoke-uuid", subtle: {} },
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
  alert() {}, confirm: () => false, prompt: () => null,
  requestAnimationFrame: () => 0, cancelAnimationFrame() {},
  Image: function () { return makeEl(); },
  performance: { now: () => Date.now() },
  MutationObserver: class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } },
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } },
  addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
  parseInt, parseFloat, isNaN, Number, String, Object, Array, Math, Date, JSON, Map, Set, Promise, RegExp, Error,
};
sandbox.window = sandbox;
sandbox.self = sandbox;
sandbox.globalThis = sandbox;

const ctx = vm.createContext(sandbox);
let topLevelError = null;
try {
  vm.runInContext(app, ctx, { timeout: 15000 });
} catch (e) {
  topLevelError = e; // function declarations are hoisted; init-code throws are acceptable
}

/* ── seed honest synthetic state ─────────────────────────────────────────── */
const ts = Date.parse("2026-10-28T12:30:00Z");
vm.runInContext(`
  U = { sub: 7, plan: "vip", name: "Smoke" };
  portfolio = [
    { id: "pos:" + "a".repeat(30), sym: "COMI", name: "المصرية للإسمنت", sector: "مواد بناء", qty: 140, price: 12.05, instrumentId: "egx:COMI",
      market: { price: 13.4, source: "tv", asOf: ${ts}, delayedMinutes: 15, freshness: "delayed" },
      closed: false, legacy: false, costBasis: 1687, realizedPnl: 172, totalFees: 15, buyCount: 2, sellCount: 1,
      marketValue: 1876, unrealizedPnl: 189, unrealizedPnlPct: 11.18, weightPct: 52.3 },
    { id: "pos:" + "b".repeat(30), sym: "HLDI", name: "حديد مصر", sector: "صناعات", qty: 60, price: 20.2, instrumentId: "egx:HLDI",
      market: { price: 21.1, source: "tv", asOf: ${ts}, delayedMinutes: 15, freshness: "delayed" },
      closed: false, legacy: false, costBasis: 1212, realizedPnl: 0, totalFees: 0, buyCount: 1, sellCount: 0,
      marketValue: 1266, unrealizedPnl: 54, unrealizedPnlPct: 4.46, weightPct: 33.8 },
    { id: "pos:" + "c".repeat(30), sym: "ETBS", name: "إيچيبت للتأمين", sector: "تأمين", qty: 0, price: 0, instrumentId: "egx:ETBS",
      market: null,
      closed: true, legacy: false, costBasis: 0, realizedPnl: -310, totalFees: 8, buyCount: 1, sellCount: 1,
      marketValue: null, unrealizedPnl: null, unrealizedPnlPct: null, weightPct: null },
  ];
  portfolioData = {
    summary: { cash: 412, investedCost: 2899, totalBuyOutlay: 3622, costBasisSold: 723,
      pricedMarketValue: 1876, marketValue: 2065, totalValue: 2477, totalValuePriced: 2288,
      unrealizedPnl: 189, unrealizedPnlPriced: 189, realizedPnl: -138, totalFees: 23,
      buyCount: 4, sellCount: 2, topConcentrationPct: 52.3, missingPriceSymbols: ["HLDI"] },
    transactions: [
      { id: "tx1", symbol: "COMI", side: "buy", quantity: 100, price: 10, fees: 10, tradeDate: "2026-09-01", note: null, realizedPnl: null, heldAfter: 100, createdAt: "2026-09-01T09:00:00Z", updatedAt: "2026-09-01T09:00:00Z" },
      { id: "tx2", symbol: "COMI", side: "buy", quantity: 100, price: 14, fees: 0, tradeDate: "2026-09-05", note: null, realizedPnl: null, heldAfter: 200, createdAt: "2026-09-05T09:00:00Z", updatedAt: "2026-09-05T09:00:00Z" },
      { id: "tx3", symbol: "COMI", side: "sell", quantity: 60, price: 15, fees: 5, tradeDate: "2026-09-10", note: null, realizedPnl: 172, heldAfter: 140, createdAt: "2026-09-10T09:00:00Z", updatedAt: "2026-09-10T09:00:00Z" },
    ],
    settings: { startingCash: 0 }, marketAvailable: true, legacyPositions: false,
  };
  portfolioState = { loaded: true, loading: false, error: "", marketAvailable: true };
  liveStocks = [
    { sym: "COMI", name: "المصرية للإسمنت", sector: "مواد بناء", price: 13.4, source: "tv", ts: ${ts}, noData: false },
    { sym: "HLDI", name: "حديد مصر", sector: "صناعات", price: 21.1, source: "tv", ts: ${ts}, noData: false },
  ];
  portHistory = Object.assign({}, PF_HISTORY_INIT, { status: "unavailable", reason: "insufficient_history", missing: [] });
  VA_SERIES_CACHE.set("egx:ETBS", { available: true, points: [
    { time: "2026-09-01", t: ${Date.parse("2026-09-01T00:00:00Z")}, close: 10.0 },
    { time: "2026-09-10", t: ${Date.parse("2026-09-10T00:00:00Z")}, close: 9.5 },
    { time: "2026-09-20", t: ${Date.parse("2026-09-20T00:00:00Z")}, close: 9.2 },
  ], source: "tv", asOf: ${ts} });
  portPosDetail = "ETBS";
`, ctx);

/* ── scenario 1: every held position fully priced ───────────────────────── */
const full = vm.runInContext(`
  (function () {
    const out = {};
    const st = portStats();
    out.returnPct = portReturnPct();
    out.kpis = portKpis(st);
    out.analytics = portAnalyticsBody();
    out.table = portPositionsTable();
    out.rows = portPosRows().map(p => p.sym);
    return out;
  })()
`, ctx);

assert.equal(typeof full.returnPct, "number", "return % computed when all inputs present");
const expectedReturn = ((-138 + 189) / 3622) * 100;
assert.ok(Math.abs(full.returnPct - expectedReturn) < 1e-6, `return % ≈ ${expectedReturn.toFixed(4)} got ${full.returnPct}`);

assert.ok(full.kpis.includes("تكلفة المراكز القائمة"), "cost card rendered");
assert.ok(full.kpis.includes("العائد على التكلفة المنصرفة"), "return card rendered");

assert.ok(full.analytics.includes("توزيع المحفظة حسب القطاع"), "sector donut card");
assert.ok(full.analytics.includes("التكلفة مقابل القيمة السوقية"), "cost-vs-market card");
assert.ok(full.analytics.includes("COMI") && full.analytics.includes("HLDI"), "cost-vs-market lists both priced assets");
assert.ok(full.analytics.includes("تطور قيمة المحفظة"), "history card present (honest empty state)");

assert.ok(full.table.includes("port-pos-search"), "table search input");
assert.ok(full.table.includes("portPosSortToggle"), "sort toggles");
assert.ok(full.table.includes("التكلفة المتبقية") && full.table.includes("القيمة الحالية") && full.table.includes("التحديث"), "required columns");
assert.ok(full.table.includes("portAddAssetFocus"), "add-asset button in table header");
assert.ok(full.table.includes("سجل عمليات هذا الأصل"), "detail panel with trade history present");
assert.ok(full.table.includes("الإغلاق اليومي") || full.table.includes("لا يتوفر سجل إغلاق يومي"), "detail performance section (licensed or honest note)");
assert.ok(full.table.includes("مغلق"), "closed chip for the fully-sold symbol");
/* vm realm arrays have foreign prototypes → normalize before deepEqual */
assert.deepEqual(JSON.parse(JSON.stringify(full.rows)), ["COMI", "HLDI"], "default filter 'held' excludes the closed symbol; priced rows first");
const allRows = vm.runInContext(`
  (function () { portPosFilter = "all"; const r = portPosRows().map(p => p.sym); portPosFilter = "held"; return r; })()
`, ctx);
assert.deepEqual(JSON.parse(JSON.stringify(allRows)), ["COMI", "HLDI", "ETBS"], "filter 'all' keeps the closed symbol, sorted last (no price)");

/* ── scenario 2: one held position without a verified quote ─────────────── */
const partial = vm.runInContext(`
  (function () {
    const hldi = portfolio.find(p => p.sym === "HLDI");
    hldi.market = null;
    hldi.marketValue = null;
    hldi.unrealizedPnl = null;
    hldi.unrealizedPnlPct = null;
    hldi.weightPct = null;
    portfolioData.summary.unrealizedPnl = null;
    portfolioData.summary.totalValue = null;
    portfolioData.summary.missingPriceSymbols = ["HLDI"];
    const out = {};
    const st = portStats();
    out.returnPct = portReturnPct();
    out.kpis = portKpis(st);
    out.analytics = portAnalyticsBody();
    out.table = portPositionsTable();
    return out;
  })()
`, ctx);

assert.equal(partial.returnPct, null, "return % is null (not a partial fabricated %) while a held position lacks a verified price");
assert.ok(partial.kpis.includes("HLDI"), "KPI footer flags the missing-price symbol");
assert.ok(partial.analytics.includes("مستبعَد"), "allocation excludes the unpriced position with an explicit note");
const hldiRow = (partial.table.split(">HLDI<")[1] || partial.table.split("HLDI")[1]) || "";
assert.ok(hldiRow.includes("—"), "unpriced row shows — instead of a price/value");
assert.ok(!partial.table.includes("12.05 ج × 60"), "no invented value for the unpriced row");

/* ── detail panel: per-symbol history + licensed performance ────────────── */
const detail = vm.runInContext(`portPosDetailPanel()`, ctx);
assert.ok(detail.includes("سجل عمليات هذا الأصل"), "detail: per-symbol history header");
assert.ok(detail.includes("الإغلاق اليومي"), "detail: licensed daily line chart rendered from cache");
assert.ok(detail.includes("لا عمليات مسجّلة لهذا الرمز"), "detail: honest note when the symbol has no recorded trades");

console.log("SMOKE OK — returnPct(full):", full.returnPct.toFixed(3), "| rows:", full.rows.join(","), "| returnPct(partial):", partial.returnPct);
if (topLevelError) console.log("note: top-level init threw (acceptable under stub DOM):", topLevelError.message.slice(0, 120));
