/**
 * Contract test for the investor portfolio dashboard (TASK I).
 *
 * The dashboard must stay honest by construction:
 *  - every price shown comes from a verified server quote (price + named
 *    source + asOf); without one the cell/detail shows "—", never stale or
 *    invented,
 *  - the return-% KPI uses the server's totalBuyOutlay denominator and is
 *    hidden (—) whenever any input is missing,
 *  - "إضافة أصل" searches only the server's stock list; picking a candidate
 *    fills the symbol field only — the price field is always the user's real
 *    trade price,
 *  - the asset table offers search / sort / filter and a row detail with the
 *    per-symbol trade history and any available licensed performance,
 *  - allocation can be by asset or by sector; cost-vs-market and all charts
 *    degrade to an explicit empty state, never a drawn estimate.
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

test("return-% KPI: server denominator, null when any input is missing", () => {
  const body = functionBody("portReturnPct");
  assert.match(body, /totalBuyOutlay/, "denominator must be the server's totalBuyOutlay");
  assert.match(body, /outlay>0/, "zero/negative outlay must not yield a %");
  assert.match(body, /unrealizedPnl===null/, "missing unrealized → null, never a fabricated %");
});

test("KPI row covers value, cost, return %, cash, realized and unrealized", () => {
  const body = functionBody("portKpis");
  assert.match(body, /قيمة المحفظة الإجمالية/, "total value card");
  assert.match(body, /تكلفة المراكز القائمة/, "held-asset cost card");
  assert.match(body, /العائد على التكلفة المنصرفة/, "return-% card");
  assert.match(body, /السيولة النقدية/, "cash card");
  assert.match(body, /غير المحقّق/, "unrealized card");
  assert.match(body, /المحقّق/, "realized card");
});

test("إضافة أصل button opens the trade form's stock search", () => {
  assert.match(html, /＋ إضافة أصل/, "the add-asset button exists");
  const focus = functionBody("portAddAssetFocus");
  assert.match(focus, /port-tx-sec/, "scrolls to the transactions section");
  assert.match(focus, /ptx-sym/, "focuses the stock search input");
});

test("stock picker searches only the server stock list; never auto-fills price", () => {
  const suggest = functionBody("portStockSuggest");
  assert.match(suggest, /liveStocks/, "candidates come from the server's stock list only");
  assert.doesNotMatch(suggest, /"COMI"|'COMI'/, "no hardcoded/fabricated symbols");
  const pick = functionBody("portPickStock");
  assert.match(pick, /ptx-sym/, "picking a candidate fills the symbol field");
  assert.doesNotMatch(pick, /ptx-price/, "the price field is never auto-filled from a quote");
});

test("asset table: search, filter, sort and the required columns", () => {
  const table = functionBody("portPositionsTable");
  assert.match(table, /port-pos-search/, "search input");
  assert.match(table, /portPosFilter/, "held/closed/all filter");
  assert.match(table, /portAddAssetFocus/, "add-asset entry point in the table header");
  const body = functionBody("portPosTableBody");
  /* the header helper renders onclick="portPosSortToggle('<key>')" */
  assert.match(body, /portPosSortToggle\('\$\{key\}'\)/, "headers are sort toggles");
  for (const key of ["sym", "qty", "avg", "price", "cost", "value", "pnl", "updated"]) {
    assert.ok(body.includes(`th("${key}",`), `sortable column ${key}`);
  }
  assert.match(body, /الأصل|الكمية|متوسط التكلفة|آخر سعر|التكلفة المتبقية|القيمة الحالية|ربح\/خسارة|التحديث/, "all required column headers");
  const sort = functionBody("portPosRows");
  assert.match(sort, /missA-missB/, "rows without a verified price sort last, never first");
});

test("asset table shows — instead of a price when no verified quote exists", () => {
  const body = functionBody("portPosTableBody");
  assert.match(body, /pr!==null\?pr\.toFixed\(2\):"—"/, "last-price cell guarded by verified quote");
  assert.match(body, /p\.market\?cairoTimestampLabel\(p\.market\.asOf\):"—"/, "last-updated cell guarded by verified quote");
  assert.match(body, /لا سعر قديم ولا سعر مخترع/, "the footer states the no-stale/no-invented rule");
});

test("row detail: per-symbol trade history + licensed performance only", () => {
  const body = functionBody("portPosDetailPanel");
  assert.match(body, /portfolioData\.transactions/, "trade history from the server ledger");
  assert.match(body, /toUpperCase\(\)===p\.sym/, "history filtered to the row's symbol");
  assert.match(body, /VA_SERIES_CACHE/, "performance only from the cached licensed closes");
  assert.match(body, /لا يتوفر سجل إغلاق يومي مرخّص/, "honest note when no licensed history");
  assert.match(body, /بلا سعر موثّق الآن/, "honest note when no verified quote");
  assert.match(body, /portEditTx|portDelTx/, "trades remain editable/deletable from the detail");
});

test("allocation: by asset and by sector, toggle re-binds charts", () => {
  const alloc = functionBody("pfAllocation");
  assert.match(alloc, /byAsset\?row\.p\.sym:/, "asset mode groups by symbol");
  assert.match(alloc, /row\.p\.sector/, "sector mode groups by catalog sector");
  const toggle = functionBody("portAllocToggle");
  assert.match(toggle, /port-analytics/, "re-renders the analytics host");
  assert.match(toggle, /vaBindCharts/, "re-binds chart interactions after the swap");
});

test("cost vs market card degrades honestly without priced positions", () => {
  const body = functionBody("pfCostVsMarketCard");
  assert.match(body, /لا توجد مراكز مسعّرة/, "explicit empty state");
  assert.match(body, /pf-cmp-cost/, "cost bar");
  assert.match(body, /pf-cmp-mv/, "market-value bar");
  assert.match(body, /row\.p\.price\*row\.p\.qty/, "cost = qty × average cost");
  assert.match(body, /row\.pr\*row\.p\.qty/, "market = qty × verified price");
});
