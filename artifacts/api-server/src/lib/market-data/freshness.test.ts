import assert from "node:assert/strict";
import test from "node:test";
import {
  CRYPTO_SESSION,
  CMX_SESSION,
  EGX_SESSION,
  US_SESSION,
  classifyQuote,
  lastCloseAt,
  sessionForInstrument,
  sessionOpenAt,
  worstState,
  zonedTimeToEpoch,
} from "./freshness";

/* Fixed instants (UTC). Offsets verified against this runtime's zone data
 * for these exact dates:
 *   Africa/Cairo      2026-10-28 → UTC+3 (Egypt DST ends after Thu 2026-10-29)
 *   Africa/Cairo      2026-10-31 → UTC+2
 *   America/New_York  2026-10-28 → UTC-4 (EDT, ends 2026-11-01)
 *   Europe/Berlin     2026-10-28 → UTC+1 (EU DST ended Sun 2026-10-25)
 *   Europe/London     2026-10-28 → UTC+0  (same) */

/**
 * Wednesday 2026-10-28 19:48Z =
 *  22:48 Cairo (EGX closed at 15:30 Cairo = 12:30Z) ·
 *  15:48 New York EDT (US open) ·
 *  20:48 Berlin CET (XETRA closed at 17:30 = 16:30Z) ·
 *  19:48 London GMT (LSE closed at 16:30 = 16:30Z) ·
 *  19:48 UTC (commodities session open).
 * The exact scenario that used to render "بيانات قديمة" on every card.
 */
const WED_EVENING = Date.parse("2026-10-28T19:48:00Z");
const WED_EGX_CLOSE = Date.parse("2026-10-28T12:30:00Z"); // 15:30 Cairo (UTC+3)
const WED_XETRA_CLOSE = Date.parse("2026-10-28T16:30:00Z"); // 17:30 Berlin (UTC+1)
const WED_LSE_CLOSE = Date.parse("2026-10-28T16:30:00Z"); // 16:30 London (UTC+0)

const XETRA_SESSION = { id: "xetra", tz: "Europe/Berlin", days: [1, 2, 3, 4, 5], openMin: 540, closeMin: 1050 };
const LSE_SESSION = { id: "lse", tz: "Europe/London", days: [1, 2, 3, 4, 5], openMin: 480, closeMin: 990 };

test("session-aware: a closed market showing its final close is not stale", () => {
  // EGX: correct close timestamp -> closed with today's close label.
  const egx = classifyQuote({ asOf: WED_EGX_CLOSE }, EGX_SESSION, WED_EVENING);
  assert.equal(egx.state, "closed");
  assert.equal(egx.labelAr, "إغلاق اليوم 15:30");
  assert.equal(egx.refTime, WED_EGX_CLOSE);

  // Scraped quote with no source timestamp, fetched after the close -> closed.
  const egxScrape = classifyQuote({ asOf: WED_EVENING, sourceAsOfUnknown: true }, EGX_SESSION, WED_EVENING);
  assert.equal(egxScrape.state, "closed");
  assert.equal(egxScrape.refTime, WED_EGX_CLOSE);

  // Same evening: US session open, fresh quote -> live.
  const us = classifyQuote({ asOf: WED_EVENING - 2 * 60_000 }, US_SESSION, WED_EVENING);
  assert.equal(us.state, "live");
  assert.equal(us.labelAr, "مباشر");

  // XETRA and LSE closed with their real close timestamps -> closed (not stale).
  const dax = classifyQuote({ asOf: WED_XETRA_CLOSE }, XETRA_SESSION, WED_EVENING);
  assert.equal(dax.state, "closed");
  assert.equal(dax.labelAr, "إغلاق اليوم 17:30");
  const ftse = classifyQuote({ asOf: WED_LSE_CLOSE }, LSE_SESSION, WED_EVENING);
  assert.equal(ftse.state, "closed");
  assert.equal(ftse.labelAr, "إغلاق اليوم 16:30");

  // Commodities session is open in the UTC evening, fresh quote -> live.
  const gold = classifyQuote({ asOf: WED_EVENING - 5 * 60_000 }, CMX_SESSION, WED_EVENING);
  assert.equal(gold.state, "live");
});

