import crypto from "node:crypto";
import { and, asc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { MARKET_INSTRUMENTS } from "./catalog";
import { getMarketDataService, type MarketDataService } from "./service";
import type { DailyOhlc } from "./types";

/** Storage contract used by the opt-in snapshot job. */
export interface MarketHistoryRepository {
  upsert(rows: DailyOhlc[]): Promise<number>;
}

/** A normalized row read from the licensed, persisted daily-history store. */
export type StoredMarketOhlc = {
  instrumentId: string;
  sourceId: string;
  sourceName: string;
  tradingDate: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number | null;
  currency?: string | null;
  delayedMinutes?: number | null;
  asOf: Date;
};

/** Read contract keeps endpoint logic testable without a real database. */
export interface MarketHistoryReadRepository {
  list(instrumentIds: string[], fromDate?: string): Promise<StoredMarketOhlc[]>;
}

export class DrizzleMarketHistoryRepository implements MarketHistoryRepository {
  async upsert(rows: DailyOhlc[]): Promise<number> {
    /* Dynamic import keeps pure provider/cache tests independent of a database
     * connection. The real job resolves the workspace DB only after explicit
     * write opt-in. */
    const { db, marketDailyOhlcTable } = await import("@workspace/db");
    let written = 0;
    for (const row of rows) {
      // Guard provider/parser failures before an invalid value reaches history.
      if (![row.open, row.high, row.low, row.close].every((value) => Number.isFinite(value))) continue;
      const id = stableHistoryId(row);
      await db.insert(marketDailyOhlcTable).values({
        id,
        instrumentId: row.instrumentId,
        sourceId: row.sourceId,
        sourceName: row.sourceName,
        tradingDate: row.tradingDate,
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
        volume: row.volume,
        currency: row.currency,
        delayedMinutes: row.delayedMinutes,
        asOf: new Date(row.asOf),
      }).onConflictDoUpdate({
        target: [
          marketDailyOhlcTable.sourceId,
          marketDailyOhlcTable.instrumentId,
          marketDailyOhlcTable.tradingDate,
        ],
        set: {
          open: row.open,
          high: row.high,
          low: row.low,
          close: row.close,
          volume: row.volume,
          currency: row.currency,
          delayedMinutes: row.delayedMinutes,
          asOf: new Date(row.asOf),
          updatedAt: sql`now()`,
        },
      });
      written++;
    }
    return written;
  }
}

/** Database adapter for history reads. It is deliberately lazy, read-only and
 * has no provider/network behavior: charts must only render persisted bars. */
const MAX_HISTORY_ROWS_PER_INSTRUMENT = 5_000;

export class DrizzleMarketHistoryReadRepository implements MarketHistoryReadRepository {
  async list(instrumentIds: string[], fromDate?: string): Promise<StoredMarketOhlc[]> {
    if (!instrumentIds.length) return [];
    const { db, marketDailyOhlcTable } = await import("@workspace/db");
    const condition = fromDate
      ? and(inArray(marketDailyOhlcTable.instrumentId, instrumentIds), gte(marketDailyOhlcTable.tradingDate, fromDate))
      : inArray(marketDailyOhlcTable.instrumentId, instrumentIds);

    /* `ALL` must never be capped by the oldest rows. Rank descending *within
     * each instrument*, retain that instrument's most recent bounded window,
     * then return it in chronological order for chart rendering. A global
     * .limit(5000) ordered ascending would silently hide current candles once
     * an asset passed five thousand stored days (and would bias batch
     * sparklines toward the first instrument alphabetically). */
    const ranked = db.$with("market_history_recent").as(
      db.select({
        instrumentId: marketDailyOhlcTable.instrumentId,
        sourceId: marketDailyOhlcTable.sourceId,
        sourceName: marketDailyOhlcTable.sourceName,
        tradingDate: marketDailyOhlcTable.tradingDate,
        open: marketDailyOhlcTable.open,
        high: marketDailyOhlcTable.high,
        low: marketDailyOhlcTable.low,
        close: marketDailyOhlcTable.close,
        volume: marketDailyOhlcTable.volume,
        currency: marketDailyOhlcTable.currency,
        delayedMinutes: marketDailyOhlcTable.delayedMinutes,
        asOf: marketDailyOhlcTable.asOf,
        rowNumber: sql<number>`row_number() over (
          partition by ${marketDailyOhlcTable.instrumentId}
          order by ${marketDailyOhlcTable.tradingDate} desc
        )`.as("row_number"),
      }).from(marketDailyOhlcTable).where(condition),
    );
    return db.with(ranked).select({
      instrumentId: ranked.instrumentId,
      sourceId: ranked.sourceId,
      sourceName: ranked.sourceName,
      tradingDate: ranked.tradingDate,
      open: ranked.open,
      high: ranked.high,
      low: ranked.low,
      close: ranked.close,
      volume: ranked.volume,
      currency: ranked.currency,
      delayedMinutes: ranked.delayedMinutes,
      asOf: ranked.asOf,
    }).from(ranked)
      .where(lte(ranked.rowNumber, MAX_HISTORY_ROWS_PER_INSTRUMENT))
      .orderBy(asc(ranked.instrumentId), asc(ranked.tradingDate));
  }
}

export type HistoryRange = "1D" | "1W" | "1M" | "3M" | "1Y" | "ALL";

const RANGE_DAYS: Record<Exclude<HistoryRange, "ALL">, number> = {
  "1D": 1,
  "1W": 7,
  "1M": 31,
  "3M": 92,
  "1Y": 366,
};

export function parseHistoryRange(value: unknown): HistoryRange {
  const candidate = String(value || "1M").toUpperCase();
  return candidate === "1D" || candidate === "1W" || candidate === "1M"
    || candidate === "3M" || candidate === "1Y" || candidate === "ALL"
    ? candidate
    : "1M";
}

export type ChartBar = {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
};

export type ChartIndicatorPoint = { time: string; value: number };
export type ChartIndicators = {
  movingAverage20: ChartIndicatorPoint[];
  rsi14: ChartIndicatorPoint[];
};

export type MarketHistorySnapshot = {
  instrumentId: string;
  range: HistoryRange;
  /** `daily` makes clear that this is EOD history, not an invented intraday feed. */
  interval: "1d";
  available: boolean;
  reason?: "no_history" | "insufficient_history";
  points: ChartBar[];
  source?: { id: string; name: string; delayedMinutes?: number; asOf: number };
  currency?: string;
  indicators?: ChartIndicators;
  indicatorRequirements: { movingAverage20: number; rsi14: number };
};

export type MarketSparkline = {
  instrumentId: string;
  available: boolean;
  points: Array<{ time: string; close: number }>;
  source?: { id: string; name: string; delayedMinutes?: number; asOf: number };
};

/**
 * Select exactly one provider source per instrument. Combining bars from two
 * vendors can create a visually plausible but false candle series, so it is
 * forbidden even when both sources are licensed.
 */
function selectOneSource(rows: StoredMarketOhlc[], allowedSourceIds?: ReadonlySet<string>): StoredMarketOhlc[] {
  const stats = new Map<string, { count: number; latest: number }>();
  for (const row of rows) {
    if (allowedSourceIds && !allowedSourceIds.has(row.sourceId)) continue;
    if (!isUsableStoredRow(row)) continue;
    const current = stats.get(row.sourceId) ?? { count: 0, latest: 0 };
    current.count++;
    current.latest = Math.max(current.latest, row.asOf.getTime());
    stats.set(row.sourceId, current);
  }
  const sourceId = [...stats.entries()]
    .sort((a, b) => b[1].count - a[1].count || b[1].latest - a[1].latest || a[0].localeCompare(b[0]))[0]?.[0];
  if (!sourceId) return [];
  return rows.filter((row) => row.sourceId === sourceId && isUsableStoredRow(row))
    .sort((a, b) => a.tradingDate.localeCompare(b.tradingDate));
}

function isUsableStoredRow(row: StoredMarketOhlc): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(row.tradingDate)) return false;
  if (![row.open, row.high, row.low, row.close].every((value) => Number.isFinite(value) && value > 0)) return false;
  if (row.high < Math.max(row.open, row.close) || row.low > Math.min(row.open, row.close) || row.low > row.high) return false;
  return Number.isFinite(row.asOf.getTime()) && Boolean(row.sourceId) && Boolean(row.sourceName);
}

