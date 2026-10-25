import assert from "node:assert/strict";
import test from "node:test";
import {
  averagePurchase,
  cagr,
  compoundGrowth,
  currencyConvert,
  dividendYield,
  inflationAdjustedReturn,
  investorProjection,
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

/* Independent reference for the investor plan: ordinary annuity closed form
 * (opening capital compounded monthly + contribution at each month end).
 * Written separately from the implementation so a shared bug cannot hide. */
function annuityFutureValue(initial: number, monthly: number, months: number, annualPercent: number): number {
  const rate = annualPercent / 100 / 12;
  if (rate === 0) return initial + monthly * months;
  const factor = Math.pow(1 + rate, months);
  return initial * factor + monthly * ((factor - 1) / rate);
}

test("investor projection matches an independent annuity formula and totals", () => {
  const cases = [
    { initialAmount: 100000, monthlyContribution: 5000, months: 60, annualReturnPercent: 18 },
    { initialAmount: 10000, monthlyContribution: 500, months: 12, annualReturnPercent: 12 },
    { initialAmount: 250000, monthlyContribution: 0, months: 36, annualReturnPercent: 9.5 },
    { initialAmount: 0, monthlyContribution: 2000, months: 24, annualReturnPercent: 0 },
  ];
  for (const input of cases) {
    const result = valid(investorProjection(input));
    const contributions = input.initialAmount + input.monthlyContribution * input.months;
    close(result.finalValue, annuityFutureValue(input.initialAmount, input.monthlyContribution, input.months, input.annualReturnPercent), 2);
    close(result.totalContributions, contributions, 6);
    close(result.estimatedProfit, result.finalValue - contributions, 2);
    close(result.multiple, result.finalValue / contributions, 6);
    close(result.profitSharePercent, (result.estimatedProfit / result.finalValue) * 100, 6);
    close(result.contributionSharePercent, (contributions / result.finalValue) * 100, 6);
    close(result.contributionSharePercent + result.profitSharePercent, 100, 6);
  }
});

test("investor timing deposits each contribution at the month end", () => {
  const result = valid(investorProjection({ initialAmount: 1000, monthlyContribution: 100, months: 2, annualReturnPercent: 12 }));
  const rate = 0.01;
  close(result.points[0].balance, 1000 * (1 + rate) + 100, 6);
  close(result.points[1].balance, (1000 * (1 + rate) + 100) * (1 + rate) + 100, 6);
  close(result.finalValue, 1000 * 1.01 ** 2 + 100 * 1.01 + 100, 6);
  /* The first contribution earns one month, never two, and the second earns none. */
  close(result.estimatedProfit, 1000 * 1.01 ** 2 + 100 * 1.01 - 1100, 6);
});

test("investor chart series is bounded, monotonic and ends on the summary value", () => {
  const result = valid(investorProjection({ initialAmount: 50000, monthlyContribution: 1500, months: 360, annualReturnPercent: 15 }));
  assert.ok(result.points.length >= 2 && result.points.length <= 61, `unexpected point count ${result.points.length}`);
  result.points.forEach((point, index) => {
    if (index > 0) assert.ok(point.month > result.points[index - 1].month, "chart months must increase");
    close(point.profit, point.balance - point.contributions, 2);
    assert.ok(point.balance >= point.contributions - 0.01, "growth never hides a loss at non-negative rates");
  });
  const last = result.points[result.points.length - 1];
  assert.equal(last.month, 360);
  close(last.balance, result.finalValue, 2);
  assert.equal(result.yearlyRows.length, 30);
  assert.equal(result.yearlyRows[result.yearlyRows.length - 1].year, 30);
  close(result.yearlyRows[result.yearlyRows.length - 1].balance, result.finalValue, 2);
});

test("investor scenarios use visible rates, stay ordered and share one formula", () => {
  const auto = valid(investorProjection({ initialAmount: 10000, monthlyContribution: 500, months: 120, annualReturnPercent: 12 }));
  assert.deepEqual(auto.scenarios.map((item) => item.key), ["conservative", "expected", "optimistic"]);
  assert.deepEqual(auto.scenarios.map((item) => item.annualReturnPercent), [9, 12, 15]);
  assert.ok(auto.scenarios[0].finalValue < auto.scenarios[1].finalValue);
  assert.ok(auto.scenarios[1].finalValue < auto.scenarios[2].finalValue);
  for (const item of auto.scenarios) {
    close(item.finalValue, annuityFutureValue(10000, 500, 120, item.annualReturnPercent), 2);
    close(item.totalContributions, 10000 + 500 * 120, 6);
    close(item.estimatedProfit, item.finalValue - item.totalContributions, 2);
    close(item.monthlyRate, item.annualReturnPercent / 100 / 12, 10);
  }
  close(auto.scenarios[1].finalValue, auto.finalValue, 2);

  const overridden = valid(investorProjection({ initialAmount: 10000, monthlyContribution: 500, months: 120, annualReturnPercent: 12, conservativePercent: 4, optimisticPercent: 20 }));
  assert.deepEqual(overridden.scenarios.map((item) => item.annualReturnPercent), [4, 12, 20]);

  const floored = valid(investorProjection({ initialAmount: 10000, monthlyContribution: 0, months: 24, annualReturnPercent: 2 }));
  assert.equal(floored.conservativePercent, 0, "a conservative scenario never promises a negative nominal return");
  close(floored.scenarios[0].finalValue, 10000, 2);
});

test("investor projection at 0% keeps every point exactly at the contributions", () => {
  const result = valid(investorProjection({ initialAmount: 12000, monthlyContribution: 750, months: 18, annualReturnPercent: 0 }));
  close(result.finalValue, 12000 + 750 * 18, 6);
  close(result.estimatedProfit, 0, 6);
  close(result.monthlyRate, 0, 10);
  assert.equal(result.profitSharePercent, 0);
  result.points.forEach((point) => close(point.profit, 0, 6));
});

test("investor validation rejects impossible inputs with Arabic errors", () => {
  const blankAmounts = investorProjection({ initialAmount: 0, monthlyContribution: 0, months: 12, annualReturnPercent: 10 });
  assert.equal(blankAmounts.ok, false);
  if (!blankAmounts.ok) assert.match(blankAmounts.error, /رأس مال|مساهمة/);

  const blankRate = investorProjection({ initialAmount: 1000, monthlyContribution: 0, months: 12, annualReturnPercent: "" });
  assert.equal(blankRate.ok, false);
  if (!blankRate.ok) assert.match(blankRate.error, /أدخل/);

  assert.equal(investorProjection({ initialAmount: -1, monthlyContribution: 0, months: 12, annualReturnPercent: 10 }).ok, false);
  assert.equal(investorProjection({ initialAmount: 1000, monthlyContribution: 0, months: 12.5, annualReturnPercent: 10 }).ok, false);
  assert.equal(investorProjection({ initialAmount: 1000, monthlyContribution: 0, months: 601, annualReturnPercent: 10 }).ok, false);
  assert.equal(investorProjection({ initialAmount: 1000, monthlyContribution: 0, months: 12, annualReturnPercent: 2000 }).ok, false);
  assert.equal(investorProjection({ initialAmount: Number.NaN, monthlyContribution: 0, months: 12, annualReturnPercent: 10 }).ok, false);
  assert.equal(investorProjection(null as unknown as Record<string, unknown>).ok, false);

  const crossed = investorProjection({ initialAmount: 1000, monthlyContribution: 0, months: 12, annualReturnPercent: 10, conservativePercent: 12 });
  assert.equal(crossed.ok, false);
  if (!crossed.ok) assert.match(crossed.error, /المتحفظ/);
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
