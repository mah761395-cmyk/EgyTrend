/**
 * Session-aware freshness classification for display quotes.
 *
 * A quote fetched after the session closed is not "stale": it is the last
 * official value of the most recent session. The previous wall-clock rule
 * (source timestamp older than a fixed window => stale) made every
 * index/commodity card show "بيانات قديمة" from the moment its session
 * closed until the next open — even though the displayed number was the
 * correct, final closing value.
 *
 * This module classifies each quote against the actual session calendar:
 *
 *   live   — the session is open and the quote is within its allowed lag
 *   closed — the session is closed and the quote belongs to the most recent
 *            session close (the final value of that session)
 *   stale  — the quote predates the most recent close, or lags badly inside
 *            an open session
 *
 * Sessions are defined in IANA time zones via Intl, so US/EU daylight
 * savings are handled automatically. The CME Globex commodities session is
 * approximated as 24/5 with a daily 17:00–18:00 UTC pause; crypto is 24/7.
 * These are display-label approximations, never trading feeds.
 */

import type { MarketInstrument } from "./types";

export type QuoteState = "live" | "closed" | "stale";

export type SessionDef = {
  id: string;
  tz: string;
  /** Local weekdays on which the session trades: 0=Sunday … 6=Saturday. */
  days: number[];
  /** Local minutes after midnight. */
  openMin: number;
  closeMin: number;
};

/** EGX regular session, Sunday–Thursday (the site's stated 10:00–15:30). */
export const EGX_SESSION: SessionDef = {
  id: "egx",
  tz: "Africa/Cairo",
  days: [0, 1, 2, 3, 4],
  openMin: 10 * 60,
  closeMin: 15 * 60 + 30,
};

export const US_SESSION: SessionDef = {
  id: "us",
  tz: "America/New_York",
  days: [1, 2, 3, 4, 5],
  openMin: 9 * 60 + 30,
  closeMin: 16 * 60,
};

export const XETRA_SESSION: SessionDef = {
  id: "xetra",
  tz: "Europe/Berlin",
  days: [1, 2, 3, 4, 5],
  openMin: 9 * 60,
  closeMin: 17 * 60 + 30,
};

export const LSE_SESSION: SessionDef = {
  id: "lse",
  tz: "Europe/London",
  days: [1, 2, 3, 4, 5],
  openMin: 8 * 60,
  closeMin: 16 * 60 + 30,
};

/**
 * CME Globex approximated: a session opens Sunday–Thursday 18:00 UTC and
 * closes the next day 17:00 UTC (so the last session of the week ends
 * Friday 17:00 UTC). For a midnight-crossing session `days` lists the days
 * on which the session OPENS, not the days it is merely trading.
 */
export const CMX_SESSION: SessionDef = {
  id: "cmx",
  tz: "UTC",
  days: [0, 1, 2, 3, 4],
  openMin: 18 * 60,
  closeMin: 17 * 60,
};

export const CRYPTO_SESSION: SessionDef = {
  id: "crypto",
  tz: "UTC",
  days: [0, 1, 2, 3, 4, 5, 6],
  openMin: 0,
  closeMin: 24 * 60,
};

export type ClassifyInput = {
  asOf: number;
  /**
   * True when the source gives no data timestamp and `asOf` is the server's
   * fetch time (HTML scrape, scanner). The freshness of such a quote is the
   * session state at fetch time — never a wall-clock age judgement.
   */
  sourceAsOfUnknown?: boolean;
  delayedMinutes?: number;
};

export type ClassifyResult = {
  state: QuoteState;
  /** Arabic display label, e.g. "مباشر" / "إغلاق اليوم 15:30" / "بيانات قديمة". */
  labelAr: string;
  /** The session boundary the value refers to (close time), epoch ms. */
  refTime?: number;
};

const LIVE_TOLERANCE_MS = 15 * 60_000;
const CLOSE_WINDOW_BEFORE_MS = 45 * 60_000;
const FUTURE_SKEW_MS = 10 * 60_000;

const DOW_AR = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
const DOW_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

type ZonedParts = { y: number; m: number; d: number; dow: number; minutes: number };

const formatCache = new Map<string, Intl.DateTimeFormat>();

