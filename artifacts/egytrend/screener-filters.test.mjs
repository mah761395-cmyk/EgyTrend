/**
 * Functional test for the Stock Screener filter layer (2026-10-31).
 *
 * Extracts the ACTUAL shipped functions from index.html (same brace-scan
 * technique as the contract tests) and runs the real filter pipeline against
 * a dataset built from the live production snapshot (TradingView scanner
 * prices fetched 2026-10-31), the official EGX P/E + coupon-yield page
 * (fetched 2026-10-31) and the live Yahoo TTM dividends — then asserts every
 * filter the product advertises: search, sector, price, performance, volume,
 * market cap, P/E bands, dividend thresholds, EPS, combined filters, sort
 * direction, reset, and the empty / no-prices states.
 *
 * This is logic-level: the DOM is stubbed with the exact element ids the
 * screener reads, and the advanced filter values are driven through those
 * elements exactly as the UI does (oninput/onchange -> element.value).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "index.html"), "utf8");

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

/* ── DOM stub: the exact element ids the screener touches ── */
function makeEl(id) {
  return {
    id,
    value: "",
    textContent: "",
    innerHTML: "",
    style: {},
    classList: { add() {}, remove() {} },
    getAttribute: () => null,
    closest: () => null,
    querySelectorAll: () => [],
  };
}

/* Extract the raw `const NAME = ...;` declaration (brace-body or
 * single-expression arrow) so it can run verbatim inside the VM context. */
function constDeclRaw(name) {
  const marker = `const ${name} = `;
  const start = html.indexOf(marker);
  assert.ok(start !== -1, `index.html must define const ${name}`);
  const after = start + marker.length;
  const firstArrow = html.indexOf("=>", after);
  const firstBrace = html.indexOf("{", after);
  const firstSemi = html.indexOf(";", after);
  const braceIsArrowBody = firstArrow !== -1 && firstBrace !== -1 && firstBrace > firstArrow && html.slice(firstArrow + 2, firstBrace).trim() === "";
  if (braceIsArrowBody) {
    /* arrow with a brace body: balance the braces */
    let depth = 0;
    for (let i = firstBrace; i < html.length; i += 1) {
      const ch = html[i];
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) return html.slice(start, i + 1) + ";";
      }
    }
    throw new Error(`unbalanced braces in const ${name}`);
  }
  return html.slice(start, firstSemi + 1);
}

function buildSandbox() {
  const els = new Map();
  const stored = new Map();
  const toasts = [];
  const escapeHtml = (s) =>
    String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const document = {
    getElementById: (id) => {
      if (!els.has(id)) els.set(id, makeEl(id));
      return els.get(id);
    },
    querySelectorAll: () => [],
    createElement: () => {
      let text = "";
      return {
        set textContent(v) {
          text = String(v);
        },
        get innerHTML() {
          return escapeHtml(text);
        },
      };
    },
  };
  const sandbox = {
    document,
    /* state the shipped code reads/writes */
    liveStocks: [],
    scrSearch: "",
    scrFilters: { sector: "all", perf: "all", sortBy: "chgPct", sortDir: -1 },
    scrMktCap: "all",
    scrMarket: "egx",
    egxFundamentals: { valuations: new Map(), dividends: new Map(), loaded: false, stale: false, loading: false, fetchedAt: 0 },
    wl: [],
    egxStocksFreshness: { fetchedAt: Date.now(), stale: false, source: "TradingView Scanner", unavailable: false, stateLabel: "إغلاق السوق", sourceNote: "note" },
    /* UI-only leaves: stubs (they render strings / fire toasts) */
    marketAgeLabel: () => "الآن",
    marketStateLabel: () => "",
    showToast: (t) => toasts.push(t),
    prompt: () => "اختبار",
    DB: { g: (k, d) => stored.get(k) ?? d, s: (k, v) => stored.set(k, v) },
    els,
    toasts,
  };
  vm.createContext(sandbox);
  /* Every helper and screener function runs INSIDE the context so the
     shipped code references the same globals it references in the browser. */
  const fnNames = [
    "knownStockNumber",
    "fmtVol",
    "fmtMktCap",
    "fmtAmountEgp",
    "stockChangeUp",
    "stockChangeText",
    "ltrChange",
    "scrPricedStocks",
    "scrPe",
    "scrDy",
    "scrDivTtm",
    "scrMissingColumns",
    "scrComputeFiltered",
    "renderScrResults",
    "renderScrSectorPills",
    "resetScrFilters",
    "scrAdvValues",
    "saveScrFilter",
    "loadScrFilter",
    "renderSavedFilters",
  ];
  vm.runInContext(
    fnNames.map((n) => functionBody(n)).join("\n") + "\n" + constDeclRaw("sanitize") + "\n" + constDeclRaw("safeJsArg"),
    sandbox,
  );
  return sandbox;
}

