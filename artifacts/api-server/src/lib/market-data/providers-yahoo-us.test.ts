/**
 * Contract test: the US equity section (stock:us:*) is priced by the same
 * Yahoo v8 chart endpoint the board already uses for global indices — one
 * real, sourced provider, no invented rows. Before this fix, no configured
 * provider could serve stock:us:* (the curated symbol map only covered
 * indices/commodities/fx), so /api/markets/us-stocks returned 0 priced rows
 * of its 50-symbol catalog (verified live in production, 2026-10-31).
 *
 * Hermetic: a fake http client stands in for query1.finance.yahoo.com.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { YahooChartProvider } from "./providers";
import type { MarketInstrument } from "./types";

const usAapl: MarketInstrument = {
  id: "stock:us:AAPL",
  symbol: "AAPL",
  name: "Apple",
  section: "gl",
  kind: "equity",
  subtitle: "Technology",
  currency: "USD",
};
const usBofA: MarketInstrument = {
  id: "stock:us:BAC",
  symbol: "BAC",
  name: "Bank of America",
  section: "gl",
  kind: "equity",
  subtitle: "Finance",
  currency: "USD",
};
const spx: MarketInstrument = {
  id: "index:SPX",
  symbol: "S&P 500",
  name: "S&P 500",
  section: "gl",
  kind: "index",
  subtitle: "أمريكي",
  currency: "USD",
};
const egxStock: MarketInstrument = {
  id: "stock:egx:COMI",
  symbol: "COMI",
  name: "البنك التجاري الدولي",
  section: "eg",
  kind: "equity",
  subtitle: "بنوك",
  currency: "EGP",
};

function yahooMeta(price: number, time: number, prevClose: number) {
  return { chart: { result: [{ meta: { regularMarketPrice: price, regularMarketTime: time, chartPreviousClose: prevClose } }] } };
}

test("canServe: US equity ids map 1:1 to their Yahoo ticker; curated ids unchanged", () => {
  const calls: string[] = [];
  const provider = new YahooChartProvider(process.env, {
    async getJson(url: string) {
      calls.push(url);
      return yahooMeta(212.5, 1_793_390_400, 215.1);
    },
  } as never);
  assert.equal(provider.canServe(usAapl), true, "stock:us:AAPL must be served");
  assert.equal(provider.canServe(usBofA), true, "stock:us:BAC must be served");
  assert.equal(provider.canServe(spx), true, "curated index coverage is unchanged");
  assert.equal(provider.canServe(egxStock), false, "EGX equities stay with the licensed scanner");
  const malformed: MarketInstrument = { ...usAapl, id: "stock:us:BAD SYM" };
  assert.equal(provider.canServe(malformed), false, "malformed ids never map to a ticker");
  const wrongMarket: MarketInstrument = { ...usAapl, id: "stock:egx:AAPL" };
  assert.equal(provider.canServe(wrongMarket), false, "non-US equity ids are not claimed");
});

test("getQuotes: a US equity quote is parsed from the same v8 meta as the board", async () => {
  const calls: string[] = [];
  const provider = new YahooChartProvider(process.env, {
    async getJson(url: string) {
      calls.push(url);
      return yahooMeta(212.5, 1_793_390_400, 215.1);
    },
  } as never);
  const result = await provider.getQuotes([usAapl]);
  assert.equal(result.requestedCount, 1);
  assert.equal(result.quotes.length, 1, "one priced row for one requested equity");
  const quote = result.quotes[0];
  assert.equal(quote.price, 212.5);
  assert.equal(quote.previousClose, 215.1);
  assert.equal(quote.asOf, 1_793_390_400_000, "asOf is the source's market time");
  assert.equal(quote.currency, "USD");
  assert.equal(quote.sourceId, "yahoo-chart");
  assert.equal(quote.sourceName, "Yahoo Finance");
  assert.ok(
    calls[0]?.includes("/v8/finance/chart/AAPL?interval=1d&range=1d"),
    `the US ticker must hit the plain Yahoo chart endpoint, got ${calls[0]}`,
  );
});

test("an empty meta stays empty — no invented price, same as the board rows", async () => {
  const provider = new YahooChartProvider(process.env, {
    async getJson() {
      return { chart: { result: [{}] } };
    },
  } as never);
  const result = await provider.getQuotes([usAapl]);
  assert.equal(result.quotes.length, 0, "missing meta fields produce no quote");
});

test("the env kill switch still disables US coverage", () => {
  const off = new YahooChartProvider({ ...process.env, LEGACY_MARKET_FEEDS_DISABLED: "true" } as NodeJS.ProcessEnv, {
    async getJson() {
      return yahooMeta(212.5, 1_793_390_400, 215.1);
    },
  } as never);
  assert.equal(off.canServe(usAapl), false, "disabled provider serves nothing");
  assert.equal(off.descriptor().state, "not_configured");
});
