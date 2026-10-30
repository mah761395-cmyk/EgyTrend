import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { createMemoryDatabase } from "../test-support/memory-db";

process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "markets-board-coverage-test-secret-not-for-deployment";
process.env.LOG_LEVEL = "silent";
/* Legacy free reference feeds stay enabled in this file: the coverage
 * contract is exactly about them pricing the expanded board. */
delete process.env["LEGACY_MARKET_FEEDS_DISABLED"];

import {
  MARKET_INSTRUMENTS,
  tvSymbolForInstrument,
} from "../lib/market-data/catalog";
import { sessionForInstrument } from "../lib/market-data/freshness";
import {
  CoinGeckoFreeProvider,
  ExchangeRateApiProvider,
  TradingEconomicsEgxIndexProvider,
  YahooChartProvider,
} from "../lib/market-data/providers";
import { MarketDataService } from "../lib/market-data/service";
import {
  resetMarketDataServiceForTest,
  setMarketDataServiceForTest,
} from "../lib/market-data/service";
import type {
  CanonicalQuote,
  MarketDataProvider,
  MarketInstrument,
  ProviderDescriptor,
  ProviderQuoteResult,
} from "../lib/market-data/types";

type Memory = Awaited<ReturnType<typeof createMemoryDatabase>>;
let memory: Memory;
let server: http.Server;
let baseUrl = "";

async function raw(path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    signal: AbortSignal.timeout(120_000),
  });
  const text = await response.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON only asserted on in failure branches */
  }
  return { status: response.status, body };
}

/** A test-only provider that prices every board instrument it is asked for.
 * It exists to verify the section aggregation, never a real feed. */
class FakeBoardProvider implements MarketDataProvider {
  readonly id = "fake-board-coverage";
  readonly name = "Fake Board (test)";
  descriptor(): ProviderDescriptor {
    return {
      id: this.id,
      name: this.name,
      state: "configured",
      note: "test-only",
      coverage: ["index", "equity", "fx", "commodity", "crypto"],
      externalDisplayConfirmed: true,
    };
  }
  canServe(): boolean {
    return true;
  }
  async getQuotes(instruments: MarketInstrument[]): Promise<ProviderQuoteResult> {
    const quotes: CanonicalQuote[] = instruments.map((instrument, index) => ({
      instrumentId: instrument.id,
      price: 100 + index,
      previousClose: 99 + index,
      currency: instrument.currency,
      asOf: Date.now(),
      sourceId: this.id,
      sourceName: this.name,
      sourceAsOfUnknown: true,
      freshness: "unknown",
    }));
    return { quotes, requestedCount: instruments.length };
  }
}

before(async () => {
  memory = await createMemoryDatabase();
  (globalThis as typeof globalThis & { __egytrendTestDatabase?: typeof memory.db }).__egytrendTestDatabase = memory.db;
  setMarketDataServiceForTest(new MarketDataService([new FakeBoardProvider()], []));
  const { default: app } = await import("../app");
  server = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  baseUrl = typeof address === "object" && address ? `http://127.0.0.1:${address.port}` : "";
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  resetMarketDataServiceForTest();
  await memory.close();
  delete (globalThis as typeof globalThis & { __egytrendTestDatabase?: unknown }).__egytrendTestDatabase;
});

test("catalog: the expanded board carries the six requested coverage families", () => {
  const byId = new Map(MARKET_INSTRUMENTS.map((instrument) => [instrument.id, instrument]));
  /* Egyptian exchange: the three headline indices. */
  for (const id of ["egx:EGX30", "egx:EGX70", "egx:EGX100"]) {
    assert.equal(byId.get(id)?.section, "eg", `${id} stays in the Egyptian section`);
  }
  /* Global indices: the existing four plus Dow, Nikkei 225 and CAC 40. */
  for (const id of ["index:SPX", "index:NASDAQ", "index:DAX", "index:FTSE100", "index:DJI", "index:N225", "index:FCHI"]) {
    assert.equal(byId.get(id)?.section, "gl", `${id} is a global index`);
  }
  /* Commodities: metals, oils, copper plus natural gas, wheat and WTI. */
  for (const id of ["commodity:XAU", "commodity:XAG", "commodity:BRENT", "commodity:COPPER", "commodity:WTI", "commodity:NATGAS", "commodity:WHEAT"]) {
    assert.equal(byId.get(id)?.section, "cm", `${id} is a commodity`);
  }
  /* Crypto: BTC, ETH and the large-market-cap additions. */
  for (const id of ["crypto:BTC", "crypto:ETH", "crypto:XRP", "crypto:BNB", "crypto:SOL", "crypto:DOGE", "crypto:ADA", "crypto:AVAX", "crypto:LINK", "crypto:TON"]) {
    assert.equal(byId.get(id)?.section, "cr", `${id} is a crypto asset`);
  }
  /* Forex: one dedicated section with the Egyptian reference pairs, the
   * international spot pairs and the dollar index. */
  const fx = MARKET_INSTRUMENTS.filter((instrument) => instrument.section === "fx");
  const fxIds = new Set(fx.map((instrument) => instrument.id));
  for (const id of ["fx:USD-EGP", "fx:EUR-EGP", "fx:GBP-EGP", "fx:SAR-EGP", "fx:EUR-USD", "fx:GBP-USD", "fx:USD-JPY", "fx:AUD-USD", "index:DXY"]) {
    assert.ok(fxIds.has(id), `${id} lives in the forex section`);
  }
  assert.equal(fx.length, 9, "forex section holds exactly the nine planned rows");
  /* The Egyptian section must no longer mix in FX pairs (they are their own
   * category now) — only the three headline indices remain. */
  const eg = MARKET_INSTRUMENTS.filter((instrument) => instrument.section === "eg");
  assert.deepEqual(eg.map((instrument) => instrument.id).sort(), ["egx:EGX100", "egx:EGX30", "egx:EGX70"]);
});

