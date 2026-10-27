/*
 * Pure calculator functions shared by automated server tests and the protected
 * browser module. They neither read DOM/state nor fetch market data.
 *
 * The browser module is emitted from the exact function bodies below via
 * `getCalculatorMathModuleSource()`, so the VIP UI cannot drift from the
 * formulae covered by tests.
 */

type CalculatorOk<T extends Record<string, unknown>> = { ok: true } & T;
type CalculatorError = { ok: false; error: string };
export type CalculatorResult<T extends Record<string, unknown>> = CalculatorOk<T> | CalculatorError;

function failure(error: string): CalculatorError {
  return { ok: false, error };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function numberInRange(value: unknown, label: string, min: number, max: number, allowZero = false): any {
  if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) return failure(`أدخل ${label}`);
  if (typeof value !== "number" && typeof value !== "string") return failure(`${label} يجب أن يكون رقمًا صحيحًا`);
  const number = Number(value);
  const lowerAllowed = allowZero ? number >= min : number > min;
  if (!Number.isFinite(number) || !lowerAllowed || number > max) {
    return failure(`${label} يجب أن يكون رقمًا ${allowZero ? "غير سالب" : "موجبًا"} ضمن الحدود المسموحة`);
  }
  return number;
}

function positive(value: unknown, label: string, max = 1_000_000_000_000): any {
  return numberInRange(value, label, 0, max, false);
}

function nonNegative(value: unknown, label: string, max = 1_000_000_000_000): any {
  return numberInRange(value, label, 0, max, true);
}

function percentage(value: unknown, label: string, max = 10_000): any {
  return nonNegative(value, label, max);
}

function valueOrError(value: number | CalculatorError): value is CalculatorError {
  return typeof value === "object" && value !== null && "ok" in value && value.ok === false;
}

function rounded(value: number, digits = 10): number {
  if (!Number.isFinite(value)) return value;
  /* Decimal serialization avoids exposing binary residue such as
   * 945.000000000001 after subtracting commission-adjusted totals. */
  return Number(value.toFixed(digits));
}

/** 1) Buy/sell proceeds, each-side commission, net P/L and break-even. */
export function profitLoss(input: Record<string, unknown>): CalculatorResult<{
  buyPrice: number; sellPrice: number; quantity: number; commissionRate: number;
  cost: number; proceeds: number; net: number; returnPercent: number; breakEvenPrice: number;
}> {
  if (!isPlainRecord(input)) return failure("بيانات الربح والخسارة غير صحيحة");
  const buyPrice = positive(input.buyPrice, "سعر الشراء");
  const sellPrice = positive(input.sellPrice, "سعر البيع");
  const quantity = positive(input.quantity, "الكمية", 1_000_000_000);
  const commissionPercent = percentage(input.commissionPercent ?? 0, "العمولة", 100);
  if ([buyPrice, sellPrice, quantity, commissionPercent].some(valueOrError)) {
    return [buyPrice, sellPrice, quantity, commissionPercent].find(valueOrError)!;
  }
  const commissionRate = commissionPercent / 100;
  const cost = buyPrice * quantity * (1 + commissionRate);
  const proceeds = sellPrice * quantity * (1 - commissionRate);
  if (!Number.isFinite(cost) || !Number.isFinite(proceeds) || cost <= 0 || 1 - commissionRate <= 0) {
    return failure("تعذر حساب النتيجة بهذه القيم");
  }
  const net = proceeds - cost;
  return {
    ok: true,
    buyPrice, sellPrice, quantity, commissionRate,
    cost: rounded(cost), proceeds: rounded(proceeds), net: rounded(net),
    returnPercent: rounded((net / cost) * 100),
    breakEvenPrice: rounded((buyPrice * (1 + commissionRate)) / (1 - commissionRate)),
  };
}

