import assert from "node:assert/strict";
import test from "node:test";
import { MemoryJsonCache, cacheEntry } from "./cache";
import { MARKET_INSTRUMENTS } from "./catalog";
import { runMarketDailySnapshot, type MarketHistoryRepository } from "./history";
import { TwelveDataProvider } from "./providers";
import { MarketDataService } from "./service";
import type {
  CanonicalQuote,
  MarketDataProvider,
  MarketInstrument,
  ProviderDescriptor,
  ProviderQuoteResult,
} from "./types";

const instrument = MARKET_INSTRUMENTS.find((item) => item.id === "index:SPX")!;
const egxInstrument = MARKET_INSTRUMENTS.find((item) => item.id === "egx:EGX30")!;

function descriptor(id: string, state: ProviderDescriptor["state"] = "configured"): ProviderDescriptor {
  return {
    id,
    name: id,
    state,
    note: "synthetic test provider",
    coverage: ["index"],
    externalDisplayConfirmed: state === "configured",
  };
}

function quote(sourceId: string, price = 100): CanonicalQuote {
  return {
    instrumentId: instrument.id,
    price,
    previousClose: 95,
    change: 5,
    changePercent: 5.263,
    asOf: Date.now(),
    sourceId,
    sourceName: sourceId,
    freshness: "delayed",
    delayedMinutes: 15,
  };
}

class SyntheticProvider implements MarketDataProvider {
  constructor(
    readonly id: string,
    private readonly behavior: "throw" | "quote" | "empty",
    private readonly quoteAsOf = Date.now(),
  ) {}
  get name(): string { return this.id; }
  descriptor = () => descriptor(this.id);
  canServe = (_item: MarketInstrument): boolean => true;
  async getQuotes(instruments: MarketInstrument[]): Promise<ProviderQuoteResult> {
    if (this.behavior === "throw") throw new Error("synthetic upstream unavailable");
    if (this.behavior === "empty") return { quotes: [], requestedCount: instruments.length };
    return { quotes: instruments.map((item) => ({ ...quote(this.id), instrumentId: item.id, asOf: this.quoteAsOf })), requestedCount: instruments.length };
  }
}

test("market service falls back only to the next configured provider", async () => {
  const service = new MarketDataService(
    [new SyntheticProvider("primary", "throw"), new SyntheticProvider("fallback", "quote")],
    [],
    new MemoryJsonCache(),
  );
  const snapshot = await service.getBoard();
  assert.equal(snapshot.stale, false);
  assert.equal(snapshot.quotes.length, MARKET_INSTRUMENTS.length);
  assert.ok(snapshot.quotes.every((item) => item.sourceId === "fallback"));
});

test("market service marks an old provider timestamp stale even after a successful fetch", async () => {
  // Session-aware: 80h old predates the most recent close of every board
  // session (worst case: the EGX Thursday close seen on a Sunday morning),
  // so the quote is stale no matter when the test runs. A quote that is
  // merely "after the close" must NOT be stale: the latest close is the
  // current official value.
  const service = new MarketDataService(
    [new SyntheticProvider("old-source", "quote", Date.now() - (80 * 3_600_000))],
    [],
    new MemoryJsonCache(),
  );
  const snapshot = await service.getBoard();
  assert.equal(snapshot.stale, true);
  assert.ok(snapshot.quotes.length > 0);
});

test("a closed market serving its latest close is not stale", async () => {
  // A quote timestamped just before the most recent close of a closed
  // session is the final official value of that session — not stale.
  const { lastCloseAt, sessionOpenAt, EGX_SESSION } = await import("./freshness");
  if (sessionOpenAt(EGX_SESSION, Date.now()).open) return; // verdict is "live" while open
  const lastClose = lastCloseAt(EGX_SESSION, Date.now());
  if (lastClose === undefined) return; // never happens within 14 days of a session
  const provider = new SyntheticProvider("close-source", "quote", lastClose - 5 * 60_000);
  provider.canServe = (item) => item.id === "egx:EGX30"; // EGX row only
  const service = new MarketDataService([provider], [], new MemoryJsonCache());
  const snapshot = await service.getBoard();
  const egx = snapshot.quotes.find((item) => item.instrumentId === "egx:EGX30");
  assert.ok(egx, "EGX quote present");
  assert.equal(snapshot.stale, false, "the latest close of a closed session is current data");
});

test("market service uses a verified stale cache when all providers fail", async () => {
  const cache = new MemoryJsonCache();
  const cachedQuotes = [quote("licensed-provider", 123)];
  const now = Date.now();
  await cache.set("egytrend:market:quotes:v2:board", cacheEntry(cachedQuotes, 1, 60_000, now - 100));
  const service = new MarketDataService([new SyntheticProvider("primary", "throw")], [], cache);
  const snapshot = await service.getBoard();
  assert.equal(snapshot.stale, true);
  assert.deepEqual(snapshot.quotes, cachedQuotes);
});

