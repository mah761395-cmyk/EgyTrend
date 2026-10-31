/**
 * Contract test for the SIMPLE portfolio (rebuilt from scratch, 2026-10-31).
 *
 * The page must stay honest and practical by construction:
 *  - "إضافة سهم" searches only the server's stock list (liveStocks); picking a
 *    candidate fills the SYMBOL field only — the cost field is always the
 *    user's real average buy price, never a market quote;
 *  - adding posts to POST /api/portfolio/positions {symbol, quantity,
 *    averageCost}; a symbol already held through the trade ledger
 *    (position id "pos:<SYM>") is refused on the client before hitting the
 *    server, and the server's 409 message is surfaced verbatim otherwise;
 *  - editing (PUT) and deleting (DELETE, after confirm()) go through the
 *    positions API for table-stored rows; ledger-derived rows expose the
 *    trade log (📋) instead of ✏️/🗑, so no ledger data is ever lost;
 *  - cash deposits/withdrawals round-trip through POST /api/portfolio/cash;
 *    the exact server error (e.g. temporal insufficient_cash) is shown;
 *  - the hero shows the server's totalValue; while any held position lacks a
 *    verified quote it shows the server's priced part + «بلا سعر» and NO
 *    P/L figure — never a partial fabricated one;
 *  - the assets table shows — instead of a price/value/P&L when no verified
 *    quote exists, and % of portfolio from the server weight when available;
 *  - nothing in the portfolio block writes portfolio truth to
 *    localStorage / indexedDB.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "index.html"), "utf8");

function functionBody(name, isAsync = false) {
  const marker = (isAsync ? "async function " : "function ") + name + "(";
  const start = html.indexOf(marker);
  assert.ok(start !== -1, `index.html must define ${name}`);
  /* skip the parameter list (it may contain object defaults like {…}) */
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

test("add-asset form: candidates from the server stock list only; price is never auto-filled", () => {
  const card = functionBody("nfpAddCardHtml");
  assert.match(card, /id="nfp-sym"/, "symbol input with autocomplete");
  assert.match(card, /id="nfp-qty"/, "integer quantity input");
  assert.match(card, /id="nfp-cost"/, "average-cost input (user's real buy price)");
  assert.match(card, /متوسط سعر الشراء/, "cost field labelled as the user's average buy price");
  assert.match(card, /nfpAddSubmit/, "submit handler");
  const suggest = functionBody("nfpStockSuggest");
  assert.match(suggest, /liveStocks/, "candidates come from the server's stock list only");
  assert.doesNotMatch(suggest, /"COMI"|'COMI'/, "no hardcoded/fabricated symbols");
  const pick = functionBody("nfpPickStock");
  assert.match(pick, /nfp-sym/, "picking a candidate fills the symbol field");
  assert.doesNotMatch(pick, /nfp-cost/, "the cost field is never auto-filled from a quote");
});

test("adding posts {symbol, quantity, averageCost} and validates before any request", () => {
  const body = functionBody("nfpAddSubmit", true);
  assert.match(body, /\/api\/portfolio\/positions/, "posts to the positions endpoint");
  assert.match(body, /method:"POST"/);
  assert.match(body, /JSON\.stringify\(\{symbol:sym,quantity:qty,averageCost:cost\}\)/, "exact payload contract");
  assert.match(body, /Number\.isInteger\(qty\)/, "quantity must be an integer");
  assert.match(body, /cost<=0/, "cost must be > 0");
  assert.match(body, /credentials:"same-origin"/, "session-authenticated fetch");
  /* A symbol already held through the trade ledger is managed via the trade
   * log — adding it again would create an orphan row the server would 409. */
  assert.match(body, /pos:/, "ledger-held symbol (id pos:<SYM>) is refused client-side");
  assert.match(body, /409/, "server 409 fallback surfaced");
});

test("editing uses PUT on the positions API; ledger rows are managed via the trade log", () => {
  const save = functionBody("nfpEditSave", true);
  assert.match(save, /method:"PUT"/);
  assert.match(save, /\/api\/portfolio\/positions\/\$\{encodeURIComponent\(id\)\}/, "PUT by id");
  assert.match(save, /JSON\.stringify\(\{symbol:p\.sym,quantity:qty,averageCost:cost\}\)/, "edit payload keeps the same symbol");
  const row = functionBody("nfpRowHtml");
  assert.match(row, /pos:/, "detects ledger-derived rows by id prefix");
  assert.match(row, /nfpEditStart/, "table-stored rows get the edit button");
  assert.match(row, /nfpDeletePos/, "table-stored rows get the delete button");
  assert.match(row, /nfpOpenTxLog/, "ledger rows expose the trade log instead");
});

