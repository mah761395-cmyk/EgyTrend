import { zonedTimeToEpoch } from "./freshness";
import { ResilientHttpClient } from "./http";
import { recordDataQualityEvent } from "./quality";
import type {
  CalendarDataProvider,
  CalendarEvent,
  CanonicalQuote,
  DailyOhlc,
  MarketDataProvider,
  MarketInstrument,
  ProviderCalendarResult,
  ProviderDescriptor,
  ProviderQuoteResult,
} from "./types";

function finite(value: unknown): number | undefined {
  /* null/empty cells mean "the source did not publish this field" — they
   * must stay undefined (the UI shows "not provided") and never become 0,
   * which would look like a real zero (a zero volume, a zero price). */
  if (value === null || value === undefined) return undefined;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  const text = String(value).trim();
  if (text === "") return undefined;
  const number = Number(text.replace(/,/g, ""));
  return Number.isFinite(number) ? number : undefined;
}

/** Provider timestamps are part of source transparency. Missing/invalid is
 * deliberately omitted — substituting the browser/server's current time would
 * falsely imply a fresher market quote. */
function epoch(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value < 10_000_000_000 ? value * 1_000 : value;
  if (typeof value === "string") {
    const parsed = Date.parse(value.endsWith("Z") ? value : `${value}Z`);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function optionalDelay(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function freshness(delayMinutes: number | undefined): "real-time" | "delayed" | "unknown" {
  if (delayMinutes === 0) return "real-time";
  if (typeof delayMinutes === "number" && delayMinutes > 0) return "delayed";
  return "unknown";
}

/**
 * Twelve Data adapter. It cannot make a request unless an API key, an operator
 * acknowledgement, a non-secret reference to the customer-display license, and
 * an explicit delay classification are present. Symbols are supplied through a
 * JSON mapping after the selected plan/exchange agreement is known; this avoids
 * guessing tickers or coverage. EGX additionally needs its own explicit
 * acknowledgement and reference.
 */
export class TwelveDataProvider implements MarketDataProvider {
  readonly id = "twelve-data";
  readonly name = "Twelve Data";
  private readonly apiKey: string;
  private readonly displayLicensed: boolean;
  /** A separate acknowledgement is needed before a zero-delay quote can be
   * labelled real-time to the customer. */
  private readonly realtimeDisplayLicensed: boolean;
  /** Non-secret contract/ticket reference. Its presence prevents a bare boolean
   * from accidentally enabling customer-facing redistribution. */
  private readonly licenseReference: string;
  /** EGX has an explicit opt-in because current Twelve coverage/redistribution
   * cannot be inferred from the XCAI catalog listing. */
  private readonly egxDisplayLicensed: boolean;
  private readonly egxLicenseReference: string;
  private readonly symbols: Record<string, string>;
  private readonly delayedMinutes?: number;

  constructor(
    env: NodeJS.ProcessEnv = process.env,
    private readonly http = new ResilientHttpClient(),
  ) {
    this.apiKey = (env["TWELVE_DATA_API_KEY"] || "").trim();
    this.displayLicensed = env["TWELVE_DATA_EXTERNAL_DISPLAY_LICENSED"] === "true";
    this.realtimeDisplayLicensed = env["TWELVE_DATA_REALTIME_DISPLAY_LICENSED"] === "true";
    this.licenseReference = (env["TWELVE_DATA_LICENSE_REFERENCE"] || "").trim();
    this.egxDisplayLicensed = env["TWELVE_DATA_EGX_DISPLAY_LICENSED"] === "true";
    this.egxLicenseReference = (env["TWELVE_DATA_EGX_LICENSE_REFERENCE"] || "").trim();
    this.delayedMinutes = optionalDelay(env["TWELVE_DATA_DELAY_MINUTES"]);
    this.symbols = parseSymbolMap(env["TWELVE_DATA_SYMBOLS_JSON"]);
  }

  private isConfigured(): boolean {
    const timingConfirmed = this.delayedMinutes !== undefined
      && (this.delayedMinutes > 0 || this.realtimeDisplayLicensed);
    return Boolean(this.apiKey && this.displayLicensed && this.licenseReference && timingConfirmed);
  }

  descriptor(): ProviderDescriptor {
    const configured = this.isConfigured();
    return {
      id: this.id,
      name: this.name,
      state: configured ? "configured" : "not_configured",
      note: configured
        ? "مُفعّل بعد تأكيد المشغّل لحقوق العرض الخارجي؛ التغطية الفعلية تحددها خريطة الرموز والعقد."
        : "لا يُستدعى قبل وجود مفتاح ومرجع عقد/ترخيص ووسم تأخير دقيق يجيز العرض الخارجي للمشتركين.",
      coverage: ["index", "equity", "fx", "commodity", "crypto"],
      externalDisplayConfirmed: configured,
    };
  }

  canServe(instrument: MarketInstrument): boolean {
    return Boolean(
      this.isConfigured()
      && this.symbols[instrument.id]
      && (!isEgyptianExchangeInstrument(instrument.id)
        || (this.egxDisplayLicensed && this.egxLicenseReference)),
    );
  }

  async getQuotes(instruments: MarketInstrument[]): Promise<ProviderQuoteResult> {
    const supported = instruments.filter((instrument) => this.canServe(instrument));
    if (!supported.length) return { quotes: [], requestedCount: 0 };

    const requestedSymbols = supported.map((instrument) => this.symbols[instrument.id]);
    const url = new URL("https://api.twelvedata.com/quote");
    url.searchParams.set("symbol", requestedSymbols.join(","));
    url.searchParams.set("apikey", this.apiKey);
    const payload = await this.http.getJson<unknown>(url.toString(), {
      providerId: this.id,
      timeoutMs: 8_000,
      attempts: 2,
      minIntervalMs: 250,
    });

    const bySymbol = normalizeBatch(payload, requestedSymbols);
    const quotes = supported.flatMap((instrument) => {
      const row = bySymbol.get(this.symbols[instrument.id]);
      const quote = row ? this.parseQuote(instrument, row) : null;
      return quote ? [quote] : [];
    });
    return { quotes, requestedCount: supported.length };
  }

  async getDailyOhlc(instruments: MarketInstrument[], tradingDate: string): Promise<DailyOhlc[]> {
    const supported = instruments.filter((instrument) => this.canServe(instrument));
    const results: DailyOhlc[] = [];
    // The vendor's daily endpoint is instrument-oriented. Sequential pacing is
    // intentional: this job runs once/day and must never burst through quota.
    for (const instrument of supported) {
      const url = new URL("https://api.twelvedata.com/time_series");
      url.searchParams.set("symbol", this.symbols[instrument.id]);
      url.searchParams.set("interval", "1day");
      url.searchParams.set("outputsize", "5");
      url.searchParams.set("apikey", this.apiKey);
      const payload = await this.http.getJson<Record<string, unknown>>(url.toString(), {
        providerId: this.id,
        timeoutMs: 10_000,
        attempts: 2,
        minIntervalMs: 500,
      });
      const values = Array.isArray(payload["values"]) ? payload["values"] as Array<Record<string, unknown>> : [];
      const value = values.find((row) => String(row["datetime"] || "").slice(0, 10) === tradingDate) ?? values[0];
      if (!value) continue;
      const open = finite(value["open"]);
      const high = finite(value["high"]);
      const low = finite(value["low"]);
      const close = finite(value["close"]);
      // Daily bars may identify their observation only by the vendor-provided
      // candle datetime. That is still transparent as a candle date; a server
      // fetch time must never masquerade as a provider timestamp.
      const asOf = epoch(value["datetime"]);
      if ([open, high, low, close].some((number) => number === undefined) || asOf === undefined) continue;
      results.push({
        instrumentId: instrument.id,
        tradingDate: String(value["datetime"] || tradingDate).slice(0, 10),
        open: open!, high: high!, low: low!, close: close!,
        volume: finite(value["volume"]),
        currency: instrument.currency,
        asOf,
        sourceId: this.id,
        sourceName: this.name,
        delayedMinutes: this.delayedMinutes,
        freshness: "end-of-day",
      });
    }
    return results;
  }

  private parseQuote(instrument: MarketInstrument, row: Record<string, unknown>): CanonicalQuote | null {
    const price = finite(row["close"] ?? row["price"]);
    if (price === undefined || price <= 0) return null;
    const previousClose = finite(row["previous_close"]);
    const change = finite(row["change"]);
    const changePercent = finite(row["percent_change"] ?? row["change_percent"]);
    const asOf = epoch(row["timestamp"] ?? row["datetime"]);
    if (asOf === undefined) return null;
    return {
      instrumentId: instrument.id,
      price,
      previousClose,
      open: finite(row["open"]),
      high: finite(row["high"]),
      low: finite(row["low"]),
      volume: finite(row["volume"]),
      change,
      changePercent: changePercent ?? (previousClose && previousClose > 0 ? ((price - previousClose) / previousClose) * 100 : undefined),
      currency: String(row["currency"] || instrument.currency || "") || undefined,
      asOf,
      sourceId: this.id,
      sourceName: this.name,
      delayedMinutes: this.delayedMinutes,
      freshness: freshness(this.delayedMinutes),
    };
  }
}

/**
 * Legacy free reference feeds, restored from the pre-upgrade v6.0 markets
 * page. The licensed providers above still take priority: these adapters are
 * registered last in the runtime singleton, so they only price instruments
 * that no contracted provider was configured for. Every quote keeps the same
 * canonical envelope — a named source, the provider's own timestamp when it
 * gives one, and a freshness label that never claims real-time.
 * An operator can switch the whole legacy layer off with
 * LEGACY_MARKET_FEEDS_DISABLED=true.
 */
const LEGACY_FEEDS_DISABLED_ENV = "LEGACY_MARKET_FEEDS_DISABLED";

/* Yahoo's public v8 chart endpoint, the same symbol list the pre-upgrade
 * build used for the global indices and commodities cards. The endpoint
 * answers without credentials but rejects non-browser user agents, so the
 * request carries one in its own name. */
const YAHOO_CHART_SYMBOLS: Record<string, string> = {
  "index:SPX": "^GSPC",
  "index:NASDAQ": "^IXIC",
  "index:DJI": "^DJI",
  "index:FCHI": "^FCHI",
  "index:DAX": "^GDAXI",
  "index:FTSE100": "^FTSE",
  "index:N225": "^N225",
  "index:DXY": "DX-Y.NYB",
  "commodity:XAU": "GC=F",
  "commodity:BRENT": "BZ=F",
  "commodity:WTI": "CL=F",
  "commodity:NATGAS": "NG=F",
  "commodity:XAG": "SI=F",
  "commodity:COPPER": "HG=F",
  "commodity:WHEAT": "ZW=F",
  /* International spot pairs: Yahoo publishes a market timestamp, so these
   * rows carry source time (timeBasis "source"), unlike the once-a-day
   * Egyptian reference pairs from ExchangeRate-API. */
  "fx:EUR-USD": "EURUSD=X",
  "fx:GBP-USD": "GBPUSD=X",
  "fx:USD-JPY": "USDJPY=X",
  "fx:AUD-USD": "AUDUSD=X",
};

type YahooChartPayload = {
  chart?: {
    result?: Array<{ meta?: Record<string, unknown> }>;
  };
};

export class YahooChartProvider implements MarketDataProvider {
  readonly id = "yahoo-chart";
  readonly name = "Yahoo Finance";
  private readonly disabled: boolean;

  constructor(
    env: NodeJS.ProcessEnv = process.env,
    private readonly http = new ResilientHttpClient(),
  ) {
    this.disabled = env[LEGACY_FEEDS_DISABLED_ENV] === "true";
  }

  descriptor(): ProviderDescriptor {
    return {
      id: this.id,
      name: this.name,
      state: this.disabled ? "not_configured" : "configured",
      note: "مرجع عام مجاني للمؤشرات والسلع العالمية؛ يُعرض بذكر المصدر ووقت التحديث من المصدر، وليس سعرًا مرخّصًا فوريًا.",
      coverage: ["index", "commodity"],
      externalDisplayConfirmed: !this.disabled,
    };
  }

  canServe(instrument: MarketInstrument): boolean {
    return !this.disabled && YAHOO_CHART_SYMBOLS[instrument.id] !== undefined;
  }

  async getQuotes(instruments: MarketInstrument[]): Promise<ProviderQuoteResult> {
    const supported = instruments.filter((instrument) => this.canServe(instrument));
    if (!supported.length) return { quotes: [], requestedCount: 0 };
    const quotes: CanonicalQuote[] = [];
    /* Sequential pacing: one free endpoint, no bursts. */
    for (const instrument of supported) {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(YAHOO_CHART_SYMBOLS[instrument.id])}?interval=1d&range=1d`;
      const payload = await this.http.getJson<YahooChartPayload>(url, {
        providerId: this.id,
        timeoutMs: 10_000,
        attempts: 2,
        minIntervalMs: 350,
        headers: {
          Accept: "application/json",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
        },
      });
      const meta = (payload.chart?.result?.[0]?.meta ?? {}) as Record<string, unknown>;
      const price = finite(meta.regularMarketPrice);
      if (price === undefined || price <= 0) continue;
      const asOf = epoch(meta.regularMarketTime);
      if (asOf === undefined) continue;
      quotes.push({
        instrumentId: instrument.id,
        price,
        previousClose: finite(meta.chartPreviousClose),
        currency: instrument.currency,
        asOf,
        sourceId: this.id,
        sourceName: this.name,
        freshness: "unknown",
      });
    }
    return { quotes, requestedCount: supported.length };
  }

  /**
   * Daily bars from the same public v8 chart endpoint the quotes use
   * (interval=1d&range=5d). This lets the daily snapshot job write history
   * without a licensed vendor: the unofficial-source standing is the one the
   * operator already accepted for quote display, and the job is paced and
   * idempotent (one upsert per source+instrument+day).
   */
  async getDailyOhlc(instruments: MarketInstrument[], tradingDate: string): Promise<DailyOhlc[]> {
    const supported = instruments.filter((instrument) => this.canServe(instrument));
    const results: DailyOhlc[] = [];
    for (const instrument of supported) {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(YAHOO_CHART_SYMBOLS[instrument.id])}?interval=1d&range=5d`;
      let payload: YahooChartOhlcPayload;
      try {
        /* The cron runs inside the platform function's 60s budget for all
         * ~27 instruments, so one attempt with a short timeout: a slow
         * symbol is skipped (idempotent upsert heals what the next run can)
         * instead of stalling the whole daily job. */
        payload = await this.http.getJson<YahooChartOhlcPayload>(url, {
          providerId: this.id,
          timeoutMs: 8_000,
          attempts: 1,
          minIntervalMs: 250,
          headers: {
            Accept: "application/json",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
          },
        });
      } catch {
        /* Best effort per instrument: one flaky symbol must not fail the
         * whole daily job; the next day's run heals any gap. */
        continue;
      }
      const result = payload.chart?.result?.[0];
      const timestamps = Array.isArray(result?.timestamp) ? result?.timestamp : [];
      const quote = result?.indicators?.quote?.[0];
      if (!timestamps?.length || !quote) continue;
      /* The snapshot day is a Cairo date; take the newest bar dated on or
       * before it so a weekday run never picks a future foreign bar. A late
       * same-day run (after the foreign close) upserts the final close over
       * the intraday one: the row id is value-independent. */
      let idx = -1;
      for (let i = timestamps.length - 1; i >= 0; i--) {
        const t = timestamps[i];
        if (!Number.isFinite(t)) continue;
        if (new Date(t * 1000).toISOString().slice(0, 10) <= tradingDate) {
          idx = i;
          break;
        }
      }
      if (idx < 0) continue;
      /* OHLC values are strict: Yahoo returns null for missing data and a
       * missing bar value must never become a price (finite() keeps nulls
       * undefined, and this local guard rejects zero/negative too). */
      const price = (value: unknown): number | undefined =>
        typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
      const open = price(quote.open?.[idx]);
      const high = price(quote.high?.[idx]);
      const low = price(quote.low?.[idx]);
      const close = price(quote.close?.[idx]);
      if ([open, high, low, close].some((value) => value === undefined)) continue;
      const volume = quote.volume?.[idx];
      results.push({
        instrumentId: instrument.id,
        tradingDate: new Date(timestamps[idx] * 1000).toISOString().slice(0, 10),
        open: open!,
        high: high!,
        low: low!,
        close: close!,
        ...(typeof volume === "number" && Number.isFinite(volume) && volume >= 0 ? { volume } : {}),
        currency: instrument.currency,
        asOf: timestamps[idx] * 1000,
        sourceId: this.id,
        sourceName: this.name,
        freshness: "end-of-day",
      });
    }
    return results;
  }
}

type YahooChartOhlcPayload = {
  chart?: {
    result?: Array<{
      timestamp?: number[];
      indicators?: {
        quote?: Array<{
          open?: Array<number | null>;
          high?: Array<number | null>;
          low?: Array<number | null>;
          close?: Array<number | null>;
          volume?: Array<number | null>;
        }>;
      };
    }>;
  };
};

/**
 * TradingView's public Egypt scanner. The pre-upgrade product relied on it
 * after verifying Yahoo's EGX prices were stale and limited; it covers the
 * EGX equities (and, when present, the EGX index rows) with name-logged
 * prices. TradingView's own attribution is displayed by the client widget
 * already used for unpriced rows.
 */
const TV_SCANNER_URL = "https://scanner.tradingview.com/egypt/scan";
/** Core columns — verified supported by the Egypt market (the pre-upgrade
 * product shipped on exactly this set). They are never requested together
 * with the experimental extended sets below, so an unsupported extended
 * column can never take the whole screener down with it. */
const TV_SCANNER_COLUMNS = [
  "type", "name", "description", "close", "change", "change_abs", "open", "high", "low",
  "volume", "market_cap_basic", "sector",
];
/** Extended column sets, probed in separate scanner passes. Column support
 * varies by market, so each set is optional: when the scanner rejects one
 * (HTTP 400), the affected fields simply stay absent and the UI shows
 * "not provided" — never an invented number.
 *  - amount: traded value of the day in base currency (EGP for EGX rows).
 *  - valuation: P/E, dividend yield, EPS and 52-week range when the source
 *    publishes them for the market. */
const TV_SCANNER_EXT_AMOUNT = ["name", "amount"];
const TV_SCANNER_EXT_VALUATION = [
  "name", "pe_basic", "dividend_yield_basic", "eps_basic",
  "price_52_week_high", "price_52_week_low",
];

/** One raw row of the public Egypt scan, mapped 1:1 from the requested
 * columns. Fields the scanner omits stay undefined — callers must render
 * "not provided" rather than invent a value. */
export type TvScanRow = {
  /** "stock" | "index" as reported by the scanner; callers filter. */
  type: string;
  /** Listing symbol with the market prefix stripped ("COMI", not "EGX:COMI"). */
  sym: string;
  /** The company name exactly as the source labels it. */
  description: string;
  close: number | undefined;
  /** Signed daily change percent (e.g. -2.36). */
  change: number | undefined;
  /** Signed daily change in price units. */
  changeAbs: number | undefined;
  open: number | undefined;
  high: number | undefined;
  low: number | undefined;
  volume: number | undefined;
  /** Basic-currency market cap (EGP for EGX rows) when the source provides it. */
  marketCap: number | undefined;
  /** Sector label exactly as the source provides it (often English). */
  sector: string;
  /* Extended-column fields: present only when the corresponding scanner
   * pass succeeded for the Egypt market. */
  /** Traded value of the day (EGP) — the scanner's "amount". */
  amount: number | undefined;
  /** Trailing P/E (basic) when the source publishes it. */
  pe: number | undefined;
  /** Dividend yield in percent when the source publishes it. */
  divYield: number | undefined;
  /** Earnings per share (basic) when the source publishes it. */
  eps: number | undefined;
  /** 52-week high/low when the source publishes them. */
  high52w: number | undefined;
  low52w: number | undefined;
};

export class TradingViewScannerProvider implements MarketDataProvider {
  readonly id = "tradingview-scanner";
  readonly name = "TradingView Scanner";
  private readonly disabled: boolean;

  constructor(
    env: NodeJS.ProcessEnv = process.env,
    private readonly http = new ResilientHttpClient(),
  ) {
    this.disabled = env[LEGACY_FEEDS_DISABLED_ENV] === "true";
  }

  descriptor(): ProviderDescriptor {
    return {
      id: this.id,
      name: this.name,
      state: this.disabled ? "not_configured" : "configured",
      note: "بيانات أسعار عرضية من ماسح TradingView العام للبورصة المصرية؛ قد تكون متأخرة عن سعر التداول وبإسناد إلزامي للمصدر.",
      coverage: ["index", "equity"],
      externalDisplayConfirmed: !this.disabled,
    };
  }

  canServe(instrument: MarketInstrument): boolean {
    if (this.disabled) return false;
    return instrument.id.startsWith("stock:egx:") || instrument.id.startsWith("egx:");
  }

  /** One scanner request for an explicit column set, mapped positionally.
   * Both the core screener scan and the optional extended passes share it,
   * and the quote path uses the core set so the market is never fetched
   * twice for quotes. */
  private async postScanColumns(columns: readonly string[]): Promise<Array<{ sym: string; entry: Record<string, unknown> }>> {
    const payload = await this.http.postJson<{ data?: Array<{ s: string; d: unknown[] }> }>(
      TV_SCANNER_URL,
      {
        filter: [{ left: "type", operation: "in_range", right: ["stock", "index"] }],
        markets: ["egypt"],
        symbols: { query: { types: [] }, tickers: [] },
        columns: [...columns],
        sort: { sortBy: "market_cap_basic", sortOrder: "desc" },
        range: [0, 500],
      },
      { providerId: this.id, timeoutMs: 12_000, attempts: 2, minIntervalMs: 1_000 },
    );

    const rows: Array<{ sym: string; entry: Record<string, unknown> }> = [];
    for (const item of payload.data ?? []) {
      if (!Array.isArray(item?.d)) continue;
      const entry: Record<string, unknown> = {};
      columns.forEach((column, index) => { entry[column] = item.d[index]; });
      const symbol = String(entry.name ?? "").trim().replace(/^EGX:/, "");
      if (!symbol) continue;
      rows.push({ sym: symbol, entry });
    }
    return rows;
  }

  /** One scanner request, mapped to raw rows (core columns). */
  private async postScan(): Promise<TvScanRow[]> {
    const rows: TvScanRow[] = [];
    for (const { sym, entry } of await this.postScanColumns(TV_SCANNER_COLUMNS)) {
      rows.push({
        type: String(entry.type ?? "stock"),
        sym,
        description: String(entry.description ?? "").trim(),
        close: finite(entry.close),
        change: finite(entry.change),
        changeAbs: finite(entry.change_abs),
        open: finite(entry.open),
        high: finite(entry.high),
        low: finite(entry.low),
        volume: finite(entry.volume),
        marketCap: finite(entry.market_cap_basic),
        sector: String(entry.sector ?? "").trim(),
        amount: undefined,
        pe: undefined,
        divYield: undefined,
        eps: undefined,
        high52w: undefined,
        low52w: undefined,
      });
    }
    return rows;
  }

  /** The scanner's full Egypt equity list (index rows included, filtered by
   * the caller). Every listed stock the source knows about is returned, not
   * just a curated subset — the screener must reflect the real market.
   *
   * After the core scan, two OPTIONAL column passes enrich the same rows:
   * "amount" (traded value) and a valuation set (P/E, dividend yield, EPS,
   * 52-week range). Extended columns are market-specific, so a rejected
   * pass is a normal outcome — it only leaves those fields absent, it never
   * fails the screener. */
  async getEgxFullScan(): Promise<TvScanRow[]> {
    if (this.disabled) return [];
    const rows = await this.postScan();
    const bySymbol = new Map(rows.map((row) => [row.sym, row]));
    const enrich = async (columns: readonly string[], assign: (row: TvScanRow, entry: Record<string, unknown>) => void): Promise<void> => {
      try {
        for (const { sym, entry } of await this.postScanColumns(columns)) {
          const target = bySymbol.get(sym);
          if (target) assign(target, entry);
        }
      } catch {
        /* Optional columns unsupported for this market (or transient
         * failure): the fields stay undefined and the UI shows the honest
         * "not provided" state. The core rows are untouched. */
      }
    };
    await enrich(TV_SCANNER_EXT_AMOUNT, (row, entry) => { row.amount = finite(entry.amount); });
    await enrich(TV_SCANNER_EXT_VALUATION, (row, entry) => {
      row.pe = finite(entry.pe_basic);
      row.divYield = finite(entry.dividend_yield_basic);
      row.eps = finite(entry.eps_basic);
      row.high52w = finite(entry.price_52_week_high);
      row.low52w = finite(entry.price_52_week_low);
    });
    return rows;
  }

  async getQuotes(instruments: MarketInstrument[]): Promise<ProviderQuoteResult> {
    const supported = instruments.filter((instrument) => this.canServe(instrument));
    if (!supported.length) return { quotes: [], requestedCount: 0 };

    const bySymbol = new Map<string, TvScanRow>();
    for (const row of await this.postScan()) bySymbol.set(row.sym, row);

    const quotes = supported.flatMap((instrument) => {
      const row = bySymbol.get(instrument.symbol);
      const price = row?.close;
      if (!row || price === undefined || price <= 0) return [];
      const changeAbs = row.changeAbs;
      return [{
        instrumentId: instrument.id,
        price,
        previousClose: changeAbs !== undefined ? price - changeAbs : undefined,
        change: changeAbs,
        changePercent: row.change,
        open: row.open,
        high: row.high,
        low: row.low,
        volume: row.volume,
        currency: instrument.currency,
        asOf: Date.now(),
        /* The scanner returns no data timestamp; asOf is the fetch time and
         * freshness must be judged by session state, not wall-clock age. */
        sourceAsOfUnknown: true,
        sourceId: this.id,
        sourceName: this.name,
        freshness: "unknown",
      } satisfies CanonicalQuote];
    });
    return { quotes, requestedCount: supported.length };
  }
}

/** The free public CoinGecko endpoint, used exactly as in the pre-upgrade
 * build: a public reference feed for crypto with its 24h change, still
 * shadowed by the CoinGecko Provider when a commercial key is configured. */
export class CoinGeckoFreeProvider implements MarketDataProvider {
  readonly id = "coingecko-free";
  readonly name = "CoinGecko (مرجع عام)";
  private readonly disabled: boolean;

  constructor(
    env: NodeJS.ProcessEnv = process.env,
    private readonly http = new ResilientHttpClient(),
  ) {
    this.disabled = env[LEGACY_FEEDS_DISABLED_ENV] === "true";
  }

  descriptor(): ProviderDescriptor {
    return {
      id: this.id,
      name: this.name,
      state: this.disabled ? "not_configured" : "configured",
      note: "مصدر عام مجاني للعملات المشفرة؛ يُعرض بذكر المصدر ووقت التحديث من المصدر فقط، وليس سعرًا مرخّصًا.",
      coverage: ["crypto"],
      externalDisplayConfirmed: !this.disabled,
    };
  }

  canServe(instrument: MarketInstrument): boolean {
    return !this.disabled && coinId(instrument) !== undefined;
  }

  async getQuotes(instruments: MarketInstrument[]): Promise<ProviderQuoteResult> {
    const supported = instruments.filter((instrument) => this.canServe(instrument));
    if (!supported.length) return { quotes: [], requestedCount: 0 };
    const ids = [...new Set(supported.map((instrument) => coinId(instrument)!))];
    const url = new URL("https://api.coingecko.com/api/v3/simple/price");
    url.searchParams.set("ids", ids.join(","));
    url.searchParams.set("vs_currencies", "usd");
    url.searchParams.set("include_24hr_change", "true");
    const payload = await this.http.getJson<Record<string, Record<string, unknown>>>(url.toString(), {
      providerId: this.id,
      timeoutMs: 9_000,
      attempts: 2,
      minIntervalMs: 500,
    });
    const fetchedAt = Date.now();
    const quotes = supported.flatMap((instrument) => {
      const row = payload[coinId(instrument)!];
      const price = finite(row?.usd);
      if (price === undefined || price <= 0) return [];
      return [{
        instrumentId: instrument.id,
        price,
        changePercent: finite(row?.usd_24h_change),
        currency: "USD",
        asOf: epoch(row?.last_updated_at) ?? fetchedAt,
        sourceId: this.id,
        sourceName: this.name,
        freshness: "unknown",
      } satisfies CanonicalQuote];
    });
    return { quotes, requestedCount: supported.length };
  }
}

/**
 * The EGX30 headline index has little third-party coverage outside Egypt.
 * The pre-upgrade build read Trading Economics' public Egypt stock-market
 * summary for exactly this number; that attribution and summary time are
 * carried through unchanged here.
 */
export class TradingEconomicsEgxIndexProvider implements MarketDataProvider {
  readonly id = "tradingeconomics-egx-index";
  readonly name = "Trading Economics (EGX30)";
  private readonly disabled: boolean;

  constructor(
    env: NodeJS.ProcessEnv = process.env,
    private readonly http = new ResilientHttpClient(),
  ) {
    this.disabled = env[LEGACY_FEEDS_DISABLED_ENV] === "true";
  }

  descriptor(): ProviderDescriptor {
    return {
      id: this.id,
      name: this.name,
      state: this.disabled ? "not_configured" : "configured",
      note: "مرجع عام مجاني لمؤشر EGX30؛ يُعرض بذكر المصدر ووقت الجلب فقط، وليس سعرًا مرخّصًا فوريًا.",
      coverage: ["index"],
      externalDisplayConfirmed: !this.disabled,
    };
  }

  canServe(instrument: MarketInstrument): boolean {
    return !this.disabled && instrument.id === "egx:EGX30";
  }

  async getQuotes(instruments: MarketInstrument[]): Promise<ProviderQuoteResult> {
    const supported = instruments.filter((instrument) => this.canServe(instrument));
    if (!supported.length) return { quotes: [], requestedCount: 0 };
    const html = await this.http.getText("https://tradingeconomics.com/egypt/stock-market", {
      providerId: this.id,
      timeoutMs: 10_000,
      attempts: 2,
      minIntervalMs: 1_000,
      headers: { Accept: "text/html" },
    });
    const priceMatch = html.match(/<td id="p">([0-9.,]+)/);
    const price = priceMatch ? finite(priceMatch[1]) : undefined;
    if (price === undefined || price <= 0) return { quotes: [], requestedCount: supported.length };
    /* The page writes the direction as a word, not as a sign on the number:
     * "losing 1.64% from the previous session". Capturing the bare number
     * therefore flipped every down-day into an up-day, so the primary read
     * must bind the direction word to the number it qualifies. */
    const sentenceMatch = /\bEGX 30\b[^<]*?\b(gaining|losing|rising|falling|up|down)\b\s*([+\-]?[0-9]+\.[0-9]+)\s*%[^<]*?from the previous/i.exec(html);
    const signedCellMatch = /\bEGX 30\b[\s\S]{0,600}?([+\-])\s*([0-9]+\.[0-9]+)\s*%/.exec(html);
    let sentenceValue: number | undefined;
    if (sentenceMatch) {
      const magnitude = Math.abs(finite(sentenceMatch[2]) ?? 0);
      if (magnitude > 0) {
        sentenceValue = /(losing|falling|down)/i.test(sentenceMatch[1]) ? -magnitude : magnitude;
      }
    }
    /* The index table row carries the daily percent with an explicit sign. */
    let cellValue: number | undefined;
    if (signedCellMatch) {
      const magnitude = finite(signedCellMatch[2]);
      if (magnitude !== undefined) {
        cellValue = signedCellMatch[1] === "-" ? -magnitude : magnitude;
      }
    }
    /* If both readings exist but disagree on direction, the page layout has
     * drifted again: record the anomaly and trust the direction word, which
     * is the primary read. */
    if (sentenceValue !== undefined && cellValue !== undefined
      && Math.sign(sentenceValue) !== Math.sign(cellValue)) {
      recordDataQualityEvent({
        sourceId: this.id,
        kind: "sign_anomaly",
        instrumentId: "egx:EGX30",
        message: `EGX30 direction word (${sentenceValue}%) disagrees with signed table cell (${cellValue}%)`,
      });
    }
    let changePercent: number | undefined = sentenceValue ?? cellValue;
    if (changePercent === undefined) {
      const pctMatch = html.match(/(gaining|losing|rising|falling|up|down)\s*([0-9.]+)%/i);
      if (pctMatch) {
        const magnitude = finite(pctMatch[2]);
        changePercent = magnitude === undefined ? undefined : (/(losing|falling|down)/i.test(pctMatch[1]) ? -magnitude : magnitude);
      }
    }
    return {
      quotes: supported.map((instrument) => ({
        instrumentId: instrument.id,
        price,
        changePercent: changePercent ?? undefined,
        currency: instrument.currency,
        asOf: Date.now(),
        /* The scraped page carries no machine-readable timestamp; asOf is the
         * fetch time and freshness must be judged by session state. */
        sourceAsOfUnknown: true,
        sourceId: this.id,
        sourceName: this.name,
        freshness: "unknown",
      } satisfies CanonicalQuote)),
      requestedCount: supported.length,
    };
  }
}

/** CoinGecko is deliberately isolated to crypto and needs a paid commercial key. */
export class CoinGeckoProvider implements MarketDataProvider {
  readonly id = "coingecko";
  readonly name = "CoinGecko";
  private readonly apiKey: string;
  private readonly displayLicensed: boolean;
  private readonly delayedMinutes?: number;

  constructor(
    env: NodeJS.ProcessEnv = process.env,
    private readonly http = new ResilientHttpClient(),
  ) {
    this.apiKey = (env["COINGECKO_PRO_API_KEY"] || "").trim();
    this.displayLicensed = env["COINGECKO_COMMERCIAL_LICENSED"] === "true";
    this.delayedMinutes = optionalDelay(env["COINGECKO_DELAY_MINUTES"]);
  }

  descriptor(): ProviderDescriptor {
    const configured = Boolean(this.apiKey && this.displayLicensed);
    return {
      id: this.id,
      name: this.name,
      state: configured ? "configured" : "not_configured",
      note: configured
        ? "مُفعّل للبيانات المشفرة مع الإسناد المطلوب من المزود."
        : "لا يُستخدم المستوى المجاني أو المفتاح غير المرخّص في واجهة العملاء.",
      coverage: ["crypto"],
      externalDisplayConfirmed: configured,
    };
  }

  canServe(instrument: MarketInstrument): boolean {
    return Boolean(this.apiKey && this.displayLicensed && coinId(instrument));
  }

  async getQuotes(instruments: MarketInstrument[]): Promise<ProviderQuoteResult> {
    const supported = instruments.filter((instrument) => this.canServe(instrument));
    if (!supported.length) return { quotes: [], requestedCount: 0 };
    const ids = [...new Set(supported.map((instrument) => coinId(instrument)!))];
    const url = new URL("https://pro-api.coingecko.com/api/v3/simple/price");
    url.searchParams.set("ids", ids.join(","));
    url.searchParams.set("vs_currencies", "usd");
    url.searchParams.set("include_24hr_change", "true");
    url.searchParams.set("include_last_updated_at", "true");
    const payload = await this.http.getJson<Record<string, Record<string, unknown>>>(url.toString(), {
      providerId: this.id,
      timeoutMs: 8_000,
      attempts: 2,
      minIntervalMs: 250,
      headers: { "x-cg-pro-api-key": this.apiKey },
    });

    const quotes = supported.flatMap((instrument) => {
      const row = payload[coinId(instrument)!];
      const price = finite(row?.["usd"]);
      if (price === undefined || price <= 0) return [];
      const asOf = epoch(row?.["last_updated_at"]);
      if (asOf === undefined) return [];
      return [{
        instrumentId: instrument.id,
        price,
        changePercent: finite(row?.["usd_24h_change"]),
        currency: "USD",
        asOf,
        sourceId: this.id,
        sourceName: this.name,
        delayedMinutes: this.delayedMinutes,
        freshness: freshness(this.delayedMinutes),
      } satisfies CanonicalQuote];
    });
    return { quotes, requestedCount: supported.length };
  }
}

/**
 * EGID is the official EGX distributor, but its production protocol and
 * redistribution terms arrive in a negotiated contract. This descriptor keeps
 * that fact visible rather than simulating an integration or scraping pages.
 */
export class EgidContractProvider implements MarketDataProvider {
  readonly id = "egid";
  readonly name = "EGID / EGX";

  descriptor(): ProviderDescriptor {
    return {
      id: this.id,
      name: this.name,
      state: "requires_contract",
      note: "المصدر الرسمي لبيانات EGX؛ يلزم عقد عرض للمشتركين وبيانات الاتصال/الرموز من EGID قبل تفعيل الموصل.",
      coverage: ["index", "equity"],
      externalDisplayConfirmed: false,
    };
  }

  canServe(): boolean { return false; }

  async getQuotes(): Promise<ProviderQuoteResult> {
    return { quotes: [], requestedCount: 0 };
  }
}

/**
 * Calendar adapter for a contracted Trading Economics API plan. It replaces
 * the previous unauthorised ForexFactory feed; it stays fully inert until a
 * commercial key and explicit display acknowledgement are present.
 */
export class TradingEconomicsCalendarProvider implements CalendarDataProvider {
  readonly id = "trading-economics";
  readonly name = "Trading Economics";
  private readonly apiKey: string;
  private readonly displayLicensed: boolean;
  private readonly countries: string;
  private readonly delayedMinutes?: number;

  constructor(
    env: NodeJS.ProcessEnv = process.env,
    private readonly http = new ResilientHttpClient(),
  ) {
    this.apiKey = (env["TRADING_ECONOMICS_API_KEY"] || "").trim();
    this.displayLicensed = env["TRADING_ECONOMICS_EXTERNAL_DISPLAY_LICENSED"] === "true";
    this.countries = (env["TRADING_ECONOMICS_CALENDAR_COUNTRIES"] || "United States,Euro Area,United Kingdom,Egypt").trim();
    this.delayedMinutes = optionalDelay(env["TRADING_ECONOMICS_DELAY_MINUTES"]);
  }

  descriptor(): ProviderDescriptor {
    const configured = Boolean(this.apiKey && this.displayLicensed);
    return {
      id: this.id,
      name: this.name,
      state: configured ? "configured" : "not_configured",
      note: configured
        ? "مُفعّل للتقويم فقط وفق خطة/حقوق العرض الخارجية التي أكدها المشغّل."
        : "لا يُستخدم حساب تجربة أو مصدر غير مرخّص لتقويم العملاء.",
      coverage: ["calendar"],
      externalDisplayConfirmed: configured,
    };
  }

  async getCalendar(): Promise<ProviderCalendarResult> {
    if (!this.apiKey || !this.displayLicensed) return { events: [] };
    const path = this.countries.split(",").map((value) => encodeURIComponent(value.trim())).join(",");
    const url = new URL(`https://api.tradingeconomics.com/calendar/country/${path}`);
    url.searchParams.set("c", this.apiKey);
    const payload = await this.http.getJson<unknown[]>(url.toString(), {
      providerId: this.id,
      timeoutMs: 10_000,
      attempts: 2,
      minIntervalMs: 500,
    });
    const fetchedAt = Date.now();
    const events = payload.flatMap((raw) => {
      const row = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
      const title = String(row["Event"] ?? row["event"] ?? "").trim();
      const at = epoch(row["Date"] ?? row["date"]);
      if (!title || at === undefined) return [];
      const country = String(row["Country"] ?? row["country"] ?? "").trim();
      const impact = normalizeImpact(row["Importance"] ?? row["importance"]);
      return [{
        title,
        at,
        country,
        countryAr: countryArabic(country),
        flag: countryFlag(country),
        impact,
        forecast: stringOrUndefined(row["Forecast"] ?? row["forecast"]),
        previous: stringOrUndefined(row["Previous"] ?? row["previous"]),
        sourceId: this.id,
        sourceName: this.name,
        asOf: fetchedAt,
        delayedMinutes: this.delayedMinutes,
        freshness: freshness(this.delayedMinutes),
      } satisfies CalendarEvent];
    });
    return { events };
  }
}

/**
 * Free global economic calendar: the public FxPro/Faireconomy syndication
 * feed (this week + next week), plus the official Central Bank of Egypt MPC
 * meeting schedule for 2026 (the feed itself carries no EGP events).
 *
 * Standing: the feed is a public syndication endpoint with no published
 * commercial license text. Display is headline-level (title, time, impact,
 * forecast, previous) with attribution to the feed, and the whole source is
 * switchable with FXPRO_CALENDAR_DISABLED=true. The CBE rows are a published
 * meeting schedule (dates), not scraped content.
 */
const FXPRO_CALENDAR_URLS = [
  "https://nfs.faireconomy.media/ff_calendar_thisweek.json",
  "https://nfs.faireconomy.media/ff_calendar_nextweek.json",
];

const FXPRO_COUNTRY: Record<string, { ar: string; flag: string }> = {
  USD: { ar: "الولايات المتحدة", flag: "🇺🇸" },
  EUR: { ar: "منطقة اليورو", flag: "🇪🇺" },
  GBP: { ar: "بريطانيا", flag: "🇬🇧" },
  JPY: { ar: "اليابان", flag: "🇯🇵" },
  CAD: { ar: "كندا", flag: "🇨🇦" },
  AUD: { ar: "أستراليا", flag: "🇦🇺" },
  CHF: { ar: "سويسرا", flag: "🇨🇭" },
  CNY: { ar: "الصين", flag: "🇨🇳" },
  NZD: { ar: "نيوزيلندا", flag: "🇳🇿" },
  EGP: { ar: "مصر", flag: "🇪🇬" },
};

/**
 * Official 2026 schedule of the Central Bank of Egypt Monetary Policy
 * Committee meetings (eight regular meetings, all Thursdays; the decision is
 * announced around 13:30 Cairo time). Dates as published by the CBE and
 * carried identically by multiple independent outlets. Meeting day = the
 * decision day; time set to 13:30 Africa/Cairo.
 */
const CBE_MPC_2026 = [
  "2026-02-12",
  "2026-04-02",
  "2026-05-21",
  "2026-07-09",
  "2026-08-20",
  "2026-09-24",
  "2026-10-29",
  "2026-12-17",
];

function cbeMpcEvents(fetchedAt: number): CalendarEvent[] {
  return CBE_MPC_2026.flatMap((date) => {
    const [y, m, d] = date.split("-").map(Number);
    if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return [];
    const at = zonedTimeToEpoch("Africa/Cairo", y, m, d, 13 * 60 + 30);
    /* Meetings older than a day are history, not calendar items. */
    if (at < fetchedAt - 86_400_000) return [];
    return [{
      title: "CBE MPC Meeting — Interest Rate Decision",
      titleAr: "اجتماع لجنة السياسة النقدية — البنك المركزي المصري (قرار الفائدة)",
      at,
      country: "Egypt",
      countryAr: "مصر",
      flag: "🇪🇬",
      impact: "high" as const,
      sourceId: "fxpro-calendar",
      sourceName: "FxPro Economic Calendar + جدول البنك المركزي المصري",
      asOf: fetchedAt,
      freshness: "unknown" as const,
    }];
  });
}

export class FxProCalendarProvider implements CalendarDataProvider {
  readonly id = "fxpro-calendar";
  readonly name = "FxPro Economic Calendar";
  private readonly disabled: boolean;

  constructor(
    env: NodeJS.ProcessEnv = process.env,
    private readonly http = new ResilientHttpClient(),
  ) {
    this.disabled = env["FXPRO_CALENDAR_DISABLED"] === "true";
  }

  descriptor(): ProviderDescriptor {
    return {
      id: this.id,
      name: this.name,
      state: this.disabled ? "not_configured" : "configured",
      note: this.disabled
        ? "معطّل من الإدارة (FXPRO_CALENDAR_DISABLED)."
        : "تقويم اقتصادي عام (FxPro/Faireconomy) مضافًا إليه جدول اجتماعات البنك المركزي المصري؛ يُعرض بالإسناد ويُعطّل بمتغيّر واحد.",
      coverage: ["calendar"],
      externalDisplayConfirmed: !this.disabled,
    };
  }

  async getCalendar(): Promise<ProviderCalendarResult> {
    if (this.disabled) return { events: [] };
    const fetchedAt = Date.now();
    const rows: unknown[] = [];
    for (const url of FXPRO_CALENDAR_URLS) {
      try {
        const payload = await this.http.getJson<unknown[]>(url, {
          providerId: this.id,
          timeoutMs: 10_000,
          attempts: 2,
          minIntervalMs: 500,
        });
        if (Array.isArray(payload)) rows.push(...payload);
      } catch {
        /* One missing week is acceptable; the other week plus the CBE
         * schedule still serve the calendar truthfully. */
      }
    }
    const events: CalendarEvent[] = rows.flatMap((raw) => {
      const row = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
      const title = String(row["title"] ?? "").trim();
      const at = Date.parse(String(row["date"] ?? ""));
      /* The feed also carries earlier events of the week. The calendar is an
       * upcoming-events surface (the UI never shows past ones), and dropping
       * them keeps the merged CBE schedule inside the payload cap. */
      if (!title || !Number.isFinite(at) || at < fetchedAt) return [];
      const country = String(row["country"] ?? "").trim();
      const meta = FXPRO_COUNTRY[country] ?? { ar: country || "دولي", flag: "🌍" };
      return [{
        title,
        at,
        country,
        countryAr: meta.ar,
        flag: meta.flag,
        impact: normalizeImpact(row["impact"]),
        forecast: stringOrUndefined(row["forecast"]),
        previous: stringOrUndefined(row["previous"]),
        sourceId: this.id,
        sourceName: "FxPro Economic Calendar",
        asOf: fetchedAt,
        freshness: "unknown" as const,
      } satisfies CalendarEvent];
    });
    events.push(...cbeMpcEvents(fetchedAt));
    return { events };
  }
}

/**
 * Daily reference FX rates from ExchangeRate-API's open endpoint.
 *
 * Terms of use (exchangerate-api.com/terms) allow commercial end use on the
 * free plan and forbid redistributing the API itself; showing a rate beside
 * its source and update time inside this product is the permitted end use.
 * The feed is a daily reference table, so it is labelled end-of-day — never
 * presented as a live, tradeable quote. Cross rates are derived from the same
 * provider table (EGP per X = EGP-per-USD ÷ X-per-USD).
 */
export class ExchangeRateApiProvider implements MarketDataProvider {
  readonly id = "exchange-rate-api";
  readonly name = "ExchangeRate-API";
  private readonly disabled: boolean;

  constructor(
    env: NodeJS.ProcessEnv = process.env,
    private readonly http = new ResilientHttpClient(),
  ) {
    this.disabled = env["FX_REFERENCE_DISABLED"] === "true";
  }

  descriptor(): ProviderDescriptor {
    return {
      id: this.id,
      name: this.name,
      state: this.disabled ? "not_configured" : "configured",
      note: this.disabled
        ? "أُوقف يدويًا من إعدادات المشغّل."
        : "أسعار مرجعية يومية للصرف (إسناد إلزامي). تُعرض مع وقت تحديث المصدر وليست سعرًا لحظيًا.",
      coverage: ["fx"],
      externalDisplayConfirmed: !this.disabled,
    };
  }

  canServe(instrument: MarketInstrument): boolean {
    return !this.disabled && FX_REFERENCE_PAIRS[instrument.id] !== undefined;
  }

  async getQuotes(instruments: MarketInstrument[]): Promise<ProviderQuoteResult> {
    const supported = instruments.filter((instrument) => this.canServe(instrument));
    if (!supported.length) return { quotes: [], requestedCount: 0 };
    const payload = await this.http.getJson<Record<string, unknown>>(
      "https://open.er-api.com/v6/latest/USD",
      { providerId: this.id, timeoutMs: 8_000, attempts: 2, minIntervalMs: 250 },
    );
    const rates = payload["rates"] as Record<string, unknown> | undefined;
    const asOf = epoch(payload["time_last_update_unix"]);
    const egpPerUsd = finite(rates?.["EGP"]);
    if (!rates || asOf === undefined || egpPerUsd === undefined || egpPerUsd <= 0) {
      return { quotes: [], requestedCount: supported.length };
    }
    const quotes = supported.flatMap((instrument) => {
      const code = FX_REFERENCE_PAIRS[instrument.id]!;
      let price = egpPerUsd;
      if (code !== "USD") {
        const perUsd = finite(rates[code]);
        if (perUsd === undefined || perUsd <= 0) return [];
        price = egpPerUsd / perUsd;
      }
      return [{
        instrumentId: instrument.id,
        price: Math.round(price * 10_000) / 10_000,
        currency: "EGP",
        asOf,
        sourceId: this.id,
        sourceName: this.name,
        freshness: "end-of-day" as const,
      } satisfies CanonicalQuote];
    });
    return { quotes, requestedCount: supported.length };
  }

  /**
   * Daily reference bar for the persisted daily-history store. The reference
   * is a single value, so open/high/low/close all carry it — no intraday
   * shape is invented. The bar is dated on the day the PROVIDER published the
   * table (Cairo calendar day of `time_last_update_unix`), not on the cron's
   * run date: that keeps the idempotent (source, instrument, day) upsert
   * honest when the feed updates late or the job re-runs, and it makes the
   * stored series the true record of verified daily references.
   */
  async getDailyOhlc(instruments: MarketInstrument[], _tradingDate: string): Promise<DailyOhlc[]> {
    const supported = instruments.filter((instrument) => this.canServe(instrument));
    if (!supported.length) return [];
    const payload = await this.http.getJson<Record<string, unknown>>(
      "https://open.er-api.com/v6/latest/USD",
      { providerId: this.id, timeoutMs: 8_000, attempts: 1, minIntervalMs: 250 },
    );
    const rates = payload["rates"] as Record<string, unknown> | undefined;
    const asOf = epoch(payload["time_last_update_unix"]);
    const egpPerUsd = finite(rates?.["EGP"]);
    if (!rates || asOf === undefined || egpPerUsd === undefined || egpPerUsd <= 0) return [];

    const dayParts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Africa/Cairo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(asOf);
    const dayPart = (type: string): string => dayParts.find((part) => part.type === type)?.value ?? "";
    const tradingDate = `${dayPart("year")}-${dayPart("month")}-${dayPart("day")}`;

    return supported.flatMap((instrument) => {
      const code = FX_REFERENCE_PAIRS[instrument.id]!;
      let price = egpPerUsd;
      if (code !== "USD") {
        const perUsd = finite(rates[code]);
        if (perUsd === undefined || perUsd <= 0) return [];
        price = egpPerUsd / perUsd;
      }
      const value = Math.round(price * 10_000) / 10_000;
      return [{
        instrumentId: instrument.id,
        tradingDate,
        open: value,
        high: value,
        low: value,
        close: value,
        currency: "EGP",
        asOf,
        sourceId: this.id,
        sourceName: this.name,
        freshness: "end-of-day" as const,
      } satisfies DailyOhlc];
    });
  }
}

const FX_REFERENCE_PAIRS: Record<string, string> = {
  "fx:USD-EGP": "USD",
  "fx:EUR-EGP": "EUR",
  "fx:GBP-EGP": "GBP",
  "fx:SAR-EGP": "SAR",
};

function isEgyptianExchangeInstrument(instrumentId: string): boolean {
  return instrumentId.startsWith("egx:") || instrumentId.startsWith("stock:egx:");
}

function parseSymbolMap(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed as Record<string, unknown>)
      .flatMap(([key, value]) => {
        const symbol = typeof value === "string" ? value.trim() : "";
        return key.trim() && symbol ? [[key.trim(), symbol]] : [];
      }));
  } catch {
    return {};
  }
}

