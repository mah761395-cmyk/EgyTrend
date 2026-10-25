/**
 * Subscription-time helpers.
 *
 * Storage and entitlement arithmetic use UTC instants. Reminder eligibility is
 * deliberately evaluated as a Cairo calendar date through ICU's IANA time-zone
 * data, rather than a fixed +02/+03 offset, so Egypt DST changes cannot shift
 * a reminder to the wrong local day.
 */
export const CAIRO_TIME_ZONE = "Africa/Cairo";
export const DAY_MS = 24 * 60 * 60 * 1000;

export type CairoParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

const cairoPartsFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: CAIRO_TIME_ZONE,
  calendar: "gregory",
  numberingSystem: "latn",
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function numericPart(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): number {
  const value = parts.find((part) => part.type === type)?.value;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`Unable to read Cairo ${type}`);
  return parsed;
}

export function cairoParts(instant: Date): CairoParts {
  if (!Number.isFinite(instant.getTime())) throw new Error("Invalid subscription instant");
  const parts = cairoPartsFormatter.formatToParts(instant);
  return {
    year: numericPart(parts, "year"),
    month: numericPart(parts, "month"),
    day: numericPart(parts, "day"),
    hour: numericPart(parts, "hour"),
    minute: numericPart(parts, "minute"),
    second: numericPart(parts, "second"),
  };
}

/** A stable UTC representation of the Cairo *date*, never an elapsed-time calculation. */
export function cairoCalendarDateEpoch(instant: Date): number {
  const p = cairoParts(instant);
  return Date.UTC(p.year, p.month - 1, p.day);
}

/**
 * Calendar days remaining, e.g. 7 means the end date is seven Cairo dates
 * ahead even across the spring/fall DST change. This is intentional for a
 * once-daily local-date scheduler.
 */
export function cairoCalendarDaysUntil(end: Date, now: Date): number {
  return Math.round((cairoCalendarDateEpoch(end) - cairoCalendarDateEpoch(now)) / DAY_MS);
}

function cairoOffsetMilliseconds(instant: Date): number {
  const p = cairoParts(instant);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - instant.getTime();
}

/**
 * Converts a Cairo wall-clock time to an instant using the runtime's IANA tz
 * database. Iteration resolves ordinary DST changes without an offset table.
 * On the rare skipped local time at a DST transition, the runtime's first
 * valid resolved instant is used; scheduler runs use normal daytime inputs.
 */
export function cairoWallClockToUtc(parts: CairoParts): Date {
  const requestedWallEpoch = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  let epoch = requestedWallEpoch;
  for (let pass = 0; pass < 3; pass += 1) {
    const offset = cairoOffsetMilliseconds(new Date(epoch));
    const resolved = requestedWallEpoch - offset;
    if (resolved === epoch) break;
    epoch = resolved;
  }
  const candidate = new Date(epoch);
  const resolvedParts = cairoParts(candidate);
  const resolvedWallEpoch = Date.UTC(resolvedParts.year, resolvedParts.month - 1, resolvedParts.day, resolvedParts.hour, resolvedParts.minute, resolvedParts.second);
  if (resolvedWallEpoch >= requestedWallEpoch) return candidate;

  /* Egypt's DST jump can skip 00:00. Move to the first valid Cairo wall time
   * after the requested one rather than silently landing on the prior date. */
  for (let minutes = 1; minutes <= 180; minutes += 1) {
    const next = new Date(epoch + minutes * 60_000);
    const p = cairoParts(next);
    const wallEpoch = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    if (wallEpoch >= requestedWallEpoch) return next;
  }
  throw new Error("Unable to resolve Cairo wall-clock time");
}

export function addCairoCalendarDays(instant: Date, days: number): Date {
  if (!Number.isInteger(days)) throw new Error("Grace days must be an integer");
  const p = cairoParts(instant);
  const shifted = new Date(Date.UTC(p.year, p.month - 1, p.day + days, p.hour, p.minute, p.second));
  return cairoWallClockToUtc({
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: p.hour,
    minute: p.minute,
    second: p.second,
  });
}

/** Monthly terms are exactly 30 elapsed 24-hour days. */
export function calculateSubscriptionEnd(base: Date, durationMonths: number): Date {
  if (!Number.isFinite(base.getTime()) || !Number.isInteger(durationMonths) || durationMonths < 1) {
    throw new Error("Invalid subscription duration");
  }
  if (durationMonths === 1) return new Date(base.getTime() + (30 * DAY_MS));

  /* Preserve the existing annual/other plan contract without local timezone mutation. */
  const end = new Date(base.getTime());
  end.setUTCMonth(end.getUTCMonth() + durationMonths);
  return end;
}

export function calculateGraceEnd(expiresAt: Date, graceDays: number): Date | null {
  if (!Number.isInteger(graceDays) || graceDays < 0 || graceDays > 31) throw new Error("Invalid grace period");
  return graceDays === 0 ? null : addCairoCalendarDays(expiresAt, graceDays);
}

export function formatCairoDate(instant: Date): string {
  return new Intl.DateTimeFormat("ar-EG-u-ca-gregory", {
    timeZone: CAIRO_TIME_ZONE,
    calendar: "gregory",
    dateStyle: "full",
  }).format(instant);
}

/** Safely parses a native datetime-local value as Cairo time for admin dry runs. */
export function parseCairoDateTime(value: string): Date | null {
  const text = String(value || "").trim();
  if (!text) return null;
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(text)) {
    const parsed = new Date(text);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  if (!match) return null;
  const [, y, m, d, h, min, sec = "0"] = match;
  const values = [y, m, d, h, min, sec].map(Number);
  if (values.some((number) => !Number.isInteger(number))) return null;
  const [year, month, day, hour, minute, second] = values;
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  const result = cairoWallClockToUtc({ year, month, day, hour, minute, second });
  const roundTrip = cairoParts(result);
  /* Reject typo dates (e.g. 31 February), but allow DST-normalised scheduler dates. */
  if (roundTrip.year !== year || roundTrip.month !== month || roundTrip.day !== day) return null;
  return result;
}