test("catalog: no board instrument is stranded without a display path", () => {
  /* Every row must resolve to at least one of: a free licensed provider
   * (Yahoo / CoinGecko-free / ExchangeRate-API / TE-EGX30), a TradingView
   * widget fallback, or be on the explicit contract-only allowlist (EGX70 /
   * EGX100 — no free feed publishes them; they appear when the operator
   * configures a licensed index provider). */
  const yahoo = new YahooChartProvider({} as NodeJS.ProcessEnv);
  const geckoFree = new CoinGeckoFreeProvider({} as NodeJS.ProcessEnv);
  const egpFx = new ExchangeRateApiProvider({} as NodeJS.ProcessEnv);
  const teEgx = new TradingEconomicsEgxIndexProvider({} as NodeJS.ProcessEnv);
  const contractOnly = new Set(["egx:EGX70", "egx:EGX100"]);
  const stranded: string[] = [];
  for (const instrument of MARKET_INSTRUMENTS) {
    const covered =
      (yahoo.canServe(instrument) && yahoo.descriptor().state === "configured") ||
      (geckoFree.canServe(instrument) && geckoFree.descriptor().state === "configured") ||
      (egpFx.canServe(instrument) && egpFx.descriptor().state === "configured") ||
      (teEgx.canServe(instrument) && teEgx.descriptor().state === "configured") ||
      tvSymbolForInstrument(instrument.id) !== null ||
      contractOnly.has(instrument.id);
    if (!covered) stranded.push(instrument.id);
  }
  assert.deepEqual(stranded, [], "instruments without any display path");
});

test("sessions: new instruments classify against their real market sessions", () => {
  assert.equal(sessionForInstrument("index:DJI")?.id, "us", "Dow trades in the US session");
  assert.equal(sessionForInstrument("index:N225")?.id, "tokyo", "Nikkei trades Tokyo 9:00-15:00");
  assert.equal(sessionForInstrument("index:FCHI")?.id, "eparis", "CAC trades the Euronext Paris session");
  assert.equal(sessionForInstrument("index:DXY")?.id, "fx24", "DXY is a live-session FX index");
  assert.equal(sessionForInstrument("fx:EUR-USD")?.id, "fx24", "international spot pair is live-session");
  assert.equal(sessionForInstrument("fx:USD-JPY")?.id, "fx24", "international spot pair is live-session");
  assert.equal(sessionForInstrument("fx:USD-EGP"), undefined, "once-a-day EGP reference keeps no session");
  assert.equal(sessionForInstrument("fx:EUR-EGP"), undefined, "once-a-day EGP reference keeps no session");
  assert.equal(sessionForInstrument("commodity:WHEAT")?.id, "cmx", "wheat futures ride the commodities session");
  assert.equal(sessionForInstrument("commodity:NATGAS")?.id, "cmx", "natural gas rides the commodities session");
  assert.equal(sessionForInstrument("crypto:TON")?.id, "crypto", "new coins ride the 24/7 crypto session");
});

test("board payload: the forex section is served, tickered and source-labelled", async () => {
  const { status, body } = await raw("/api/markets");
  assert.equal(status, 200);
  assert.equal(body.status, "ok");
  for (const section of ["eg", "gl", "cm", "cr", "fx"]) {
    assert.ok(Array.isArray(body.markets[section]), `markets.${section} is present`);
  }
  const fxNames = body.markets.fx.map((row: { n: string }) => row.n);
  for (const name of ["USD/EGP", "EUR/EGP", "GBP/EGP", "SAR/EGP", "EUR/USD", "GBP/USD", "USD/JPY", "AUD/USD", "مؤشر الدولار"]) {
    assert.ok(fxNames.includes(name), `forex section carries ${name}`);
  }
  const egNames = body.markets.eg.map((row: { n: string }) => row.n);
  assert.ok(!egNames.some((name: string) => name.includes("/")), "no FX pairs remain in the Egyptian section");
  const glNames = body.markets.gl.map((row: { n: string }) => row.n);
  for (const name of ["Dow Jones 30", "Nikkei 225", "CAC 40"]) {
    assert.ok(glNames.includes(name), `global section carries ${name}`);
  }
  const cmNames = body.markets.cm.map((row: { n: string }) => row.n);
  for (const name of ["نفط خام WTI", "غاز طبيعي", "قمح"]) {
    assert.ok(cmNames.includes(name), `commodities carry ${name}`);
  }
  const crNames = body.markets.cr.map((row: { n: string }) => row.n);
  for (const name of ["BNB", "DOGE", "ADA", "AVAX", "LINK", "TON"]) {
    assert.ok(crNames.includes(name), `crypto carries ${name}`);
  }
  /* Ticker: EGX30 headline plus the forex pairs that now live in sections.fx. */
  const tickerNames = body.ticker.map((row: { n: string }) => row.n);
  assert.ok(tickerNames.includes("EGX30"), "ticker keeps the EGX30 headline");
  assert.ok(tickerNames.some((name: string) => name.includes("/")), "ticker carries forex pairs from the fx section");
  /* The forex source label comes from the forex section, not the Egyptian one. */
  assert.equal(body.sources.forex, "Fake Board (test)");
  assert.ok(body.freshness.sections.fx, "section freshness metadata exists for forex");
});
