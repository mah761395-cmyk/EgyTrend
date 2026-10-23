import { createMarketCache, loadCached, type JsonCache } from "./cache";
import { MARKET_INSTRUMENTS, type StockDefinition } from "./catalog";
import { ProviderHealthMonitor } from "./health";
import {
  CoinGeckoProvider,
  EgidContractProvider,
  ExchangeRateApiProvider,
  TradingEconomicsCalendarProvider,
  TwelveDataProvider,
} from "./providers";
import type {
  CalendarDataProvider,
  CalendarEvent,
  CanonicalQuote,
  DailyOhlc,
  MarketDataProvider,
  MarketInstrument,
  ProviderDescriptor,
  ProviderHealth,
} from "./types";

export type QuoteSnapshot = {
  quotes: CanonicalQuote[];
  fetchedAt: number;
  stale: boolean;
  /** A stale snapshot always came from a prior successful licensed provider request. */
  fromCache: boolean;
};

export type CalendarSnapshot = {
  events: CalendarEvent[];
  fetchedAt: number;
  stale: boolean;
  fromCache: boolean;
};

export class MarketDataService {
  private readonly health: ProviderHealthMonitor;

  constructor(
    private readonly providers: MarketDataProvider[],
    private readonly calendarProviders: CalendarDataProvider[],
    private readonly cache: JsonCache = createMarketCache(),
    health?: ProviderHealthMonitor,
  ) {
    this.health = health ?? new ProviderHealthMonitor(cache);
  }

  /** Providers that can actually supply a daily series. Display approval alone
   * is not enough: an FX reference feed has no OHLC history and must never
   * unlock stored rows for other instruments. */
  historySourceIds(): ReadonlySet<string> {
    return new Set(
      this.providers
        .filter((provider) => typeof provider.getDailyOhlc === "function")
        .map((provider) => provider.id),
    );
  }

  async getBoard(): Promise<QuoteSnapshot> {
    return this.getQuoteSnapshot("board", MARKET_INSTRUMENTS, 60_000, 15 * 60_000);
  }

  async getStocks(market: "egx" | "us", definitions: StockDefinition[]): Promise<QuoteSnapshot> {
    const instruments: MarketInstrument[] = definitions.map((stock) => ({
      id: stock.id,
      symbol: stock.sym,
      name: stock.name,
      section: market === "egx" ? "eg" : "gl",
      kind: "equity",
      subtitle: stock.sector,
      currency: market === "egx" ? "EGP" : "USD",
    }));
    return this.getQuoteSnapshot(`stocks:${market}`, instruments, market === "egx" ? 180_000 : 300_000, 2 * 60 * 60_000);
  }

  async getCalendar(): Promise<CalendarSnapshot> {
    const key = "egytrend:market:calendar:v2";
    const cached = await loadCached(this.cache, key, 30 * 60_000, 2 * 60 * 60_000, async () => {
      const events: CalendarEvent[] = [];
      for (const provider of this.calendarProviders) {
        const descriptor = provider.descriptor();
        if (descriptor.state !== "configured") continue;
        try {
          const result = await provider.getCalendar();
          await this.health.recordSuccess(provider.id);
          events.push(...result.events);
          // One contracted calendar source is intentional: do not merge two
          // feeds that may duplicate/conflict without a source hierarchy.
          if (result.events.length) break;
        } catch (error) {
          await this.health.recordFailure(descriptor, error);
        }
      }
      return events
        .filter((event) => Number.isFinite(event.at) && Boolean(event.title))
        .sort((a, b) => a.at - b.at)
        .slice(0, 50);
    });
    return {
      events: cached.value,
      fetchedAt: cached.cachedAt,
      stale: cached.stale,
      fromCache: cached.cacheHit,
    };
  }