/** 2) Position size and risk. The stop determines long vs short direction. */
export function positionRisk(input: Record<string, unknown>): CalculatorResult<{
  capital: number; riskPercent: number; riskAmount: number; entryPrice: number; stopPrice: number; targetPrice: number;
  direction: "long" | "short"; riskPerShare: number; quantity: number; positionValue: number; positionPercent: number;
  targetValid: boolean; warning: string | null; rewardPerShare: number | null; riskReward: number | null;
  expectedProfit: number | null; targets: Array<{ multiple: number; price: number; expectedProfit: number }>;
}> {
  if (!isPlainRecord(input)) return failure("بيانات إدارة المخاطر غير صحيحة");
  const capital = positive(input.capital, "رأس المال");
  const riskPercent = percentage(input.riskPercent, "نسبة المخاطرة", 100);
  const entryPrice = positive(input.entryPrice, "سعر الدخول");
  const stopPrice = positive(input.stopPrice, "وقف الخسارة");
  const targetPrice = positive(input.targetPrice, "سعر الهدف");
  if ([capital, riskPercent, entryPrice, stopPrice, targetPrice].some(valueOrError)) {
    return [capital, riskPercent, entryPrice, stopPrice, targetPrice].find(valueOrError)!;
  }
  if (entryPrice === stopPrice) return failure("لا يمكن أن يساوي وقف الخسارة سعر الدخول");
  const direction: "long" | "short" = stopPrice < entryPrice ? "long" : "short";
  const riskAmount = capital * (riskPercent / 100);
  const riskPerShare = Math.abs(entryPrice - stopPrice);
  const quantity = Math.floor(riskAmount / riskPerShare);
  if (!Number.isFinite(quantity) || quantity < 1) return failure("المبلغ المعرّض لا يكفي لوحدة واحدة عند وقف الخسارة المحدد");
  const positionValue = entryPrice * quantity;
  const positionPercent = (positionValue / capital) * 100;
  const targetValid = direction === "long" ? targetPrice > entryPrice : targetPrice < entryPrice;
  const rewardPerShare = targetValid ? Math.abs(targetPrice - entryPrice) : null;
  const riskReward = rewardPerShare === null ? null : rewardPerShare / riskPerShare;
  const expectedProfit = rewardPerShare === null ? null : rewardPerShare * quantity;
  const targets = [1, 2, 3].map((multiple) => {
    const price = direction === "long"
      ? entryPrice + multiple * riskPerShare
      : entryPrice - multiple * riskPerShare;
    return { multiple, price: rounded(price), expectedProfit: rounded(multiple * riskPerShare * quantity) };
  });
  const warnings = [] as string[];
  if (!targetValid) warnings.push("الهدف في الاتجاه المعاكس لاتجاه الصفقة المحدد من وقف الخسارة");
  if (positionValue > capital) warnings.push("قيمة المركز أكبر من رأس المال المتاح");
  return {
    ok: true,
    capital, riskPercent, riskAmount: rounded(riskAmount), entryPrice, stopPrice, targetPrice, direction,
    riskPerShare: rounded(riskPerShare), quantity, positionValue: rounded(positionValue), positionPercent: rounded(positionPercent),
    targetValid, warning: warnings.length ? warnings.join(" · ") : null,
    rewardPerShare: rewardPerShare === null ? null : rounded(rewardPerShare),
    riskReward: riskReward === null ? null : rounded(riskReward),
    expectedProfit: expectedProfit === null ? null : rounded(expectedProfit), targets,
  };
}

/** 3) Compound value with contribution deposited at each month end. */
export function compoundGrowth(input: Record<string, unknown>): CalculatorResult<{
  initialAmount: number; annualReturnPercent: number; monthlyContribution: number; months: number;
  monthlyRate: number; balance: number; contributions: number; growth: number;
  monthlySeries: Array<{ month: number; balance: number; contributions: number }>;
  yearlyRows: Array<{ year: number; balance: number; contributions: number; growth: number }>;
}> {
  if (!isPlainRecord(input)) return failure("بيانات العائد المركب غير صحيحة");
  const initialAmount = nonNegative(input.initialAmount, "المبلغ الابتدائي");
  const annualReturnPercent = percentage(input.annualReturnPercent, "العائد السنوي", 1_000);
  const monthlyContribution = nonNegative(input.monthlyContribution ?? 0, "الإضافة الشهرية");
  const monthsRaw = positive(input.months, "عدد الأشهر", 1_200);
  if ([initialAmount, annualReturnPercent, monthlyContribution, monthsRaw].some(valueOrError)) {
    return [initialAmount, annualReturnPercent, monthlyContribution, monthsRaw].find(valueOrError)!;
  }
  const months = Math.floor(monthsRaw);
  if (months !== monthsRaw) return failure("عدد الأشهر يجب أن يكون رقمًا صحيحًا");
  if (initialAmount === 0 && monthlyContribution === 0) return failure("أدخل مبلغًا ابتدائيًا أو إضافة شهرية على الأقل");
  const monthlyRate = annualReturnPercent / 100 / 12;
  const growthFactor = (1 + monthlyRate) ** months;
  const balance = monthlyRate === 0
    ? initialAmount + monthlyContribution * months
    : initialAmount * growthFactor + monthlyContribution * ((growthFactor - 1) / monthlyRate);
  if (!Number.isFinite(balance) || balance > 1_000_000_000_000_000) return failure("النتيجة أكبر من الحد المسموح");
  const monthlySeries: Array<{ month: number; balance: number; contributions: number }> = [];
  const yearlyRows: Array<{ year: number; balance: number; contributions: number; growth: number }> = [];
  let rollingBalance = initialAmount;
  for (let month = 1; month <= months; month += 1) {
    rollingBalance = rollingBalance * (1 + monthlyRate) + monthlyContribution;
    const contributions = initialAmount + monthlyContribution * month;
    monthlySeries.push({ month, balance: rounded(rollingBalance), contributions: rounded(contributions) });
    if (month % 12 === 0 || month === months) {
      yearlyRows.push({
        year: Math.ceil(month / 12), balance: rounded(rollingBalance), contributions: rounded(contributions), growth: rounded(rollingBalance - contributions),
      });
    }
  }
  const contributions = initialAmount + monthlyContribution * months;
  return {
    ok: true, initialAmount, annualReturnPercent, monthlyContribution, months, monthlyRate: rounded(monthlyRate),
    balance: rounded(balance), contributions: rounded(contributions), growth: rounded(balance - contributions), monthlySeries, yearlyRows,
  };
}