/* ── dataset: live production snapshot 2026-10-31 ──
 * prices/volume/cap: /api/markets/stocks (TradingView Scanner) live fetch
 * P/E + DY:          the official EGX MarketPECompanies page, live fetch
 * TTM dividends:     /api/markets/dividends (Yahoo), live fetch
 * PHDC's TTM value is a test-assumption (the OR branch needs a row whose
 * page yield is 0 but which paid a real dividend in the window).          */
function stock(o) {
  return {
    instrumentId: `stock:egx:${o.sym}`,
    sym: o.sym,
    name: o.name,
    sector: o.sector,
    price: o.price,
    prevClose: o.prevClose,
    chg: o.chg,
    chgPct: o.chgPct,
    vol: o.vol,
    high: o.price + 1,
    low: o.price - 1,
    open: o.price,
    mktCapM: o.mktCapM,
    high52w: o.price * 1.2,
    low52w: o.price * 0.8,
    ts: Date.now(),
    source: "TradingView Scanner",
    state: "closed",
    ...o,
  };
}

const BASE_ROWS = [
  stock({ sym: "COMI", name: "البنك التجاري الدولي", sector: "بنوك", price: 120.47, prevClose: 119.9, chg: 0.57, chgPct: 0.475, vol: 4_357_823, mktCapM: 410_217 }),
  stock({ sym: "ETEL", name: "المصرية للاتصالات", sector: "اتصالات", price: 120.1, prevClose: 122.12, chg: -2.02, chgPct: -1.654, vol: 3_258_873, mktCapM: 790_225 }),
  stock({ sym: "SWDY", name: "السويدي إليكتريك", sector: "صناعة", price: 112.25, prevClose: 113, chg: -0.75, chgPct: -0.664, vol: 310_150, mktCapM: 694_560 }),
  stock({ sym: "TMGH", name: "طلعت مصطفى", sector: "عقارات", price: 80.4, prevClose: 80.15, chg: 0.25, chgPct: 0.312, vol: 3_013_409, mktCapM: 165_684 }),
  stock({ sym: "MFPC", name: "Misr Fertilizers Production Company MOPCO", sector: "صناعة", price: 44.85, prevClose: 46, chg: -1.14, chgPct: -2.5, vol: 108_529, mktCapM: 128_639 }),
  stock({ sym: "FWRY", name: "فوري للتكنولوجيا", sector: "تقنية", price: 17.05, prevClose: 17, chg: 0.05, chgPct: 0.294, vol: 10_125_630, mktCapM: 58_082 }),
  stock({ sym: "CANA", name: "Suez Canal Bank SAE", sector: "بنوك", price: 46.5, prevClose: 44.88, chg: 1.61, chgPct: 3.605, vol: 234_198, mktCapM: 46_500 }),
  stock({ sym: "PHDC", name: "بالم هيلز", sector: "عقارات", price: 25.3, prevClose: 25.1, chg: 0.2, chgPct: 0.797, vol: 900_000, mktCapM: 3_000 }),
  /* a curated symbol the scanner cannot price — must stay OUT of the screener */
  { instrumentId: "stock:egx:SCOM", sym: "SCOM", name: "سيدى كرير للبتروكيماويات", sector: "صناعة", noData: true, ts: Date.now(), source: "غير متاح" },
];

