/**
 * Contract test for the stock screener's data honesty.
 *
 * The "37 stocks" incident had two silent-dropping layers: the API only
 * priced a curated subset, and normalizeStockList() silently discarded every
 * row without a price. This test pins the client half of the fix:
 *  - rows the server flags noData survive normalization (counter stays true),
 *  - no UI surface calls toFixed on a possibly-absent price,
 *  - the landing headline counts priced stocks, not rows,
 *  - the black-area fix: while the landing is on screen the app frame gives
 *    way (no max-width cap, no sidebar padding, no side borders), with no
 *    clipping or page-wide overflow tricks,
 *  - unexplained "—" cells are gone: the screener footer states which rows
 *    lack data and which columns the source does not provide.
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
  // Capture the balanced function body starting at the first "{" after the
  // signature; the inline scripts define whole functions on one line each,
  // so a brace scan is reliable.
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

test("normalizeStockList keeps server-flagged no-data rows", () => {
  const body = functionBody("normalizeStockList");
  assert.match(body, /noData=s\.noData===true/, "must read the server's noData flag");
  // The row is only dropped when it is BOTH not no-data AND unpriced.
  assert.match(body, /\(!noData&&\(!Number\.isFinite\(price\)\|\|price<=0\)\)/, "unpriced rows are dropped only when not flagged noData");
  // No-data rows must not keep a price: every numeric field is nulled.
  assert.match(body, /price:noData\?undefined:price/, "no-data rows carry no price");
  // The list cap stays for sanity but far above any real EGX listing count.
  assert.match(body, /\.slice\(0,600\)/, "the 600-row safety cap is preserved");
});

test("no stock UI surface calls toFixed on a possibly-absent price", () => {
  // Every render/export path must guard a price before formatting it.
  const priced = functionBody("scrPricedStocks");
  assert.match(priced, /s\.noData!==true&&typeof s\.price==="number"&&Number\.isFinite\(s\.price\)&&s\.price>0/, "the priced-row helper is the single noData/price guard");
  const screenerRow = functionBody("renderScrResults");
  assert.match(screenerRow, /noData\?"—":s\.price\.toFixed\(2\)/, "screener price cell shows — for no-data rows");
  const csv = functionBody("exportScrCSV");
  assert.match(csv, /\(typeof s\.price==="number"&&Number\.isFinite\(s\.price\)\)\?s\.price\.toFixed\(2\):""/, "CSV export never formats a missing price");
  assert.match(csv, /const stocks_src=scrPricedStocks\(\)/, "CSV export mirrors the on-screen priced-only row set");
  const egxPage = functionBody("renderStocks");
  assert.match(egxPage, /noData\?"—":s\.price\.toFixed\(2\)/, "EGX page price cell shows — for no-data rows");
});

test("the EGX page skips sparklines for no-data rows", () => {
  const body = functionBody("renderStocks");
  assert.match(body, /scheduleSparklines\(curStocks\.filter\(stock=>!stock\.noData\)\.map\(stock=>stock\.instrumentId\)\)/, "no-data rows must not be requested in the sparkline batch");
});

test("the screener footer explains no-data rows and unavailable columns", () => {
  const body = functionBody("renderScrResults");
  assert.match(body, /تم استبعاد \$\{excludedNoData\} سهم بدون بيانات من المصدر/, "footer discloses exactly how many no-data rows were excluded");
  assert.match(body, /غير متاحة من المصدر/, "footer states the columns the source does not provide");
  const counter = body.match(/countEl\.textContent=`\$\{stocks\.length\} سهم/);
  assert.ok(counter, "counter still reflects the real post-filter count");
});

test("the landing headline counts priced stocks, not rows", () => {
  const loadStats = functionBody("loadStats");
  assert.match(loadStats, /d\?\.pricedCount/, "prefers the server's pricedCount");
  assert.match(loadStats, /d\.stocks\.filter\(s=>!s\.noData\)\.length/, "falls back to counting non-no-data rows");
  assert.ok(!/lnd-stat-stocks",fmtInt\(Array\.isArray/.test(loadStats), "must not count raw rows for the headline");
});

test("guest mode: the app frame gives way to the landing (no black strips)", () => {
  // The fix: while the landing is visible the frame is full-bleed.
  const frameRule = /#app:has\(#landing:not\(\[hidden\]\)\)\{max-width:none;padding-right:0;border-left:none;border-right:none;\}/;
  assert.match(html, frameRule, "frame rule must remove cap, sidebar padding and borders while the landing is on screen");
  // The fix must be layout, not faked with clipping: the rule itself and the
  // landing element must not rely on overflow tricks.
  const frameMatch = html.match(/#app:has\(#landing:not\(\[hidden\]\)\)\{[^}]*\}/);
  assert.ok(frameMatch, "the guest frame rule exists");
  assert.ok(!frameMatch[0].includes("overflow"), "the frame rule uses no overflow tricks");
  assert.ok(!html.match(/#landing(?::[^{]*)?\{[^}]*overflow\s*:\s*hidden/), "no clipping of the landing itself");
  // The logged-in layout must keep the sidebar padding (the sidebar is real
  // when logged in).
  assert.match(html, /#app\{max-width:1400px;margin:0 auto;padding-right:240px;/, "logged-in desktop frame keeps the 240px sidebar room");
});

test("the no-data state is visible, never silent", () => {
  assert.ok(html.includes("لا بيانات من المصدر"), "EGX page tags no-data rows explicitly");
  assert.ok(html.includes("لا بيانات"), "screener table tags no-data rows explicitly");
});

test("the screener is EGX-only: no NYSE/foreign market option anywhere in it", () => {
  // The UI: no US tab element and no market-switch call with "us".
  assert.ok(!html.includes("scr-tab-us"), "no US market tab element in the DOM template");
  assert.ok(!/setScrMarket\(\s*["']us["']/.test(html), "no code path switches the screener to a foreign market");
  const build = functionBody("vBuildScr");
  assert.ok(!build.includes("نيويورك") && !build.includes("NYSE"), "the screener header names no foreign exchange");
  assert.ok(build.includes("البورصة المصرية"), "the screener header names the Egyptian exchange");
  // The data path: results and CSV read the EGX list, not a market switch.
  const results = functionBody("renderScrResults");
  assert.match(results, /const all=liveStocks;/, "the EGX list is the only data source");
  assert.match(results, /const stocks_src=scrPricedStocks\(\);/, "results render the priced-only subset of the EGX list");
  assert.ok(!/usStocks/.test(results), "the results table never reads the US list");
  const csv = functionBody("exportScrCSV");
  assert.match(csv, /EgyTrend_EGX_/, "CSV export is labeled EGX");
  assert.ok(!/usStocks/.test(csv), "CSV export never reads the US list");
});

test("the screener table shows every field the source provides, with null guards", () => {
  const results = functionBody("renderScrResults");
  // Required visible fields: last price, absolute change, change %, session
  // high/low, volume, traded value — each guarded against absent data.
  assert.match(results, /knownStockNumber\(s\.chg\)/, "absolute change cell is null-guarded");
  assert.match(results, /s\.chgPct/, "percent change cell present");
  assert.match(results, /num\(s\.high,2\)/, "session high cell present");
  assert.match(results, /num\(s\.low,2\)/, "session low cell present");
  assert.match(results, /fmtVol\(s\.vol\)/, "volume cell present");
  assert.match(results, /s\.amount/, "traded-value cell present");
  assert.match(results, /fmtAmountEgp/, "traded value is formatted in EGP, not invented units");
  // The table header carries the same columns (sortable).
  const build = functionBody("vBuildScr");
  for (const col of ["آخر سعر (ج)", "تغيّر (ج)", "تغيّر %", "الأعلى", "الأدنى", "الحجم", "قيمة التداول"]) {
    assert.ok(build.includes(col), `screener header must include the "${col}" column`);
  }
});

test("sector pills are built from the loaded data, never a hard-coded list", () => {
  const body = functionBody("renderScrSectorPills");
  assert.match(body, /for\(const s of priced\)/, "sector pills count the sectors present in the loaded EGX rows");
  assert.match(body, /const priced=scrPricedStocks\(\);/, "pills count the priced-only rows the screener shows");
  assert.ok(!body.includes("usSectors"), "no foreign sector list remains");
  // The stale hard-coded Arabic sector list must be gone.
  assert.ok(!/عقارات:🏢 عقارات/.test(body), "the hard-coded sector list was replaced by data-driven pills");
});

test("the screener footer states session state, the source note and the exact missing columns", () => {
  const results = functionBody("renderScrResults");
  assert.match(results, /meta\.stateLabel/, "footer shows the session state (live/closed) when the server publishes it");
  assert.match(results, /meta\.sourceNote/, "footer renders the server's own latency note verbatim");
  assert.match(results, /scrMissingColumns\(/, "footer lists exactly the columns the source did not provide");
  const missing = functionBody("scrMissingColumns");
  assert.match(missing, /قيمة التداول/, "traded value is reported when absent");
  assert.match(missing, /52 أسبوع/, "52-week range is reported when absent");
});

/* ─── TASK G: no-data exclusion + secondary fundamentals layer ─── */

