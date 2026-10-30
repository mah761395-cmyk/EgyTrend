import assert from "node:assert/strict";
import { test } from "node:test";
import { attachMarketValue, cashBalanceOn, cashEventDelta, computePortfolio, quoteVerified, round6, type PortfolioTxInput } from "./portfolio-accounting";

let seq = 0;
function tx(partial: Partial<PortfolioTxInput> & Pick<PortfolioTxInput, "symbol" | "side" | "quantity" | "price" | "tradeDate">): PortfolioTxInput {
  seq += 1;
  return {
    id: `tx-${seq.toString().padStart(3, "0")}`,
    fees: 0,
    createdAtMs: seq,
    ...partial,
  };
}

const near = (a: number, b: number, eps = 0.011) => assert.ok(Math.abs(a - b) <= eps, `expected ${a} ≈ ${b}`);

test("single buy: quantity, average cost, cash outflow", () => {
  const c = computePortfolio([tx({ symbol: "COMI", side: "buy", quantity: 100, price: 10, tradeDate: "2026-01-01" })], 1500);
  const led = c.bySymbol.get("COMI")!;
  assert.equal(led.quantity, 100);
  near(led.averageCost, 10);
  near(c.cash, 500);
  near(c.investedCost, 1000);
  assert.equal(c.realizedPnl, 0);
  assert.equal(c.errors.length, 0);
});

test("buy with fees raises average cost and reduces cash", () => {
  const c = computePortfolio([tx({ symbol: "COMI", side: "buy", quantity: 100, price: 10, fees: 20, tradeDate: "2026-01-01" })], 2000);
  near(c.cash, 980); // 2000 − (1000 + 20)
  near(c.bySymbol.get("COMI")!.averageCost, 10.2); // (1000+20)/100
});

test("multiple buys: moving average", () => {
  const c = computePortfolio([
    tx({ symbol: "COMI", side: "buy", quantity: 100, price: 10, tradeDate: "2026-01-01" }),
    tx({ symbol: "COMI", side: "buy", quantity: 100, price: 14, tradeDate: "2026-01-05" }),
  ], 5000);
  const led = c.bySymbol.get("COMI")!;
  near(led.averageCost, 12); // (1000 + 1400)/200
  near(led.quantity, 200);
  near(c.cash, 2600);
});

test("partial sell: realized P/L with fees, average cost unchanged, quantity reduced", () => {
  const c = computePortfolio([
    tx({ symbol: "COMI", side: "buy", quantity: 100, price: 10, tradeDate: "2026-01-01" }),
    tx({ symbol: "COMI", side: "sell", quantity: 40, price: 13, fees: 5, tradeDate: "2026-01-10" }),
  ], 5000);
  const led = c.bySymbol.get("COMI")!;
  assert.equal(led.quantity, 60);
  near(led.averageCost, 10);
  // realized = 40*13 - 5 - 40*10 = 520 - 5 - 400 = 115
  near(led.realizedPnl, 115);
  near(c.realizedPnl, 115);
  near(c.cash, 5000 - 1000 + 520 - 5, 0.001);
  assert.equal(c.events[1].realizedPnl !== null, true);
  near(c.events[1].realizedPnl!, 115);
});

test("full sell then rebuy: average cost resets from the new buy", () => {
  const c = computePortfolio([
    tx({ symbol: "COMI", side: "buy", quantity: 100, price: 10, tradeDate: "2026-01-01" }),
    tx({ symbol: "COMI", side: "sell", quantity: 100, price: 9, tradeDate: "2026-01-10" }),
    tx({ symbol: "COMI", side: "buy", quantity: 50, price: 20, tradeDate: "2026-01-20" }),
  ], 10000);
  const led = c.bySymbol.get("COMI")!;
  assert.equal(led.quantity, 50);
  near(led.averageCost, 20);
  near(led.realizedPnl, -100); // 900 - 1000
  assert.equal(led.buyCount, 2);
  assert.equal(led.sellCount, 1);
});

