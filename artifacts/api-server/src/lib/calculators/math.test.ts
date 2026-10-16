import assert from "node:assert/strict";
import test from "node:test";
import {
  averagePurchase,
  cagr,
  compoundGrowth,
  currencyConvert,
  dividendYield,
  inflationAdjustedReturn,
  positionRisk,
  profitLoss,
} from "./math";

function valid<T extends { ok: boolean }>(value: T): Extract<T, { ok: true }> {
  assert.equal(value.ok, true, value.ok ? undefined : (value as { error?: string }).error);
  return value as Extract<T, { ok: true }>;
}

function close(actual: number | null, expected: number, places = 8) {
  assert.notEqual(actual, null);
  assert.ok(Math.abs(Number(actual) - expected) < 10 ** -places, `expected ${expected}, got ${actual}`);
}

test("P/L formula covers zero fee, per-side fee and break-even", () => {
  const noFee = valid(profitLoss({ buyPrice: 100, sellPrice: 120, quantity: 50, commissionPercent: 0 }));
  close(noFee.net, 1000);
  close(noFee.returnPercent, 20);

  const halfPercent = valid(profitLoss({ buyPrice: 100, sellPrice: 120, quantity: 50, commissionPercent: 0.5 }));
  close(halfPercent.net, 945);
  close(halfPercent.returnPercent, 18.805970149254, 10);
  close(halfPercent.breakEvenPrice, 101.005025125628, 10);
});

test("position sizing uses floor risk sizing, direction and target warnings", () => {
  const result = valid(positionRisk({ capital: 100000, riskPercent: 1, entryPrice: 50, stopPrice: 48, targetPrice: 56 }));
  assert.equal(result.quantity, 500);
  close(result.riskAmount, 1000);
  close(result.positionValue, 25000);
  close(result.positionPercent, 25);
  assert.equal(result.direction, "long");
  close(result.riskReward, 3);
  close(result.expectedProfit, 3000);
  assert.deepEqual(result.targets.map((target) => target.price), [52, 54, 56]);

  const invalidTarget = valid(positionRisk({ capital: 100000, riskPercent: 1, entryPrice: 50, stopPrice: 48, targetPrice: 46 }));
  assert.equal(invalidTarget.targetValid, false);
  assert.equal(invalidTarget.riskReward, null);
  assert.match(invalidTarget.warning || "", /الاتجاه المعاكس/);
});

test("compound growth has exact monthly-end contribution convention and zero-rate path", () => {
  const bare = valid(compoundGrowth({ initialAmount: 10000, annualReturnPercent: 12, monthlyContribution: 0, months: 12 }));
  close(bare.balance, 11268.2503013197, 8);

  const contributed = valid(compoundGrowth({ initialAmount: 10000, annualReturnPercent: 12, monthlyContribution: 500, months: 12 }));
  close(contributed.balance, 17609.501807918186, 8);
  assert.equal(contributed.yearlyRows.length, 1);

  const zeroRate = valid(compoundGrowth({ initialAmount: 10000, annualReturnPercent: 0, monthlyContribution: 500, months: 12 }));
  close(zeroRate.balance, 16000);
  close(zeroRate.growth, 0);
});

test("weighted average includes all lots and an unrealized P/L", () => {
  const result = valid(averagePurchase({ lots: [{ quantity: 10, price: 100 }, { quantity: 20, price: 90 }], currentPrice: 95 }));
  close(result.averagePrice, 93.333333333333, 10);
  close(result.unrealized, 50);
  close(result.unrealizedPercent, 1.785714285714, 10);
});

test("dividend yield reports gross/monthly income and after-tax income", () => {
  const gross = valid(dividendYield({ annualDividendPerShare: 2, currentPrice: 40, quantity: 1000, taxPercent: 0, costPerShare: 40 }));
  close(gross.yieldPercent, 5);
  close(gross.grossAnnualIncome, 2000);
  close(gross.grossMonthlyIncome, 166.666666666667, 10);

  const afterTax = valid(dividendYield({ annualDividendPerShare: 2, currentPrice: 40, quantity: 1000, taxPercent: 10, costPerShare: 40 }));
  close(afterTax.netAnnualIncome, 1800);
  close(afterTax.yieldOnCostPercent, 5);
});

test("CAGR yields multiplier and a five-year doubling duration", () => {
  const result = valid(cagr({ initialValue: 100, finalValue: 200, years: 5 }));
  close(result.cagrPercent, 14.869835499704, 10);
  close(result.multiplier, 2);
  close(result.doublingYears, 5, 10);
});

test("real return and future purchasing power use inflation-adjusted math", () => {
  const returnOnly = valid(inflationAdjustedReturn({ nominalReturnPercent: 20, inflationPercent: 25, amount: 10000, years: 0 }));
  close(returnOnly.realReturnPercent, -4);

  const future = valid(inflationAdjustedReturn({ nominalReturnPercent: 0, inflationPercent: 25, amount: 10000, years: 3 }));
  close(future.realValue, 5120);
});

test("currency conversion uses only supplied source-backed rates", () => {
  const result = valid(currencyConvert({ amount: 100, from: "USD", to: "EGP", rates: { USD: 50, EGP: 1 } }));
  close(result.convertedAmount, 5000);
  const cross = valid(currencyConvert({ amount: 100, from: "USD", to: "EUR", rates: { USD: 50, EUR: 55, EGP: 1 } }));
  close(cross.convertedAmount, 90.9090909091, 8);
  const absent = currencyConvert({ amount: 100, from: "USD", to: "SAR", rates: { USD: 50, EGP: 1 } });
  assert.equal(absent.ok, false, "missing rates must never become a fixed fallback");
});

test("strict validation returns Arabic errors instead of NaN or Infinity", () => {
  const blank = profitLoss({ buyPrice: "", sellPrice: 120, quantity: 50, commissionPercent: 0 });
  assert.equal(blank.ok, false);
  if (!blank.ok) assert.match(blank.error, /أدخل/);

  const negative = dividendYield({ annualDividendPerShare: -1, currentPrice: 40, quantity: 1, taxPercent: 0 });
  assert.equal(negative.ok, false);
  const nullInput = cagr({ initialValue: null, finalValue: 100, years: 1 });
  assert.equal(nullInput.ok, false);

  const zeroDivision = positionRisk({ capital: 100000, riskPercent: 1, entryPrice: 50, stopPrice: 50, targetPrice: 60 });
  assert.equal(zeroDivision.ok, false);

  const huge = compoundGrowth({ initialAmount: 1e13, annualReturnPercent: 12, monthlyContribution: 0, months: 12 });
  assert.equal(huge.ok, false);
});