test("the secondary fundamentals endpoints are pinned", () => {
  assert.match(html, /const DIVIDENDS_API\s*=\s*"\/api\/markets\/dividends"/, "dividends endpoint constant");
  assert.match(html, /const VALUATIONS_API\s*=\s*"\/api\/markets\/valuations"/, "valuations endpoint constant");
});

test("fetchScreenerExtras runs fire-and-forget after the price scan", () => {
  const fetch = functionBody("fetchStocksData");
  assert.match(fetch, /fetchScreenerExtras\(\);/, "the price scan triggers the extras fetch");
  assert.ok(!/await\s+fetchScreenerExtras\(\)/.test(fetch), "the extras fetch must NOT be awaited — it cannot delay the price table");
});

test("fetchScreenerExtras is bounded, cached per response, and fail-soft", () => {
  const body = functionBody("fetchScreenerExtras");
  assert.match(body, /\.slice\(0,40\)/, "dividends are requested for at most 40 tickers (server cap)");
  assert.match(body, /sort\(\(a,b\)=>\(b\.mktCapM\|\|0\)-\(a\.mktCapM\|\|0\)\)/, "dividend picks are the largest priced names by market cap");
  assert.match(body, /\.slice\(0,300\)/, "valuations are requested for at most 300 tickers (server cap)");
  assert.match(body, /Promise\.allSettled/, "the two vendors are fetched in parallel and none can reject the batch");
  assert.match(body, /scrExtrasInFlight/, "re-entrancy guard prevents duplicate in-flight batches");
  assert.ok(!/s\.amount/.test(body), "the secondary layer must never write traded value (no free source exists)");
  assert.ok(!/\.pe\s*=/.test(body) || /nf\.valuations\.set/.test(body), "values land in the egxFundamentals map, never silently in the price rows");
});

