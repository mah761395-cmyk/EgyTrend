/**
 * Market quote freshness rules for the restored production line.
 *
 * The cached-at timestamp a server remembers is NOT evidence that a price is
 * current: Yahoo kept answering 200 for Egyptian tickers whose last trade was
 * July 2024, and the old UI then showed those values as live. Everything that
 * can be displayed must therefore be judged by the provider's own timestamp.
 *
 * No module here invents a price, a timestamp or a delay: a missing timestamp
 * counts as unusable, and an unknown declared delay stays unknown.
 */

/** Longest age still treated as a CURRENT market price.
 *
 * 72 hours covers a normal weekend plus one public holiday. Anything older is
 * shown only with an explicit "not current" warning carrying its data time.
 */
export const MAX_QUOTE_AGE_MS = 72 * 60 * 60 * 1000;

/** Age beyond which a feed is dead, not merely closed.
 *
 * 30 days cannot be a weekend, a holiday or a suspension: it is a provider that
 * stopped updating the symbol (Yahoo's EGX quotes are frozen at July 2024, two
 * years behind). Such rows are dropped entirely, while rows between the 72h
 * "current" limit and this one are kept but flagged as not current — a market
 * shut for Eid must still show its last close WITH a warning, not vanish. */
export const DEAD_QUOTE_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export type QuoteAgeReason = "ok" | "stale" | "no_timestamp";

export type QuoteAge = {
  /** Age in ms; Infinity when the provider supplied no timestamp. */
  ageMs: number;
  /** True when the value must not be shown as a current price. */
  stale: boolean;
  reason: QuoteAgeReason;
};

/** Judge a quote by the provider's own timestamp (epoch ms). */
export function quoteAge(asOf: unknown, now: number = Date.now()): QuoteAge {
  const ts = Number(asOf);
  if (!Number.isFinite(ts) || ts <= 0) return { ageMs: Infinity, stale: true, reason: "no_timestamp" };
  const ageMs = Math.max(0, now - ts);
  return ageMs > MAX_QUOTE_AGE_MS
    ? { ageMs, stale: true, reason: "stale" }
    : { ageMs, stale: false, reason: "ok" };
}

/** TradingView `update_mode` → declared delay in minutes.
 *
 * `delayed_streaming_900` means the price is 900 seconds behind the exchange.
 * `streaming` is real time. Any other mode (including a plain "delayed" with no
 * number) has an unknown delay, so it is reported as unknown rather than 0.
 */
export function tvDelayMinutes(updateMode: unknown): number | undefined {
  const mode = String(updateMode ?? "").trim();
  if (mode === "streaming") return 0;
  const match = /^delayed_streaming_(\d+)$/.exec(mode);
  if (!match) return undefined;
  const seconds = Number(match[1]);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.round(seconds / 60);
}

/** A delayed feed's data time is the fetch time minus the declared delay. */
export function asOfForDelayedFetch(fetchedAt: number, delayMinutes: number | undefined): number {
  return fetchedAt - (delayMinutes ?? 0) * 60_000;
}

/** A quote so old that its provider has stopped updating it. */
export function isDeadQuote(asOf: unknown, now: number = Date.now()): boolean {
  return quoteAge(asOf, now).ageMs > DEAD_QUOTE_AGE_MS;
}

/** Provider timestamps arrive in epoch SECONDS (TradingView `update_time`).
 *  Milliseconds are accepted too, so a unit change upstream cannot silently
 *  turn a real timestamp into a 1970 one. */
export function providerEpochMs(value: unknown): number | undefined {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n > 1e12 ? n : n * 1000;
}

/** The market time of one row: the provider's own timestamp when it publishes
 *  one, otherwise fetch time minus the delay the feed declares. When neither is
 *  known the result is undefined, and the row is treated as undated. */
export function resolveAsOf(
  providerTime: unknown,
  fetchedAt: number,
  delayMinutes: number | undefined,
): number | undefined {
  const fromProvider = providerEpochMs(providerTime);
  if (fromProvider !== undefined) return fromProvider;
  if (delayMinutes === undefined) return undefined;
  return asOfForDelayedFetch(fetchedAt, delayMinutes);
}

export type FreshnessSplit<T> = { fresh: T[]; rejected: T[] };

/** Split provider rows into displayable and stale ones, using each row's own time. */
export function partitionFreshQuotes<T extends { asOf?: number }>(
  rows: readonly T[],
  now: number = Date.now(),
): FreshnessSplit<T> {
  const fresh: T[] = [];
  const rejected: T[] = [];
  for (const row of rows) (quoteAge(row.asOf, now).stale ? rejected : fresh).push(row);
  return { fresh, rejected };
}

/** Split rows into usable (dated and still maintained) and dead ones.
 *  A usable row may still be older than MAX_QUOTE_AGE_MS; the response's
 *  `fresh` flag turns that into a warning instead of a silent deletion. */
export function partitionUsableQuotes<T extends { asOf?: number }>(
  rows: readonly T[],
  now: number = Date.now(),
): { usable: T[]; rejected: T[] } {
  const usable: T[] = [];
  const rejected: T[] = [];
  for (const row of rows) (isDeadQuote(row.asOf, now) ? rejected : usable).push(row);
  return { usable, rejected };
}

/** Newest provider timestamp across rows, or null when none carried one. */
export function newestAsOf(rows: readonly { asOf?: number }[]): number | null {
  let newest: number | null = null;
  for (const row of rows) {
    const ts = Number(row.asOf);
    if (Number.isFinite(ts) && ts > 0 && (newest === null || ts > newest)) newest = ts;
  }
  return newest;
}