  async getDailyOhlc(instruments: MarketInstrument[], tradingDate: string): Promise<DailyOhlc[]> {
    const remaining = new Map(instruments.map((instrument) => [instrument.id, instrument]));
    const accepted: DailyOhlc[] = [];
    for (const provider of this.providers) {
      if (!provider.getDailyOhlc) continue;
      const candidates = [...remaining.values()].filter((instrument) => provider.canServe(instrument));
      if (!candidates.length) continue;
      const descriptor = provider.descriptor();
      try {
        const rows = await provider.getDailyOhlc(candidates, tradingDate);
        await this.health.recordSuccess(provider.id);
        for (const row of rows) {
          if (!remaining.has(row.instrumentId)) continue;
          accepted.push(row);
          remaining.delete(row.instrumentId);
        }
      } catch (error) {
        await this.health.recordFailure(descriptor, error);
      }
    }
    return accepted;
  }

  descriptors(): ProviderDescriptor[] {
    return [
      ...this.providers.map((provider) => provider.descriptor()),
      ...this.calendarProviders.map((provider) => provider.descriptor()),
    ];
  }

  async healthStatus(): Promise<{
    cache: ReturnType<JsonCache["status"]>;
    providers: ProviderHealth[];
  }> {
    return { cache: this.cache.status(), providers: await this.health.status(this.descriptors()) };
  }

  private async getQuoteSnapshot(
    keyPart: string,
    instruments: MarketInstrument[],
    ttlMs: number,
    staleMs: number,
  ): Promise<QuoteSnapshot> {
    const key = `egytrend:market:quotes:v2:${keyPart}`;
    const cached = await loadCached(this.cache, key, ttlMs, staleMs, async () => this.resolveQuotes(instruments));
    // A successful HTTP fetch is not enough to call a quote current: the
    // provider's own timestamp may already be beyond this snapshot's maximum
    // cache age. Keep serving it transparently, but expose it as stale rather
    // than refreshing the browser's confidence with our fetch time.
    /* End-of-day reference data is not late just because the wall clock moved:
     * its freshness is the provider's trading date, so only intraday quotes
     * are measured against the cache-age window. */
    const sourceStale = cached.value.some(
      (quote) => quote.freshness !== "end-of-day" && Date.now() - quote.asOf > staleMs,
    );
    return {
      quotes: cached.value,
      fetchedAt: cached.cachedAt,
      stale: cached.stale || sourceStale,
      fromCache: cached.cacheHit,
    };
  }

  private async resolveQuotes(instruments: MarketInstrument[]): Promise<CanonicalQuote[]> {
    const pending = new Map(instruments.map((instrument) => [instrument.id, instrument]));
    const accepted: CanonicalQuote[] = [];
    let failedProviderCalls = 0;

    for (const provider of this.providers) {
      const candidates = [...pending.values()].filter((instrument) => provider.canServe(instrument));
      if (!candidates.length) continue;
      const descriptor = provider.descriptor();
      try {
        const result = await provider.getQuotes(candidates);
        await this.health.recordSuccess(provider.id);
        for (const quote of result.quotes) {
          const instrument = pending.get(quote.instrumentId);
          if (!instrument || !isValidQuote(quote)) continue;
          accepted.push(quote);
          pending.delete(instrument.id);
        }
      } catch (error) {
        failedProviderCalls++;
        await this.health.recordFailure(descriptor, error);
      }
    }

    /* A network/vendor failure must not overwrite a known good cache with an
     * empty success. `loadCached` will serve its verified snapshot as stale.
     * An empty result without failures remains a truthful unavailable state. */
    if (failedProviderCalls > 0 && accepted.length === 0) {
      throw new Error("all licensed market providers failed without a fallback quote");
    }
    return accepted;
  }
}

function isValidQuote(quote: CanonicalQuote): boolean {
  return Number.isFinite(quote.price) && quote.price > 0 && Number.isFinite(quote.asOf) && Boolean(quote.sourceId);
}

let singleton: MarketDataService | null = null;

/** Runtime singleton: provider calls remain server-side and configuration is read once. */
export function getMarketDataService(): MarketDataService {
  if (!singleton) {
    singleton = new MarketDataService(
      [new EgidContractProvider(), new TwelveDataProvider(), new CoinGeckoProvider(), new ExchangeRateApiProvider()],
      [new TradingEconomicsCalendarProvider()],
    );
  }
  return singleton;
}

/** Test-only reset; it is not exported from an HTTP route. */
export function resetMarketDataServiceForTest(): void {
  singleton = null;
}