test("merged accessors prefer the price scan and fall back to the secondary layer", () => {
  const pe = functionBody("scrPe");
  assert.match(pe, /knownStockNumber\(s\.pe\)/, "P/E: the price-scan value wins when present");
  assert.match(pe, /egxFundamentals\.valuations\.get\(s\.sym\)/, "P/E: falls back to the EGX official layer");
  const dy = functionBody("scrDy");
  assert.match(dy, /knownStockNumber\(s\.divYield\)/, "DY: the price-scan value wins when present");
  assert.match(dy, /egxFundamentals\.valuations\.get\(s\.sym\)/, "DY: falls back to the EGX official layer");
  const div = functionBody("scrDivTtm");
  assert.match(div, /d\.status==="ok"/, "TTM dividends are shown only for rows the source confirmed");
});

test("the screener table and CSV use the merged P/E + dividend yield", () => {
  const results = functionBody("renderScrResults");
  assert.match(results, /scrPe\(s\)!==null\?scrPe\(s\)\.toFixed\(1\):"—"/, "table P/E cell uses the merged value with an honest —");
  assert.match(results, /scrDy\(s\)!==null\?scrDy\(s\)\.toFixed\(2\)\+"%":"—"/, "table DY cell uses the merged value with an honest —");
  const csv = functionBody("exportScrCSV");
  assert.match(csv, /scrPe\(s\)!==null\?scrPe\(s\)\.toFixed\(2\):""/, "CSV P/E column uses the merged value");
  assert.match(csv, /scrDy\(s\)!==null\?scrDy\(s\)\.toFixed\(2\):""/, "CSV Div Yield column uses the merged value");
});

test("the P/E and dividend filters operate on the merged values", () => {
  const filtered = functionBody("scrComputeFiltered");
  assert.match(filtered, /scrPe\(s\)/, "P/E filter uses the merged value");
  assert.match(filtered, /scrDy\(s\)/, "dividend filter uses the merged value");
});

test("the detail modal discloses TTM dividends, P/E and coupon yield for EGX", () => {
  const detail = functionBody("openStockDetail");
  assert.match(detail, /توزيعات آخر 12 شهرًا/, "detail modal shows trailing-12-month dividends");
  assert.match(detail, /scrDivTtmText\(s\)/, "TTM dividend text comes from the merged accessor");
  assert.match(detail, /scrPeText\(s\)/, "detail modal shows P/E via the honest text accessor");
  assert.match(detail, /scrDy\(s\)!==null\?scrDy\(s\)\.toFixed\(2\)\+"%":"غير متاح"/, "detail modal shows coupon yield or an explicit غير متاح");
  const peText = functionBody("scrPeText");
  assert.match(peText, /غير متاح/, "a missing P/E says غير متاح");
  assert.match(peText, /غير موجب/, "P/E = 0 (no positive earnings on the EGX page) is not printed as a bare 0.00");
});

test("the screener excludes no-data rows and discloses the exclusion", () => {
  const results = functionBody("renderScrResults");
  assert.match(results, /const excludedNoData=all\.length-stocks_src\.length;/, "the excluded count is derived, never hard-coded");
  assert.match(results, /countEl\.textContent=`\$\{stocks\.length\} سهم`;/, "the counter shows only the rows actually shown");
  assert.ok(!/\(noDataCount\)/.test(results), "no stale noDataCount plumbing remains in the counter");
  // normalizeStockList still keeps the no-data rows — the exclusion is a
  // view decision, so the market page and detail view keep working.
  const norm = functionBody("normalizeStockList");
  assert.match(norm, /const noData=s\.noData===true;/, "normalization still preserves no-data rows");
});
