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
