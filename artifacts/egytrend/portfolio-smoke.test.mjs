/* Runtime smoke test for the SIMPLE portfolio (no browser in this sandbox):
 * load the whole inline app script under a Proxy-based DOM stub with
 * memoized, stateful elements, then render the new portfolio renderer with
 * synthetic, honestly-shaped data and assert the produced HTML is sane and
 * honest. Catches runtime errors (undefined vars, bad template refs, typos)
 * that static checks cannot, and pins the value/price honesty rules.
 */
import vm from "node:vm";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const scripts = [...html.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const app = scripts.find(s => s.length > 100000);
assert.ok(app, "main inline script found");

/* ── stateful DOM stub ─────────────────────────────────────────────────────
 * Elements are memoized per id so the app's set/get round-trips (sanitize
 * encodes via textContent→innerHTML; the renderer writes host.innerHTML and
 * the test reads it back). classList is real Set-backed state. */
const escapeHtml = v => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const byId = new Map();
function makeEl(id = "") {
  const el = {
    id,
    value: "",
    disabled: false,
    open: false,
    readOnly: false,
    _text: null,
    _html: "",
    _classes: new Set(),
    style: new Proxy({}, { get: (t, p) => t[p] ?? "", set: (t, p, v) => { t[p] = v; return true; } }),
    dataset: {},
  };
  el.classList = {
    add: (...cs) => cs.forEach(c => el._classes.add(c)),
    remove: (...cs) => cs.forEach(c => el._classes.delete(c)),
    toggle: c => { el._classes.has(c) ? el._classes.delete(c) : el._classes.add(c); },
    contains: c => el._classes.has(c),
  };
  Object.defineProperties(el, {
    textContent: {
      get() { return el._text ?? ""; },
      set(v) { el._text = String(v); el._html = ""; },
    },
    innerHTML: {
      get() { return el._text !== null ? escapeHtml(el._text) : el._html; },
      set(v) { el._html = String(v); el._text = null; },
    },
  });
  for (const fn of ["focus", "blur", "click", "select", "scrollIntoView", "appendChild", "append", "remove",
    "setSelectionRange", "insertAdjacentHTML", "dispatchEvent", "addEventListener", "removeEventListener",
    "getBoundingClientRect"]) {
    el[fn] = () => (fn === "getBoundingClientRect" ? { left: 0, top: 0, width: 100, height: 100 } : undefined);
  }
  el.querySelector = () => makeEl();
  el.querySelectorAll = () => [];
  el.getAttribute = () => null;
  el.contains = () => false;
  el.closest = () => null;
  el.children = [];
  el.clientWidth = 100;
  el.offsetWidth = 100;
  el.offsetHeight = 100;
  return el;
}
function el(id) {
  if (!byId.has(id)) byId.set(id, makeEl(id));
  return byId.get(id);
}

const documentStub = {
  getElementById: id => el(String(id)),
  createElement: tag => makeEl(tag),
  createTextNode: t => makeEl(),
  querySelector: () => makeEl(),
  querySelectorAll: () => [],
  getElementsByClassName: () => [],
  getElementsByName: () => [],
  elements: [],
  body: makeEl("body"),
  documentElement: makeEl("html"),
  head: makeEl("head"),
  activeElement: makeEl("active"),
  addEventListener() {},
  removeEventListener() {},
  write() {},
  cookie: "",
};

const sandbox = {
  document: documentStub,
  navigator: { userAgent: "node-smoke", language: "ar-EG", clipboard: { writeText: () => Promise.resolve() } },
  location: { href: "http://localhost/", origin: "http://localhost", host: "localhost", protocol: "http:", pathname: "/", search: "", hash: "" },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {}, clear() {} },
  fetch: () => new Promise(() => {}),
  AbortController,
  /* Timers are inert: the app's boot polling must never keep this test
   * process (or its event loop) alive; init code awaiting a timer simply
   * parks, which is fine for a render-level smoke test. */
  setTimeout: () => 0,
  clearTimeout: () => {},
  setInterval: () => 0,
  clearInterval: () => {},
  console,
  URL, URLSearchParams, Headers, Request, Response,
  crypto: { getRandomValues: (a) => a, randomUUID: () => "smoke-uuid-000000000000", subtle: {} },
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
  alert() {}, confirm: () => false, prompt: () => null,
  requestAnimationFrame: () => 0, cancelAnimationFrame() {},
  Image: function () { return makeEl("img"); },
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
  vm.runInContext(app, ctx, { timeout: 20000 });
} catch (e) {
  topLevelError = e; // function declarations are hoisted; init-code throws are acceptable
}