test("sell more than held is flagged and clamped (never silently credited)", () => {
  const c = computePortfolio([
    tx({ symbol: "COMI", side: "buy", quantity: 100, price: 10, tradeDate: "2026-01-01" }),
    tx({ symbol: "COMI", side: "sell", quantity: 250, price: 12, tradeDate: "2026-01-10" }),
  ], 10000);
  assert.equal(c.errors.length, 1);
  assert.equal(c.errors[0].code, "sell_exceeds_held");
  assert.equal(c.errors[0].held, 100);
  assert.equal(c.errors[0].requested, 250);
  assert.equal(c.bySymbol.get("COMI")!.quantity, 0);
  near(c.bySymbol.get("COMI")!.realizedPnl, 100 * 12 - 100 * 10); // clamped to 100
  assert.equal(c.events[1].clamped, true);
});

test("same-day trades keep insertion order via createdAtMs, then id", () => {
  const c = computePortfolio([
    tx({ symbol: "COMI", side: "sell", quantity: 10, price: 11, tradeDate: "2026-01-01", id: "b", createdAtMs: 2 }),
    tx({ symbol: "COMI", side: "buy", quantity: 100, price: 10, tradeDate: "2026-01-01", id: "a", createdAtMs: 1 }),
  ], 1000);
  assert.equal(c.events[0].txId, "a");
  assert.equal(c.events[1].txId, "b");
  assert.equal(c.errors.length, 0);
});

test("separate symbols are independent ledgers", () => {
  const c = computePortfolio([
    tx({ symbol: "COMI", side: "buy", quantity: 10, price: 10, tradeDate: "2026-01-01" }),
    tx({ symbol: "HLC", side: "buy", quantity: 5, price: 20, tradeDate: "2026-01-01" }),
    tx({ symbol: "HLC", side: "sell", quantity: 5, price: 25, tradeDate: "2026-01-02" }),
  ], 1000);
  assert.equal(c.bySymbol.get("COMI")!.quantity, 10);
  assert.equal(c.bySymbol.get("HLC")!.quantity, 0);
  near(c.bySymbol.get("HLC")!.realizedPnl, 25);
  near(c.cash, 1000 - 100 - 100 + 125);
  assert.deepEqual(c.symbolOrder, ["COMI", "HLC"]);
});

test("cash flows with starting cash, buys and sells", () => {
  const c = computePortfolio([
    tx({ symbol: "COMI", side: "buy", quantity: 100, price: 10, fees: 10, tradeDate: "2026-01-01" }),
    tx({ symbol: "COMI", side: "sell", quantity: 30, price: 12, fees: 3, tradeDate: "2026-01-02" }),
  ], 2000);
  near(c.cash, 2000 - 1010 + 357);
});

test("attachMarketValue: all priced → total value, weights, unrealized, concentration", () => {
  const c = computePortfolio([
    tx({ symbol: "COMI", side: "buy", quantity: 100, price: 10, tradeDate: "2026-01-01" }),
    tx({ symbol: "HLC", side: "buy", quantity: 100, price: 10, tradeDate: "2026-01-01" }),
  ], 5000);
  const att = attachMarketValue(c, new Map([
    ["COMI", { price: 12, source: "tv", asOf: 1 }],
    ["HLC", { price: 8, source: "tv", asOf: 1 }],
  ]));
  near(c.cash, 3000);
  near(att.pricedMarketValue, 1200 + 800);
  near(att.marketValue!, 2000);
  near(att.totalValue!, 5000);
  near(att.totalValuePriced, 5000);
  near(att.unrealizedPnl!, 0);
  assert.equal(att.missingSymbols.length, 0);
  const comi = att.perSymbol.get("COMI")!;
  near(comi.weightPct!, (1200 / 5000) * 100);
  near(comi.unrealizedPnl!, 200);
  near(comi.unrealizedPnlPct!, 20);
  near(att.topConcentrationPct!, (1200 / 5000) * 100);
});