/* ─── investor plan (حاسبة المستثمر) ──────────────────────────────────────
 * One projection engine feeds the numbers and every chart, so a chart can
 * never disagree with the summary. Timing convention is identical to
 * compoundGrowth: the opening capital earns from month 1, each periodic
 * contribution is deposited at month end and therefore earns only from the
 * following month (ordinary annuity, not annuity-due). */
type InvestorPoint = { month: number; balance: number; contributions: number; profit: number };
type InvestorSeries = { monthlyRate: number; finalValue: number; totalContributions: number; estimatedProfit: number; points: InvestorPoint[] };
type InvestorScenario = {
  key: "conservative" | "expected" | "optimistic";
  label: string;
  annualReturnPercent: number;
  monthlyRate: number;
  finalValue: number;
  totalContributions: number;
  estimatedProfit: number;
};

function investorSeries(initialAmount: number, monthlyContribution: number, months: number, annualReturnPercent: number): InvestorSeries {
  const monthlyRate = annualReturnPercent / 100 / 12;
  const points: InvestorPoint[] = [];
  let balance = initialAmount;
  for (let month = 1; month <= months; month += 1) {
    balance = balance * (1 + monthlyRate) + monthlyContribution;
    const contributions = initialAmount + monthlyContribution * month;
    points.push({ month, balance: rounded(balance), contributions: rounded(contributions), profit: rounded(balance - contributions) });
  }
  const totalContributions = initialAmount + monthlyContribution * months;
  return {
    monthlyRate: rounded(monthlyRate, 12),
    finalValue: rounded(balance),
    totalContributions: rounded(totalContributions),
    estimatedProfit: rounded(balance - totalContributions),
    points,
  };
}

/** Evenly thin a series for chart rendering while always keeping the last point. */
function thinPoints<T>(points: T[], maxPoints: number): T[] {
  if (!Array.isArray(points) || points.length <= maxPoints) return points.slice();
  const step = (points.length - 1) / (maxPoints - 1);
  const thinned: T[] = [];
  for (let index = 0; index < maxPoints; index += 1) thinned.push(points[Math.round(index * step)]);
  return thinned;
}

/**
 * 3b) Investor plan: opening capital + periodic contributions, compounded
 * monthly, with conservative / expected / optimistic scenarios computed by the
 * same engine. Scenario rates default to expected ∓ 3 percentage points and are
 * floored at 0% so a scenario never promises a negative nominal return.
 */
