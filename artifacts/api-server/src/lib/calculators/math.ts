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
export function getCalculatorMathModuleSource(): string {
  const helpers = [
    failure, isPlainRecord, numberInRange, positive, nonNegative, percentage, valueOrError, rounded,
    profitLoss, positionRisk, compoundGrowth, averagePurchase, dividendYield, cagr, inflationAdjustedReturn, currencyConvert,
  ].map((fn) => fn.toString()).join("\n\n");
  return `${helpers}\n\nexport { profitLoss, positionRisk, compoundGrowth, averagePurchase, dividendYield, cagr, inflationAdjustedReturn, currencyConvert };\n`;
}