/* P/E + coupon yield exactly as the official page published them (2026-10-31).
 * CANA (Suez Canal Bank) and PHDC are the rows the matcher may or may not
 * bind; PHDC's page yield is 0 (used to exercise the TTM OR-branch).        */
const EGX_PAGE = {
  COMI: { pe: 4.96, dy: 5 },
  ETEL: { pe: 9.23, dy: 1.23 },
  SWDY: { pe: 12.6, dy: 1.64 },
  TMGH: { pe: 9.07, dy: 0.37 },
  MFPC: { pe: 11.68, dy: 8.56 },
  FWRY: { pe: 18.68, dy: 0 },
  PHDC: { pe: 7.34, dy: 0 },
};
/* Live Yahoo TTM dividends (EGP per share, trailing 12 months). */
const YAHOO_TTM = { COMI: 6, ETEL: 1.5, TMGH: 0.3, SWDY: 1.85, PHDC: 2.5 };

function setup() {
  const sandbox = buildSandbox();
  sandbox.liveStocks = BASE_ROWS.map((r) => ({ ...r }));
  sandbox.egxFundamentals = {
    valuations: new Map(Object.entries(EGX_PAGE).map(([sym, v]) => [sym, { pe: v.pe, dy: v.dy, egxName: sym, match: "name" }])),
    dividends: new Map(Object.entries(YAHOO_TTM).map(([sym, ttm]) => [sym, { sym, status: "ok", ttm }])),
    loaded: true,
    stale: false,
    loading: false,
    fetchedAt: Date.now(),
    valOk: true,
    divOk: true,
  };
  const getEl = (id) => sandbox.document.getElementById(id); // auto-creates
  const results = () => sandbox.scrComputeFiltered(sandbox.scrPricedStocks());
  const syms = (rows) => rows.map((r) => r.sym);
  const setAdvanced = (vals) => {
    for (const [id, value] of Object.entries(vals)) getEl(id).value = String(value);
  };
  const counter = () => getEl("scr-count").textContent;
  const footer = () => getEl("scr-footer").textContent;
  const table = () => getEl("scr-results").innerHTML;
  const render = () => sandbox.renderScrResults();
  return { sandbox, results, syms, setAdvanced, counter, footer, table, render, getEl };
}

const symSet = (s) => new Set(s);
const expectSyms = (actual, expected, msg) =>
  assert.deepEqual([...actual].sort(), [...expected].sort(), msg);

test("baseline: the screener shows every priced row and excludes the no-data row", () => {
  const { sandbox, syms, results } = setup();
  const rows = results();
  expectSyms(syms(rows), ["COMI", "ETEL", "SWDY", "TMGH", "MFPC", "FWRY", "CANA", "PHDC"], "all priced rows");
  assert.ok(!syms(rows).includes("SCOM"), "no-data rows never reach the screener");
  sandbox.renderScrResults();
  assert.equal(sandbox.document.getElementById("scr-count").textContent, "8 سهم");
  assert.match(sandbox.document.getElementById("scr-footer").textContent, /تم استبعاد 1 سهم بدون بيانات من المصدر/);
});

test("search: by ticker, by Arabic name, by English name (case-insensitive)", () => {
  const { sandbox, results, syms } = setup();
  sandbox.scrSearch = "COMI";
  expectSyms(syms(results()), ["COMI"]);
  sandbox.scrSearch = "طلعت";
  expectSyms(syms(results()), ["TMGH"], "Arabic name substring");
  sandbox.scrSearch = "suez";
  expectSyms(syms(results()), ["CANA"], "English name substring, case-insensitive");
  sandbox.scrSearch = "لا يوجد هذا الاسم";
  assert.equal(results().length, 0);
  sandbox.renderScrResults();
  assert.match(sandbox.document.getElementById("scr-results").innerHTML, /لا توجد أسهم مطابقة/);
});