export function investorProjection(input: Record<string, unknown>): CalculatorResult<{
  initialAmount: number; monthlyContribution: number; months: number; years: number;
  annualReturnPercent: number; monthlyRate: number;
  totalContributions: number; estimatedProfit: number; finalValue: number;
  multiple: number; profitSharePercent: number; contributionSharePercent: number;
  conservativePercent: number; optimisticPercent: number;
  points: InvestorPoint[];
  yearlyRows: Array<{ year: number; balance: number; contributions: number; growth: number }>;
  scenarios: InvestorScenario[];
}> {
  if (!isPlainRecord(input)) return failure("بيانات حاسبة المستثمر غير صحيحة");
  const blank = (value: unknown) => value === undefined || value === null || (typeof value === "string" && value.trim() === "");
  const initialAmount = nonNegative(input.initialAmount ?? 0, "رأس المال الأولي");
  const monthlyContribution = nonNegative(input.monthlyContribution ?? 0, "المساهمة الدورية");
  const annualReturnPercent = percentage(input.annualReturnPercent, "العائد السنوي المتوقع", 1_000);
  const monthsRaw = positive(input.months, "مدة الاستثمار", 600);
  const conservativeInput = blank(input.conservativePercent) ? null : percentage(input.conservativePercent, "عائد السيناريو المتحفظ", 1_000);
  const optimisticInput = blank(input.optimisticPercent) ? null : percentage(input.optimisticPercent, "عائد السيناريو المتفائل", 1_000);
  const checked = [initialAmount, monthlyContribution, annualReturnPercent, monthsRaw, conservativeInput, optimisticInput];
  if (checked.some(valueOrError)) return checked.find(valueOrError)!;
  const months = Math.floor(monthsRaw as number);
  if (months !== monthsRaw) return failure("مدة الاستثمار يجب أن تكون بعدد أشهر صحيح");
  if (initialAmount === 0 && monthlyContribution === 0) return failure("أدخل رأس مال أوليًا أو مساهمة دورية على الأقل");
  const conservativePercent = conservativeInput === null ? Math.max(0, annualReturnPercent - 3) : (conservativeInput as number);
  const optimisticPercent = optimisticInput === null ? Math.min(1_000, annualReturnPercent + 3) : (optimisticInput as number);
  if (conservativePercent > annualReturnPercent || optimisticPercent < annualReturnPercent) {
    return failure("عائد السيناريو المتحفظ يجب ألا يتجاوز العائد المتوقع، والمتفائل ألا يقل عنه");
  }
  const expected = investorSeries(initialAmount, monthlyContribution, months, annualReturnPercent);
  const conservative = investorSeries(initialAmount, monthlyContribution, months, conservativePercent);
  const optimistic = investorSeries(initialAmount, monthlyContribution, months, optimisticPercent);
  if (!Number.isFinite(expected.finalValue) || expected.finalValue > 1_000_000_000_000_000) return failure("النتيجة أكبر من الحد المسموح");
  const yearlyRows = expected.points
    .filter((point) => point.month % 12 === 0 || point.month === months)
    .map((point) => ({ year: Math.ceil(point.month / 12), balance: point.balance, contributions: point.contributions, growth: point.profit }));
  const scenario = (key: InvestorScenario["key"], label: string, percent: number, series: InvestorSeries): InvestorScenario => ({
    key, label, annualReturnPercent: percent, monthlyRate: series.monthlyRate,
    finalValue: series.finalValue, totalContributions: series.totalContributions, estimatedProfit: series.estimatedProfit,
  });
  return {
    ok: true,
    initialAmount, monthlyContribution, months, years: rounded(months / 12),
    annualReturnPercent, monthlyRate: expected.monthlyRate,
    totalContributions: expected.totalContributions, estimatedProfit: expected.estimatedProfit, finalValue: expected.finalValue,
    multiple: rounded(expected.finalValue / expected.totalContributions),
    profitSharePercent: rounded(expected.finalValue > 0 ? (expected.estimatedProfit / expected.finalValue) * 100 : 0),
    contributionSharePercent: rounded(expected.finalValue > 0 ? (expected.totalContributions / expected.finalValue) * 100 : 0),
    conservativePercent, optimisticPercent,
    points: thinPoints(expected.points, 61),
    yearlyRows,
    scenarios: [
      scenario("conservative", "متحفظ", conservativePercent, conservative),
      scenario("expected", "متوسط", annualReturnPercent, expected),
      scenario("optimistic", "متفائل", optimisticPercent, optimistic),
    ],
  };
}

