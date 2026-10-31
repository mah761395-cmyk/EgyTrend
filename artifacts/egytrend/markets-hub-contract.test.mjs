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

test("tabs: «الكل» is the first tab and the default view; the category tabs keep their order", () => {
  const order = [...html.matchAll(/data-mkt-tab="([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ["all", "eg", "gl", "cm", "cr", "fx", "ind", "wl"], "tab order: all (default), EGX, global, commodities, crypto, forex, indicators, watchlist");
  assert.match(html, /<button class="mkt-tab on" type="button" role="tab" data-mkt-tab="all"/, "«الكل» tab exists and is active by default");
  const egBtn = html.slice(html.lastIndexOf("<button", html.indexOf("data-mkt-tab=\"eg\"")), html.indexOf("</button>", html.indexOf("data-mkt-tab=\"eg\"")));
  assert.match(egBtn, /class="mkt-tab"/, "the EGX tab is not the default anymore");
  for (const pane of ["mkt-all-pane", "mkt-eg-pane", "mkt-gl-pane", "mkt-cm-pane", "mkt-cr-pane", "mkt-fx-pane", "mkt-ind-pane", "mkt-wl-pane"]) {
    assert.ok(html.includes(`id="${pane}"`), `pane ${pane} exists`);
  }
  assert.match(html, /<div class="mkt-tab-pane on" id="mkt-all-pane">/, "unified list pane is the default pane");
  assert.ok(html.includes(`id="mkt-all"`), "the unified list has its grid");
  assert.ok(html.includes(`id="mkt-all-filters"`), "the unified list has its type-filter row");
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
test("unified «الكل» list: filters, dedupe and type mapping are computed from the real sources", () => {
  assert.match(html, /const MKT_HUB_TABS=\["all","eg","gl","cm","cr","fx","ind","wl"\];/, "«الكل» leads the tab list");
  assert.match(html, /let mktActiveTab="all";/, "«الكل» is the default tab");
  const ids = [...html.matchAll(/\{id:"([a-z]+)",label:"[^"]+"\},/g)].map((m) => m[1]);
  for (const wanted of ["all", "stocks", "currencies", "gold", "indices", "crypto"]) {
    assert.ok(ids.includes(wanted), `type filter ${wanted} exists`);
  }
  const render = functionBody("renderMktAll");
  assert.match(render, /mktAllFilter==="all"/, "«الكل» filter shows every category");
  assert.match(render, /mktAllType===mktAllFilter/, "a chosen filter shows only its type");
  assert.match(render, /if\(!liveStocks\.length&&!egxStocksFreshness\.loading\)fetchStocksData\(\);/, "EGX universe loads on demand");
  assert.match(render, /if\(!usStocks\.length&&!usStocksFreshness\.loading\)fetchUsStocksData\(\);/, "US universe loads on demand");
  assert.match(render, /غير متاح حاليًا/, "unpriced rows stay visible as unavailable — never invented");
  const merged = functionBody("renderMktTabContent");
  assert.match(merged, /renderMktAll\(\);/, "board refreshes re-render the unified list");
  assert.match(html, /renderMktUsTable\(\);\s*if\(mktActiveTab==="all"\)renderMktAll\(\);/, "US data refresh re-renders the unified list");
  assert.match(html, /renderMktWatchlist\(\);\s*if\(mktActiveTab==="all"\)renderMktAll\(\);/, "EGX data refresh re-renders the unified list");
});

test("unified «الكل» list: one card per asset, type fixed by where the server prices it", () => {
  const body = functionBody("mktAllAssets");
  const run = new Function("liveMarkets", "liveStocks", "usStocks", body + "\nreturn mktAllAssets();");
  const boardRow = (n, sec, id) => ({ instrumentId: id, n, v: "100", c: "1%", up: true, source: "Source", asOf: 0, state: "closed", stateLabel: "إغلاق" });
  const egxStock = { instrumentId: "stock:egx:COMI", sym: "COMI", name: "البنك التجاري الدولي", sector: "بنوك", price: 120, chgPct: -1.2, source: "TradingView Scanner", ts: 1, state: "closed", stateLabel: "إغلاق" };
  const usStock = { instrumentId: "stock:us:AAPL", sym: "AAPL", name: "Apple", sector: "Technology", price: 300, chgPct: 0.5, source: "Yahoo Finance", ts: 1, state: "closed", stateLabel: "إغلاق" };
  const rows = run(
    {
      eg: [boardRow("EGX30", "eg", "egx:EGX30")],
      gl: [boardRow("S&P 500", "gl", "index:SPX"), boardRow("EGX30", "gl", "egx:EGX30")], /* duplicate name from another section */
      cm: [boardRow("ذهب", "cm", "commodity:XAU"), boardRow("فضة", "cm", "commodity:XAG"), boardRow("نفط برنت", "cm", "commodity:BRN")],
      cr: [boardRow("BTC", "cr", "crypto:BTC")],
      fx: [boardRow("USD/EGP", "fx", "fx:USD-EGP"), boardRow("EUR/EGP", "fx", "fx:EUR-EGP")],
    },
    [egxStock, { ...egxStock, instrumentId: "stock:egx:COMI" }], /* same equity twice */
    [usStock],
  );
  const byName = new Map(rows.map((r) => [r.n, r]));
  assert.equal(rows.length, 10, "duplicates collapse: 12 rows in, 10 assets out");
  assert.equal(byName.get("EGX30").mktAllType, "indices", "EGX30 is an index");
  assert.equal(byName.get("EGX30").mktSec, "eg", "the first (Egyptian) row wins the duplicate");
  assert.equal(byName.get("S&P 500").mktAllType, "indices", "global board rows are indices");
  assert.equal(byName.get("البنك التجاري الدولي").mktAllType, "stocks", "EGX listed equity is a stock (card name = the source's name)");
  assert.equal(byName.get("البنك التجاري الدولي").sym, "COMI", "the listing symbol is kept for the detail view");
  assert.equal(byName.get("Apple").mktAllType, "stocks", "US listed equity is a stock");
  assert.equal(byName.get("ذهب").mktAllType, "gold", "gold has its own filter");
  assert.equal(byName.get("فضة").mktAllType, "commodity", "other metals are visible under «الكل» only");
  assert.equal(byName.get("BTC").mktAllType, "crypto", "crypto rows");
  assert.equal(byName.get("USD/EGP").mktAllType, "currencies", "forex rows");
  assert.equal(byName.get("EUR/EGP").mktAllType, "currencies", "forex rows");
});

test("forex section metadata survives client normalization (currency cards stay priced)", () => {
  /* Regression: normalizeMarketFreshness used to build sections for
   * eg/gl/cm/cr only — the missing fx section made the forex pane fall back
   * to «unavailable», so every currency card read «غير متاح» while the
   * server had priced the rows. */
  /* Same semantics as the app helper (const arrow — passed in, not extracted). */
  const finiteNumber = (value, fallback = 0) => {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  };
  const code = functionBody("normalizeMarketFreshness");
  const normalizeMarketFreshness = new Function("finiteNumber", code + "\nreturn normalizeMarketFreshness;")(finiteNumber);
  const out = normalizeMarketFreshness(
    { fetchedAt: 1_793_400_000_000, sections: { eg: { sources: "Trading Economics" }, gl: { sources: "Yahoo Finance" }, cm: { sources: "TradingView" }, cr: { sources: "CoinGecko" }, fx: { sources: "ExchangeRate-API, Yahoo Finance" } } },
    false,
  );
  assert.ok(out.sections.fx, "fx section metadata is normalized");
  assert.equal(out.sections.fx.sources, "ExchangeRate-API, Yahoo Finance");
  assert.equal(out.sections.fx.unavailable, false, "a sourced fx section is available");
  const dead = normalizeMarketFreshness({ fetchedAt: 0, sections: { fx: { sources: "غير متاح" } } }, true);
  assert.equal(dead.sections.fx.unavailable, true, "an unsourced fx section stays honestly unavailable");
  assert.equal(dead.stale, true);
});