test("sector filter: only the selected sector, pills rebuild from data", () => {
  const { sandbox, results, syms } = setup();
  sandbox.scrFilters.sector = "بنوك";
  expectSyms(syms(results()), ["COMI", "CANA"]);
  sandbox.scrFilters.sector = "صناعة";
  expectSyms(syms(results()), ["SWDY", "MFPC"]);
  sandbox.renderScrSectorPills();
  const pills = sandbox.document.getElementById("scr-sector-row").innerHTML;
  assert.match(pills, /الكل \(8\)/, "the all-pill counts the priced rows");
  assert.match(pills, /صناعة \(2\)/, "sector counts come from the data, not a hard-coded list");
});

test("performance filter: up / down / +3% / -3% / +5%", () => {
  const { sandbox, results, syms } = setup();
  sandbox.scrFilters.perf = "up";
  expectSyms(syms(results()), ["COMI", "TMGH", "FWRY", "CANA", "PHDC"]);
  sandbox.scrFilters.perf = "dn";
  expectSyms(syms(results()), ["ETEL", "SWDY", "MFPC"]);
  sandbox.scrFilters.perf = "up3";
  expectSyms(syms(results()), ["CANA"], "only +3% or more");
  sandbox.scrFilters.perf = "dn3";
  assert.equal(results().length, 0, "-3%+: nothing that deep in this snapshot");
  sandbox.scrFilters.perf = "up5";
  assert.equal(results().length, 0, "+5%+: none");
});

test("price band and volume floor", () => {
  const { sandbox, results, syms, setAdvanced } = setup();
  setAdvanced({ "scr-pr-min": "100", "scr-pr-max": "200" });
  expectSyms(syms(results()), ["COMI", "ETEL", "SWDY"]);
  setAdvanced({ "scr-pr-min": "", "scr-pr-max": "" });
  setAdvanced({ "scr-vol-min": "1000000" });
  expectSyms(syms(results()), ["COMI", "ETEL", "TMGH", "FWRY"], "1M+ volume floor");
});

test("market cap pills: mega / large / mid / small on the real caps", () => {
  const { sandbox, results, syms } = setup();
  sandbox.scrMktCap = "mega";
  expectSyms(syms(results()), ["COMI", "ETEL", "SWDY", "TMGH", "MFPC"], ">100B");
  sandbox.scrMktCap = "large";
  expectSyms(syms(results()), ["FWRY", "CANA"], "10-100B");
  sandbox.scrMktCap = "mid";
  expectSyms(syms(results()), ["PHDC"], "1-10B");
  sandbox.scrMktCap = "small";
  assert.equal(results().length, 0);
});

test("P/E bands operate on the merged EGX-page values", () => {
  const { sandbox, results, syms, setAdvanced } = setup();
  setAdvanced({ "scr-pe": "0-15" });
  expectSyms(syms(results()), ["COMI", "ETEL", "SWDY", "TMGH", "MFPC", "PHDC"]);
  setAdvanced({ "scr-pe": "15-30" });
  expectSyms(syms(results()), ["FWRY"]);
  setAdvanced({ "scr-pe": "50+" });
  assert.equal(results().length, 0);
  setAdvanced({ "scr-pe": "neg" });
  expectSyms(syms(results()), ["CANA"], "unpublished P/E is honest — it lands in the neg/unavailable bucket only");
});

test("dividend filter: pays = page yield OR real TTM dividend; thresholds use the yield", () => {
  const { sandbox, results, syms, setAdvanced } = setup();
  setAdvanced({ "scr-div": "any" });
  /* FWRY: page yield 0 and no TTM dividend -> excluded; PHDC: yield 0 but a
     real TTM dividend -> included. Everyone else pays on the page. */
  expectSyms(syms(results()), ["COMI", "ETEL", "SWDY", "TMGH", "MFPC", "PHDC"]);
  setAdvanced({ "scr-div": "4+" });
  expectSyms(syms(results()), ["COMI", "MFPC"], "4%+ coupon yield");
  setAdvanced({ "scr-div": "2+" });
  expectSyms(syms(results()), ["COMI", "MFPC"], "2%+ coupon yield (ETEL 1.23 and SWDY 1.64 stay out)");
  setAdvanced({ "scr-div": "6+" });
  expectSyms(syms(results()), ["MFPC"]);
});