test("deleting asks for confirmation and soft-archives through the server", () => {
  const del = functionBody("nfpDeletePos", true);
  assert.match(del, /confirm\(/, "destructive action asks first");
  assert.match(del, /method:"DELETE"/);
  assert.match(del, /\/api\/portfolio\/positions\/\$\{encodeURIComponent\(id\)\}/, "DELETE by id");
});

test("cash: server round-trip, exact error surfaced, deletable events", () => {
  const submit = functionBody("nfpCashSubmit", true);
  assert.match(submit, /fetch\("\/api\/portfolio\/cash"/, "posts to the server endpoint");
  assert.match(submit, /method:"POST"/);
  assert.match(submit, /JSON\.stringify\(\{kind,amount:amt,note:note\|\|null\}\)/, "exact payload (deposit|withdrawal)");
  assert.match(submit, /j\?\.message/, "the server's exact error text (incl. insufficient_cash) is surfaced");
  const del = functionBody("nfpDeleteCash", true);
  assert.match(del, /confirm\(/, "destructive action asks first");
  assert.match(del, /method:"DELETE"/);
  assert.match(del, /\/api\/portfolio\/cash\/\$\{encodeURIComponent\(id\)\}/, "soft-delete by id");
  const card = functionBody("nfpCashCardHtml");
  assert.match(card, /portfolioData\.cashEvents/, "event list from the server payload");
  assert.match(card, /s\.cash/, "balance from the server summary, never local math");
});

test("hero: server total, honest partial state, P/L only with full verified pricing", () => {
  const hero = functionBody("nfpHeroHtml");
  assert.match(hero, /s\.totalValue/, "total from the server summary");
  assert.match(hero, /s\.totalValuePriced/, "priced part when not everything is priced");
  assert.match(hero, /\+ بلا سعر/, "partial state labelled, not hidden");
  assert.match(hero, /s\.unrealizedPnl/, "P/L from the server summary");
  assert.match(hero, /un===null/, "no P/L figure while any held position is unpriced");
  assert.match(hero, /missingPriceSymbols/, "the unpriced symbols are named");
  assert.match(hero, /heroSourceLine\(\)/, "named price source + time line");
  /* The hero never draws a % or value from client-side price math. */
  assert.doesNotMatch(hero, /liveStocks/, "hero pricing never reads local quotes directly");
});

test("table: required columns; — instead of price/value/P&L without a verified quote", () => {
  const table = functionBody("nfpTableHtml");
  assert.match(table, /الأصل/, "asset column");
  assert.match(table, /الكمية/, "quantity column");
  assert.match(table, /متوسط الشراء/, "average-cost column");
  assert.match(table, /السعر الحالي/, "current-price column");
  assert.match(table, /القيمة/, "value column");
  assert.match(table, /% من المحفظة/, "% of portfolio column");
  assert.match(table, /ربح\/خسارة/, "P/L column");
  const row = functionBody("nfpRowHtml");
  assert.match(row, /— بلا سعر/, "unpriced row says so explicitly");
  assert.match(row, /p\.marketValue/, "value from the server per-position field");
  assert.match(row, /p\.weightPct/, "weight from the server when available");
  assert.match(row, /cairoTimestampLabel\(pr\.asOf\)/, "quote time shown with the price");
});

test("allocation is a labelled visual aid; unpriced rows are drawn at cost and flagged", () => {
  const alloc = functionBody("nfpAllocHtml");
  assert.match(alloc, /nfp-alloc-cost/, "cost-drawn segments get a distinct style");
  assert.match(alloc, /بلا سعر — معروض بالتكلفة/, "cost-drawn segments are labelled as such");
  assert.match(alloc, /p\.market/, "priced segments use the verified quote");
  assert.match(alloc, /p\.price\*p\.qty/, "cost = qty × recorded average cost");
  assert.match(alloc, /s\.cash/, "cash segment from the server summary");
});

test("no portfolio truth is persisted to localStorage / indexedDB in the portfolio block", () => {
  /* The whole simple-portfolio block (renderer + actions) must not write
   * portfolio data locally — the server owns it. UI-only state (edit id,
   * busy flags) lives in plain variables. */
  const start = html.indexOf("PORTFOLIO — the simple portfolio (rebuilt from scratch)");
  assert.ok(start !== -1, "portfolio block found");
  const end = html.indexOf("function pfpVisible(");
  assert.ok(end !== -1 && end > start, "block end found");
  const block = html.slice(start, end);
  assert.doesNotMatch(block, /localStorage\.set/, "no localStorage writes");
  assert.doesNotMatch(block, /DB\.set\(.*portfolio/i, "no indexed-DB portfolio writes");
});

test("periodic refresh re-fetches from the server only while a portfolio host is visible", () => {
  const timer = functionBody("nfpEnsureTimer");
  assert.match(timer, /60000/, "one-minute cadence");
  assert.match(timer, /nfpVisibleHost\(\)/, "no fetches while the page/tab is hidden");
  assert.match(timer, /loadServerPortfolio\(true\)/, "forced server refresh, never a local recompute");
  const hook = html.slice(
    html.indexOf("async function loadServerPortfolio("),
    html.indexOf("function portStats("),
  );
  assert.match(hook, /pfpVisible\(\)/, "page host re-renders after every server load");
  assert.match(hook, /nfpRender\(h\)/, "re-render goes through the single renderer");
});