function rowsToBars(rows: StoredMarketOhlc[]): ChartBar[] {
  const uniqueDates = new Set<string>();
  return rows.flatMap((row) => {
    // Duplicate daily bars from a malformed import are rejected rather than
    // silently rendering two candles with the same date.
    if (uniqueDates.has(row.tradingDate)) return [];
    uniqueDates.add(row.tradingDate);
    return [{
      time: row.tradingDate,
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      ...(typeof row.volume === "number" && Number.isFinite(row.volume) && row.volume >= 0 ? { volume: row.volume } : {}),
    }];
  });
}

function sourceMeta(rows: StoredMarketOhlc[]): MarketHistorySnapshot["source"] | undefined {
  const latest = [...rows].sort((a, b) => b.asOf.getTime() - a.asOf.getTime())[0];
  if (!latest) return undefined;
  return {
    id: latest.sourceId,
    name: latest.sourceName,
    ...(typeof latest.delayedMinutes === "number" && latest.delayedMinutes >= 0 ? { delayedMinutes: latest.delayedMinutes } : {}),
    asOf: latest.asOf.getTime(),
  };
}

/** Pure indicator calculations over source-backed closes; no price is inferred. */
export function simpleMovingAverage(points: ChartBar[], period = 20): ChartIndicatorPoint[] {
  if (!Number.isInteger(period) || period < 2 || points.length < period) return [];
  const output: ChartIndicatorPoint[] = [];
  let sum = 0;
  for (let index = 0; index < points.length; index++) {
    sum += points[index]!.close;
    if (index >= period) sum -= points[index - period]!.close;
    if (index >= period - 1) output.push({ time: points[index]!.time, value: sum / period });
  }
  return output;
}

