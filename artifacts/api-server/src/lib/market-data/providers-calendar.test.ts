import assert from "node:assert/strict";
import test from "node:test";
import { MARKET_INSTRUMENTS } from "./catalog";
import { FxProCalendarProvider, YahooChartProvider } from "./providers";

const spx = MARKET_INSTRUMENTS.find((item) => item.id === "index:SPX")!;
const gold = MARKET_INSTRUMENTS.find((item) => item.id === "commodity:XAU")!;

function yahooOhlcPayload(bars: Array<{ day: string; o: number | null; h: number | null; l: number | null; c: number | null; v?: number | null }>) {
  // Yahoo daily bars are timestamped around the market open (13:30Z for US).
  return {
    chart: {
      result: [
        {
          timestamp: bars.map((bar) => Math.floor(Date.parse(`${bar.day}T13:30:00Z`) / 1000)),
          indicators: {
            quote: [
              {
                open: bars.map((bar) => bar.o),
                high: bars.map((bar) => bar.h),
                low: bars.map((bar) => bar.l),
                close: bars.map((bar) => bar.c),
                volume: bars.map((bar) => bar.v ?? null),
              },
            ],
          },
        },
      ],
    },
  };
}

test("Yahoo daily OHLC picks the newest bar dated on or before the snapshot day", async () => {
  const bars = [
    { day: "2026-10-26", o: 100, h: 102, l: 99, c: 101, v: 42 },
    { day: "2026-10-27", o: 101, h: 104, l: 100, c: 103, v: 44 },
    { day: "2026-10-28", o: 103, h: 105, l: 102, c: 104, v: 47 },
  ];
  const provider = new YahooChartProvider({} as NodeJS.ProcessEnv, {
    async getJson<T>(): Promise<T> {
      return yahooOhlcPayload(bars) as T;
    },
  } as never);

  const rows = await provider.getDailyOhlc([spx, gold], "2026-10-28");
  assert.equal(rows.length, 2, "one bar per supported instrument");
  const spxRow = rows.find((row) => row.instrumentId === "index:SPX")!;
  assert.equal(spxRow.tradingDate, "2026-10-28");
  assert.equal(spxRow.open, 103);
  assert.equal(spxRow.high, 105);
  assert.equal(spxRow.low, 102);
  assert.equal(spxRow.close, 104);
  assert.equal(spxRow.volume, 47);
  assert.equal(spxRow.freshness, "end-of-day");
  assert.equal(spxRow.asOf, Date.parse("2026-10-28T13:30:00Z"));

  // A snapshot before the latest bar falls back to the previous day's bar.
  const before = await provider.getDailyOhlc([spx], "2026-10-27");
  assert.equal(before[0]?.tradingDate, "2026-10-27");
  assert.equal(before[0]?.close, 103);
});

test("Yahoo daily OHLC skips bars with missing prices and per-instrument failures", async () => {
  let calls = 0;
  const provider = new YahooChartProvider({} as NodeJS.ProcessEnv, {
    async getJson<T>(_url: string): Promise<T> {
      // First instrument (SPX): a bar with a null close; second (XAU): a hard failure.
      calls += 1;
      if (calls === 1) {
        return {
          chart: {
            result: [
              {
                timestamp: [Math.floor(Date.parse("2026-10-28T13:30:00Z") / 1000)],
                indicators: { quote: [{ open: [103], high: [105], low: [102], close: [null], volume: [null] }] },
              },
            ],
          },
        } as T;
      }
      throw new Error("upstream timeout");
    },
  } as never);

  const rows = await provider.getDailyOhlc([spx, gold], "2026-10-28");
  assert.deepEqual(rows, [], "no partial bar, no crash");
});

/* ── FxPro calendar + CBE schedule ─────────────────────────────────────────── */

const FXPRO_ROWS = [
  {
    title: "FOMC Rate Decision",
    country: "USD",
    date: "2026-10-28T14:00:00-04:00",
    impact: "High",
    forecast: "3.90",
    previous: "4.00",
  },
  {
    title: "Retail Sales m/m",
    country: "EUR",
    date: "2026-11-03T09:00:00+01:00",
    impact: "Medium",
    forecast: "",
    previous: "0.2%",
  },
  {
    title: "Bank Holiday",
    country: "GBP",
    date: "2026-11-01T00:00:00+00:00",
    impact: "Holiday",
  },
  { title: "", country: "USD", date: "not-a-date", impact: "High" }, // must be dropped
];