function zonedParts(tz: string, ms: number): ZonedParts {
  let fmt = formatCache.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatCache.set(tz, fmt);
  }
  const parts: Record<string, string> = {};
  for (const part of fmt.formatToParts(ms)) parts[part.type] = part.value;
  const dow = DOW_EN.indexOf(parts.weekday ?? "");
  return {
    y: Number(parts.year),
    m: Number(parts.month),
    d: Number(parts.day),
    dow: dow < 0 ? 0 : dow,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

/**
 * Epoch ms of a wall-clock time (local year/month/day + minutes) in `tz`.
 * Iterates the UTC guess against the zone's own offset; converges in a few
 * steps and is DST-safe for ordinary inputs.
 */
export function zonedTimeToEpoch(tz: string, y: number, m: number, d: number, minutes: number): number {
  const target = Date.UTC(y, m - 1, d, 0, 0) + minutes * 60_000;
  let guess = target;
  for (let i = 0; i < 4; i++) {
    const p = zonedParts(tz, guess);
    const wallNow = Date.UTC(p.y, p.m - 1, p.d, 0, 0) + p.minutes * 60_000;
    const delta = target - wallNow;
    guess += delta;
    if (delta === 0) break;
  }
  return guess;
}

export type SessionStatus = {
  open: boolean;
  start?: number;
  end?: number;
};

export function sessionOpenAt(def: SessionDef, ms: number): SessionStatus {
  const p = zonedParts(def.tz, ms);
  const sameDay = (minutes: number) => zonedTimeToEpoch(def.tz, p.y, p.m, p.d, minutes);
  if (def.closeMin > def.openMin) {
    if (!def.days.includes(p.dow)) return { open: false };
    if (p.minutes >= def.openMin && p.minutes < def.closeMin) {
      return { open: true, start: sameDay(def.openMin), end: sameDay(def.closeMin) };
    }
    return { open: false };
  }
  // Session crosses midnight (commodities): it must have opened this
  // `days` entry, or it is the early-morning tail of a session opened by
  // the previous `days` entry.
  if (def.days.includes(p.dow) && p.minutes >= def.openMin) {
    return {
      open: true,
      start: sameDay(def.openMin),
      end: zonedTimeToEpoch(def.tz, p.y, p.m, p.d + 1, def.closeMin),
    };
  }
  const prevDow = (p.dow + 6) % 7;
  if (def.days.includes(prevDow) && p.minutes < def.closeMin) {
    return {
      open: true,
      start: zonedTimeToEpoch(def.tz, p.y, p.m, p.d - 1, def.openMin),
      end: sameDay(def.closeMin),
    };
  }
  return { open: false };
}

/**
 * The most recent session close at or before `ms`. Walks local calendar
 * days backwards (bounded) and returns the close boundary of the last
 * trading day.
 */
export function lastCloseAt(def: SessionDef, ms: number): number | undefined {
  for (let i = 0; i < 14; i++) {
    const p = zonedParts(def.tz, ms - i * 86_400_000);
    if (!def.days.includes(p.dow)) continue;
    // A normal session closes on its own day; a midnight-crossing one
    // (commodities) opened on p.d closes on p.d + 1.
    const close = def.closeMin > def.openMin
      ? zonedTimeToEpoch(def.tz, p.y, p.m, p.d, def.closeMin)
      : zonedTimeToEpoch(def.tz, p.y, p.m, p.d + 1, def.closeMin);
    if (close <= ms + 2 * 60_000) return close;
  }
  return undefined;
}

function closeLabel(lc: number, now: number, def: SessionDef): string {
  const p = zonedParts(def.tz, lc);
  const n = zonedParts(def.tz, now);
  const hhmm = `${String(Math.floor(p.minutes / 60)).padStart(2, "0")}:${String(p.minutes % 60).padStart(2, "0")}`;
  const sameLocalDay = p.y === n.y && p.m === n.m && p.d === n.d;
  return sameLocalDay ? `إغلاق اليوم ${hhmm}` : `إغلاق ${DOW_AR[p.dow]} ${hhmm}`;
}

/**
 * Classify one quote against a session. Pure function of its inputs plus
 * `now` so tests can freeze the clock.
 */
export function classifyQuote(input: ClassifyInput, def: SessionDef, now: number): ClassifyResult {
  const { asOf } = input;

  if (input.sourceAsOfUnknown) {
    /* The quote arrived with the fetch: its value is whatever the source
     * last published, i.e. the latest close whenever the session is closed
     * (no wall-clock age applies across an ordinary weekend). */
    const status = sessionOpenAt(def, now);
    if (status.open) return { state: "live", labelAr: "مباشر" };
    const lc = lastCloseAt(def, now);
    if (lc !== undefined) {
      return { state: "closed", labelAr: closeLabel(lc, now, def), refTime: lc };
    }
    return { state: "stale", labelAr: "بيانات قديمة" };
  }

  const status = sessionOpenAt(def, now);
  if (status.open) {
    const tolerance = Math.max(LIVE_TOLERANCE_MS, (input.delayedMinutes ?? 0) * 60_000 + 5 * 60_000);
    if (asOf <= now + tolerance && asOf >= now - tolerance) {
      return { state: "live", labelAr: "مباشر" };
    }
    return { state: "stale", labelAr: "بيانات قديمة" };
  }

  /* Closed session: the quote is the latest close unless a newer close
   * postdates it — true across weekends and daily pauses alike. */
  const lc = lastCloseAt(def, now);
  if (lc !== undefined && asOf >= lc - CLOSE_WINDOW_BEFORE_MS && asOf <= now + FUTURE_SKEW_MS) {
    return { state: "closed", labelAr: closeLabel(lc, now, def), refTime: lc };
  }
  return { state: "stale", labelAr: "بيانات قديمة" };
}

/**
 * The session an instrument belongs to, or undefined for end-of-day
 * references (FX daily table) which the caller labels separately.
 * Accepts a catalog entry or just its canonical id (stock lists only carry
 * ids to the display layer).
 */
export function sessionForInstrument(instrument: MarketInstrument | string): SessionDef | undefined {
  const id = typeof instrument === "string" ? instrument : instrument.id;
  if (id.startsWith("fx:")) return undefined;
  if (id.startsWith("egx:") || id.startsWith("stock:egx:")) return EGX_SESSION;
  if (id === "index:SPX" || id === "index:NASDAQ" || id.startsWith("stock:us:")) return US_SESSION;
  if (id === "index:DAX") return XETRA_SESSION;
  if (id === "index:FTSE100") return LSE_SESSION;
  if (id.startsWith("commodity:")) return CMX_SESSION;
  if (id.startsWith("crypto:")) return CRYPTO_SESSION;
  if (typeof instrument === "object" && instrument.section === "gl" && instrument.kind === "equity") {
    return US_SESSION;
  }
  return undefined;
}

/** Worst-case state across rows: stale beats closed beats live. */
export function worstState(states: ReadonlyArray<QuoteState | undefined>): QuoteState {
  if (states.some((s) => s === "stale")) return "stale";
  if (states.some((s) => s === "closed")) return "closed";
  return "live";
}