test("session-aware: a quote from an earlier close is stale even after the close", () => {
  const oldClose = Date.parse("2026-10-27T12:30:00Z"); // Tuesday's EGX close
  const egx = classifyQuote({ asOf: oldClose }, EGX_SESSION, WED_EVENING);
  assert.equal(egx.state, "stale");
  assert.equal(egx.labelAr, "بيانات قديمة");

  // Open session with a badly lagging quote -> stale.
  const us = classifyQuote({ asOf: WED_EVENING - 60 * 60_000 }, US_SESSION, WED_EVENING);
  assert.equal(us.state, "stale");
});

test("the EGX weekend keeps the Thursday close as the latest official value", () => {
  // Saturday 2026-10-31 10:00Z (12:00 Cairo): EGX closed since Thursday 12:30Z.
  const SAT = Date.parse("2026-10-31T10:00:00Z");
  const thuClose = Date.parse("2026-10-29T12:30:00Z"); // 15:30 Cairo, still UTC+3
  const egx = classifyQuote({ asOf: thuClose }, EGX_SESSION, SAT);
  assert.equal(egx.state, "closed");
  assert.equal(egx.labelAr, "إغلاق الخميس 15:30");
  assert.equal(egx.refTime, thuClose);

  // Unknown-timestamp scrape across the weekend is still the latest close.
  const scrape = classifyQuote({ asOf: SAT, sourceAsOfUnknown: true }, EGX_SESSION, SAT);
  assert.equal(scrape.state, "closed");
  assert.equal(scrape.refTime, thuClose);

  // US over the same weekend: Friday's close (16:00 EDT = 20:00Z) is the latest.
  const friClose = Date.parse("2026-10-30T20:00:00Z");
  const us = classifyQuote({ asOf: friClose }, US_SESSION, SAT);
  assert.equal(us.state, "closed");
  assert.equal(us.labelAr, "إغلاق الجمعة 16:00");
});

test("delayed feeds get a wider live window; beyond it they are stale", () => {
  const withDelay = classifyQuote(
    { asOf: WED_EVENING - 35 * 60_000, delayedMinutes: 30 },
    US_SESSION,
    WED_EVENING,
  );
  assert.equal(withDelay.state, "live");
  const tooOld = classifyQuote(
    { asOf: WED_EVENING - 40 * 60_000, delayedMinutes: 30 },
    US_SESSION,
    WED_EVENING,
  );
  assert.equal(tooOld.state, "stale");
});

test("a quote arriving a few minutes after the close is the close", () => {
  // 15:35 Cairo (12:35Z on 2026-10-28, UTC+3) = 5 minutes after EGX close.
  const now = Date.parse("2026-10-28T12:35:00Z");
  const result = classifyQuote({ asOf: Date.parse("2026-10-28T12:32:00Z") }, EGX_SESSION, now);
  assert.equal(result.state, "closed");
  assert.equal(result.labelAr, "إغلاق اليوم 15:30");
});

test("session boundaries respect local clocks and DST", () => {
  // 2026-11-01 is a Sunday; Cairo has already fallen back to UTC+2
  // (transition happened after Thu 2026-10-29), so the session runs
  // 08:00Z–13:30Z that day.
  assert.equal(sessionOpenAt(EGX_SESSION, Date.parse("2026-11-01T07:59:00Z")).open, false);
  assert.equal(sessionOpenAt(EGX_SESSION, Date.parse("2026-11-01T08:00:00Z")).open, true);
  assert.equal(sessionOpenAt(EGX_SESSION, Date.parse("2026-11-01T13:30:00Z")).open, false);
  // Friday is closed for EGX.
  assert.equal(sessionOpenAt(EGX_SESSION, Date.parse("2026-10-30T10:00:00Z")).open, false);
  // US: 13:30Z is the open in EDT (summer) and 14:30Z in EST (winter).
  assert.equal(sessionOpenAt(US_SESSION, Date.parse("2026-07-15T13:30:00Z")).open, true);
  assert.equal(sessionOpenAt(US_SESSION, Date.parse("2026-01-15T14:30:00Z")).open, true);
  assert.equal(sessionOpenAt(US_SESSION, Date.parse("2026-07-15T21:00:00Z")).open, false);
});