function normalizeBatch(payload: unknown, requestedSymbols: string[]): Map<string, Record<string, unknown>> {
  const result = new Map<string, Record<string, unknown>>();
  if (!payload || typeof payload !== "object") return result;
  const record = payload as Record<string, unknown>;
  // One-symbol endpoint returns the quote object directly; batch returns an
  // object keyed by the requested vendor symbol.
  if (requestedSymbols.length === 1 && (record["close"] !== undefined || record["price"] !== undefined)) {
    result.set(requestedSymbols[0], record);
    return result;
  }
  for (const symbol of requestedSymbols) {
    const row = record[symbol];
    if (row && typeof row === "object" && !Array.isArray(row)) result.set(symbol, row as Record<string, unknown>);
  }
  return result;
}

function coinId(instrument: MarketInstrument): string | undefined {
  const ids: Record<string, string> = {
    "crypto:BTC": "bitcoin",
    "crypto:ETH": "ethereum",
    "crypto:XRP": "ripple",
    "crypto:BNB": "binancecoin",
    "crypto:SOL": "solana",
    "crypto:DOGE": "dogecoin",
    "crypto:ADA": "cardano",
    "crypto:AVAX": "avalanche-2",
    "crypto:LINK": "chainlink",
    "crypto:TON": "the-open-network",
  };
  return ids[instrument.id];
}

function normalizeImpact(value: unknown): "high" | "medium" | "low" | "unknown" {
  const normalized = String(value ?? "").toLowerCase();
  if (/high|3/.test(normalized)) return "high";
  if (/medium|2/.test(normalized)) return "medium";
  if (/low|1|holiday/.test(normalized)) return "low";
  return "unknown";
}

function stringOrUndefined(value: unknown): string | undefined {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, 100) : undefined;
}

function countryArabic(country: string): string {
  const map: Record<string, string> = {
    "United States": "الولايات المتحدة",
    "Euro Area": "منطقة اليورو",
    "United Kingdom": "المملكة المتحدة",
    Egypt: "مصر",
    Japan: "اليابان",
    China: "الصين",
  };
  return map[country] ?? country;
}

function countryFlag(country: string): string {
  const map: Record<string, string> = {
    "United States": "🇺🇸",
    "Euro Area": "🇪🇺",
    "United Kingdom": "🇬🇧",
    Egypt: "🇪🇬",
    Japan: "🇯🇵",
    China: "🇨🇳",
  };
  return map[country] ?? "🌐";
}
