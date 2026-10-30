/**
 * Contract test for the market price chain honesty (TASK M — M1/M2).
 *
 * Pins the client+server halves of the fixes verified against production:
 *  - the board derives a change from the provider's previousClose; when the
 *    provider publishes no explicit changePercent (server sends "—"/flat),
 *    the client shows NO change at all — never a dash, never a direction,
 *  - the daily FX change comes only from the platform's own previously
 *    verified reading of the same provider, and only when its reference day
 *    advanced (never a same-day 0.00%, never a third-party number),
 *  - `asOf` is labelled "source publish time" or "server fetch time" by the
 *    server (`timeBasis`) and the UI must keep those labels distinct,
 *  - the landing hero's "آخر تحديث" chip uses the data's reference time
 *    (session close / refTime), not a fetch time,
 *  - no market-data API endpoint or key ever appears in browser code: all
 *    prices come from the same-origin /api/* backend (the TradingView
 *    widgets are display-only vendor frames and stay allowed).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "index.html"), "utf8");
const apiRoot = join(here, "..", "api-server", "src");
const marketsTs = readFileSync(join(apiRoot, "routes", "markets.ts"), "utf8");
const serviceTs = readFileSync(join(apiRoot, "lib", "market-data", "service.ts"), "utf8");
const providersTs = readFileSync(join(apiRoot, "lib", "market-data", "providers.ts"), "utf8");

test("server: the board derives the change from the provider's previousClose", () => {
  assert.ok(marketsTs.includes("export function deriveChangePercent"), "deriveChangePercent must exist and be exported");
  /* formatChange/toDisplayQuote must route through it, not read changePercent alone. */
  const formatChangeIdx = marketsTs.indexOf("function formatChange(");
  assert.ok(formatChangeIdx !== -1);
  const formatChange = marketsTs.slice(formatChangeIdx, formatChangeIdx + 400);
  assert.ok(formatChange.includes("deriveChangePercent(quote)"), "formatChange must use deriveChangePercent");
  /* A missing change with no previousClose stays absent (flat), never a fake 0. */
  const derive = marketsTs.slice(marketsTs.indexOf("export function deriveChangePercent("), marketsTs.indexOf("export function deriveChangePercent(") + 700);
  assert.ok(derive.includes("return null"), "no inputs -> null (rendered —), never an invented value");
});

test("server: timeBasis marks fetch-time asOf so the UI can label it truthfully", () => {
  assert.ok(
    marketsTs.includes('timeBasis: quote.sourceAsOfUnknown ? "fetch" : "source"'),
    "rows whose asOf is the server fetch time (scraper, scanner) must be marked timeBasis=fetch",
  );
});

test("server: the FX daily change is derived only from the same provider's previous verified reference", () => {
  assert.ok(serviceTs.includes("enrichFxDailyChange"), "the service must derive the FX daily change");
  assert.ok(serviceTs.includes("FX_REFERENCE_CACHE_KEY"), "the previous reference must be stored under a dedicated key");
  /* The change must require BOTH a strictly newer asOf and a different Cairo day. */
  const idx = serviceTs.indexOf("private async enrichFxDailyChange");
  assert.ok(idx !== -1);
  const body = serviceTs.slice(idx, idx + 2_500);
  assert.ok(body.includes("previous.asOf < quote.asOf"), "same/older reference time never produces a change");
  assert.ok(body.includes("cairoDayOf(previous.asOf) !== cairoDayOf(quote.asOf)"), "a same-day re-fetch must not be reported as a change");
  /* The reference record is best-effort: a cache failure must never break the price. */
  assert.ok(body.includes("catch"), "reference-store failures are fail-soft");
});

test("server: the FX provider persists one daily reference bar dated on its own publish day", () => {
  const cls = providersTs.indexOf("export class ExchangeRateApiProvider");
  assert.ok(cls !== -1);
  const body = providersTs.slice(cls, providersTs.indexOf("const FX_REFERENCE_PAIRS"));
  assert.ok(body.includes("async getDailyOhlc"), "ExchangeRateApiProvider must expose a daily reference bar");
  assert.ok(body.includes("open: value"), "no intraday shape is invented for a reference value");
  assert.ok(body.includes("high: value") && body.includes("low: value") && body.includes("close: value"), "O=H=L=C for the reference bar");
  assert.ok(/tradingDate[\s\S]{0,400}?time_last_update_unix|dayPart\("year"\)/.test(body), "the bar is dated from the provider's publish time");
});