test("attachMarketValue: missing price → totalValue null, priced part still reported", () => {
  const c = computePortfolio([
    tx({ symbol: "COMI", side: "buy", quantity: 100, price: 10, tradeDate: "2026-01-01" }),
    tx({ symbol: "HLC", side: "buy", quantity: 100, price: 10, tradeDate: "2026-01-01" }),
  ], 5000);
  const att = attachMarketValue(c, new Map([["COMI", { price: 12, source: "tv" }]]));
  assert.equal(att.totalValue, null);
  near(att.pricedMarketValue, 1200);
  near(att.totalValuePriced, 4200);
  assert.deepEqual(att.missingSymbols, ["HLC"]);
  assert.equal(att.topConcentrationPct, null);
});

test("attachMarketValue: under-declared cash (negative) → no weights, values still shown", () => {
  const c = computePortfolio([
    tx({ symbol: "COMI", side: "buy", quantity: 100, price: 10, tradeDate: "2026-01-01" }),
  ], 500);
  const att = attachMarketValue(c, new Map([["COMI", { price: 12, source: "tv" }]]));
  near(c.cash, -500);
  near(att.totalValue!, 700); // −500 + 1200
  assert.equal(att.perSymbol.get("COMI")!.weightPct, null);
  assert.equal(att.topConcentrationPct, null);
  near(att.marketValue!, 1200);
});

test("attachMarketValue: legacy-only holdings merge without trades", () => {
  const c = computePortfolio([], 100);
  const att = attachMarketValue(c, new Map([["FA", { price: 20, source: "tv" }]]), new Map([["FA", { quantity: 10, averageCost: 15 }]]));
  near(att.marketValue!, 200);
  near(att.totalValue!, 300);
  near(att.unrealizedPnl!, 50);
  near(att.perSymbol.get("FA")!.weightPct!, (200 / 300) * 100);
});

test("quoteVerified requires finite positive price and a named source", () => {
  assert.equal(quoteVerified({ price: 10, source: "tv" }), true);
  assert.equal(quoteVerified({ price: 0, source: "tv" }), false);
  assert.equal(quoteVerified({ price: Number.NaN, source: "tv" }), false);
  assert.equal(quoteVerified({ price: 10, source: "" }), false);
  assert.equal(quoteVerified(undefined), false);
});

test("round6 keeps six decimals stable", () => {
  assert.equal(round6(1.005 * 100 + 0.1 + 0.2), 100.8);
  assert.equal(round6(123456.123456789), 123456.123457);
});

test("totalBuyOutlay = Σ buys qty·price + buy fees (the return denominator)", () => {
  const c = computePortfolio([
    tx({ symbol: "COMI", side: "buy", quantity: 100, price: 10, fees: 20, tradeDate: "2026-01-01" }),
    tx({ symbol: "COMI", side: "buy", quantity: 100, price: 14, fees: 0, tradeDate: "2026-01-05" }),
    tx({ symbol: "COMI", side: "sell", quantity: 40, price: 13, fees: 5, tradeDate: "2026-01-10" }),
  ], 5000);
  // outlay = (100·10 + 20) + (100·14) = 1020 + 1400 = 2420 — sell fees excluded
  near(c.totalBuyOutlay, 2420);
  const led = c.bySymbol.get("COMI")!;
  near(led.totalBuyValue, 2400); // 1000 + 1400, fees excluded
  near(led.buyFees, 20); // only the buy fee
  near(led.totalFees, 25); // buy 20 + sell 5
});

test("costBasisSold = Σ soldQty·avgCostAtTime, fees excluded; empty before any sell", () => {
  const noSell = computePortfolio([
    tx({ symbol: "COMI", side: "buy", quantity: 100, price: 10, fees: 20, tradeDate: "2026-01-01" }),
  ], 5000);
  assert.equal(noSell.costBasisSold, 0);
  assert.equal(noSell.bySymbol.get("COMI")!.costBasisSold, 0);

  const c = computePortfolio([
    tx({ symbol: "COMI", side: "buy", quantity: 100, price: 10, fees: 20, tradeDate: "2026-01-01" }),
    tx({ symbol: "COMI", side: "sell", quantity: 40, price: 13, fees: 5, tradeDate: "2026-01-10" }),
  ], 5000);
  // avg after the buy = (1000+20)/100 = 10.2 → cost basis of the sold 40 = 408
  near(c.costBasisSold, 408);
  near(c.bySymbol.get("COMI")!.costBasisSold, 408);
  // and realized stays consistent: 40·13 − 5 − 408 = 107
  near(c.realizedPnl, 107);
});

