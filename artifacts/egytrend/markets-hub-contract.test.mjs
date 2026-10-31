/**
 * Contract test for the markets hub (categories tabs, quick search,
 * gainers/losers, listed-stocks tables, watchlist tab).
 *
 * Rules enforced here:
 *  - the six requested coverage families are first-class tabs, in the
 *    brief's order, plus a watchlist tab — the economic-indicators tab is
 *    honest about the missing data source instead of showing invented
 *    values;
 *  - the hub is presentation/filtering only: no fetch() of its own, no
 *    price ever synthesised, missing source values stay "—";
 *  - the forex section is a real server section (eg no longer mixes FX
 *    pairs into the Egyptian section) and the landing strip keeps the EGP
 *    pairs visible after the move;
 *  - every new board instrument has a human context entry (icon/desc/
 *    trading hours) for the detail overlay.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "index.html"), "utf8");

function functionBody(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.ok(start !== -1, `index.html must define ${name}`);
  let i = html.indexOf("(", start);
  let pd = 0;
  for (; i < html.length; i += 1) {
    const ch = html[i];
    if (ch === "(") pd += 1;
    else if (ch === ")") {
      pd -= 1;
      if (pd === 0) break;
    }
  }
  let depth = 0;
  for (i = html.indexOf("{", i); i < html.length; i += 1) {
    const ch = html[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return html.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

test("tabs: the six coverage families are first-class tabs, in the brief's order", () => {
  const order = [...html.matchAll(/data-mkt-tab="([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ["eg", "gl", "cm", "cr", "fx", "ind", "wl"], "tab order: EGX, global, commodities, crypto, forex, indicators, watchlist");
  for (const pane of ["mkt-eg-pane", "mkt-gl-pane", "mkt-cm-pane", "mkt-cr-pane", "mkt-fx-pane", "mkt-ind-pane", "mkt-wl-pane"]) {
    assert.ok(html.includes(`id="${pane}"`), `pane ${pane} exists`);
  }
  assert.match(html, /البورصة المصرية/, "Egyptian tab label");
  assert.match(html, /عالمي/, "global tab label");
  assert.match(html, /سلع ومعادن/, "commodities tab label");
  assert.match(html, /كريبتو/, "crypto tab label");
  assert.match(html, /عملات/, "forex tab label");
});

test("forex is its own server section on the client (EG section: indices only)", () => {
  const staticBlock = html.slice(html.indexOf("const MARKET_STATIC = {"), html.indexOf("const TICKS_STATIC"));
  assert.ok(staticBlock.includes("fx:["), "static catalog has an fx section");
  const egBlock = staticBlock.slice(staticBlock.indexOf("eg:["), staticBlock.indexOf("gl:["));
  assert.ok(egBlock.includes("EGX30"), "eg keeps the EGX30 headline index");
  assert.doesNotMatch(egBlock, /EGX70|EGX100/, "EGX70/EGX100 have no reliable data source — no loading placeholders either");
  /* Rows still sent by the shared server API are dropped client-side so they
   * never re-enter lists or the ticker. */
  const removed = html.indexOf("const REMOVED_MARKETS = new Set(");
  assert.ok(removed !== -1, "REMOVED_MARKETS filter exists");
  const removedSet = html.slice(removed, html.indexOf("];", removed));
  assert.ok(removedSet.includes('"EGX70"') && removedSet.includes('"EGX100"'), "filter still drops EGX70/EGX100 from any payload");
  assert.doesNotMatch(egBlock, /EGP/, "no FX pairs remain in the Egyptian static section");
  for (const name of ["USD/EGP", "EUR/EGP", "GBP/EGP", "SAR/EGP", "EUR/USD", "GBP/USD", "USD/JPY", "AUD/USD", "مؤشر الدولار"]) {
    assert.ok(staticBlock.includes(`n:"${name}"`), `fx static section carries ${name}`);
  }
  /* The merge loop and the unavailable-state loop both include the new section. */
  assert.match(html, /\["eg","gl","cm","cr","fx"\]\.forEach\(k=>\{\s*const rows=normalizeMarketRows\(d\.markets\[k\]\)/, "board merge includes fx");
  assert.match(html, /\["eg","gl","cm","cr","fx"\]\.forEach\(key=>/, "unavailable state includes fx");
  /* Landing strip keeps the EGP pairs after the section move. */
  assert.match(html, /const mktOrder=\["eg","fx","gl","cm","cr"\]\.sort\(/, "landing strip order includes fx");
});

test("search: client-side over already-loaded data, no fetch of its own", () => {
  assert.ok(html.includes('id="mkt-hub-search"'), "search box exists");
  const body = functionBody("mktHubSearch");
  assert.doesNotMatch(body, /fetch\(/, "global search never issues a network request");
  assert.match(body, /mktBoardLookup/, "searches the board rows by server name");
  assert.match(body, /liveStocks\.filter/, "searches the EGX scan list");
  assert.match(body, /usStocks\.filter/, "searches the US list");
  assert.match(body, /openStockDetail|openMarketDetail/, "a hit opens the existing detail overlay");
  /* The hub renders no prices of its own: the tables and movers read the
   * server rows, missing values stay absent. */
  const priced = functionBody("mktPricedEgx");
  assert.match(priced, /typeof s\.chgPct==="number"/, "rankings only use server-provided change values");
  const movers = functionBody("renderMktMovers");
  assert.match(movers, /mktPricedEgx\(\)/, "movers rank only priced rows with a real change");
  const egxTable = functionBody("renderMktEgxTable");
  assert.match(egxTable, /noData===true/, "unpriced scanner rows stay visible, marked");
  assert.match(egxTable, /لا بيانات من المصدر/, "the unpriced mark is explicit");
  const usTable = functionBody("renderMktUsTable");
  assert.match(usTable, /typeof s\.price==="number"\?s\.price\.toFixed\(2\):"—"/, "missing US price renders —, never 0");
});

test("indicators tab: honest about the missing economic-indicator source", () => {
  const indPane = html.slice(html.indexOf('id="mkt-ind-pane"'), html.indexOf('id="mkt-wl-pane"'));
  assert.match(indPane, /لا تتوفر حاليًا قيم هذه المؤشرات من مصدر مرخّص/, "names the missing source honestly");
  assert.match(indPane, /لا تعرض قيمًا تقديرية أو قديمة بوصفها حالية/, "and states it will not show invented values");
  assert.doesNotMatch(indPane, /%\.toFixed/, "no computed indicator values in the pane");
});

test("watchlist tab: resolves names against live data, never stores prices", () => {
  const body = functionBody("renderMktWatchlist");
  assert.match(body, /mktBoardLookup\.get\(name\)/, "board names resolve via the lookup index");
  assert.match(body, /liveStocks\.find|usStocks\.find/, "stock names resolve against the server lists");
  assert.doesNotMatch(body, /DB\.set|localStorage\.set/, "the watchlist view never persists data");
  assert.ok(html.includes('id="mkt-wl-count"'), "tab shows the watch count");
});

test("compare: 2-4 assets, chart only from stored-daily-closes sparklines, honest when history is short", () => {
  const toggle = functionBody("mktCompareToggle");
  assert.match(toggle, /mktCompare\.length>=4/, "hard cap of 4 assets");

  const modal = functionBody("openCompareModal");
  assert.match(modal, /MARKET_SPARKLINES_API/ , "uses the sparklines endpoint");
  assert.match(modal, /ids=\$\{encodeURIComponent\(mktCompare/, "one batched request for the whole compare list");
  assert.doesNotMatch(modal, /demo|static.*price/i);

  const chart = functionBody("mktCompareChartSvg");
  assert.match(chart, /e\.available&&e\.points\.length>=2/, "assets without a usable stored series are excluded from the draw");
  assert.match(chart, /100\*p\.close\/e\.points\[0\]\.close/, "normalised to 100 per asset");
  assert.match(chart, /لا يتوفر سجل يومي مرخّص كافٍ/, "all-unavailable renders an honest message, not an empty or faked chart");

  assert.match(html, /مقارنة الأصول/, "the detail overlay offers a compare entry point");
  assert.match(html, /id="mkt-compare-bar"/, "floating compare state on the markets page");
  assert.match(toggle, /mktCompare\.(push|splice)/, "toggle adds and removes");
});

test("new board instruments all have detail-overlay context entries", () => {
  const ctxStart = html.indexOf("const MKT_CTX={");
  const ctxEnd = html.indexOf("const SEC_COL", ctxStart);
  const ctx = html.slice(ctxStart, ctxEnd);
  for (const name of [
    "Dow Jones 30", "Nikkei 225", "CAC 40",
    "نفط خام WTI", "غاز طبيعي", "قمح",
    "EUR/USD", "GBP/USD", "USD/JPY", "AUD/USD", "مؤشر الدولار",
    "BNB", "DOGE", "ADA", "AVAX", "LINK", "TON",
    "EGX70", "EGX100",
  ]) {
    assert.ok(ctx.includes(`"${name}":{`), `MKT_CTX entry for ${name}`);
  }
});