test("the commodities session ends Friday 17:00Z and restarts Sunday 18:00Z", () => {
  const fri10 = Date.parse("2026-10-30T10:00:00Z");
  const fri17 = Date.parse("2026-10-30T17:00:00Z");
  const fri18 = Date.parse("2026-10-30T18:00:00Z");
  const sat10 = Date.parse("2026-10-31T10:00:00Z");
  const sun1759 = Date.parse("2026-11-01T17:59:00Z");
  const sun18 = Date.parse("2026-11-01T18:00:00Z");
  assert.equal(sessionOpenAt(CMX_SESSION, fri10).open, true);
  assert.equal(sessionOpenAt(CMX_SESSION, fri17).open, false);
  assert.equal(sessionOpenAt(CMX_SESSION, fri18).open, false);
  assert.equal(sessionOpenAt(CMX_SESSION, sat10).open, false);
  assert.equal(sessionOpenAt(CMX_SESSION, sun1759).open, false);
  assert.equal(sessionOpenAt(CMX_SESSION, sun18).open, true);

  // Latest closes: Friday 17:00Z for Saturday and all Sunday before 18:00Z.
  assert.equal(lastCloseAt(CMX_SESSION, sat10), fri17);
  assert.equal(lastCloseAt(CMX_SESSION, sun1759), fri17);

  // Friday 18:00Z (just after close) shows Friday's close, same UTC day.
  const result = classifyQuote({ asOf: fri17, sourceAsOfUnknown: true }, CMX_SESSION, fri18);
  assert.equal(result.state, "closed");
  assert.equal(result.labelAr, "إغلاق اليوم 17:00");
  assert.equal(result.refTime, fri17);

  // Saturday it is no longer "today": the day name appears instead.
  const satResult = classifyQuote({ asOf: fri17, sourceAsOfUnknown: true }, CMX_SESSION, sat10);
  assert.equal(satResult.labelAr, "إغلاق الجمعة 17:00");
});

test("crypto trades 24/7: only a badly lagging quote is stale", () => {
  const fresh = classifyQuote({ asOf: WED_EVENING - 10 * 60_000 }, CRYPTO_SESSION, WED_EVENING);
  assert.equal(fresh.state, "live");
  const lagging = classifyQuote({ asOf: WED_EVENING - 3 * 3_600_000 }, CRYPTO_SESSION, WED_EVENING);
  assert.equal(lagging.state, "stale");
});

test("sessionForInstrument maps ids, and FX is end-of-day by design", () => {
  assert.equal(sessionForInstrument("egx:EGX30")?.id, "egx");
  assert.equal(sessionForInstrument("stock:egx:COMI")?.id, "egx");
  assert.equal(sessionForInstrument("stock:us:AAPL")?.id, "us");
  assert.equal(sessionForInstrument("index:SPX")?.id, "us");
  assert.equal(sessionForInstrument("index:DAX")?.id, "xetra");
  assert.equal(sessionForInstrument("index:FTSE100")?.id, "lse");
  assert.equal(sessionForInstrument("commodity:XAU")?.id, "cmx");
  assert.equal(sessionForInstrument("crypto:BTC")?.id, "crypto");
  assert.equal(sessionForInstrument("fx:USD-EGP"), undefined);
});

test("zonedTimeToEpoch follows each zone's own DST rules", () => {
  // Cairo: UTC+3 on 2026-10-29 (DST day), UTC+2 in January.
  assert.equal(zonedTimeToEpoch("Africa/Cairo", 2026, 10, 29, 13 * 60 + 30), Date.parse("2026-10-29T10:30:00Z"));
  assert.equal(zonedTimeToEpoch("Africa/Cairo", 2026, 1, 15, 13 * 60 + 30), Date.parse("2026-01-15T11:30:00Z"));
  // New York: 09:30 is 14:30Z in EST (January) and 13:30Z in EDT (July).
  assert.equal(zonedTimeToEpoch("America/New_York", 2026, 1, 15, 9 * 60 + 30), Date.parse("2026-01-15T14:30:00Z"));
  assert.equal(zonedTimeToEpoch("America/New_York", 2026, 7, 15, 9 * 60 + 30), Date.parse("2026-07-15T13:30:00Z"));
});

test("worstState: stale beats closed beats live", () => {
  assert.equal(worstState(["live", "closed"]), "closed");
  assert.equal(worstState(["live", "stale", "closed"]), "stale");
  assert.equal(worstState(["live"]), "live");
  assert.equal(worstState([undefined]), "live");
});