/** 4) Weighted average entry plus unrealized P/L at an optional current price. */
export function averagePurchase(input: Record<string, unknown>): CalculatorResult<{
  shares: number; totalCost: number; averagePrice: number; currentPrice: number | null;
  marketValue: number | null; unrealized: number | null; unrealizedPercent: number | null;
}> {
  if (!isPlainRecord(input) || !Array.isArray(input.lots) || input.lots.length < 1 || input.lots.length > 1_500) {
    return failure("أدخل عملية شراء واحدة على الأقل؛ عدد الصفوف تجاوز الحد الآمن للحساب");
  }
  let shares = 0;
  let totalCost = 0;
  for (const lot of input.lots) {
    if (!isPlainRecord(lot)) return failure("بيانات عملية الشراء غير صحيحة");
    const quantity = positive(lot.quantity, "كمية الشراء", 1_000_000_000);
    const price = positive(lot.price, "سعر الشراء");
    if (valueOrError(quantity) || valueOrError(price)) return valueOrError(quantity) ? quantity : price;
    shares += quantity;
    totalCost += quantity * price;
  }
  if (!Number.isFinite(shares) || !Number.isFinite(totalCost) || shares <= 0 || totalCost <= 0) return failure("تعذر حساب متوسط الشراء");
  const currentPriceRaw = input.currentPrice;
  if (currentPriceRaw === undefined || currentPriceRaw === null || currentPriceRaw === "") {
    return { ok: true, shares, totalCost: rounded(totalCost), averagePrice: rounded(totalCost / shares), currentPrice: null, marketValue: null, unrealized: null, unrealizedPercent: null };
  }
  const currentPrice = positive(currentPriceRaw, "السعر الحالي");
  if (valueOrError(currentPrice)) return currentPrice;
  const marketValue = shares * currentPrice;
  const unrealized = marketValue - totalCost;
  return {
    ok: true, shares, totalCost: rounded(totalCost), averagePrice: rounded(totalCost / shares), currentPrice,
    marketValue: rounded(marketValue), unrealized: rounded(unrealized), unrealizedPercent: rounded((unrealized / totalCost) * 100),
  };
}

/** 5) Current dividend yield, after-tax income and optional yield on cost. */
export function dividendYield(input: Record<string, unknown>): CalculatorResult<{
  annualDividendPerShare: number; currentPrice: number; quantity: number; taxPercent: number; costPerShare: number | null;
  yieldPercent: number; grossAnnualIncome: number; grossMonthlyIncome: number; netAnnualIncome: number; netMonthlyIncome: number; yieldOnCostPercent: number | null;
}> {
  if (!isPlainRecord(input)) return failure("بيانات التوزيعات غير صحيحة");
  const annualDividendPerShare = nonNegative(input.annualDividendPerShare, "التوزيع السنوي للسهم");
  const currentPrice = positive(input.currentPrice, "السعر الحالي");
  const quantity = positive(input.quantity, "الكمية", 1_000_000_000);
  const taxPercent = percentage(input.taxPercent ?? 0, "نسبة الضريبة", 100);
  if ([annualDividendPerShare, currentPrice, quantity, taxPercent].some(valueOrError)) {
    return [annualDividendPerShare, currentPrice, quantity, taxPercent].find(valueOrError)!;
  }
  let costPerShare: number | null = null;
  if (input.costPerShare !== undefined && input.costPerShare !== null && input.costPerShare !== "") {
    const parsedCost = positive(input.costPerShare, "تكلفة السهم");
    if (valueOrError(parsedCost)) return parsedCost;
    costPerShare = parsedCost;
  }
  const grossAnnualIncome = annualDividendPerShare * quantity;
  const netAnnualIncome = grossAnnualIncome * (1 - taxPercent / 100);
  return {
    ok: true, annualDividendPerShare, currentPrice, quantity, taxPercent, costPerShare,
    yieldPercent: rounded((annualDividendPerShare / currentPrice) * 100),
    grossAnnualIncome: rounded(grossAnnualIncome), grossMonthlyIncome: rounded(grossAnnualIncome / 12),
    netAnnualIncome: rounded(netAnnualIncome), netMonthlyIncome: rounded(netAnnualIncome / 12),
    yieldOnCostPercent: costPerShare === null ? null : rounded((annualDividendPerShare / costPerShare) * 100),
  };
}

/** 6) CAGR, capital multiplier and time to double at the computed CAGR. */
export function cagr(input: Record<string, unknown>): CalculatorResult<{
  initialValue: number; finalValue: number; years: number; multiplier: number; cagrPercent: number; doublingYears: number | null;
}> {
  if (!isPlainRecord(input)) return failure("بيانات النمو السنوي غير صحيحة");
  const initialValue = positive(input.initialValue, "القيمة الابتدائية");
  const finalValue = positive(input.finalValue, "القيمة النهائية");
  const years = positive(input.years, "عدد السنوات", 200);
  if ([initialValue, finalValue, years].some(valueOrError)) return [initialValue, finalValue, years].find(valueOrError)!;
  const multiplier = finalValue / initialValue;
  const rate = multiplier ** (1 / years) - 1;
  if (!Number.isFinite(rate) || rate <= -1) return failure("تعذر حساب معدل النمو بهذه القيم");
  const doublingYears = rate > 0 ? Math.log(2) / Math.log(1 + rate) : null;
  return { ok: true, initialValue, finalValue, years, multiplier: rounded(multiplier), cagrPercent: rounded(rate * 100), doublingYears: doublingYears === null ? null : rounded(doublingYears) };
}

