import assert from "node:assert/strict";
import test from "node:test";
import { cacheEntry, MemoryJsonCache } from "./cache";
import type { ResilientHttpClient } from "./http";
import { MARKET_INSTRUMENTS } from "./catalog";
import { ExchangeRateApiProvider } from "./providers";
import {
  MarketDataService,
  resetMarketDataServiceForTest,
  setMarketDataServiceForTest,
} from "./service";
import type {
  CanonicalQuote,
  MarketDataProvider,
  MarketInstrument,
  ProviderDescriptor,
  ProviderQuoteResult,
} from "./types";
import { deriveChangePercent, getMarketsSnapshot } from "../../routes/markets";

/* ═══════════════════════════════════════════════════════════════════════
 * TASK M (M1): the board's change column and the FX daily change.
 *
 * Proven production gaps these tests pin:
 *  - Yahoo board rows publish `previousClose` but the board never derived
 *    the change from it, so every index/commodity row read "—".
 *  - the daily FX reference (ExchangeRate-API) publishes no previous-day
 *    rate; the change must come from the platform's own previously
 *    verified reading of the SAME provider, only when its reference day
 *    advanced — never invented, never a same-day 0.00%.
 *  - `asOf` is the provider's publish time for some rows and the server's
 *    fetch time for others; the payload must say which (`timeBasis`), so
 *    the UI never labels a fetch time as the source's publish time.
 * ═══════════════════════════════════════════════════════════════════════ */

const DAY1 = Date.UTC(2026, 8, 25, 3, 0, 0); // 06:00 Cairo 2026-09-25
const DAY1_LATER = Date.UTC(2026, 8, 25, 10, 0, 0); // 13:00 Cairo, same day
const DAY2 = Date.UTC(2026, 8, 26, 3, 0, 0); // next Cairo day

function erPayload(egpPerUsd: number, at: number): Record<string, unknown> {
  return {
    result: "success",
    base: "USD",
    time_last_update_unix: at,
    rates: { EGP: egpPerUsd, EUR: 0.88, GBP: 0.75, SAR: 0.27 },
  };
}

function erApiHttp(initial: Record<string, unknown>) {
  const state = { payload: initial };
  const http = {
    async getJson<T>(_url: string): Promise<T> {
      return state.payload as T;
    },
  };
  return { http: http as unknown as ResilientHttpClient, set: (payload: Record<string, unknown>) => { state.payload = payload; } };
}

test("deriveChangePercent: an explicit provider change is used as-is", () => {
  assert.equal(deriveChangePercent({ price: 100, changePercent: 5.263 }), 5.263);
  assert.equal(deriveChangePercent({ price: 100, changePercent: -1.5, previousClose: 95 }), -1.5);
});

test("deriveChangePercent: derives from the provider's previous close when no change is published", () => {
  const percent = deriveChangePercent({ price: 100, previousClose: 95 });
  assert.ok(percent !== null && Math.abs(percent - (5 / 95) * 100) < 1e-9);
});

test("deriveChangePercent: absent or invalid inputs stay absent (never invented as 0)", () => {
  assert.equal(deriveChangePercent({ price: 100 }), null);
  assert.equal(deriveChangePercent({ price: 100, previousClose: 0 }), null);
  assert.equal(deriveChangePercent({ price: 100, previousClose: Number.NaN }), null);
  assert.equal(deriveChangePercent({ price: 100, changePercent: Number.NaN, previousClose: 95 }), (5 / 95) * 100);
});

test("FX daily change: the first verified reading has no change (no previous reference)", async () => {
  const { http } = erApiHttp(erPayload(56.0, DAY1));
  const service = new MarketDataService([new ExchangeRateApiProvider({}, http)], [], new MemoryJsonCache());
  const snapshot = await service.getBoard();
  const usd = snapshot.quotes.find((quote) => quote.instrumentId === "fx:USD-EGP");
  assert.ok(usd, "USD/EGP priced by the reference provider");
  assert.equal(usd.price, 56.0);
  assert.equal(usd.changePercent, undefined, "no previous reference yet — the change stays absent, not 0.00%");
});

test("FX daily change: derived only when the provider's reference day advanced", async () => {
  const cache = new MemoryJsonCache();
  const { http, set } = erApiHttp(erPayload(56.0, DAY1));
  const service = new MarketDataService([new ExchangeRateApiProvider({}, http)], [], cache);

  const first = await service.getBoard();
  const usdDay1 = first.quotes.find((quote) => quote.instrumentId === "fx:USD-EGP");
  assert.equal(usdDay1?.changePercent, undefined);

  /* The feed now carries the NEXT Cairo day's reference. Expire the board
   * snapshot the way time does (a past expiresAt forces a re-fetch). */
  await cache.set("egytrend:market:quotes:v2:board", cacheEntry(first.quotes, 0, 0, Date.now() - 61_000));
  set(erPayload(56.2, DAY2));
  const second = await service.getBoard();
  const usdDay2 = second.quotes.find((quote) => quote.instrumentId === "fx:USD-EGP");
  assert.equal(usdDay2?.price, 56.2);
  assert.ok(usdDay2?.changePercent !== undefined, "change published once the reference day advanced");
  assert.equal(usdDay2.changePercent, Math.round(((56.2 - 56.0) / 56.0) * 100 * 1_000) / 1_000);
  assert.equal(usdDay2?.change, 0.2);

  const eurDay2 = second.quotes.find((quote) => quote.instrumentId === "fx:EUR-EGP");
  assert.ok(eurDay2?.changePercent !== undefined, "cross rates get the same verified basis");
});

