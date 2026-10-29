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
  // Every render/export path that can see no-data rows must branch on noData
  // (or a knownStockNumber guard) before formatting a price.
  for (const fn of ["renderScrResults", "exportScrCSV"]) {
    const body = functionBody(fn);
    assert.match(body, /noData/, `${fn} must branch on noData`);
  }
  const screenerRow = functionBody("renderScrResults");
  assert.match(screenerRow, /noData\?"—":s\.price\.toFixed\(2\)/, "screener price cell shows — for no-data rows");
  const csv = functionBody("exportScrCSV");
  assert.match(csv, /\(s\.noData===true\|\|!\(typeof s\.price==="number"&&Number\.isFinite\(s\.price\)\)\)\?"":s\.price\.toFixed\(2\)/, "CSV export leaves the price blank for no-data rows");
  const egxPage = functionBody("renderStocks");
  assert.match(egxPage, /noData\?"—":s\.price\.toFixed\(2\)/, "EGX page price cell shows — for no-data rows");
});

test("the EGX page skips sparklines for no-data rows", () => {
  const body = functionBody("renderStocks");
  assert.match(body, /scheduleSparklines\(curStocks\.filter\(stock=>!stock\.noData\)\.map\(stock=>stock\.instrumentId\)\)/, "no-data rows must not be requested in the sparkline batch");
});

test("the screener footer explains no-data rows and unavailable columns", () => {
  const body = functionBody("renderScrResults");
  assert.match(body, /بدون بيانات من المصدر/, "footer states how many rows lack source data");
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
  assert.match(results, /const stocks_src=liveStocks;/, "results render from the EGX list only");
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
  assert.match(body, /for\(const s of liveStocks\)/, "sector pills count the sectors present in the loaded EGX rows");
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
