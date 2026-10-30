import {
  cashBalanceOn,
  round6,
  type CashEventLike,
  type TradeSide,
} from "./portfolio-accounting";

/**
 * Pure portfolio value-over-time builder — the single source of truth for
 * the time-series chart data.
 *
 * Honesty rules (same contract as the live valuation):
 *  - A day's total is only reported when EVERY symbol held that day has a
 *    stored, source-verified daily close. A partial day is drawn as a gap
 *    (value: null), never as a number that never existed.
 *  - Cash is always known (declared starting cash + trades + cash events),
 *    so the series always carries the exact cash line even when no price
 *    history exists yet.
 *  - No price is ever interpolated, carried forward, or estimated from the
 *    current board price. Missing → null + missingSymbols.
 */

export type PortfolioSeriesRange = "1D" | "1W" | "1M" | "3M" | "6M" | "1Y" | "ALL";

export const PORTFOLIO_SERIES_RANGES: readonly PortfolioSeriesRange[] = ["1D", "1W", "1M", "3M", "6M", "1Y", "ALL"];

const RANGE_DAYS: Record<Exclude<PortfolioSeriesRange, "ALL">, number> = {
  "1D": 1,
  "1W": 7,
  "1M": 31,
  "3M": 92,
  "6M": 182,
  "1Y": 365,
};

export function parsePortfolioSeriesRange(value: unknown): PortfolioSeriesRange {
  const candidate = String(value || "1M").toUpperCase();
  return (PORTFOLIO_SERIES_RANGES as readonly string[]).includes(candidate)
    ? (candidate as PortfolioSeriesRange)
    : "1M";
}

/** Inclusive calendar window (YYYY-MM-DD) for a range, ending at `to`. */
export function seriesWindow(range: PortfolioSeriesRange, to: string, earliestActivity: string | null): { from: string; to: string } {
  if (range === "ALL") {
    const floor = "2000-01-01";
    const from = earliestActivity && earliestActivity > floor ? earliestActivity : floor;
    return { from: from < to ? from : to, to };
  }
  const end = Date.parse(`${to}T00:00:00Z`);
  const start = end - RANGE_DAYS[range] * 86_400_000;
  const from = new Date(start).toISOString().slice(0, 10);
  return { from: from < to ? from : to, to };
}

export function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  let cursor = Date.parse(`${from}T00:00:00Z`);
  const last = Date.parse(`${to}T00:00:00Z`);
  for (; cursor <= last; cursor += 86_400_000) {
    out.push(new Date(cursor).toISOString().slice(0, 10));
  }
  return out;
}

type LedgerTrade = { symbol: string; side: TradeSide; quantity: number; price: number; fees: number; tradeDate: string };

export type HeldSymbol = {
  symbol: string;
  /**
   * Shares held as of "now" (ledger-derived). Legacy positions (no trade
   * history) are passed with a constant quantity held since before any
   * window start — documented approximation, they have no dated ledger.
   */
  quantityNow: number;
  legacy: boolean;
};

export type SeriesPoint = {
  date: string;
  /** cash + priced holdings; null while holdings exist without full pricing. */
  value: number | null;
  /** Always finite: declared starting cash + trades + cash events up to the date. */
  cash: number;
  /** Σ heldQty × verified close for the date; null when not fully priced. */
  heldValue: number | null;
  /** Distinct symbols with quantity > 0 on the date. */
  heldSymbols: number;
};

export type PortfolioSeriesResult = {
  range: PortfolioSeriesRange;
  from: string;
  to: string;
  points: SeriesPoint[];
  /** Change between the last two fully-valued points, in %. */
  dailyChangePct: number | null;
  /** Symbols held now that never had a verified close in the window. */
  missingSymbols: string[];
  /** 0..1 share of days with a fully-valued total (1 = no gaps). */
  coverage: number;
  /** "full" = every holding day priced; "partial" = some gaps; "cash-only" = no holdings in window. */
  basis: "full" | "partial" | "cash-only";
  hasPriceHistory: boolean;
};

export type PortfolioSeriesInput = {
  range: PortfolioSeriesRange;
  to: string;
  startingCash: number;
  trades: LedgerTrade[];
  cashEvents: CashEventLike[];
  held: HeldSymbol[];
  /** symbol (upper) → date → verified daily close, from the stored history only. */
  closes: ReadonlyMap<string, ReadonlyMap<string, number>>;
  /** Earliest dated activity (trade or cash event), for the ALL lower bound. */
  earliestActivity: string | null;
};

/**
 * Dated quantity changes of one traded symbol, sorted by date:
 * buy +qty, sell −qty. Non-legacy symbols start at 0.
 */