/** Wilder RSI. The first value needs `period + 1` real closes, never a fill. */
export function relativeStrengthIndex(points: ChartBar[], period = 14): ChartIndicatorPoint[] {
  if (!Number.isInteger(period) || period < 2 || points.length <= period) return [];
  let gains = 0;
  let losses = 0;
  for (let index = 1; index <= period; index++) {
    const change = points[index]!.close - points[index - 1]!.close;
    gains += Math.max(change, 0);
    losses += Math.max(-change, 0);
  }
  let averageGain = gains / period;
  let averageLoss = losses / period;
  const output: ChartIndicatorPoint[] = [{ time: points[period]!.time, value: rsiValue(averageGain, averageLoss) }];
  for (let index = period + 1; index < points.length; index++) {
    const change = points[index]!.close - points[index - 1]!.close;
    averageGain = ((averageGain * (period - 1)) + Math.max(change, 0)) / period;
    averageLoss = ((averageLoss * (period - 1)) + Math.max(-change, 0)) / period;
    output.push({ time: points[index]!.time, value: rsiValue(averageGain, averageLoss) });
  }
  return output;
}

function rsiValue(averageGain: number, averageLoss: number): number {
  if (averageLoss === 0) return 100;
  if (averageGain === 0) return 0;
  return 100 - (100 / (1 + (averageGain / averageLoss)));
}

export function historySnapshotFromRows(options: {
  instrumentId: string;
  range: HistoryRange;
  rows: StoredMarketOhlc[];
  includeIndicators?: boolean;
  /** Current commercial-display approval gate, supplied by the HTTP layer. */
  allowedSourceIds?: ReadonlySet<string>;
}): MarketHistorySnapshot {
  const rows = selectOneSource(options.rows, options.allowedSourceIds);
  const points = rowsToBars(rows);
  const base: MarketHistorySnapshot = {
    instrumentId: options.instrumentId,
    range: options.range,
    interval: "1d",
    available: points.length >= 2,
    ...(points.length === 0 ? { reason: "no_history" as const } : points.length < 2 ? { reason: "insufficient_history" as const } : {}),
    points,
    ...(sourceMeta(rows) ? { source: sourceMeta(rows) } : {}),
    ...(rows[0]?.currency ? { currency: rows[0].currency } : {}),
    indicatorRequirements: { movingAverage20: 20, rsi14: 15 },
  };
  if (options.includeIndicators && points.length) {
    base.indicators = {
      movingAverage20: simpleMovingAverage(points, 20),
      rsi14: relativeStrengthIndex(points, 14),
    };
  }
  return base;
}

/* Test seam: pg-mem cannot run the repository's ranked window-function
 * query, so in-process tests register a plain-select equivalent (same
 * contract, same data). Production always uses the Drizzle repository. */
let testReadRepository: MarketHistoryReadRepository | null = null;
export function setMarketHistoryReadRepositoryForTest(repository: MarketHistoryReadRepository | null): void {
  testReadRepository = repository;
}