/* ── seed honest synthetic state ───────────────────────────────────────────
 * COMI = ledger-derived (trades) row, fully priced.
 * HLDI = positions-table row (uuid id), fully priced in scenario 1.
 * ETBS = fully closed symbol (trade history only, qty 0). */
const ts = Date.parse("2026-10-28T12:30:00Z");
vm.runInContext(`
  U = { sub: 7, plan: "vip", name: "Smoke" };
  vipTab = "home";
  portfolio = [
    { id: "pos:comi", sym: "COMI", name: "المصرية للإسمنت", sector: "مواد بناء", qty: 140, price: 12.05, instrumentId: "egx:COMI",
      market: { price: 13.4, source: "tv", asOf: ${ts}, delayedMinutes: 15, freshness: "delayed" },
      closed: false, legacy: false, costBasis: 1687, realizedPnl: 172, totalFees: 15, buyCount: 2, sellCount: 1,
      marketValue: 1876, unrealizedPnl: 189, unrealizedPnlPct: 11.18, weightPct: 52.3 },
    { id: "11111111-2222-3333-4444-555555555555", sym: "HLDI", name: "حديد مصر", sector: "صناعات", qty: 60, price: 20.2, instrumentId: "egx:HLDI",
      market: { price: 21.1, source: "tv", asOf: ${ts}, delayedMinutes: 15, freshness: "delayed" },
      closed: false, legacy: true, costBasis: 1212, realizedPnl: 0, totalFees: 0, buyCount: 1, sellCount: 0,
      marketValue: 1266, unrealizedPnl: 54, unrealizedPnlPct: 4.46, weightPct: 33.8 },
    { id: "pos:etbs", sym: "ETBS", name: "إيچيبت للتأمين", sector: "تأمين", qty: 0, price: 0, instrumentId: "egx:ETBS",
      market: null,
      closed: true, legacy: false, costBasis: 0, realizedPnl: -310, totalFees: 8, buyCount: 1, sellCount: 1,
      marketValue: null, unrealizedPnl: null, unrealizedPnlPct: null, weightPct: null },
  ];
  portfolioData = {
    summary: { cash: 412, investedCost: 2899, totalBuyOutlay: 3622, costBasisSold: 723,
      pricedMarketValue: 3142, marketValue: 3142, totalValue: 3554, totalValuePriced: 3554,
      unrealizedPnl: 243, unrealizedPnlPriced: 243, realizedPnl: -138, totalFees: 23,
      buyCount: 4, sellCount: 2, topConcentrationPct: 52.8, missingPriceSymbols: [], cashEventsIn: 412, cashEventsOut: 0 },
    transactions: [
      { id: "tx1", symbol: "COMI", side: "buy", quantity: 100, price: 10, fees: 10, tradeDate: "2026-09-01", note: null, realizedPnl: null, heldAfter: 100, createdAt: "2026-09-01T09:00:00Z", updatedAt: "2026-09-01T09:00:00Z" },
      { id: "tx2", symbol: "COMI", side: "sell", quantity: 60, price: 15, fees: 5, tradeDate: "2026-09-10", note: null, realizedPnl: 172, heldAfter: 140, createdAt: "2026-09-10T09:00:00Z", updatedAt: "2026-09-10T09:00:00Z" },
    ],
    cashEvents: [
      { id: "c111111111111111111111", kind: "deposit", amount: 412, tradeDate: "2026-10-15", note: null, symbol: null },
    ],
    settings: { startingCash: 0 }, marketAvailable: true, legacyPositions: false,
  };
  portfolioState = { loaded: true, loading: false, error: "", marketAvailable: true };
  liveStocks = [
    { sym: "COMI", name: "المصرية للإسمنت", sector: "مواد بناء", price: 13.4, source: "tv", ts: ${ts}, noData: false },
    { sym: "HLDI", name: "حديد مصر", sector: "صناعات", price: 21.1, source: "tv", ts: ${ts}, noData: false },
  ];
`, ctx);

