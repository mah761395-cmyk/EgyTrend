import assert from "node:assert/strict";
import test from "node:test";
import {
  getMarketSparklines,
  historySnapshotFromRows,
  relativeStrengthIndex,
  simpleMovingAverage,
  type ChartBar,
  type MarketHistoryReadRepository,
  type StoredMarketOhlc,
} from "./history";

function row(overrides: Partial<StoredMarketOhlc> = {}): StoredMarketOhlc {
  const value: StoredMarketOhlc = {
    instrumentId: "egx:TEST",
    sourceId: "licensed-a",
    sourceName: "Licensed A",
    tradingDate: "2026-10-01",
    open: 10.5,
    high: 11.5,
    low: 9.5,
    close: 10.5,
    volume: 100,
    currency: "EGP",
    delayedMinutes: 1440,
    asOf: new Date("2026-10-02T18:00:00.000Z"),
    ...overrides,
  };
  // Most test rows override only close. Keep the unoverridden OHLC legs valid
  // around that real close, while preserving explicitly malformed test rows.
  if (!("open" in overrides)) value.open = value.close;
  if (!("high" in overrides)) value.high = value.close + 1;
  if (!("low" in overrides)) value.low = Math.max(.01, value.close - 1);
  return value;
}

test("history selects one licensed source rather than mixing vendor candles", () => {
  const snapshot = historySnapshotFromRows({
    instrumentId: "egx:TEST",
    range: "1M",
    rows: [
      row({ sourceId: "licensed-a", sourceName: "Licensed A", tradingDate: "2026-10-01", close: 10.5 }),
      row({ sourceId: "licensed-a", sourceName: "Licensed A", tradingDate: "2026-10-02", close: 11 }),
      row({ sourceId: "licensed-b", sourceName: "Licensed B", tradingDate: "2026-10-01", close: 80 }),
      row({ sourceId: "licensed-b", sourceName: "Licensed B", tradingDate: "2026-10-02", close: 81 }),
      row({ sourceId: "licensed-b", sourceName: "Licensed B", tradingDate: "2026-10-03", close: 82 }),
    ],
  });

  assert.equal(snapshot.available, true);
  assert.equal(snapshot.source?.id, "licensed-b");
  assert.deepEqual(snapshot.points.map((point) => point.close), [80, 81, 82]);
});

test("invalid or duplicate bars are rejected and a one-bar series is not chartable", () => {
  const snapshot = historySnapshotFromRows({
    instrumentId: "egx:TEST",
    range: "1W",
    rows: [
      row({ tradingDate: "2026-10-01" }),
      row({ tradingDate: "2026-10-01", close: 12 }), // duplicate date
      row({ tradingDate: "2026-10-02", high: 8, low: 9 }), // malformed OHLC
    ],
  });

  assert.equal(snapshot.available, false);
  assert.equal(snapshot.reason, "insufficient_history");
  assert.equal(snapshot.points.length, 1);
});

test("MA and Wilder RSI are computed only from supplied historical closes", () => {
  const bars: ChartBar[] = Array.from({ length: 21 }, (_, index) => ({
    time: `2026-09-${String(index + 1).padStart(2, "0")}`,
    open: index + 1,
    high: index + 2,
    low: Math.max(.1, index),
    close: index + 1,
  }));
  const ma = simpleMovingAverage(bars, 20);
  const rsi = relativeStrengthIndex(bars, 14);

  assert.equal(ma.length, 2);
  assert.equal(ma[0]?.value, 10.5);
  assert.equal(ma[1]?.value, 11.5);
  assert.equal(rsi.length, 7);
  assert.equal(rsi[0]?.value, 100);
});

test("batched sparklines stay empty when a history source has fewer than two valid closes", async () => {
  const repository: MarketHistoryReadRepository = {
    async list(ids) {
      assert.deepEqual(ids, ["egx:ONE", "egx:TWO"]);
      return [
        row({ instrumentId: "egx:ONE", tradingDate: "2026-10-01", close: 20 }),
        row({ instrumentId: "egx:ONE", tradingDate: "2026-10-02", close: 21 }),
        row({ instrumentId: "egx:TWO", tradingDate: "2026-10-01", close: 30 }),
      ];
    },
  };

  const result = await getMarketSparklines({
    instrumentIds: ["egx:ONE", "egx:TWO"],
    repository,
    now: new Date("2026-10-16T12:00:00.000Z"),
  });
  assert.equal(result[0]?.available, true);
  assert.deepEqual(result[0]?.points.map((point) => point.close), [20, 21]);
  assert.equal(result[1]?.available, false);
  assert.deepEqual(result[1]?.points, [{ time: "2026-10-01", close: 30 }]);
});