/** 7) Fisher real return and inflation-adjusted purchasing power. */
export function inflationAdjustedReturn(input: Record<string, unknown>): CalculatorResult<{
  nominalReturnPercent: number; inflationPercent: number; amount: number; years: number; realReturnPercent: number; realValue: number;
}> {
  if (!isPlainRecord(input)) return failure("بيانات التضخم غير صحيحة");
  const nominalReturnPercent = percentage(input.nominalReturnPercent, "العائد الاسمي", 10_000);
  const inflationPercent = percentage(input.inflationPercent, "التضخم", 10_000);
  const amount = positive(input.amount, "المبلغ");
  const years = nonNegative(input.years, "عدد السنوات", 200);
  if ([nominalReturnPercent, inflationPercent, amount, years].some(valueOrError)) {
    return [nominalReturnPercent, inflationPercent, amount, years].find(valueOrError)!;
  }
  const realReturnPercent = (((1 + nominalReturnPercent / 100) / (1 + inflationPercent / 100)) - 1) * 100;
  const realValue = amount / ((1 + inflationPercent / 100) ** years);
  if (!Number.isFinite(realValue)) return failure("تعذر حساب القيمة الحقيقية بهذه القيم");
  return { ok: true, nominalReturnPercent, inflationPercent, amount, years, realReturnPercent: rounded(realReturnPercent), realValue: rounded(realValue) };
}

/** 8) Cross currency conversion from source-backed EGP-per-unit rates. */
export function currencyConvert(input: Record<string, unknown>): CalculatorResult<{
  amount: number; from: string; to: string; fromRate: number; toRate: number; convertedAmount: number;
}> {
  if (!isPlainRecord(input) || !isPlainRecord(input.rates)) return failure("أسعار الصرف غير متاحة حاليًا");
  const amount = nonNegative(input.amount, "المبلغ");
  const from = String(input.from || "").trim().toUpperCase();
  const to = String(input.to || "").trim().toUpperCase();
  if (valueOrError(amount)) return amount;
  if (!/^[A-Z]{3}$/.test(from) || !/^[A-Z]{3}$/.test(to)) return failure("اختر عملتين صحيحتين");
  const fromRate = positive(input.rates[from], "سعر عملة التحويل");
  const toRate = positive(input.rates[to], "سعر العملة المستهدفة");
  if (valueOrError(fromRate) || valueOrError(toRate)) return valueOrError(fromRate) ? fromRate : toRate;
  const convertedAmount = amount * fromRate / toRate;
  if (!Number.isFinite(convertedAmount) || convertedAmount > 1_000_000_000_000_000) return failure("النتيجة أكبر من الحد المسموح");
  return { ok: true, amount, from, to, fromRate, toRate, convertedAmount: rounded(convertedAmount) };
}

/**
 * Build a browser ESM payload from the exact runtime function bodies above.
 * All helpers are named functions and have no closure dependency, so the
 * protected endpoint can safely send this ES module only after hasVip().
 */
/** Normalize user-entered numerals before validation: Arabic-Indic digits
 * ٠-٩, the Arabic decimal separator ٫, thousands separators ٬/،/, and
 * whitespace. Returns a plain numeric string (or "" for blank/garbage) so the
 * labelled validators produce an honest message either way. */
export function normalizeNumericText(raw: unknown): string {
  if (typeof raw === "number") return Number.isFinite(raw) ? String(raw) : "";
  if (typeof raw !== "string") return "";
  const mapped = raw
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/٫/g, ".")
    .replace(/[،٬]/g, ",")
    .replace(/,/g, "")
    .replace(/\s+/g, "");
  if (mapped === "") return "";
  return Number.isFinite(Number(mapped)) ? String(Number(mapped)) : "";
}

/** 9) Dividend portfolio builder: with a fixed budget and an expected annual
 * dividend yield, how many whole shares can be bought, at what cost, and what
 * annual dividend income does that position produce? */
