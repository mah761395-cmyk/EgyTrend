import { cacheEntry, createMarketCache, loadCached, type JsonCache } from "./cache";
import { MARKET_INSTRUMENTS, type StockDefinition } from "./catalog";
import { classifyQuote, sessionForInstrument } from "./freshness";
import { ProviderHealthMonitor } from "./health";
import { safeUpstreamErrorSummary } from "./http";
import { readMarketProviderSettings } from "../market-provider-settings";
import { ResilientHttpClient } from "./http";
import {
  CoinGeckoFreeProvider,
  CoinGeckoProvider,
  EgidContractProvider,
  ExchangeRateApiProvider,
  FxProCalendarProvider,
  TradingEconomicsCalendarProvider,
  TradingEconomicsEgxIndexProvider,
  TradingViewScannerProvider,
  TwelveDataProvider,
  YahooChartProvider,
  type TvScanRow,
} from "./providers";
import type {
  CalendarDataProvider,
  CalendarEvent,
  CanonicalQuote,
  DailyOhlc,
  DataFreshness,
  InstrumentKind,
  MarketDataProvider,
  MarketInstrument,
  ProviderDescriptor,
  ProviderHealth,
  ProviderState,
} from "./types";

const BOARD_CACHE_KEY = "egytrend:market:quotes:v2:board";
const PROBE_TIMEOUT_MS = 10_000;

/**
 * Last verified daily FX reference per pair (ExchangeRate-API). The feed is a
 * once-a-day table and publishes no previous-day rate, so the daily change is
 * derived against the platform's own previously verified reading of the same
 * provider — never against an unrelated third-party number.
 */
const FX_REFERENCE_CACHE_KEY = "egytrend:market:fx-daily-reference:v1";
const FX_REFERENCE_TTL_MS = 30 * 86_400_000;

type FxDailyReference = { price: number; asOf: number };

/** Cairo calendar day (YYYY-MM-DD) of an epoch-ms timestamp. */
function cairoDayOf(timestamp: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Cairo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(timestamp);
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("operation timed out")), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Admin dashboard row: proven state only — health store, last cached
 * snapshot, and the descriptor. No credential material, ever. */
export type AdminProviderInfo = {
  id: string;
  name: string;
  kind: "quotes" | "calendar";
  state: ProviderState;
  adminDisabled: boolean;
  note: string;
  coverage: string[];
  externalDisplayConfirmed: boolean;
  servesInstrumentCount: number;
  health: {
    lastSuccessAt?: number;
    lastFailureAt?: number;
    consecutiveFailures: number;
    degraded: boolean;
  };
  lastQuoteAsOf?: number;
  lastQuoteFreshness?: DataFreshness;
};

export type AdminInstrumentAttention = {
  instrumentId: string;
  symbol: string;
  name: string;
  kind: InstrumentKind;
  state: "fresh" | "stale" | "end-of-day" | "no-verified-quote";
  asOf?: number;
  freshness?: DataFreshness;
};

export type AdminMarketOverview = {
  generatedAt: number;
  cache: ReturnType<JsonCache["status"]>;
  board: {
    fetchedAt: number;
    stale: boolean;
    fromCache: boolean;
    quoteCount: number;
    /** true when even the stale-serving window has expired (nothing verified) */
    expired: boolean;
  } | null;
  providers: AdminProviderInfo[];
  instruments: AdminInstrumentAttention[];
};

export type MarketProbeResult = {
  ok: boolean;
  testedAt: number;
  kind: "quotes" | "calendar";
  instrumentId?: string;
  symbol?: string;
  price?: number;
  currency?: string;
  asOf?: number;
  freshness?: DataFreshness;
  delayedMinutes?: number;
  eventCount?: number;
  firstEventTitle?: string;
  error?: string;
};

