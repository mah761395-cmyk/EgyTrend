import assert from "node:assert/strict";
import test from "node:test";
import { preserveCalendarSuccess } from "./markets";

/* preserveCalendarSuccess is the invariant that keeps the calendar honest:
 * an empty snapshot (source disabled upstream, vendor silent) must never
 * erase the last verified events; those are served instead, marked stale. */

type CalendarPayloadType = NonNullable<Parameters<typeof preserveCalendarSuccess>[0]>;

function event(title: string): CalendarPayloadType["events"][number] {
  return {
    ev: title,
    evEn: title,
    t: "الاثنين 14:30",
    tISO: "2026-10-28T11:30:00.000Z",
    imp: "عالي",
    c: "#ef4444",
    country: "United States",
    countryAr: "الولايات المتحدة",
    flag: "🇺🇸",
    forecast: "3.1%",
    previous: "2.9%",
    source: "Trading Economics",
    fetchedAt: 1_000,
  };
}

const previous: CalendarPayloadType = {
  status: "ok",
  ts: 1_000,
  fetchedAt: 1_000,
  stale: false,
  unavailable: false,
  events: [event("CPI"), event("FOMC")],
  source: "Trading Economics",
};

test("an empty snapshot serves the last verified events, clearly stale", () => {
  const next: CalendarPayloadType = { ...previous, ts: 2_000, fetchedAt: 2_000, stale: false, events: [], source: "غير متاح", reason: "no_configured_provider" };
  const out = preserveCalendarSuccess(previous, next);
  assert.equal(out.events.length, 2);
  assert.equal(out.stale, true, "preserved snapshot must be presented as stale");
  assert.equal(out.unavailable, false);
  assert.equal(out.fetchedAt, 1_000, "the original success time is kept, not the empty fetch time");
  assert.equal(out.reason, undefined, "a preserved success carries no empty-state reason");
});

test("a fresh successful snapshot replaces the previous one", () => {
  const next: CalendarPayloadType = { ...previous, ts: 3_000, fetchedAt: 3_000, stale: false, events: [event("GDP")] };
  const out = preserveCalendarSuccess(previous, next);
  assert.equal(out, next);
  assert.equal(out.stale, false);
  assert.equal(out.events.length, 1);
});

test("the empty payload itself keeps its reason for logging and the UI", () => {
  const next: CalendarPayloadType = { ...previous, ts: 4_000, fetchedAt: 4_000, events: [], source: "غير متاح", reason: "source_empty" };
  const out = preserveCalendarSuccess(previous, next);
  assert.equal(out.events.length, 2, "a prior success is never replaced by an empty one");
  assert.equal(out.stale, true);
  assert.equal(next.reason, "source_empty", "the reason rides on the empty payload for logging/UX");
});
