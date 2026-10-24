import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEAD_QUOTE_AGE_MS,
  MAX_QUOTE_AGE_MS,
  asOfForDelayedFetch,
  isDeadQuote,
  newestAsOf,
  partitionFreshQuotes,
  partitionUsableQuotes,
  providerEpochMs,
  quoteAge,
  resolveAsOf,
  tvDelayMinutes,
} from "./market-freshness";

const NOW = Date.UTC(2026, 9, 24, 12, 0, 0);

test("a quote from today is displayable", () => {
  const result = quoteAge(NOW - 5 * 60 * 1000, NOW);
  assert.equal(result.stale, false);
  assert.equal(result.reason, "ok");
  assert.equal(result.ageMs, 5 * 60 * 1000);
});

test("a quote older than the weekend window is stale", () => {
  const result = quoteAge(NOW - MAX_QUOTE_AGE_MS - 1, NOW);
  assert.equal(result.stale, true);
  assert.equal(result.reason, "stale");
});

test("a quote exactly at the limit is still displayable", () => {
  assert.equal(quoteAge(NOW - MAX_QUOTE_AGE_MS, NOW).stale, false);
});

test("the real Yahoo EGX timestamp from July 2024 is rejected", () => {
  /* Yahoo still answers 200 for COMI.CA with this exact regularMarketTime. */
  const yahooEgyLastTrade = Date.UTC(2024, 6, 23, 20, 0, 0);
  const result = quoteAge(yahooEgyLastTrade, NOW);
  assert.equal(result.stale, true);
  assert.equal(result.reason, "stale");
  assert.ok(result.ageMs > 365 * 24 * 60 * 60 * 1000);
});

test("a missing or zero timestamp is never treated as current", () => {
  assert.equal(quoteAge(undefined, NOW).reason, "no_timestamp");
  assert.equal(quoteAge(0, NOW).stale, true);
  assert.equal(quoteAge("not-a-date", NOW).stale, true);
});

test("a future timestamp is not reported as stale forever", () => {
  const result = quoteAge(NOW + 60_000, NOW);
  assert.equal(result.ageMs, 0);
  assert.equal(result.stale, false);
});

test("TradingView delays are read from update_mode, never guessed", () => {
  assert.equal(tvDelayMinutes("delayed_streaming_900"), 15);
  assert.equal(tvDelayMinutes("delayed_streaming_60"), 1);
  assert.equal(tvDelayMinutes("streaming"), 0);
  assert.equal(tvDelayMinutes("delayed"), undefined);
  assert.equal(tvDelayMinutes(undefined), undefined);
});

test("a delayed feed timestamp is fetch time minus the declared delay", () => {
  assert.equal(asOfForDelayedFetch(NOW, 15), NOW - 15 * 60_000);
  assert.equal(asOfForDelayedFetch(NOW, 0), NOW);
  assert.equal(asOfForDelayedFetch(NOW, undefined), NOW);
});

test("stale provider rows are rejected while fresh ones survive", () => {
  const rows = [
    { sym: "COMI", asOf: NOW - 60_000 },
    { sym: "STALE", asOf: Date.UTC(2024, 6, 23) },
    { sym: "NO_TIME" },
  ];
  const { fresh, rejected } = partitionFreshQuotes(rows, NOW);
  assert.deepEqual(fresh.map((row) => row.sym), ["COMI"]);
  assert.deepEqual(rejected.map((row) => row.sym), ["STALE", "NO_TIME"]);
});

test("the newest provider time ignores missing timestamps", () => {
  assert.equal(newestAsOf([{ asOf: NOW - 1000 }, {}, { asOf: NOW }]), NOW);
  assert.equal(newestAsOf([{}, {}]), null);
});

/* ── provider timestamps (TradingView `update_time`) ────────────────────── */

test("provider timestamps in epoch seconds are converted, not guessed", () => {
  assert.equal(providerEpochMs(NOW / 1000), NOW); // seconds → ms
  assert.equal(providerEpochMs(NOW), NOW); // already ms
  assert.equal(providerEpochMs(0), undefined);
  assert.equal(providerEpochMs(null), undefined);
  assert.equal(providerEpochMs("n/a"), undefined);
});

test("the provider's own time wins over fetch-time arithmetic", () => {
  const lastUpdate = NOW - 62 * 60 * 60 * 1000; // Thursday close, fetched Sunday
  assert.equal(resolveAsOf(lastUpdate / 1000, NOW, 15), lastUpdate);
});

test("fetch time minus delay is only a fallback when no provider time exists", () => {
  assert.equal(resolveAsOf(null, NOW, 15), NOW - 15 * 60_000);
  assert.equal(resolveAsOf(null, NOW, 0), NOW);
});

test("no provider time and no declared delay means undated, never fresh", () => {
  assert.equal(resolveAsOf(null, NOW, undefined), undefined);
  assert.equal(isDeadQuote(resolveAsOf(null, NOW, undefined), NOW), true);
});

test("a long market closure is kept with its real time, not called current", () => {
  /* EGX shut for a 5-day holiday: older than the 72h window, far from dead. */
  const lastClose = NOW - 5 * 24 * 60 * 60 * 1000;
  assert.equal(quoteAge(lastClose, NOW).stale, true); // → warning in the payload
  assert.equal(isDeadQuote(lastClose, NOW), false); // → still shown
});

test("a feed that stopped two years ago is dead and dropped", () => {
  const yahooFrozen = Date.UTC(2024, 6, 23, 20, 0, 0);
  assert.equal(isDeadQuote(yahooFrozen, NOW), true);
  assert.ok(DEAD_QUOTE_AGE_MS > MAX_QUOTE_AGE_MS);
});

test("usable rows survive while dead and undated rows are dropped", () => {
  const rows = [
    { sym: "FRESH", asOf: NOW - 60_000 },
    { sym: "CLOSED", asOf: NOW - 5 * 24 * 60 * 60 * 1000 },
    { sym: "DEAD", asOf: Date.UTC(2024, 6, 23) },
    { sym: "NO_TIME" },
  ];
  const { usable, rejected } = partitionUsableQuotes(rows, NOW);
  assert.deepEqual(usable.map((row) => row.sym), ["FRESH", "CLOSED"]);
  assert.deepEqual(rejected.map((row) => row.sym), ["DEAD", "NO_TIME"]);
});