function fxproHttp(rows: unknown[]): { getJson: (url: string) => Promise<unknown> } {
  return {
    async getJson(_url: string) {
      return rows;
    },
  };
}

/** Freeze Date.now around the start of the 2026 MPC season so the embedded
 * schedule test is deterministic whatever day it runs on. */
function withFrozenNow<T>(iso: string, run: () => Promise<T>): Promise<T> {
  const spy = Date.now;
  (globalThis.Date as { now: () => number }).now = () => Date.parse(iso);
  return run().finally(() => {
    (globalThis.Date as { now: () => number }).now = spy;
  });
}

test("FxPro calendar maps feed rows and merges the CBE 2026 schedule", async () => {
  const provider = new FxProCalendarProvider({}, fxproHttp(FXPRO_ROWS) as never);
  const { events } = await withFrozenNow("2026-02-11T12:00:00Z", async () => provider.getCalendar());

  const fomc = events.find((event) => event.title === "FOMC Rate Decision")!;
  assert.ok(fomc, "FOMC row present");
  assert.equal(fomc.at, Date.parse("2026-10-28T14:00:00-04:00"));
  assert.equal(fomc.country, "USD");
  assert.equal(fomc.countryAr, "الولايات المتحدة");
  assert.equal(fomc.flag, "🇺🇸");
  assert.equal(fomc.impact, "high");
  assert.equal(fomc.forecast, "3.90");

  const holiday = events.find((event) => event.title === "Bank Holiday")!;
  assert.equal(holiday.impact, "low", "holiday impact maps to low");

  assert.ok(!events.some((event) => !event.title), "rows without a title are dropped");

  // The CBE MPC 2026 schedule is merged as high-impact Egyptian events.
  const cbe = events.filter((event) => event.countryAr === "مصر");
  assert.equal(cbe.length, 8, "all eight 2026 MPC meetings");
  const nextMeeting = cbe.find((event) => event.at === Date.parse("2026-10-29T10:30:00Z"));
  assert.ok(nextMeeting, "Oct 29 meeting at 13:30 Cairo (10:30Z while Cairo is UTC+3)");
  assert.equal(nextMeeting?.impact, "high");
  assert.equal(nextMeeting?.flag, "🇪🇬");
  assert.ok(nextMeeting?.titleAr?.includes("البنك المركزي"), "Arabic title for the CBE meeting");
});

test("a missing week is tolerated; the other week still serves the calendar", async () => {
  let calls = 0;
  const provider = new FxProCalendarProvider(
    {},
    {
      async getJson() {
        calls += 1;
        if (calls === 1) throw new Error("this week feed down");
        return FXPRO_ROWS;
      },
    } as never,
  );
  const { events } = await withFrozenNow("2026-02-11T12:00:00Z", async () => provider.getCalendar());
  assert.ok(events.some((event) => event.title === "FOMC Rate Decision"));
  assert.equal(events.filter((event) => event.countryAr === "مصر").length, 8);
});

test("FXPRO_CALENDAR_DISABLED=true turns the whole source off", async () => {
  const provider = new FxProCalendarProvider({ FXPRO_CALENDAR_DISABLED: "true" }, fxproHttp(FXPRO_ROWS) as never);
  assert.equal(provider.descriptor().state, "not_configured");
  assert.deepEqual(await provider.getCalendar(), { events: [] });
});

test("past CBE meetings are not calendar items", async () => {
  const provider = new FxProCalendarProvider({}, fxproHttp([]) as never);
  // Fetched now (before the end of 2026): upcoming meetings are present…
  const nowEvents = (await provider.getCalendar()).events;
  assert.ok(nowEvents.some((event) => event.at === Date.parse("2026-12-17T11:30:00Z")), "Dec 17 meeting at 13:30 Cairo (UTC+2)");

  // …but once the last meeting has passed, the schedule is exhausted.
  const dateNowSpy = Date.now;
  (globalThis.Date as { now: () => number }).now = () => Date.parse("2026-12-18T12:00:00Z");
  try {
    const events = (await provider.getCalendar()).events;
    assert.equal(events.filter((event) => event.countryAr === "مصر").length, 0, "no 2026 meetings remain after the last one");
  } finally {
    (globalThis.Date as { now: () => number }).now = dateNowSpy;
  }
});