function quantityDeltas(trades: LedgerTrade[], symbol: string): Array<{ date: string; delta: number }> {
  const deltas: Array<{ date: string; delta: number }> = [];
  for (const trade of trades) {
    if (trade.symbol !== symbol) continue;
    if (trade.side !== "buy" && trade.side !== "sell") continue;
    if (!Number.isFinite(trade.quantity) || trade.quantity <= 0) continue;
    deltas.push({ date: trade.tradeDate, delta: trade.side === "buy" ? trade.quantity : -trade.quantity });
  }
  return deltas.sort((a, b) => a.date.localeCompare(b.date));
}

export function buildPortfolioSeries(input: PortfolioSeriesInput): PortfolioSeriesResult {
  const { range, to, startingCash, trades, cashEvents, held, closes } = input;
  const { from } = seriesWindow(range, to, input.earliestActivity);
  const days = eachDay(from, to);

  /* Pre-compute per-symbol dated deltas once (trades only; legacy symbols
   * hold a constant quantity for the whole window). */
  const deltasBySymbol = new Map<string, Array<{ date: string; delta: number }>>();
  for (const heldSymbol of held) {
    if (heldSymbol.legacy) continue;
    deltasBySymbol.set(heldSymbol.symbol, quantityDeltas(trades, heldSymbol.symbol));
  }

  const points: SeriesPoint[] = [];
  let valuedDays = 0;
  let holdingDays = 0;
  let valuedHoldingDays = 0;
  let lastValue: number | null = null;
  let previousValue: number | null = null;

  for (const day of days) {
    let cash = cashBalanceOn(startingCash, trades, cashEvents, day);
    let heldValue = 0;
    let heldCount = 0;
    let fullyPriced = true;
    let heldAnything = false;

    for (const heldSymbol of held) {
      const symbol = heldSymbol.symbol;
      let qty: number;
      if (heldSymbol.legacy) {
        qty = heldSymbol.quantityNow;
      } else {
        qty = 0;
        for (const delta of deltasBySymbol.get(symbol) || []) {
          if (delta.date <= day) qty += delta.delta;
        }
      }
      if (qty <= 0) continue;
      heldAnything = true;
      heldCount += 1;
      const dayCloses = closes.get(symbol);
      const close = dayCloses ? dayCloses.get(day) : undefined;
      if (typeof close !== "number" || !Number.isFinite(close) || close <= 0) {
        fullyPriced = false;
      } else {
        heldValue += qty * close;
      }
    }

    if (heldAnything) holdingDays += 1;
    if (heldAnything && fullyPriced) {
      heldValue = round6(heldValue);
      const value = round6(cash + heldValue);
      previousValue = lastValue;
      lastValue = value;
      valuedDays += 1;
      valuedHoldingDays += 1;
      points.push({ date: day, value, cash, heldValue, heldSymbols: heldCount });
    } else if (!heldAnything) {
      /* No holdings that day: the portfolio is exactly its cash. */
      previousValue = lastValue;
      lastValue = round6(cash);
      valuedDays += 1;
      points.push({ date: day, value: lastValue, cash, heldValue: null, heldSymbols: 0 });
    } else {
      /* Held without a complete verified price set: honest gap. */
      points.push({ date: day, value: null, cash, heldValue: null, heldSymbols: heldCount });
    }
  }

  /* Daily change from the last two valued points (consecutive or not — the
   * chart's "change" is the change between the two latest known totals). */
  let dailyChangePct: number | null = null;
  if (lastValue !== null && previousValue !== null && previousValue !== 0) {
    dailyChangePct = round6(((lastValue - previousValue) / Math.abs(previousValue)) * 100);
  }

  /* A symbol is "missing" when it has no verified close on ANY day of the
   * window (even if other symbols make some days fully priced). */
  const missingRefined = held
    .filter((heldSymbol) => heldSymbol.quantityNow > 0)
    .filter((heldSymbol) => {
      const dayCloses = closes.get(heldSymbol.symbol);
      if (!dayCloses || dayCloses.size === 0) return true;
      return !days.some((day) => dayCloses.has(day));
    })
    .map((heldSymbol) => heldSymbol.symbol);

  const coverage = days.length > 0 ? valuedDays / days.length : 0;
  const basis: PortfolioSeriesResult["basis"] =
    holdingDays === 0 ? "cash-only" : valuedHoldingDays === holdingDays ? "full" : "partial";
  /* Price history exists when at least one held symbol has a verified close
   * on some day of the window — enough for the client to offer the chart. */
  const hasPriceHistory = held.some((heldSymbol) => {
    const dayCloses = closes.get(heldSymbol.symbol);
    return dayCloses ? days.some((day) => dayCloses.has(day)) : false;
  });

  return {
    range,
    from,
    to,
    points,
    dailyChangePct,
    missingSymbols: missingRefined,
    coverage: round6(coverage),
    basis,
    hasPriceHistory,
  };
}