test("totalBuyOutlay accumulates across symbols for a portfolio-wide denominator", () => {
  const c = computePortfolio([
    tx({ symbol: "COMI", side: "buy", quantity: 100, price: 10, fees: 20, tradeDate: "2026-01-01" }),
    tx({ symbol: "HLDI", side: "buy", quantity: 50, price: 20, fees: 10, tradeDate: "2026-01-02" }),
    tx({ symbol: "HLDI", side: "sell", quantity: 20, price: 25, fees: 0, tradeDate: "2026-01-10" }),
  ], 5000);
  // COMI 1020 + HLDI (50·20 + 10) 1010 = 2030
  near(c.totalBuyOutlay, 2030);
  // HLDI avg = (1000+10)/50 = 20.2 → sold cost = 20·20.2 = 404
  near(c.costBasisSold, 404);
});

/* ═══════════ Cash events (pure) ═══════════ */

test("cashEventDelta signs money in/out correctly and rejects garbage", () => {

  assert.equal(cashEventDelta("deposit", 100), 100);
  assert.equal(cashEventDelta("dividend", 100), 100);
  assert.equal(cashEventDelta("withdrawal", 100), -100);
  assert.equal(cashEventDelta("deposit", 0), 0);
  assert.equal(cashEventDelta("deposit", -5), 0);
  assert.equal(cashEventDelta("deposit", Number.NaN), 0);
});

test("cashBalanceOn folds trades and events up to the given date (inclusive)", () => {

  const trades = [
    { side: "buy" as const, quantity: 100, price: 10, fees: 10, tradeDate: "2026-01-05" },
    { side: "sell" as const, quantity: 40, price: 13, fees: 5, tradeDate: "2026-02-01" },
  ];
  const events = [
    { id: "e1", kind: "deposit" as const, amount: 5000, tradeDate: "2026-01-01", createdAtMs: 1 },
    { id: "e2", kind: "withdrawal" as const, amount: 800, tradeDate: "2026-02-10", createdAtMs: 2 },
  ];
  /* Before anything: just starting cash. */
  near(cashBalanceOn(1000, trades, events, "2025-12-31"), 1000);
  /* After the deposit, before the buy: 1000 + 5000. */
  near(cashBalanceOn(1000, trades, events, "2026-01-03"), 6000);
  /* On the buy date (inclusive): 6000 − 1010. */
  near(cashBalanceOn(1000, trades, events, "2026-01-05"), 4990);
  /* After the sell: 4990 + (40·13 − 5) = 4990 + 515. */
  near(cashBalanceOn(1000, trades, events, "2026-02-01"), 5505);
  /* After the withdrawal: 5505 − 800. */
  near(cashBalanceOn(1000, trades, events, "2026-02-10"), 4705);
  /* A later date is the same (nothing after). */
  near(cashBalanceOn(1000, trades, events, "2027-01-01"), 4705);
});

test("cashBalanceOn is stable with unsorted input and never throws on bad rows", () => {

  const a = cashBalanceOn(
    1000,
    [
      { side: "sell", quantity: 40, price: 13, fees: 5, tradeDate: "2026-02-01" },
      { side: "buy", quantity: 100, price: 10, fees: 10, tradeDate: "2026-01-05" },
    ],
    [
      { id: "e2", kind: "withdrawal", amount: 800, tradeDate: "2026-02-10", createdAtMs: 2 },
      { id: "e1", kind: "deposit", amount: 5000, tradeDate: "2026-01-01", createdAtMs: 1 },
    ],
    "2026-02-10",
  );
  near(a, 4705);
  near(cashBalanceOn(NaN, [], [], "2026-01-01"), 0);
});