test("EPS filter is honest: with no EPS source, neither pos nor neg claims rows", () => {
  const { sandbox, results, setAdvanced } = setup();
  setAdvanced({ "scr-eps": "pos" });
  assert.equal(results().length, 0, "unknown EPS is not a winner");
  setAdvanced({ "scr-eps": "neg" });
  assert.equal(results().length, 0, "unknown EPS must not be presented as losing (the old bug claimed all 8 rows)");
  sandbox.renderScrResults();
  assert.match(sandbox.document.getElementById("scr-footer").textContent, /غير متاحة من المصدر: [^·]*EPS/, "the footer states EPS is not published");
});

test("combined filters stack (sector + performance + price in one pass)", () => {
  const { sandbox, results, syms, setAdvanced } = setup();
  sandbox.scrFilters.sector = "بنوك";
  sandbox.scrFilters.perf = "up";
  setAdvanced({ "scr-pr-max": "50" });
  expectSyms(syms(results()), ["CANA"], "the only bank that is up AND priced ≤50");
});

test("sorting: default chgPct desc is real descending; the arrow matches the data", () => {
  const { sandbox, results, syms } = setup();
  const order = (rows) => [...rows].map((r) => r.sym); // copy out of the VM realm
  assert.deepEqual(order(results()), ["CANA", "PHDC", "COMI", "TMGH", "FWRY", "SWDY", "ETEL", "MFPC"], "chgPct descending");
  sandbox.scrFilters.sortDir = 1;
  assert.deepEqual(order(results()), ["MFPC", "ETEL", "SWDY", "FWRY", "TMGH", "COMI", "PHDC", "CANA"], "ascending after a toggle");
});

test("sorting by P/E uses the merged values and nulls sink to the end", () => {
  const { sandbox, results, syms } = setup();
  const order = (rows) => [...rows].map((r) => r.sym); // copy out of the VM realm
  sandbox.scrFilters.sortBy = "pe";
  sandbox.scrFilters.sortDir = -1;
  assert.deepEqual(
    order(results()),
    ["FWRY", "SWDY", "MFPC", "ETEL", "TMGH", "PHDC", "COMI", "CANA"],
    "18.68 → 4.96, unpublished P/E (CANA) last",
  );
  sandbox.scrFilters.sortDir = 1;
  assert.deepEqual(order(results()), ["CANA", "COMI", "PHDC", "TMGH", "ETEL", "MFPC", "SWDY", "FWRY"], "ascending: nulls first");
});

test("sorting by dividend % uses the merged values", () => {
  const { sandbox, results, syms } = setup();
  const order = (rows) => [...rows].map((r) => r.sym);
  sandbox.scrFilters.sortBy = "divYield";
  sandbox.scrFilters.sortDir = -1;
  assert.deepEqual(order(results()), ["MFPC", "COMI", "SWDY", "ETEL", "TMGH", "FWRY", "PHDC", "CANA"], "8.56 → 0, null last");
});

test("reset: clears every filter, restores the default desc sort, real count back", () => {
  const { sandbox, results, syms, setAdvanced } = setup();
  sandbox.scrFilters.sector = "بنوك";
  sandbox.scrFilters.perf = "up";
  sandbox.scrMktCap = "mega";
  sandbox.scrSearch = "COMI";
  setAdvanced({ "scr-pr-min": "10", "scr-pe": "0-10", "scr-div": "any", "scr-eps": "pos", "scr-vol-min": "100000" });
  assert.ok(results().length < 8);
  sandbox.resetScrFilters();
  assert.equal(sandbox.scrFilters.sector, "all");
  assert.equal(sandbox.scrMktCap, "all");
  assert.equal(sandbox.scrSearch, "");
  assert.equal(sandbox.document.getElementById("scr-pe").value, "all");
  assert.equal(sandbox.document.getElementById("scr-pr-min").value, "");
  expectSyms(syms(results()), ["COMI", "ETEL", "SWDY", "TMGH", "MFPC", "FWRY", "CANA", "PHDC"]);
  assert.equal(sandbox.document.getElementById("scr-count").textContent, "8 سهم");
});

