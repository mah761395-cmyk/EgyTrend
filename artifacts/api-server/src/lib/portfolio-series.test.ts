import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildPortfolioSeries,
  eachDay,
  parsePortfolioSeriesRange,
  seriesWindow,
  type PortfolioSeriesInput,
} from "./portfolio-series";

const near = (a: number, b: number, eps = 0.011, label = "") =>
  assert.ok(typeof a === "number" && Number.isFinite(a) && Math.abs(a - b) <= eps, `${label} expected ${a} ≈ ${b}`);

function closesFor(symbol: string, days: Array<[date: string, close: number]>): Map<string, number> {
  return new Map(days);
}

function input(partial: Partial<PortfolioSeriesInput> & Pick<PortfolioSeriesInput, "range" | "to">): PortfolioSeriesInput {
  return {
    startingCash: 0,
    trades: [],
    cashEvents: [],
    held: [],
    closes: new Map(),
    earliestActivity: null,
    ...partial,
  };
}

test("range parsing falls back to 1M and windows are computed in days", () => {
  assert.equal(parsePortfolioSeriesRange("1W"), "1W");
  assert.equal(parsePortfolioSeriesRange("bogus"), "1M");
  assert.equal(parsePortfolioSeriesRange(undefined), "1M");
  assert.deepEqual(seriesWindow("1M", "2026-10-30", null), { from: "2026-09-29", to: "2026-10-30" });
  assert.deepEqual(seriesWindow("1D", "2026-10-30", null), { from: "2026-10-29", to: "2026-10-30" });
  assert.deepEqual(seriesWindow("1Y", "2026-10-30", null), { from: "2025-10-30", to: "2026-10-30" });
  /* ALL starts at the earliest activity (or the 2000 floor). */
  assert.deepEqual(seriesWindow("ALL", "2026-10-30", "2026-03-05"), { from: "2026-03-05", to: "2026-10-30" });
  assert.deepEqual(seriesWindow("ALL", "2026-10-30", null), { from: "2000-01-01", to: "2026-10-30" });
  assert.equal(eachDay("2026-01-01", "2026-01-03").length, 3);
});

test("a single asset with full closes: exact daily values and daily change", () => {
  const closes = new Map<string, Map<string, number>>([
    ["COMI", closesFor("COMI", [
      ["2026-10-28", 10],
      ["2026-10-29", 11],
      ["2026-10-30", 12],
    ])],
  ]);
  const result = buildPortfolioSeries(input({
    range: "1W",
    to: "2026-10-30",
    startingCash: 100,
    trades: [
      { symbol: "COMI", side: "buy", quantity: 10, price: 9, fees: 0, tradeDate: "2026-10-27" },
    ],
    held: [{ symbol: "COMI", quantityNow: 10, legacy: false }],
    closes,
    earliestActivity: "2026-10-27",
  }));
  assert.equal(result.hasPriceHistory, true);
  assert.deepEqual(result.missingSymbols, []);
  const byDate = new Map(result.points.map((point) => [point.date, point]));
  /* Cash after the buy: 100 − 90 = 10 (unchanged afterwards). */
  near(byDate.get("2026-10-28")!.cash, 10);
  near(byDate.get("2026-10-28")!.value as number, 10 + 10 * 10);
  near(byDate.get("2026-10-29")!.value as number, 10 + 10 * 11);
  near(byDate.get("2026-10-30")!.value as number, 10 + 10 * 12);
  near(byDate.get("2026-10-28")!.heldValue as number, 100);
  assert.equal(byDate.get("2026-10-26")!.value, 100, "before the buy day: cash only");
  assert.equal(byDate.get("2026-10-27")!.value, null, "buy day without a stored close is an honest gap");
  assert.equal(result.basis, "partial", "one unpriced holding day → partial, never 'full'");
  /* Daily change = last two valued points: (130 − 120) / 120. */
  near(result.dailyChangePct as number, ((130 - 120) / 120) * 100);
  near(result.coverage, 7 / 8);
});

test("a held symbol without closes creates honest gaps — never a fabricated total", () => {
  const closes = new Map<string, Map<string, number>>([
    ["COMI", closesFor("COMI", [
      ["2026-10-28", 10],
      ["2026-10-29", 11],
      ["2026-10-30", 12],
    ])],
  ]);
  /* ABUK is held but has NO stored history at all. */
  const result = buildPortfolioSeries(input({
    range: "1W",
    to: "2026-10-30",
    startingCash: 50,
    trades: [
      { symbol: "COMI", side: "buy", quantity: 5, price: 10, fees: 0, tradeDate: "2026-10-27" },
      { symbol: "ABUK", side: "buy", quantity: 5, price: 20, fees: 0, tradeDate: "2026-10-27" },
    ],
    held: [
      { symbol: "COMI", quantityNow: 5, legacy: false },
      { symbol: "ABUK", quantityNow: 5, legacy: false },
    ],
    closes,
    earliestActivity: "2026-10-27",
  }));
  assert.equal(result.basis, "partial", "gaps while ABUK lacks closes");
  assert.deepEqual(result.missingSymbols, ["ABUK"]);
  for (const point of result.points) {
    if (point.heldSymbols > 0) {
      assert.equal(point.value, null, `no invented total on ${point.date}`);
      assert.equal(point.heldValue, null);
    }
  }
  /* Cash: 50 before the buy date, −100 from it on (50 − 50 − 100). */
  for (const point of result.points) near(point.cash, point.date < "2026-10-27" ? 50 : -100);
});