export function dividendPortfolio(input: Record<string, unknown>): CalculatorResult<{
  amount: number; price: number; yieldPercent: number; taxPercent: number | null;
  shares: number; cost: number; remaining: number; annualDividend: number; annualDividendNet: number | null;
}> {
  if (!isPlainRecord(input)) return failure("بيانات حافظة التوزيعات غير صحيحة");
  const amount = positive(input.amount, "المبلغ المتاح");
  const price = positive(input.price, "سعر السهم");
  const yieldPercent = percentage(input.yieldPercent, "عائد التوزيعات السنوي");
  const taxRaw = input.taxPercent;
  const taxBlank = taxRaw === undefined || taxRaw === null || (typeof taxRaw === "string" && taxRaw.trim() === "");
  const taxPercent = taxBlank ? null : percentage(taxRaw, "نسبة ضريبة التوزيعات");
  if ([amount, price, yieldPercent, taxPercent].some(valueOrError)) {
    return [amount, price, yieldPercent, taxPercent].find(valueOrError)!;
  }
  const shares = Math.floor((amount as number) / (price as number));
  if (shares < 1) return failure("المبلغ المتاح لا يكفي لشراء سهم واحد بالسعر المدخل");
  if (shares > 1_000_000_000) return failure("عدد الأسهم أكبر من الحد المسموح");
  const cost = (shares as number) * (price as number);
  const remaining = (amount as number) - cost;
  const annualDividend = cost * ((yieldPercent as number) / 100);
  if (!Number.isFinite(annualDividend) || annualDividend > 1_000_000_000_000_000) return failure("النتيجة أكبر من الحد المسموح");
  return {
    ok: true,
    amount: amount as number, price: price as number, yieldPercent: yieldPercent as number,
    taxPercent, shares,
    cost: rounded(cost), remaining: rounded(remaining), annualDividend: rounded(annualDividend),
    annualDividendNet: taxPercent === null ? null : rounded(annualDividend * (1 - (taxPercent as number) / 100)),
  };
}

export type FeeLine = {
  key: string;
  labelAr: string;
  side: "buy" | "sell" | "both";
  percent: number;
  minimum: number;
};

export type FeeLineDetail = FeeLine & { fee: number };

/** Validate the user's fee schedule. Blank percent/minimum mean 0 — the
 * platform never injects a rate on the user's behalf. */
function feeLines(input: Record<string, unknown>): FeeLine[] | CalculatorError {
  const raw = input.fees;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > 50) return failure("جدول الرسوم غير صحيح");
  const lines: FeeLine[] = [];
  for (const item of raw) {
    if (!isPlainRecord(item)) return failure("بند في جدول الرسوم غير صحيح");
    const key = String(item["key"] || "").trim().slice(0, 64);
    if (!key) return failure("بند في جدول الرسوم بلا معرّف");
    const side = item["side"] === "buy" || item["side"] === "sell" || item["side"] === "both" ? item["side"] : "both";
    const percentRaw = item["percent"];
    const minimumRaw = item["minimum"];
    const percent = percentRaw === undefined || percentRaw === null || percentRaw === "" ? 0 : percentage(percentRaw, "نسبة بند من الرسوم");
    const minimum = minimumRaw === undefined || minimumRaw === null || minimumRaw === "" ? 0 : nonNegative(minimumRaw, "حد أدنى لبند من الرسوم");
    if (valueOrError(percent) || valueOrError(minimum)) return valueOrError(percent) ? percent : minimum;
    lines.push({ key, labelAr: String(item["labelAr"] || key).slice(0, 80), side, percent, minimum });
  }
  return lines;
}

/** Total fees on one side: for each applicable line, max(percent × notional,
 * minimum). Pure-minimum lines (percent 0) are flat charges. */
function sideFees(lines: FeeLine[], side: "buy" | "sell", notional: number): { total: number; breakdown: FeeLineDetail[] } {
  const breakdown: FeeLineDetail[] = lines
    .filter((line) => line.side === side || line.side === "both")
    .map((line) => ({
      ...line,
      fee: rounded(Math.max((line.percent / 100) * notional, line.minimum)),
    }));
  return { total: rounded(breakdown.reduce((sum, line) => sum + line.fee, 0)), breakdown };
}

/** Break-even sell price with fees. Sell fees are piecewise linear in price
 * (each line flips from its minimum to its percent at a breakpoint), so the
 * solution is found interval by interval: inside one interval the set of
 * minimum-dominated lines is fixed and proceeds(P) is linear. */