test("client: rows keep timeBasis and refTime from the server", () => {
  const idx = html.indexOf("function normalizeMarketRows(");
  assert.ok(idx !== -1);
  const body = html.slice(idx, idx + 1_600);
  assert.ok(body.includes("timeBasis:String(m.timeBasis"), "timeBasis must survive normalization");
  assert.ok(body.includes("refTime:finiteNumber(m.refTime"), "refTime must survive normalization");
});

test("client: a server fetch time is labelled \"وقت الجلب\", a source time \"وقت المصدر\"", () => {
  const boardIdx = html.indexOf("function buildMarkets(");
  assert.ok(boardIdx !== -1);
  const board = html.slice(boardIdx, boardIdx + 5_000);
  assert.ok(board.includes('m.timeBasis==="fetch"?"وقت الجلب":"وقت المصدر"'), "board rows must distinguish the two time meanings");
  assert.ok(!/وقت المصدر: \$\{sanitize\(cairoTimestampLabel\(asOf\)\)/.test(board), "the board must no longer hardcode the source-time label");

  const detailIdx = html.indexOf("function openMarketDetail(");
  assert.ok(detailIdx !== -1);
  const detail = html.slice(detailIdx, detailIdx + 1_800);
  assert.ok(detail.includes('m.timeBasis==="fetch"?"وقت الجلب":"وقت المصدر"'), "the detail modal must use the same rule");
});

test("client: the landing hero's last-update chip uses the data's reference time, not a fetch time", () => {
  const heroIdx = html.indexOf("function renderHero(");
  assert.ok(heroIdx !== -1);
  const hero = html.slice(heroIdx, heroIdx + 3_000);
  assert.ok(hero.includes("Number(d[0].refTime)||Number(d[0].asOf)"), "refTime (the session close) must win over asOf for closed rows");
});

test("client: no market-data API endpoint or credential exists in browser code", () => {
  for (const forbidden of [
    "open.er-api.com",
    "er-api.com",
    "query1.finance.yahoo.com",
    "query2.finance.yahoo.com",
    "tradingeconomics.com/egypt/stock-market",
    "api.coingecko.com",
    "api.twelvedata.com",
    "x-api-key",
    "apiKey=",
    "apikey=",
  ]) {
    assert.ok(!html.toLowerCase().includes(forbidden.toLowerCase()), `browser code must not contain ${forbidden}`);
  }
  /* The only allowed external host is the display-only TradingView widget. */
  assert.ok(html.includes("s3.tradingview.com"), "display-only TradingView widgets remain (vendor-attributed frames)");
});

test("client: flat rows render no change at all — never a dash, never a direction", () => {
  const boardIdx = html.indexOf("function buildMarkets(");
  const board = html.slice(boardIdx, boardIdx + 6_000);
  assert.ok(board.includes('const hasChange=!unavailable&&m.c&&m.c!=="—"'), "the server's '—'/flat change is excluded from display");
  assert.ok(!board.includes('unavailable||m.flat?"—"'), "the dash placeholder is gone from the card template");
});

test("client: the admin panel obeys the same flat contract — no direction arrow on EOD dashes", () => {
  /* admin.html renders the same board rows (ticker, strip, cards, modals, home stats).
     An unguarded `(t.up?"▲":"▼")+t.c` prints a direction arrow next to the EOD "—"
     dash — exactly the fake-direction the contract forbids (shipped regression,
     fixed 2026-10-31 after launch). Pin the guard on every board renderer. */
  const admin = readFileSync(join(here, "admin.html"), "utf8");
  const guardedTick = '(unavailable||t.flat)?"—":(t.up?"▲":"▼")+sanitize(t.c)';
  const guardedCard = '(unavailable||m.flat)?"—":(m.up?"▲":"▼")+" "+sanitize(m.c)';
  assert.ok(admin.includes(guardedTick), "admin ticker/strip must guard on t.flat before printing an arrow");
  assert.ok(admin.includes(guardedCard), "admin market cards must guard on m.flat before printing an arrow");
  assert.ok(admin.includes('change:(unavailable||m.flat)?"—"'), "admin detail modal must guard on m.flat");
  assert.ok(admin.includes('m.flat?"var(--t4)":m.up?"var(--g)"'), "admin home market stats must guard on m.flat");
  /* The old unguarded renderers must be gone for good. */
  assert.ok(!admin.includes('${unavailable?"—":(t.up?"▲":"▼")+sanitize(t.c)}'), "unguarded ticker renderer must not come back");
  assert.ok(!admin.includes('${unavailable?"—":(m.up?"▲":"▼")+" "+sanitize(m.c)}'), "unguarded card renderer must not come back");
});