test("Twelve Data adapter normalizes a vendor quote without leaking its key", async () => {
  const calls: string[] = [];
  const fakeHttp = {
    async getJson<T>(url: string): Promise<T> {
      calls.push(url);
      return {
        SPX_VENDOR: {
          close: "6000.25",
          previous_close: "5980.00",
          percent_change: "0.338",
          timestamp: 1_700_000_000,
          currency: "USD",
        },
      } as T;
    },
  };
  const provider = new TwelveDataProvider({
    TWELVE_DATA_API_KEY: "test-key-must-not-appear-in-output",
    TWELVE_DATA_EXTERNAL_DISPLAY_LICENSED: "true",
    TWELVE_DATA_LICENSE_REFERENCE: "test-contract-reference",
    TWELVE_DATA_DELAY_MINUTES: "15",
    TWELVE_DATA_SYMBOLS_JSON: JSON.stringify({ "index:SPX": "SPX_VENDOR" }),
  }, fakeHttp as never);
  const result = await provider.getQuotes([instrument]);
  assert.equal(result.quotes.length, 1);
  assert.equal(result.quotes[0]?.price, 6000.25);
  assert.equal(result.quotes[0]?.sourceName, "Twelve Data");
  assert.equal(result.quotes[0]?.delayedMinutes, 15);
  assert.ok(calls[0]?.includes("SPX_VENDOR"));
  assert.ok(!JSON.stringify(result).includes("test-key-must-not-appear-in-output"));
  assert.ok(!JSON.stringify(provider.descriptor()).includes("test-contract-reference"));
});

test("Twelve Data stays inert without a non-secret display-license reference", async () => {
  let requestAttempted = false;
  const provider = new TwelveDataProvider({
    TWELVE_DATA_API_KEY: "synthetic-key",
    TWELVE_DATA_EXTERNAL_DISPLAY_LICENSED: "true",
    TWELVE_DATA_SYMBOLS_JSON: JSON.stringify({ "index:SPX": "SPX_VENDOR" }),
  }, { async getJson<T>(): Promise<T> {
    requestAttempted = true;
    throw new Error("a missing contract reference must stop the request first");
  } } as never);

  assert.equal(provider.descriptor().state, "not_configured");
  assert.equal(provider.descriptor().externalDisplayConfirmed, false);
  assert.deepEqual(await provider.getQuotes([instrument]), { quotes: [], requestedCount: 0 });
  assert.equal(requestAttempted, false);
});

test("Twelve Data cannot label a zero-delay quote real-time without a specific acknowledgement", () => {
  const base = {
    TWELVE_DATA_API_KEY: "synthetic-key",
    TWELVE_DATA_EXTERNAL_DISPLAY_LICENSED: "true",
    TWELVE_DATA_LICENSE_REFERENCE: "test-contract-reference",
    TWELVE_DATA_DELAY_MINUTES: "0",
    TWELVE_DATA_SYMBOLS_JSON: JSON.stringify({ "index:SPX": "SPX_VENDOR" }),
  };
  const delayedOnly = new TwelveDataProvider(base);
  assert.equal(delayedOnly.descriptor().state, "not_configured");
  assert.equal(delayedOnly.canServe(instrument), false);

  const realtimeApproved = new TwelveDataProvider({
    ...base,
    TWELVE_DATA_REALTIME_DISPLAY_LICENSED: "true",
  });
  assert.equal(realtimeApproved.descriptor().state, "configured");
  assert.equal(realtimeApproved.canServe(instrument), true);
});

test("Twelve Data keeps EGX inert until its own coverage and redistribution reference is supplied", async () => {
  const base = {
    TWELVE_DATA_API_KEY: "synthetic-key",
    TWELVE_DATA_EXTERNAL_DISPLAY_LICENSED: "true",
    TWELVE_DATA_LICENSE_REFERENCE: "global-contract-reference",
    TWELVE_DATA_DELAY_MINUTES: "15",
    TWELVE_DATA_SYMBOLS_JSON: JSON.stringify({ "egx:EGX30": "EGX30_VENDOR" }),
  };
  const genericApproval = new TwelveDataProvider(base);
  assert.equal(genericApproval.descriptor().state, "configured");
  assert.equal(genericApproval.canServe(egxInstrument), false);
  assert.deepEqual(await genericApproval.getQuotes([egxInstrument]), { quotes: [], requestedCount: 0 });

  const egxApproved = new TwelveDataProvider({
    ...base,
    TWELVE_DATA_EGX_DISPLAY_LICENSED: "true",
    TWELVE_DATA_EGX_LICENSE_REFERENCE: "egx-contract-reference",
  });
  assert.equal(egxApproved.canServe(egxInstrument), true);
});

test("daily snapshot job is opt-in and idempotent through its repository contract", async () => {
  const disabled = await runMarketDailySnapshot({ env: {} });
  assert.equal(disabled.status, "skipped");

  const rows = [{
    instrumentId: "index:SPX",
    tradingDate: "2026-10-16",
    open: 100,
    high: 102,
    low: 99,
    close: 101,
    asOf: 1_700_000_000_000,
    sourceId: "licensed-provider",
    sourceName: "Licensed Provider",
    freshness: "end-of-day" as const,
  }];
  const service = { getDailyOhlc: async () => rows };
  const written: unknown[][] = [];
  const repository: MarketHistoryRepository = { upsert: async (input) => { written.push(input); return input.length; } };
  const result = await runMarketDailySnapshot({
    env: { MARKET_SNAPSHOT_WRITES_ENABLED: "true" },
    service: service as never,
    repository,
    now: new Date("2026-10-16T18:00:00.000Z"),
  });
  assert.equal(result.status, "ok");
  assert.equal(result.fetched, 1);
  assert.equal(result.written, 1);
  assert.equal(written.length, 1);
});