function feeBreakEven(cost: number, quantity: number, lines: FeeLine[]): number | null {
  const sellLines = lines.filter((line) => line.side === "sell" || line.side === "both");
  if (!sellLines.length) return cost / quantity;
  const variable = sellLines.filter((line) => line.percent > 0);
  const breakpoint = (line: FeeLine): number => line.minimum / ((line.percent / 100) * quantity);
  const edges: number[] = [0, ...variable.filter((line) => line.minimum > 0).map(breakpoint).sort((a, b) => a - b), Infinity];
  for (let i = 0; i < edges.length - 1; i += 1) {
    const low = edges[i];
    const high = edges[i + 1];
    /* Inside (low, high) a variable line stays at its minimum iff its
     * breakpoint is at/above the interval's upper edge. */
    const atMin = variable.filter((line) => breakpoint(line) >= high);
    const pctPart = variable.filter((line) => !atMin.includes(line)).reduce((sum, line) => sum + line.percent / 100, 0);
    const minPart = atMin.reduce((sum, line) => sum + line.minimum, 0);
    const flatMin = sellLines.filter((line) => line.percent <= 0).reduce((sum, line) => sum + line.minimum, 0);
    const denominator = quantity * (1 - pctPart);
    if (denominator <= 0) continue; /* fees grow as fast as proceeds — no break-even */
    const candidate = (cost + minPart + flatMin) / denominator;
    const within = candidate > low && (high === Infinity ? candidate >= low : candidate < high);
    if (within) return candidate;
  }
  return null;
}

/** 10) Buy/sell with a user fee schedule: each side's fees are the sum of
 * max(percent × notional, minimum) over the lines charged on that side. */
export function feeTrade(input: Record<string, unknown>): CalculatorResult<{
  buyPrice: number; sellPrice: number; quantity: number;
  buyFeeTotal: number; sellFeeTotal: number;
  buyFees: FeeLineDetail[]; sellFees: FeeLineDetail[];
  cost: number; proceeds: number; net: number; returnPercent: number;
  breakEvenPrice: number | null;
}> {
  if (!isPlainRecord(input)) return failure("بيانات حاسبة الصفقة بالرسوم غير صحيحة");
  const buyPrice = positive(input.buyPrice, "سعر الشراء");
  const sellPrice = positive(input.sellPrice, "سعر البيع");
  const quantity = positive(input.quantity, "عدد الأسهم");
  const lines = feeLines(input);
  const firstFailure = [buyPrice, sellPrice, quantity].find(valueOrError);
  if (firstFailure) return firstFailure;
  if (!Array.isArray(lines)) return lines;
  const feeList: FeeLine[] = lines;
  const buy = sideFees(feeList, "buy", (buyPrice as number) * (quantity as number));
  const sell = sideFees(feeList, "sell", (sellPrice as number) * (quantity as number));
  const cost = (buyPrice as number) * (quantity as number) + buy.total;
  const proceeds = (sellPrice as number) * (quantity as number) - sell.total;
  if (!Number.isFinite(cost) || !Number.isFinite(proceeds) || cost <= 0 || proceeds < -1_000_000_000_000_000) {
    return failure("تعذر حساب النتيجة بهذه القيم");
  }
  const net = proceeds - cost;
  return {
    ok: true,
    buyPrice: buyPrice as number, sellPrice: sellPrice as number, quantity: quantity as number,
    buyFeeTotal: buy.total, sellFeeTotal: sell.total,
    buyFees: buy.breakdown, sellFees: sell.breakdown,
    cost: rounded(cost), proceeds: rounded(proceeds), net: rounded(net),
    returnPercent: rounded((net / cost) * 100),
    breakEvenPrice: (() => {
      const value = feeBreakEven(cost, quantity as number, feeList);
      return value === null || !Number.isFinite(value) ? null : rounded(value);
    })(),
  };
}

export function getCalculatorMathModuleSource(): string {
  const helpers = [
    failure, isPlainRecord, numberInRange, positive, nonNegative, percentage, valueOrError, rounded,
    profitLoss, positionRisk, compoundGrowth, investorSeries, thinPoints, investorProjection,
    averagePurchase, dividendYield, cagr, inflationAdjustedReturn, currencyConvert,
    normalizeNumericText, dividendPortfolio, feeLines, sideFees, feeBreakEven, feeTrade,
  ].map((fn) => fn.toString()).join("\n\n");
  /* A TypeScript/esbuild transform (tsx's keepNames, for one) prints each
   * declaration as `var f = __name(function …, "f")` and leaves that helper
   * call in the printed source. Browsers have no `__name`, so the payload
   * would throw ReferenceError while it is being evaluated — before any
   * calculator runs. The shim is exactly what esbuild itself injects. */
  const keepNamesShim = "const __name = (target, _name) => target;\n";
  return `${keepNamesShim}${helpers}\n\nexport { profitLoss, positionRisk, compoundGrowth, investorProjection, averagePurchase, dividendYield, cagr, inflationAdjustedReturn, currencyConvert, normalizeNumericText, dividendPortfolio, feeTrade };\n`;
}