const host = el("pfp-host");

/* ── scenario 1: every held position fully priced ───────────────────────── */
vm.runInContext(`nfpRender(document.getElementById("pfp-host"))`, ctx);
const full = host.innerHTML;

assert.ok(full.includes("محفظتي"), "hero title rendered");
const money = vm.runInContext(`vaFmt(3554,0)`, ctx);
assert.ok(full.includes(money), `hero shows the server's totalValue number (${money})`);
assert.ok(full.includes("ج.م"), "explicit ج.م unit next to the total");
assert.ok(full.includes("nfp-pl") && full.includes("▲"), "P/L line with up arrow for a positive server P/L");
assert.ok(full.includes("+243 ج.م"), "P/L uses the server's unrealizedPnl (243)");
assert.ok(full.includes("nfp-chip"), "summary chips rendered");
assert.ok(full.includes("nfp-add-card") && full.includes("nfp-cash-card"), "add-stock + cash cards rendered");
assert.ok(full.includes("nfp-alloc-bar"), "allocation bar rendered");
assert.ok(full.includes("nfp-table"), "assets table rendered");
assert.ok(full.includes("سجل الصفقات"), "trade log section rendered (transactions exist)");
assert.ok(!full.includes("أهلًا! محفظتك جاهزة"), "no empty state with data present");

/* COMI ledger row: flagged + trade-log button, no edit/delete buttons */
assert.ok(full.includes("المصرية للإسمنت"), "COMI name rendered");
assert.ok(full.includes("من سجل الصفقات"), "ledger row flagged as built from trades");
assert.ok(full.includes("nfpOpenTxLog()"), "ledger row exposes the trade log");
/* HLDI table row: real quote with source + time, value, weight, P/L, edit+delete */
assert.ok(full.includes("حديد مصر"), "HLDI name rendered");
assert.ok(full.includes("21.10"), "HLDI verified price rendered");
assert.ok(full.includes("nfpEditStart("), "table-stored row has the edit button");
assert.ok(full.includes("nfpDeletePos("), "table-stored row has the delete button");
assert.ok(full.includes("ن.م") || full.includes("ج"), "money units present");
/* Closed symbol: kept for its realized result, shown as مغلق */
assert.ok(full.includes("مغلق"), "closed symbol marked مغلق");

/* ── scenario 2: one held position without a verified quote ─────────────── */
vm.runInContext(`
  (function () {
    const hldi = portfolio.find(p => p.sym === "HLDI");
    hldi.market = null;
    hldi.marketValue = null;
    hldi.unrealizedPnl = null;
    hldi.unrealizedPnlPct = null;
    hldi.weightPct = null;
    portfolioData.summary.marketValue = null;
    portfolioData.summary.totalValue = null;
    portfolioData.summary.unrealizedPnl = null;
    portfolioData.summary.pricedMarketValue = 1876;
    portfolioData.summary.totalValuePriced = 2288;
    portfolioData.summary.missingPriceSymbols = ["HLDI"];
  })()
`, ctx);
vm.runInContext(`nfpRender(document.getElementById("pfp-host"))`, ctx);
const partial = host.innerHTML;
const partialMoney = vm.runInContext(`vaFmt(2288,0)`, ctx);
assert.ok(partial.includes(partialMoney), `partial state shows the server's priced part (${partialMoney})`);
assert.ok(partial.includes("+ بلا سعر"), "partial state explicitly labelled «+ بلا سعر»");
assert.ok(partial.includes("HLDI"), "the unpriced symbol is named in the hero");
assert.ok(partial.includes("الربح/الخسارة يظهر عندما يتوفر سعر موثّق"), "NO P/L figure while a held position is unpriced");
assert.ok(partial.includes("— بلا سعر"), "unpriced row says بلا سعر instead of a price");
/* the unpriced row must not carry the old quote value */
assert.ok(!partial.includes(">21.10<"), "no stale price left in the unpriced row");

