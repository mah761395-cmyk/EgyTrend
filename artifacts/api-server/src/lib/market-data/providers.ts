import { ResilientHttpClient } from "./http";
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
  const number = typeof value === "number" ? value : Number(String(value ?? "").replace(/,/g, ""));
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
 * Twelve Data adapter. It cannot make a request unless BOTH an API key and an
 * operator acknowledgement of the customer-facing display license are set.
 * Symbols are supplied through a JSON mapping after the selected plan/exchange
 * agreement is known; this avoids guessing exchange tickers or coverage.
 */
export class TwelveDataProvider implements MarketDataProvider {
  readonly id = "twelve-data";
  readonly name = "Twelve Data";
  private readonly apiKey: string;
  private readonly displayLicensed: boolean;
  private readonly symbols: Record<string, string>;
  private readonly delayedMinutes?: number;

  constructor(
    env: NodeJS.ProcessEnv = process.env,
    private readonly http = new ResilientHttpClient(),
  ) {
    this.apiKey = (env["TWELVE_DATA_API_KEY"] || "").trim();
    this.displayLicensed = env["TWELVE_DATA_EXTERNAL_DISPLAY_LICENSED"] === "true";
    this.delayedMinutes = optionalDelay(env["TWELVE_DATA_DELAY_MINUTES"]);
    this.symbols = parseSymbolMap(env["TWELVE_DATA_SYMBOLS_JSON"]);
  }

  descriptor(): ProviderDescriptor {
    const configured = Boolean(this.apiKey && this.displayLicensed);
    return {
      id: this.id,
      name: this.name,
      state: configured ? "configured" : "not_configured",
      note: configured
        ? "مُفعّل بعد تأكيد المشغّل لحقوق العرض الخارجي؛ التغطية الفعلية تحددها خريطة الرموز والعقد."
        : "لا يُستدعى قبل وجود مفتاح وخطاب/عقد يجيز العرض الخارجي للمشتركين.",
      coverage: ["index", "equity", "fx", "commodity", "crypto"],
      externalDisplayConfirmed: configured,
    };
  }

  canServe(instrument: MarketInstrument): boolean {
    return Boolean(this.apiKey && this.displayLicensed && this.symbols[instrument.id]);
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
    "crypto:SOL": "solana",
    "crypto:XRP": "ripple",
  };
  return ids[instrument.id];
}

function normalizeImpact(value: unknown): "high" | "medium" | "low" | "unknown" {
  const normalized = String(value ?? "").toLowerCase();
  if (/high|3/.test(normalized)) return "high";
  if (/medium|2/.test(normalized)) return "medium";
  if (/low|1/.test(normalized)) return "low";
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