export async function getMarketHistorySnapshot(options: {
  instrumentId: string;
  range?: HistoryRange;
  repository?: MarketHistoryReadRepository;
  now?: Date;
  includeIndicators?: boolean;
  allowedSourceIds?: ReadonlySet<string>;
}): Promise<MarketHistorySnapshot> {
  const range = options.range ?? "1M";
  // An explicit empty approval set means no current redistribution right. Do
  // not even query old rows: historical storage must not outlive its license.
  if (options.allowedSourceIds && options.allowedSourceIds.size === 0) {
    return historySnapshotFromRows({ instrumentId: options.instrumentId, range, rows: [], includeIndicators: options.includeIndicators, allowedSourceIds: options.allowedSourceIds });
  }
  const repository = options.repository ?? testReadRepository ?? new DrizzleMarketHistoryReadRepository();
  const rows = await repository.list([options.instrumentId], historyStartDate(range, options.now));
  return historySnapshotFromRows({
    instrumentId: options.instrumentId,
    range,
    rows,
    includeIndicators: options.includeIndicators,
    allowedSourceIds: options.allowedSourceIds,
  });
}

/** Batch read for list sparklines. One query, no provider calls, max data by caller. */
export async function getMarketSparklines(options: {
  instrumentIds: string[];
  repository?: MarketHistoryReadRepository;
  now?: Date;
  days?: number;
  allowedSourceIds?: ReadonlySet<string>;
}): Promise<MarketSparkline[]> {
  const ids = [...new Set(options.instrumentIds)].slice(0, 64);
  if (!ids.length) return [];
  if (options.allowedSourceIds && options.allowedSourceIds.size === 0) {
    return ids.map((instrumentId) => ({ instrumentId, available: false, points: [] }));
  }
  const repository = options.repository ?? testReadRepository ?? new DrizzleMarketHistoryReadRepository();
  const days = Math.max(7, Math.min(180, Math.floor(options.days ?? 31)));
  const fromDate = historyStartDateForDays(days, options.now);
  const rows = await repository.list(ids, fromDate);
  const grouped = new Map<string, StoredMarketOhlc[]>();
  for (const row of rows) {
    const list = grouped.get(row.instrumentId) ?? [];
    list.push(row);
    grouped.set(row.instrumentId, list);
  }
  return ids.map((instrumentId) => {
    const sourceRows = selectOneSource(grouped.get(instrumentId) ?? [], options.allowedSourceIds);
    const points = rowsToBars(sourceRows).map(({ time, close }) => ({ time, close }));
    return {
      instrumentId,
      available: points.length >= 2,
      points,
      ...(sourceMeta(sourceRows) ? { source: sourceMeta(sourceRows) } : {}),
    };
  });
}

function historyStartDate(range: HistoryRange, now = new Date()): string | undefined {
  if (range === "ALL") return undefined;
  return historyStartDateForDays(RANGE_DAYS[range], now);
}

function historyStartDateForDays(days: number, now = new Date()): string {
  const date = new Date(now);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

export type SnapshotJobResult = {
  status: "skipped" | "ok";
  reason?: string;
  tradingDate?: string;
  fetched: number;
  written: number;
};

/**
 * The schedule invokes this only after explicit opt-in. It is idempotent by
 * (source, instrument, trading date), so a retry safely corrects a provider's
 * daily-bar revision rather than making duplicate rows.
 */
export async function runMarketDailySnapshot(options: {
  env?: NodeJS.ProcessEnv;
  service?: MarketDataService;
  repository?: MarketHistoryRepository;
  now?: Date;
} = {}): Promise<SnapshotJobResult> {
  const env = options.env ?? process.env;
  if (env["MARKET_SNAPSHOT_WRITES_ENABLED"] !== "true") {
    return { status: "skipped", reason: "MARKET_SNAPSHOT_WRITES_ENABLED is not true", fetched: 0, written: 0 };
  }

  const tradingDate = cairoDate(options.now ?? new Date());
  const service = options.service ?? getMarketDataService();
  const repository = options.repository ?? new DrizzleMarketHistoryRepository();
  const rows = await service.getDailyOhlc(MARKET_INSTRUMENTS, tradingDate);
  const written = await repository.upsert(rows);
  return { status: "ok", tradingDate, fetched: rows.length, written };
}

function stableHistoryId(row: DailyOhlc): string {
  return crypto.createHash("sha256")
    .update(`${row.sourceId}\u0000${row.instrumentId}\u0000${row.tradingDate}`)
    .digest("hex")
    .slice(0, 40);
}

function cairoDate(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Cairo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}