test("partially covered symbol: days with both closes are valued, others gap", () => {
  const closes = new Map<string, Map<string, number>>([
    ["COMI", closesFor("COMI", [["2026-10-29", 11], ["2026-10-30", 12]])],
    ["ABUK", closesFor("ABUK", [["2026-10-30", 22]])],
  ]);
  const result = buildPortfolioSeries(input({
    range: "1W",
    to: "2026-10-30",
    startingCash: 0,
    trades: [
      { symbol: "COMI", side: "buy", quantity: 1, price: 1, fees: 0, tradeDate: "2026-10-27" },
      { symbol: "ABUK", side: "buy", quantity: 1, price: 1, fees: 0, tradeDate: "2026-10-27" },
    ],
    held: [
      { symbol: "COMI", quantityNow: 1, legacy: false },
      { symbol: "ABUK", quantityNow: 1, legacy: false },
    ],
    closes,
    earliestActivity: "2026-10-27",
  }));
  const byDate = new Map(result.points.map((point) => [point.date, point]));
  assert.equal(byDate.get("2026-10-29")!.value, null, "COMI alone is not the portfolio total");
  /* Cash: 0 − 1 − 1 = −2; both priced on the last day: −2 + 12 + 22. */
  near(byDate.get("2026-10-30")!.value as number, -2 + 12 + 22, 0.011, "both priced on the last day");
  assert.equal(result.basis, "partial");
  assert.deepEqual(result.missingSymbols, []);
});

test("quantity changes over time: sells reduce the valued quantity day by day", () => {
  const closes = new Map<string, Map<string, number>>([
    ["COMI", closesFor("COMI", [
      ["2026-10-24", 10],
      ["2026-10-25", 10],
      ["2026-10-26", 10],
      ["2026-10-27", 10],
      ["2026-10-28", 10],
      ["2026-10-29", 10],
      ["2026-10-30", 10],
    ])],
  ]);
  const result = buildPortfolioSeries(input({
    range: "1W",
    to: "2026-10-30",
    startingCash: 100,
    trades: [
      { symbol: "COMI", side: "buy", quantity: 10, price: 10, fees: 0, tradeDate: "2026-10-24" },
      { symbol: "COMI", side: "sell", quantity: 4, price: 12, fees: 0, tradeDate: "2026-10-27" },
    ],
    held: [{ symbol: "COMI", quantityNow: 6, legacy: false }],
    closes,
    earliestActivity: "2026-10-24",
  }));
  const byDate = new Map(result.points.map((point) => [point.date, point]));
  /* Before the sell: 10 shares × 10 + cash 0 (100 − 100 buy). */
  near(byDate.get("2026-10-26")!.value as number, 100);
  /* From the sell date: 6 shares × 10 + cash 48 (sell proceeds). */
  near(byDate.get("2026-10-27")!.value as number, 60 + 48);
  near(byDate.get("2026-10-30")!.value as number, 108);
  assert.equal(result.basis, "full");
});

test("legacy positions hold a constant quantity across the window", () => {
  const closes = new Map<string, Map<string, number>>([
    ["HLDI", closesFor("HLDI", [["2026-10-29", 20], ["2026-10-30", 21]])],
  ]);
  const result = buildPortfolioSeries(input({
    range: "1W",
    to: "2026-10-30",
    startingCash: 0,
    held: [{ symbol: "HLDI", quantityNow: 100, legacy: true }],
    closes,
    earliestActivity: null,
  }));
  const byDate = new Map(result.points.map((point) => [point.date, point]));
  near(byDate.get("2026-10-30")!.value as number, 100 * 21);
  near(byDate.get("2026-10-29")!.value as number, 100 * 20);
  assert.equal(byDate.get("2026-10-28")!.value, null, "no legacy history before closes exist");
});

test("cash events move the cash line inside the series", () => {
  const closes = new Map<string, Map<string, number>>([
    ["COMI", closesFor("COMI", [["2026-10-29", 10], ["2026-10-30", 10]])],
  ]);
  const result = buildPortfolioSeries(input({
    range: "1W",
    to: "2026-10-30",
    startingCash: 0,
    trades: [],
    cashEvents: [
      { id: "c1", kind: "deposit", amount: 500, tradeDate: "2026-10-25", createdAtMs: 1 },
      { id: "c2", kind: "withdrawal", amount: 200, tradeDate: "2026-10-29", createdAtMs: 2 },
    ],
    held: [],
    closes,
    earliestActivity: "2026-10-25",
  }));
  assert.equal(result.basis, "cash-only");
  const byDate = new Map(result.points.map((point) => [point.date, point]));
  near(byDate.get("2026-10-25")!.value as number, 500);
  near(byDate.get("2026-10-28")!.value as number, 500);
  near(byDate.get("2026-10-29")!.value as number, 300);
  /* Last two valued points (10-29, 10-30) are both 300 → flat. The drop
   * itself is visible in the point values above. */
  near(result.dailyChangePct as number, 0);
});

test("empty window never invents values and reports coverage 0 days honestly", () => {
  const result = buildPortfolioSeries(input({
    range: "1W",
    to: "2026-10-30",
    startingCash: 25,
    held: [],
  }));
  assert.equal(result.points.length, 8);
  for (const point of result.points) {
    near(point.value as number, 25);
    near(point.cash, 25);
    assert.equal(point.heldSymbols, 0);
  }
  near(result.coverage, 1, 0.0001, "cash-only days are fully valued days");
  assert.equal(result.basis, "cash-only");
  assert.equal(result.hasPriceHistory, false);
  assert.equal(result.dailyChangePct, 0, "flat cash line has zero change");
});