test("saved filters persist the advanced values and restore them on load", () => {
  const { sandbox, results, syms, setAdvanced } = setup();
  sandbox.scrFilters.sector = "صناعة";
  setAdvanced({ "scr-pe": "0-15", "scr-pr-max": "50" });
  sandbox.saveScrFilter();
  const saved = sandbox.DB.g("scr_saved", []);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].adv.peFilter, "0-15");
  assert.equal(saved[0].adv.priceMax, "50");
  /* simulate the user resetting, then loading the saved filter */
  sandbox.resetScrFilters();
  setAdvanced({ "scr-pe": "all", "scr-pr-max": "" });
  expectSyms(syms(results()), ["COMI", "ETEL", "SWDY", "TMGH", "MFPC", "FWRY", "CANA", "PHDC"], "everything back after reset");
  sandbox.loadScrFilter(0);
  assert.equal(sandbox.scrFilters.sector, "صناعة");
  assert.equal(sandbox.document.getElementById("scr-pe").value, "0-15");
  assert.equal(sandbox.document.getElementById("scr-pr-max").value, "50");
  expectSyms(syms(results()), ["MFPC"], "صناعة + P/E 0-15 + price ≤50 = MOPCO only");
});

test("empty state: source unavailable shows the retry button, not fake rows", () => {
  const { sandbox } = setup();
  sandbox.liveStocks = [];
  sandbox.egxStocksFreshness = { fetchedAt: 0, stale: true, source: "غير متاح", unavailable: true, loading: false };
  sandbox.renderScrResults();
  assert.match(sandbox.document.getElementById("scr-results").innerHTML, /بيانات أسهم EGX غير متاحة من المصدر حاليًا/);
  assert.match(sandbox.document.getElementById("scr-results").innerHTML, /إعادة المحاولة/);
  assert.equal(sandbox.document.getElementById("scr-count").textContent, "غير متاح");
});

test("no-prices state: rows exist but the source priced none", () => {
  const { sandbox } = setup();
  sandbox.liveStocks = BASE_ROWS.filter((r) => r.noData);
  sandbox.egxStocksFreshness = { fetchedAt: Date.now(), stale: false, source: "TradingView Scanner", unavailable: false };
  sandbox.renderScrResults();
  assert.match(sandbox.document.getElementById("scr-results").innerHTML, /المصدر لم يقدّم أسعارًا لأي سهم حاليًا/);
  assert.equal(sandbox.document.getElementById("scr-count").textContent, "0 سهم");
});

test("footer: states both sources — the scan and the secondary layer — honestly", () => {
  const { sandbox } = setup();
  sandbox.renderScrResults();
  const f = sandbox.document.getElementById("scr-footer").textContent;
  assert.match(f, /المصدر: TradingView Scanner/);
  assert.match(f, /الصفحة الرسمية للبورصة \(يومية · تغطية جزئية لـ7 شركة\)/, "the EGX page is named with its daily nature and real coverage");
  assert.match(f, /التوزيعات: Yahoo \(آخر 12 شهرًا\)/);
  /* when the secondary layer has no answer at all, say so */
  sandbox.egxFundamentals = { valuations: new Map(), dividends: new Map(), loaded: true, valOk: false, divOk: false, stale: false, loading: false, fetchedAt: Date.now() };
  sandbox.renderScrResults();
  const f2 = sandbox.document.getElementById("scr-footer").textContent;
  assert.match(f2, /P\/E والعائد: مصدر البورصة غير متاح حاليًا/);
  assert.match(f2, /غير متاحة من المصدر: [^·]*P\/E/, "the missing-columns line takes over");
});