test("FX daily change: a same-day re-fetch is never reported as a change", async () => {
  const cache = new MemoryJsonCache();
  const { http, set } = erApiHttp(erPayload(56.0, DAY1));
  const service = new MarketDataService([new ExchangeRateApiProvider({}, http)], [], cache);

  await service.getBoard();
  await cache.set("egytrend:market:quotes:v2:board", cacheEntry([], 0, 0, Date.now() - 61_000));
  set(erPayload(56.05, DAY1_LATER)); // same Cairo day, provider still "updated"
  const sameDay = await service.getBoard();
  const usd = sameDay.quotes.find((quote) => quote.instrumentId === "fx:USD-EGP");
  assert.equal(usd?.changePercent, undefined, "the reference day did not advance — no change is published");
});

test("ExchangeRateApiProvider.getDailyOhlc: one reference bar dated on the provider's own day", async () => {
  const { http } = erApiHttp(erPayload(56.0, DAY1));
  const provider = new ExchangeRateApiProvider({}, http);
  const usd = MARKET_INSTRUMENTS.find((item) => item.id === "fx:USD-EGP")!;
  const eur = MARKET_INSTRUMENTS.find((item) => item.id === "fx:EUR-EGP")!;
  const rows = await provider.getDailyOhlc([usd, eur], "2026-09-26");
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.open, row.close);
    assert.equal(row.high, row.close);
    assert.equal(row.low, row.close);
    assert.equal(row.tradingDate, "2026-09-25", "the bar is dated on the provider's publish day, not the cron's");
    assert.equal(row.asOf, DAY1);
    assert.equal(row.freshness, "end-of-day");
    assert.equal(row.sourceId, "exchange-rate-api");
  }
  const usdRow = rows.find((row) => row.instrumentId === "fx:USD-EGP")!;
  assert.equal(usdRow.close, 56.0);
  const eurRow = rows.find((row) => row.instrumentId === "fx:EUR-EGP")!;
  assert.equal(eurRow.close, Math.round((56.0 / 0.88) * 10_000) / 10_000);
});

test("ExchangeRateApiProvider.getDailyOhlc: an update without a publish time yields no row", async () => {
  const http = {
    async getJson<T>(_url: string): Promise<T> {
      return { result: "success", base: "USD", rates: { EGP: 56.0 } } as T;
    },
  } as unknown as ResilientHttpClient;
  const provider = new ExchangeRateApiProvider({}, http);
  const usd = MARKET_INSTRUMENTS.find((item) => item.id === "fx:USD-EGP")!;
  assert.deepEqual(await provider.getDailyOhlc([usd], "2026-09-26"), []);
});

/* A board-shaped provider: the EGX30 row mimics the scraper (fetch-time
 * asOf, sourceAsOfUnknown), the index row mimics Yahoo (previousClose only,
 * provider market time), the FX row mimics the reference feed. */
class BoardShapeProvider implements MarketDataProvider {
  readonly id = "board-shape";
  get name(): string { return "board-shape"; }
  descriptor = (): ProviderDescriptor => ({
    id: this.id,
    name: this.name,
    state: "configured",
    note: "synthetic board shape",
    coverage: ["index", "fx"],
    externalDisplayConfirmed: true,
  });
  canServe = (_item: MarketInstrument): boolean => true;
  async getQuotes(instruments: MarketInstrument[]): Promise<ProviderQuoteResult> {
    const now = Date.now();
    const quotes: CanonicalQuote[] = instruments.map((item) => {
      if (item.id === "egx:EGX30") {
        return {
          instrumentId: item.id,
          price: 49_596.14,
          changePercent: 0.64,
          asOf: now,
          sourceAsOfUnknown: true,
          sourceId: this.id,
          sourceName: this.name,
          freshness: "unknown",
        } satisfies CanonicalQuote;
      }
      if (item.id === "index:SPX") {
        return {
          instrumentId: item.id,
          price: 7_720.39,
          previousClose: 7_335.0,
          asOf: now - 3_600_000,
          sourceId: this.id,
          sourceName: this.name,
          freshness: "unknown",
        } satisfies CanonicalQuote;
      }
      return {
        instrumentId: item.id,
        price: 56.12,
        asOf: now - 86_400_000,
        sourceId: this.id,
        sourceName: this.name,
        freshness: "end-of-day",
      } satisfies CanonicalQuote;
    });
    return { quotes, requestedCount: instruments.length };
  }
}

test("board payload: timeBasis tells source publish time apart from server fetch time, and Yahoo rows get their change", async () => {
  const service = new MarketDataService([new BoardShapeProvider()], [], new MemoryJsonCache());
  setMarketDataServiceForTest(service);
  try {
    const { data } = await getMarketsSnapshot();
    const egx = data.markets.eg.find((row) => row.id === "egx:EGX30");
    const usd = data.markets.eg.find((row) => row.id === "fx:USD-EGP");
    const spx = data.markets.gl.find((row) => row.id === "index:SPX");

    assert.equal(egx?.timeBasis, "fetch", "the scraped index has no publish time — asOf is the fetch time");
    assert.equal(egx?.c, "+0.64%", "explicit provider change is kept");
    assert.equal(usd?.timeBasis, "source", "the daily reference publishes its own update time");
    assert.equal(spx?.timeBasis, "source", "the provider's market time is a source time");
    assert.equal(spx?.c, "+5.25%", "previousClose is derived into the change instead of '—'");
    assert.equal(spx?.flat, false);
  } finally {
    resetMarketDataServiceForTest();
  }
});
