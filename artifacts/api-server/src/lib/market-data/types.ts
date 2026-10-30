/**
 * Canonical, provider-neutral market-data types.
 *
 * No browser code or provider credential is allowed to depend on these types.
 * A quote is only created after a backend provider has returned a valid value.
 */

export type MarketSection = "eg" | "gl" | "cm" | "cr" | "fx";
export type InstrumentKind =
  | "index"
  | "equity"
  | "fx"
  | "commodity"
  | "crypto";
export type DataFreshness = "real-time" | "delayed" | "end-of-day" | "unknown";
export type ProviderState = "configured" | "not_configured" | "requires_contract";

export type MarketInstrument = {
  /** Stable platform-side identifier. It is never a provider ticker. */
  id: string;
  symbol: string;
  name: string;
  section: MarketSection;
  kind: InstrumentKind;
  subtitle: string;
  /** ISO currency when a single currency is meaningful. */
  currency?: string;
};

export type CanonicalQuote = {
  instrumentId: string;
  price: number;
  previousClose?: number;
  open?: number;
  high?: number;
  low?: number;
  volume?: number;
  change?: number;
  changePercent?: number;
  currency?: string;
  /** Provider timestamp, in epoch milliseconds. */
  asOf: number;
  /**
   * True when the source gives no data timestamp and `asOf` is the server's
   * fetch time (HTML scrape, public scanner). Freshness for such quotes is
   * judged by session state at fetch time, never by wall-clock age.
   */
  sourceAsOfUnknown?: boolean;
  sourceId: string;
  sourceName: string;
  /** The provider's contractual latency. 0 is real-time; undefined is not guessed. */
  delayedMinutes?: number;
  freshness: DataFreshness;
};

export type DailyOhlc = {
  instrumentId: string;
  tradingDate: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
  currency?: string;
  asOf: number;
  sourceId: string;
  sourceName: string;
  delayedMinutes?: number;
  freshness: DataFreshness;
};

export type ProviderDescriptor = {
  id: string;
  name: string;
  state: ProviderState;
  /** Plain operational explanation; never includes a token or endpoint secret. */
  note: string;
  coverage: InstrumentKind[] | ["calendar"];
  externalDisplayConfirmed: boolean;
};

export type ProviderHealth = {
  providerId: string;
  state: ProviderState;
  lastSuccessAt?: number;
  lastFailureAt?: number;
  consecutiveFailures: number;
  /** true only when a configured provider has failed for at least the threshold */
  degraded: boolean;
};

export type ProviderQuoteResult = {
  quotes: CanonicalQuote[];
  /** A successful response with no rows is valid but should not be invented. */
  requestedCount: number;
};

export type CalendarEvent = {
  title: string;
  titleAr?: string;
  at: number;
  country: string;
  countryAr: string;
  flag: string;
  impact: "high" | "medium" | "low" | "unknown";
  forecast?: string;
  previous?: string;
  sourceId: string;
  sourceName: string;
  asOf: number;
  delayedMinutes?: number;
  freshness: DataFreshness;
};

export type ProviderCalendarResult = {
  events: CalendarEvent[];
};

export interface MarketDataProvider {
  readonly id: string;
  readonly name: string;
  descriptor(): ProviderDescriptor;
  canServe(instrument: MarketInstrument): boolean;
  getQuotes(instruments: MarketInstrument[]): Promise<ProviderQuoteResult>;
  getDailyOhlc?(instruments: MarketInstrument[], tradingDate: string): Promise<DailyOhlc[]>;
}

export interface CalendarDataProvider {
  readonly id: string;
  readonly name: string;
  descriptor(): ProviderDescriptor;
  getCalendar(): Promise<ProviderCalendarResult>;
}