export type ProviderImpact = {
  instrumentSymbols: string[];
  otherConfiguredProviders: Array<{ id: string; name: string }>;
};

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
  /** Shared upstream client for the secondary fundamentals endpoints
   * (dividends / EGX valuation page) — same pacing and retry policy as the
   * board providers, but a separate instance so their traffic is paced
   * independently of the licensed quote feeds. */
  private readonly fundamentalsHttp = new ResilientHttpClient();

  constructor(
    private readonly providers: MarketDataProvider[],
    private readonly calendarProviders: CalendarDataProvider[],
    private readonly cache: JsonCache = createMarketCache(),
    health?: ProviderHealthMonitor,
  ) {
    this.health = health ?? new ProviderHealthMonitor(cache);
  }

  /** Read-only dependencies for the secondary fundamentals endpoints. */
  fundamentalsDeps(): { http: ResilientHttpClient; cache: JsonCache } {
    return { http: this.fundamentalsHttp, cache: this.cache };
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

  /**
   * Admin-disabled provider ids (app_settings). Fail-open: a settings or DB
   * outage changes nothing about live provider selection.
   */
  private async disabledProviderIds(): Promise<Set<string>> {
    try {
      const settings = await readMarketProviderSettings();
      return settings.disabled;
    } catch {
      return new Set();
    }
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

  /** The scanner's full Egypt equity list for the screener. Same freshness
   * contract as the stock quotes: 3-minute TTL, last good scan served stale
   * for up to 2h, fail-closed (no rows) when there is nothing verified. */
  async getEgxStockScan(): Promise<{ rows: TvScanRow[]; fetchedAt: number; stale: boolean }> {
    const provider = this.providers.find((item) => item.id === "tradingview-scanner");
    if (!provider) throw new Error("egx stock scan provider not configured");
    const descriptor = provider.descriptor();
    if (descriptor.state !== "configured") throw new Error("egx stock scan provider not configured");
    if ((await this.disabledProviderIds()).has(provider.id)) {
      throw new Error("egx stock scan provider is disabled by admin");
    }
    const key = "egytrend:market:egx-scan:v1";
    const cached = await loadCached(this.cache, key, 180_000, 2 * 60 * 60_000, async () => {
      const rows = await (provider as TradingViewScannerProvider).getEgxFullScan();
      if (!rows.length) throw new Error("egx stock scan returned no rows");
      await this.health.recordSuccess(provider.id);
      return rows;
    });
    if (cached.stale) await this.health.recordFailure(descriptor, new Error("serving stale egx stock scan"));
    return { rows: cached.value, fetchedAt: cached.cachedAt, stale: cached.stale };
  }

  async getCalendar(): Promise<CalendarSnapshot> {
    const key = "egytrend:market:calendar:v2";
    const cached = await loadCached(this.cache, key, 30 * 60_000, 2 * 60 * 60_000, async () => {
      const disabled = await this.disabledProviderIds();
      const events: CalendarEvent[] = [];
      for (const provider of this.calendarProviders) {
        if (disabled.has(provider.id)) continue;
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
        /* The FxPro feed spans two weeks (up to ~90 upcoming events on a
         * Monday); the cap must stay above that so the merged CBE meetings
         * are never truncated. The UI itself only renders the first 30. */
        .slice(0, 120);
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
    const disabled = await this.disabledProviderIds();
    for (const provider of this.providers) {
      if (!provider.getDailyOhlc) continue;
      if (disabled.has(provider.id)) continue;
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

  /**
   * Admin dashboard payload. Read-only by construction: no provider call,
   * no cache write, no credential. "Working" claims are limited to what the
   * health store and the last cached snapshot actually prove; anything
   * unknown is reported as unknown, never invented.
   */
  async adminOverview(): Promise<AdminMarketOverview> {
    const now = Date.now();
    const disabled = await this.disabledProviderIds();
    const healthList = await this.health.status(this.descriptors());
    const healthMap = new Map(healthList.map((item) => [item.providerId, item]));
    const boardEntry = await this.cache.get<QuoteSnapshot>(BOARD_CACHE_KEY);
    const board = boardEntry ? boardEntry.value : null;

    const lastBySource = new Map<string, CanonicalQuote>();
    for (const quote of board?.quotes ?? []) {
      const prev = lastBySource.get(quote.sourceId);
      if (!prev || quote.asOf > prev.asOf) lastBySource.set(quote.sourceId, quote);
    }

    const rows: AdminProviderInfo[] = [];
    const pushRow = (provider: { id: string; descriptor(): ProviderDescriptor }, kind: "quotes" | "calendar", canServe?: (instrument: MarketInstrument) => boolean): void => {
      const d = provider.descriptor();
      const health = healthMap.get(d.id);
      const last = kind === "quotes" ? lastBySource.get(d.id) : undefined;
      rows.push({
        id: d.id,
        name: d.name,
        kind,
        state: d.state,
        adminDisabled: disabled.has(d.id),
        note: d.note,
        coverage: [...d.coverage],
        externalDisplayConfirmed: d.externalDisplayConfirmed,
        servesInstrumentCount: kind === "quotes" && canServe ? MARKET_INSTRUMENTS.filter((i) => canServe(i)).length : 0,
        health: {
          lastSuccessAt: health?.lastSuccessAt,
          lastFailureAt: health?.lastFailureAt,
          consecutiveFailures: health?.consecutiveFailures ?? 0,
          degraded: health?.degraded ?? false,
        },
        lastQuoteAsOf: last?.asOf,
        lastQuoteFreshness: last?.freshness,
      });
    };
    for (const provider of this.providers) pushRow(provider, "quotes", (instrument) => provider.canServe(instrument));
    for (const provider of this.calendarProviders) pushRow(provider, "calendar");

    const instruments: AdminInstrumentAttention[] = MARKET_INSTRUMENTS.map((instrument) => {
      const quote = (board?.quotes ?? []).find((q) => q.instrumentId === instrument.id);
      if (!quote) {
        return { instrumentId: instrument.id, symbol: instrument.symbol, name: instrument.name, kind: instrument.kind, state: "no-verified-quote" as const };
      }
      if (quote.freshness === "end-of-day") {
        return { instrumentId: instrument.id, symbol: instrument.symbol, name: instrument.name, kind: instrument.kind, state: "end-of-day" as const, asOf: quote.asOf, freshness: quote.freshness };
      }
      const session = sessionForInstrument(instrument.id);
      if (!session) {
        return { instrumentId: instrument.id, symbol: instrument.symbol, name: instrument.name, kind: instrument.kind, state: "fresh" as const, asOf: quote.asOf, freshness: quote.freshness };
      }
      const classification = classifyQuote(
        { asOf: quote.asOf, sourceAsOfUnknown: quote.sourceAsOfUnknown, delayedMinutes: quote.delayedMinutes },
        session,
        now,
      );
      return {
        instrumentId: instrument.id,
        symbol: instrument.symbol,
        name: instrument.name,
        kind: instrument.kind,
        state: classification.state === "stale" ? ("stale" as const) : ("fresh" as const),
        asOf: quote.asOf,
        freshness: quote.freshness,
      };
    });

    return {
      generatedAt: now,
      cache: this.cache.status(),
      board: board
        ? { fetchedAt: board.fetchedAt, stale: board.stale, fromCache: board.fromCache, quoteCount: board.quotes.length, expired: boardEntry ? boardEntry.staleUntil <= now : false }
        : null,
      providers: rows,
      instruments,
    };
  }

  /**
   * Limited data-fetch probe for the admin panel: exactly one real call
   * (one instrument, or one calendar fetch), a 10 s guard, and zero side
   * effects — no health record, no cache write, no state mutation. A
   * disabled provider can still be probed (to verify before re-enabling);
   * an unconfigured one is answered honestly without any upstream call.
   */
  async probeProvider(id: string): Promise<MarketProbeResult> {
    const quoteProvider = this.providers.find((p) => p.id === id) ?? null;
    const calendarProvider = this.calendarProviders.find((p) => p.id === id) ?? null;
    if (!quoteProvider && !calendarProvider) {
      return { ok: false, testedAt: Date.now(), kind: "quotes", error: "unknown provider" };
    }
    const kind: "quotes" | "calendar" = calendarProvider ? "calendar" : "quotes";
    const provider = calendarProvider ?? (quoteProvider as MarketDataProvider);
    const descriptor = provider.descriptor();
    if (descriptor.state !== "configured") {
      return {
        ok: false,
        testedAt: Date.now(),
        kind,
        error: descriptor.state === "requires_contract"
          ? "provider requires a documented contract"
          : "provider is not configured",
      };
    }
    try {
      if (calendarProvider) {
        const result = await withTimeout(calendarProvider.getCalendar(), PROBE_TIMEOUT_MS);
        if (!result.events.length) {
          return { ok: false, testedAt: Date.now(), kind: "calendar", eventCount: 0, error: "calendar returned no events" };
        }
        return {
          ok: true,
          testedAt: Date.now(),
          kind: "calendar",
          eventCount: result.events.length,
          firstEventTitle: result.events[0]?.title,
        };
      }
      const instrument = MARKET_INSTRUMENTS.find((i) => (provider as MarketDataProvider).canServe(i));
      if (!instrument) {
        return { ok: false, testedAt: Date.now(), kind: "quotes", error: "provider serves no board instruments" };
      }
      const result = await withTimeout((provider as MarketDataProvider).getQuotes([instrument]), PROBE_TIMEOUT_MS);
      const quote = result.quotes.find((q) => q.instrumentId === instrument.id && isValidQuote(q));
      if (!quote) {
        return { ok: false, testedAt: Date.now(), kind: "quotes", instrumentId: instrument.id, symbol: instrument.symbol, error: "no valid quote returned" };
      }
      return {
        ok: true,
        testedAt: Date.now(),
        kind: "quotes",
        instrumentId: quote.instrumentId,
        symbol: instrument.symbol,
        price: quote.price,
        currency: quote.currency,
        asOf: quote.asOf,
        freshness: quote.freshness,
        delayedMinutes: quote.delayedMinutes,
      };
    } catch (error) {
      return { ok: false, testedAt: Date.now(), kind, error: safeUpstreamErrorSummary(error) || "probe failed" };
    }
  }

  /**
   * What disabling a provider would change: the board instruments it serves
   * and which other configured + enabled providers could still serve them.
   * An instrument with no remaining source is called out explicitly instead
   * of letting the failure surface later as a silent gap.
   */
  async providerImpact(id: string): Promise<ProviderImpact> {
    const provider = this.providers.find((p) => p.id === id);
    if (!provider) return { instrumentSymbols: [], otherConfiguredProviders: [] };
    const disabled = await this.disabledProviderIds();
    const instruments = MARKET_INSTRUMENTS.filter((i) => provider.canServe(i));
    const others = new Map<string, { id: string; name: string }>();
    for (const other of this.providers) {
      if (other.id === id || disabled.has(other.id)) continue;
      if (other.descriptor().state !== "configured") continue;
      if (instruments.some((i) => other.canServe(i))) others.set(other.id, { id: other.id, name: other.name });
    }
    return {
      instrumentSymbols: instruments.map((i) => i.symbol),
      otherConfiguredProviders: [...others.values()],
    };
  }

  async healthStatus(): Promise<{
    cache: ReturnType<JsonCache["status"]>;
    providers: ProviderHealth[];
  }> {
    return { cache: this.cache.status(), providers: await this.health.status(this.descriptors()) };
  }

  /**
   * Derives the daily change for FX reference rows. The upstream feed
   * (ExchangeRate-API) is a once-a-day table with no previous-day rate, so the
   * only honest source for "yesterday" is the platform's own previously
   * verified reading of the same provider. The derived value is only published
   * when the provider's reference day actually advanced (same-day re-fetches
   * are never reported as 0.00%). The reference record is best-effort cache
   * state: a cold start simply withholds the change instead of inventing it.
   */
  private async enrichFxDailyChange(quotes: CanonicalQuote[]): Promise<CanonicalQuote[]> {
    const fxQuotes = quotes.filter((quote) => quote.instrumentId.startsWith("fx:"));
    if (!fxQuotes.length) return quotes;

    let stored: Record<string, FxDailyReference> = {};
    try {
      const entry = await this.cache.get<Record<string, FxDailyReference>>(FX_REFERENCE_CACHE_KEY);
      stored = entry && typeof entry.value === "object" ? entry.value : {};
    } catch {
      stored = {};
    }

    for (const quote of fxQuotes) {
      const previous = stored[quote.instrumentId];
      if (
        previous
        && Number.isFinite(previous.price) && previous.price > 0
        && previous.asOf < quote.asOf
        && cairoDayOf(previous.asOf) !== cairoDayOf(quote.asOf)
      ) {
        const percent = ((quote.price - previous.price) / previous.price) * 100;
        if (Number.isFinite(percent)) {
          quote.change = Math.round((quote.price - previous.price) * 10_000) / 10_000;
          quote.changePercent = Math.round(percent * 1_000) / 1_000;
        }
      }
      stored[quote.instrumentId] = { price: quote.price, asOf: quote.asOf };
    }

    try {
      await this.cache.set(FX_REFERENCE_CACHE_KEY, cacheEntry(stored, FX_REFERENCE_TTL_MS, FX_REFERENCE_TTL_MS));
    } catch {
      /* The reference store is best-effort; losing it only withholds the
       * derived change on the next fetch. It never affects the price itself. */
    }
    return quotes;
  }

  private async getQuoteSnapshot(
    keyPart: string,
    instruments: MarketInstrument[],
    ttlMs: number,
    staleMs: number,
  ): Promise<QuoteSnapshot> {
    const key = keyPart === "board" ? BOARD_CACHE_KEY : `egytrend:market:quotes:v2:${keyPart}`;
    const cached = await loadCached(this.cache, key, ttlMs, staleMs, async () => {
      const resolved = await this.resolveQuotes(instruments);
      return this.enrichFxDailyChange(resolved);
    });
    // A successful HTTP fetch is not enough to call a quote current: the
    // provider's own timestamp may already be beyond this snapshot's maximum
    // cache age. Keep serving it transparently, but expose it as stale rather
    // than refreshing the browser's confidence with our fetch time.
    //
    // The judgement is session-aware: a closed market whose quote is its
    // latest official close is current, not stale (the old wall-clock rule
    // here is what made every index/commodity card read "بيانات قديمة"
    // from close until the next open). End-of-day references (FX) and
    // session-less instruments are exempt, as before.
    const now = Date.now();
    const sourceStale = cached.value.some((quote) => {
      if (quote.freshness === "end-of-day") return false;
      const session = sessionForInstrument(quote.instrumentId);
      if (!session) return false;
      const { state } = classifyQuote(
        { asOf: quote.asOf, sourceAsOfUnknown: quote.sourceAsOfUnknown, delayedMinutes: quote.delayedMinutes },
        session,
        now,
      );
      return state === "stale";
    });
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
    const disabled = await this.disabledProviderIds();

    for (const provider of this.providers) {
      /* Admin-disabled providers are skipped entirely (no call, no health
       * record). Remaining configured providers keep their original order —
       * the panel never reorders or auto-promotes a fallback. */
      if (disabled.has(provider.id)) continue;
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
    /* The legacy free reference feeds are registered last on purpose: they
     * only price instruments that no licensed provider was configured for. */
    singleton = new MarketDataService(
      [
        new EgidContractProvider(),
        new TwelveDataProvider(),
        new CoinGeckoProvider(),
        new ExchangeRateApiProvider(),
        new YahooChartProvider(),
        new TradingEconomicsEgxIndexProvider(),
        new TradingViewScannerProvider(),
        new CoinGeckoFreeProvider(),
      ],
      /* A licensed Trading Economics calendar always wins; the free FxPro
       * feed (plus the official CBE meeting schedule) is the fallback so the
       * calendar is never "غير متاح" merely because no paid key is set. */
      [new TradingEconomicsCalendarProvider(), new FxProCalendarProvider()],
    );
  }
  return singleton;
}

/** Test-only reset; it is not exported from an HTTP route. */
export function resetMarketDataServiceForTest(): void {
  singleton = null;
}

/** Test-only injection: swap the runtime singleton (fake providers, fake
 * clock). Never reachable from an HTTP route. */
export function setMarketDataServiceForTest(service: MarketDataService): void {
  singleton = service;
}