/* ── scenario 3: empty portfolio → friendly onboarding + the forms ──────── */
vm.runInContext(`
  portfolio = [];
  portfolioData = { summary: { cash: 0, investedCost: 0, pricedMarketValue: 0, marketValue: 0, totalValue: 0,
    totalValuePriced: 0, unrealizedPnl: null, realizedPnl: 0, totalFees: 0, missingPriceSymbols: [] },
    transactions: [], cashEvents: [], settings: { startingCash: 0 }, marketAvailable: true, legacyPositions: false };
  portfolioState = { loaded: true, loading: false, error: "", marketAvailable: true };
`, ctx);
vm.runInContext(`nfpRender(document.getElementById("pfp-host"))`, ctx);
const empty = host.innerHTML;
assert.ok(empty.includes("ابدأ في خطوتين"), "empty state explains how to start");
assert.ok(empty.includes("nfp-sym") && empty.includes("nfp-cash-amt"), "the add + cash forms are present in the empty state");
assert.ok(!empty.includes("nfp-table"), "no assets table when there are no assets");
assert.ok(!empty.includes("nfp-alloc-bar"), "no allocation bar when there is nothing to allocate");

/* ── scenario 4: stock picker fills the symbol only, never the price ────── */
vm.runInContext(`
  portfolio = [
    { id: "11111111-2222-3333-4444-555555555555", sym: "HLDI", name: "حديد مصر", sector: "صناعات", qty: 60, price: 20.2, instrumentId: "egx:HLDI",
      market: { price: 21.1, source: "tv", asOf: ${ts}, delayedMinutes: 15, freshness: "delayed" },
      closed: false, legacy: true, costBasis: 1212, realizedPnl: 0, totalFees: 0, buyCount: 1, sellCount: 0,
      marketValue: 1266, unrealizedPnl: 54, unrealizedPnlPct: 4.46, weightPct: 100 },
  ];
  portfolioState = { loaded: true, loading: false, error: "", marketAvailable: true };
`, ctx);
vm.runInContext(`nfpRender(document.getElementById("pfp-host"))`, ctx);
vm.runInContext(`nfpStockSuggest("comi")`, ctx);
const suggestBox = el("nfp-suggest");
assert.ok(suggestBox._classes.has("open"), "suggest box opens with a query");
assert.ok(suggestBox.innerHTML.includes("COMI"), "candidate from the server list");
assert.ok(!suggestBox.innerHTML.includes("FAKE"), "no fabricated candidates");
vm.runInContext(`nfpPickStock("COMI")`, ctx);
assert.equal(el("nfp-sym").value, "COMI", "picking fills the symbol field");
assert.equal(el("nfp-cost").value, "", "picking never auto-fills the cost field");

/* ── scenario 5: add-form validation rejects bad input before any request ─ */
el("nfp-sym").value = "";
el("nfp-qty").value = "";
el("nfp-cost").value = "";
vm.runInContext(`void nfpAddSubmit()`, ctx);
const addErr = el("nfp-add-err");
assert.ok(addErr._text.length > 0, "empty form shows a validation message");
assert.ok(addErr._text.includes("رمز"), "message points at the symbol field");

el("nfp-sym").value = "COMI";
el("nfp-qty").value = "0.5";
el("nfp-cost").value = "10";
vm.runInContext(`void nfpAddSubmit()`, ctx);
assert.ok(addErr._text.includes("كمية"), "non-integer quantity rejected");

/* ── scenario 6: the VIP tab entry point renders the same page ──────────── */
vm.runInContext(`
  vipTab = "port";
  vBuildPort(document.getElementById("vip-body"));
`, ctx);
const tab = el("vip-body").innerHTML;
assert.ok(tab.includes("محفظتي"), "VIP tab shows the same hero");
assert.ok(tab.includes("nfp-add-card"), "VIP tab shows the same add form");

console.log("SMOKE OK — simple portfolio renders honestly in all scenarios");
if (topLevelError) console.log("note: top-level init threw (acceptable under stub DOM):", String(topLevelError.message).slice(0, 120));
