// @ts-nocheck
/*
 * VIP browser runtime. This file is never linked from the public SPA: the
 * router serializes this exact function only after requireVipUser has passed.
 * It intentionally keeps calculation math in /calculators/math.js, another
 * separately protected module generated from the tested pure functions.
 */

export function mountCalculatorRuntime(root: HTMLElement): void {
  const API = "/api/calculators";
  const numberFormatter = new Intl.NumberFormat("ar-EG", { maximumFractionDigits: 2, minimumFractionDigits: 2 });
  const compactFormatter = new Intl.NumberFormat("ar-EG", { maximumFractionDigits: 4 });
  const calculatorList = [
    { key: "pl", title: "الربح والخسارة", icon: "↗", subtitle: "صافي الصفقة ونقطة التعادل", formula: "التكلفة = الشراء × الكمية × (1 + العمولة) · المتحصلات = البيع × الكمية × (1 − العمولة)" },
    { key: "risk", title: "حجم المركز والمخاطرة", icon: "◈", subtitle: "كم سهم تشتري مقابل وقف الخسارة", formula: "الكمية = أرضية(مبلغ المخاطرة ÷ |الدخول − وقف الخسارة|)" },
    { key: "compound", title: "العائد المركب", icon: "◌", subtitle: "نمو الاستثمار مع إضافات شهرية", formula: "القيمة = الأصل × (1 + r)^n + الإضافة × (((1 + r)^n − 1) ÷ r)" },
    { key: "average", title: "متوسط الشراء", icon: "≋", subtitle: "متوسطك المرجّح وربحك غير المحقق", formula: "المتوسط = إجمالي تكلفة الشراء ÷ إجمالي عدد الأسهم" },
    { key: "dividend", title: "عائد التوزيعات", icon: "٪", subtitle: "الدخل والعائد بعد الضريبة", formula: "العائد = التوزيع السنوي للسهم ÷ السعر الحالي × 100" },
    { key: "cagr", title: "CAGR ومضاعف رأس المال", icon: "⌁", subtitle: "النمو السنوي المركب ومدة المضاعفة", formula: "CAGR = (القيمة النهائية ÷ الابتدائية)^(1 ÷ السنوات) − 1" },
    { key: "inflation", title: "العائد الحقيقي بعد التضخم", icon: "◒", subtitle: "القوة الشرائية لا الرقم الاسمي فقط", formula: "العائد الحقيقي = (1 + العائد الاسمي) ÷ (1 + التضخم) − 1" },
    { key: "fx", title: "محول العملات", icon: "⇄", subtitle: "تحويل بسعر مصدره طبقة البيانات", formula: "المبلغ المستهدف = المبلغ × سعر العملة الأصلية بالجنيه ÷ سعر العملة المستهدفة بالجنيه" },
  ];
  const calculatorByKey = Object.fromEntries(calculatorList.map((calculator) => [calculator.key, calculator]));
  const defaults = {
    pl: { buyPrice: "", sellPrice: "", quantity: "", commissionPercent: "0", quoteSymbol: "" },
    risk: { capital: "", riskPercent: "1", entryPrice: "", stopPrice: "", targetPrice: "", quoteSymbol: "" },
    compound: { initialAmount: "", annualReturnPercent: "", monthlyContribution: "0", months: "12" },
    average: { lots: [{ quantity: "", price: "" }], currentPrice: "", quoteSymbol: "" },
    dividend: { annualDividendPerShare: "", currentPrice: "", quantity: "", taxPercent: "0", costPerShare: "", quoteSymbol: "" },
    cagr: { initialValue: "", finalValue: "", years: "" },
    inflation: { nominalReturnPercent: "", inflationPercent: "", amount: "", years: "" },
    fx: { amount: "", from: "EGP", to: "USD" },
  };
  const state = {
    active: "pl",
    inputs: JSON.parse(JSON.stringify(defaults)),
    result: null,
    math: null,
    scenarios: [],
    history: [],
    scenarioError: "",
    historyError: "",
    fx: { rates: null, metadata: null, loading: false, error: "" },
    quoteNotice: "",
    busy: false,
  };

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#039;", '"': "&quot;" })[character]);
  }

  function formatNumber(value, digits = 2) {
    if (typeof value !== "number" || !Number.isFinite(value)) return "—";
    if (digits === 4) return compactFormatter.format(value);
    return numberFormatter.format(value);
  }

  function formatPercent(value, digits = 2) {
    if (typeof value !== "number" || !Number.isFinite(value)) return "—";
    const formatter = digits === 4 ? compactFormatter : numberFormatter;
    return `${value > 0 ? "+" : ""}${formatter.format(value)}٪`;
  }

  function valueClass(value) {
    if (typeof value !== "number") return "";
    return value > 0 ? "positive" : value < 0 ? "negative" : "neutral";
  }

  function displayTime(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return "الوقت غير متاح";
    return new Intl.DateTimeFormat("ar-EG", { timeZone: "Africa/Cairo", dateStyle: "medium", timeStyle: "short" }).format(date);
  }

  function getActiveCalculator() {
    return calculatorByKey[state.active];
  }

  function inputValue(id) {
    const field = root.querySelector(`#calc-${id}`);
    return field ? field.value : "";
  }

  function setInputValue(id, value) {
    const field = root.querySelector(`#calc-${id}`);
    if (field) field.value = value === null || value === undefined ? "" : String(value);
  }

  function inputControl(id, label, options = {}) {
    const { value = "", hint = "", min = "0", step = "any", required = true, suffix = "", liveTarget = "", wide = false } = options;
    return `<label class="calc-field ${wide ? "wide" : ""}">
      <span>${escapeHtml(label)}${required ? " <b aria-hidden=\"true\">*</b>" : ""}</span>
      <div class="calc-input-wrap">
        <input id="calc-${escapeHtml(id)}" data-input="${escapeHtml(id)}" inputmode="decimal" type="number" min="${escapeHtml(min)}" step="${escapeHtml(step)}" value="${escapeHtml(value)}" ${required ? "required" : ""} />
        ${suffix ? `<em>${escapeHtml(suffix)}</em>` : ""}
        ${liveTarget ? `<button class="calc-live-price" type="button" data-live-price="${escapeHtml(liveTarget)}" title="استخدم سعرًا حاليًا من المصدر">استخدم السعر الحالي</button>` : ""}
      </div>
      ${hint ? `<small>${escapeHtml(hint)}</small>` : ""}
    </label>`;
  }

  function textControl(id, label, options = {}) {
    const { value = "", placeholder = "", hint = "", wide = false } = options;
    return `<label class="calc-field ${wide ? "wide" : ""}">
      <span>${escapeHtml(label)}</span>
      <div class="calc-input-wrap"><input id="calc-${escapeHtml(id)}" data-input="${escapeHtml(id)}" type="text" maxlength="24" autocomplete="off" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}" /></div>
      ${hint ? `<small>${escapeHtml(hint)}</small>` : ""}
    </label>`;
  }

  function selectControl(id, label, value, options) {
    return `<label class="calc-field"><span>${escapeHtml(label)}</span><div class="calc-input-wrap"><select id="calc-${escapeHtml(id)}" data-input="${escapeHtml(id)}">${options.map((option) => `<option value="${escapeHtml(option.value)}" ${String(option.value) === String(value) ? "selected" : ""}>${escapeHtml(option.label)}</option>`).join("")}</select></div></label>`;
  }

  function formFor(key) {
    const input = state.inputs[key];
    if (key === "pl") return `<div class="calc-form-grid">
      ${inputControl("buyPrice", "سعر الشراء", { value: input.buyPrice, liveTarget: "buyPrice" })}
      ${inputControl("sellPrice", "سعر البيع", { value: input.sellPrice, liveTarget: "sellPrice" })}
      ${inputControl("quantity", "عدد الأسهم", { value: input.quantity, step: "1" })}
      ${inputControl("commissionPercent", "العمولة لكل جانب", { value: input.commissionPercent, suffix: "%", required: false })}
      ${textControl("quoteSymbol", "رمز السهم لاستخدام السعر الحالي", { value: input.quoteSymbol, placeholder: "مثال: COMI", hint: "يُقبل رمز مدعوم من سوق EGX فقط." })}
    </div>`;
    if (key === "risk") return `<div class="calc-form-grid">
      ${inputControl("capital", "رأس المال المتاح", { value: input.capital, suffix: "جنيه" })}
      ${inputControl("riskPercent", "المخاطرة من رأس المال", { value: input.riskPercent, suffix: "%" })}
      ${inputControl("entryPrice", "سعر الدخول", { value: input.entryPrice, liveTarget: "entryPrice" })}
      ${inputControl("stopPrice", "وقف الخسارة", { value: input.stopPrice })}
      ${inputControl("targetPrice", "سعر الهدف", { value: input.targetPrice })}
      ${textControl("quoteSymbol", "رمز السهم لاستخدام السعر الحالي", { value: input.quoteSymbol, placeholder: "مثال: COMI" })}
    </div>`;
    if (key === "compound") return `<div class="calc-form-grid">
      ${inputControl("initialAmount", "المبلغ الابتدائي", { value: input.initialAmount, suffix: "جنيه", min: "0", required: false })}
      ${inputControl("annualReturnPercent", "العائد السنوي المتوقع", { value: input.annualReturnPercent, suffix: "%", min: "0" })}
      ${inputControl("monthlyContribution", "إضافة نهاية كل شهر", { value: input.monthlyContribution, suffix: "جنيه", min: "0", required: false })}
      ${inputControl("months", "المدة", { value: input.months, suffix: "شهر", step: "1" })}
    </div>`;
    if (key === "average") return `<div class="calc-average-lots">
      <div class="lot-header"><span>عمليات الشراء</span><button type="button" class="calc-mini-button" data-add-lot>+ إضافة صف</button></div>
      <div id="calc-lots">${input.lots.map((lot, index) => `<div class="calc-lot-row">
        <label><span>الكمية</span><input data-lot-quantity="${index}" inputmode="decimal" type="number" min="0" step="1" value="${escapeHtml(lot.quantity)}"></label>
        <label><span>سعر الشراء</span><input data-lot-price="${index}" inputmode="decimal" type="number" min="0" step="any" value="${escapeHtml(lot.price)}"></label>
        <button type="button" data-remove-lot="${index}" class="calc-remove" aria-label="حذف صف الشراء">×</button>
      </div>`).join("")}</div>
      <div class="calc-form-grid average-bottom">
        ${inputControl("currentPrice", "السعر الحالي", { value: input.currentPrice, liveTarget: "currentPrice", required: false })}
        ${textControl("quoteSymbol", "رمز السهم لاستخدام السعر الحالي", { value: input.quoteSymbol, placeholder: "مثال: COMI" })}
      </div>
    </div>`;
    if (key === "dividend") return `<div class="calc-form-grid">
      ${inputControl("annualDividendPerShare", "التوزيع السنوي للسهم", { value: input.annualDividendPerShare, min: "0" })}
      ${inputControl("currentPrice", "السعر الحالي", { value: input.currentPrice, liveTarget: "currentPrice" })}
      ${inputControl("quantity", "عدد الأسهم", { value: input.quantity, step: "1" })}
      ${inputControl("taxPercent", "الضريبة", { value: input.taxPercent, suffix: "%", required: false })}
      ${inputControl("costPerShare", "تكلفة السهم (لعائد التكلفة)", { value: input.costPerShare, required: false })}
      ${textControl("quoteSymbol", "رمز السهم لاستخدام السعر الحالي", { value: input.quoteSymbol, placeholder: "مثال: COMI" })}
    </div>`;
    if (key === "cagr") return `<div class="calc-form-grid">
      ${inputControl("initialValue", "القيمة الابتدائية", { value: input.initialValue })}
      ${inputControl("finalValue", "القيمة النهائية", { value: input.finalValue })}
      ${inputControl("years", "عدد السنوات", { value: input.years, step: "0.1" })}
    </div>`;
    if (key === "inflation") return `<div class="calc-form-grid">
      ${inputControl("nominalReturnPercent", "العائد الاسمي", { value: input.nominalReturnPercent, suffix: "%", min: "0" })}
      ${inputControl("inflationPercent", "معدل التضخم", { value: input.inflationPercent, suffix: "%", min: "0" })}
      ${inputControl("amount", "المبلغ اليوم", { value: input.amount })}
      ${inputControl("years", "عدد السنوات", { value: input.years, step: "1", min: "0" })}
    </div>`;
    const currencies = [
      { value: "EGP", label: "جنيه مصري (EGP)" }, { value: "USD", label: "دولار أمريكي (USD)" },
      { value: "EUR", label: "يورو (EUR)" }, { value: "GBP", label: "جنيه إسترليني (GBP)" }, { value: "SAR", label: "ريال سعودي (SAR)" },
    ];
    return `<div class="calc-form-grid">
      ${inputControl("amount", "المبلغ", { value: input.amount, min: "0" })}
      ${selectControl("from", "من عملة", input.from, currencies)}
      ${selectControl("to", "إلى عملة", input.to, currencies)}
      <div class="calc-field calc-fx-source wide"><span>سعر الصرف</span><div id="calc-fx-meta">${fxMetaMarkup()}</div><button type="button" class="calc-mini-button" data-refresh-fx>تحديث من المصدر</button></div>
    </div>`;
  }

  function fxMetaMarkup() {
    if (state.fx.loading) return "جارٍ التحقق من المصدر…";
    if (state.fx.error) return `<span class="calc-data-unavailable">${escapeHtml(state.fx.error)}</span>`;
    if (!state.fx.metadata) return "يُحمّل عند فتح المحول";
    const meta = state.fx.metadata;
    const delay = meta.delayed ? '<strong class="stale-tag">متأخر</strong>' : '<strong class="fresh-tag">محدّث</strong>';
    return `${delay} <span>${escapeHtml(meta.source)} · ${escapeHtml(meta.asOf)}</span>`;
  }

  function navMarkup() {
    return calculatorList.map((calculator) => `<button type="button" class="calc-nav-item ${calculator.key === state.active ? "active" : ""}" data-calculator="${calculator.key}">
      <i>${calculator.icon}</i><span><b>${calculator.title}</b><small>${calculator.subtitle}</small></span>
    </button>`).join("");
  }

  function shellMarkup() {
    const active = getActiveCalculator();
    return `<style>${styles()}</style>
    <section class="calc-app" aria-label="حاسبات المستثمر">
      <div class="calc-topline"><span class="calc-vip-badge">VIP</span><span>كل الحسابات تعمل محليًا بعد تحميل أدوات المشتركين</span></div>
      <div class="calc-layout">
        <aside class="calc-sidebar"><h2>حاسبات المستثمر</h2><p>اختَر الأداة المناسبة لقرارك.</p>${navMarkup()}</aside>
        <main class="calc-main">
          <div class="calc-mobile-select"><label for="calc-mobile-picker">الحاسبة</label><select id="calc-mobile-picker">${calculatorList.map((calculator) => `<option value="${calculator.key}" ${calculator.key === state.active ? "selected" : ""}>${calculator.title}</option>`).join("")}</select></div>
          <header class="calc-header"><div><span class="calc-eyebrow">أدوات المستثمر</span><h2>${active.title}</h2><p>${active.subtitle}</p></div><div class="calc-header-actions"><button type="button" class="calc-soft-button" data-reset>إعادة ضبط</button><button type="button" class="calc-soft-button" data-show-scenarios>السيناريوهات</button><button type="button" class="calc-soft-button" data-show-history>آخر العمليات</button></div></header>
          <section class="calc-card calc-input-card"><h3>البيانات</h3>${formFor(state.active)}<div id="calc-quote-notice" class="calc-quote-notice" aria-live="polite">${state.quoteNotice}</div></section>
          <section id="calc-output" class="calc-card calc-output" aria-live="polite">${resultMarkup()}</section>
          <section class="calc-card calc-formula"><h3>طريقة الحساب</h3><code>${escapeHtml(active.formula)}</code><p>يتم تحديث النتيجة فور إدخال قيم صحيحة. لا تُرسل مدخلاتك للحساب إلى الخادم.</p></section>
          <aside id="calc-scenarios-panel" class="calc-history-panel" hidden></aside>
          <aside id="calc-history-panel" class="calc-history-panel" hidden></aside>
          <p class="calc-disclaimer">النتائج تقديرية ولا تمثل نصيحة استثمارية.</p>
        </main>
      </div>
    </section>`;
  }

  function statistic(label, value, tone = "") {
    return `<div class="calc-stat ${tone}"><span>${escapeHtml(label)}</span><b>${value}</b></div>`;
  }

  function monetary(value) { return `${formatNumber(value)} ج.م`; }
  function percentageText(value) { return formatPercent(value); }

  function compoundChart(series) {
    if (!Array.isArray(series) || series.length < 2) return "";
    const width = 600; const height = 175; const pad = 16;
    const max = Math.max(...series.map((point) => Math.max(point.balance, point.contributions)), 1);
    const path = (field) => series.map((point, index) => {
      const x = pad + (index / (series.length - 1)) * (width - pad * 2);
      const y = height - pad - (point[field] / max) * (height - pad * 2);
      return `${index ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
    }).join(" ");
    return `<div class="calc-chart-wrap"><div class="calc-chart-key"><span><i class="balance"></i>القيمة</span><span><i class="contrib"></i>المساهمات</span></div><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="رسم نمو الاستثمار مقابل المساهمات"><path class="grid" d="M${pad} ${height - pad}H${width - pad}"/><path class="contrib-line" d="${path("contributions")}"/><path class="balance-line" d="${path("balance")}"/></svg></div>`;
  }

  function yearlyTable(rows) {
    if (!Array.isArray(rows) || !rows.length) return "";
    return `<div class="calc-table-wrap"><table><thead><tr><th>السنة</th><th>القيمة</th><th>المساهمات</th><th>النمو</th></tr></thead><tbody>${rows.map((row) => `<tr><td>${formatNumber(row.year, 0)}</td><td>${monetary(row.balance)}</td><td>${monetary(row.contributions)}</td><td class="${valueClass(row.growth)}">${monetary(row.growth)}</td></tr>`).join("")}</tbody></table></div>`;
  }

  function resultMarkup() {
    const result = state.result;
    if (!result) return `<div class="calc-empty-result"><span>⌁</span><h3>أدخل بيانات الحاسبة</h3><p>ستظهر النتيجة والتفاصيل فور صحة القيم.</p></div>`;
    if (!result.ok) return `<div class="calc-error-result"><span>!</span><h3>راجِع البيانات</h3><p>${escapeHtml(result.error || "تعذر حساب النتيجة")}</p></div>`;
    const key = state.active;
    let primary = "";
    let details = "";
    if (key === "pl") {
      primary = `<span>صافي الربح / الخسارة</span><b class="${valueClass(result.net)}">${monetary(result.net)}</b><small class="${valueClass(result.returnPercent)}">${percentageText(result.returnPercent)}</small>`;
      details = statistic("إجمالي التكلفة", monetary(result.cost)) + statistic("متحصلات البيع", monetary(result.proceeds)) + statistic("نقطة التعادل", monetary(result.breakEvenPrice));
    } else if (key === "risk") {
      primary = `<span>حجم المركز المقترح</span><b>${formatNumber(result.quantity, 0)} سهم</b><small>${result.direction === "long" ? "صفقة شراء" : "صفقة بيع"} · مخاطرة ${monetary(result.riskAmount)}</small>`;
      const rr = result.riskReward === null ? "غير صالح" : `R:R ${formatNumber(result.riskReward, 2)}`;
      details = statistic("قيمة المركز", monetary(result.positionValue), result.positionValue > result.capital ? "negative" : "") + statistic("من رأس المال", percentageText(result.positionPercent)) + statistic("الهدف", rr) + statistic("ربح الهدف", result.expectedProfit === null ? "—" : monetary(result.expectedProfit), valueClass(result.expectedProfit));
      details += `<div class="calc-targets"><b>أهداف 1R / 2R / 3R</b>${result.targets.map((target) => `<span>${target.multiple}R: <strong>${formatNumber(target.price)}</strong> <small>(${monetary(target.expectedProfit)})</small></span>`).join("")}</div>`;
      if (result.warning) details += `<div class="calc-warning">${escapeHtml(result.warning)}</div>`;
    } else if (key === "compound") {
      primary = `<span>القيمة المستقبلية التقديرية</span><b>${monetary(result.balance)}</b><small class="${valueClass(result.growth)}">النمو: ${monetary(result.growth)}</small>`;
      details = statistic("إجمالي المساهمات", monetary(result.contributions)) + statistic("العائد الشهري", percentageText(result.monthlyRate * 100, 4)) + statistic("المدة", `${formatNumber(result.months, 0)} شهر`);
      details += compoundChart(result.monthlySeries) + yearlyTable(result.yearlyRows);
    } else if (key === "average") {
      primary = `<span>متوسط سعر الشراء</span><b>${monetary(result.averagePrice)}</b><small>${formatNumber(result.shares, 0)} سهم</small>`;
      details = statistic("إجمالي التكلفة", monetary(result.totalCost));
      if (result.currentPrice !== null) details += statistic("القيمة السوقية", monetary(result.marketValue)) + statistic("غير محقق", `${monetary(result.unrealized)} · ${percentageText(result.unrealizedPercent)}`, valueClass(result.unrealized));
    } else if (key === "dividend") {
      primary = `<span>عائد التوزيعات الحالي</span><b>${percentageText(result.yieldPercent)}</b><small>قبل الضريبة</small>`;
      details = statistic("الدخل السنوي الإجمالي", monetary(result.grossAnnualIncome)) + statistic("الدخل الشهري الإجمالي", monetary(result.grossMonthlyIncome)) + statistic("الصافي السنوي", monetary(result.netAnnualIncome), "positive") + statistic("الصافي الشهري", monetary(result.netMonthlyIncome), "positive") + statistic("Yield on cost", result.yieldOnCostPercent === null ? "أدخل تكلفة السهم" : percentageText(result.yieldOnCostPercent));
    } else if (key === "cagr") {
      primary = `<span>النمو السنوي المركب</span><b>${percentageText(result.cagrPercent)}</b><small>مضاعف رأس المال ${formatNumber(result.multiplier, 2)}×</small>`;
      details = statistic("مضاعف رأس المال", `${formatNumber(result.multiplier, 2)}×`) + statistic("مدة المضاعفة", result.doublingYears === null ? "لا يتضاعف بعائد غير موجب" : `${formatNumber(result.doublingYears, 2)} سنة`) + statistic("المدة المدخلة", `${formatNumber(result.years, 2)} سنة`);
    } else if (key === "inflation") {
      primary = `<span>العائد الحقيقي بعد التضخم</span><b class="${valueClass(result.realReturnPercent)}">${percentageText(result.realReturnPercent)}</b><small>وفق معادلة فيشر</small>`;
      details = statistic("القيمة الحقيقية مستقبلًا", monetary(result.realValue), valueClass(result.realValue - result.amount)) + statistic("العائد الاسمي", percentageText(result.nominalReturnPercent)) + statistic("التضخم", percentageText(result.inflationPercent));
    } else if (key === "fx") {
      primary = `<span>القيمة المحوّلة</span><b>${formatNumber(result.convertedAmount)} ${escapeHtml(result.to)}</b><small>${formatNumber(result.amount)} ${escapeHtml(result.from)}</small>`;
      details = statistic(`سعر ${result.from} بالجنيه`, formatNumber(result.fromRate, 4)) + statistic(`سعر ${result.to} بالجنيه`, formatNumber(result.toRate, 4));
      if (state.fx.metadata) {
        const sourceMeta = state.fx.metadata.rateMetadata || {};
        const exactRateMeta = (currency) => sourceMeta[currency]
          ? `${escapeHtml(currency)}: <strong>${escapeHtml(sourceMeta[currency].source)}</strong> · ${escapeHtml(sourceMeta[currency].asOf)}${sourceMeta[currency].delayed ? ' <span class="stale-tag">متأخر</span>' : ""}`
          : `${escapeHtml(currency)}: قيمة تعريفية (1 جنيه مصري)`;
        details += `<div class="calc-source-detail">${exactRateMeta(result.from)}<br>${exactRateMeta(result.to)}</div>`;
      }
    }
    return `<div class="calc-primary ${key}">${primary}</div><div class="calc-stats">${details}</div><div class="calc-result-actions"><button type="button" class="calc-primary-button" data-copy>نسخ النتيجة</button><button type="button" class="calc-soft-button" data-save>حفظ سيناريو</button><button type="button" class="calc-soft-button" data-pdf>طباعة / حفظ PDF</button></div>`;
  }

  function readCurrentInputs() {
    const key = state.active;
    const input = state.inputs[key];
    if (key === "average") {
      return { lots: input.lots.map((lot) => ({ quantity: lot.quantity, price: lot.price })), currentPrice: input.currentPrice };
    }
    if (key === "fx") return { amount: input.amount, from: input.from, to: input.to, rates: state.fx.rates || {} };
    const output = {};
    Object.keys(input).forEach((property) => { if (property !== "quoteSymbol") output[property] = input[property]; });
    return output;
  }

  function calculate() {
    if (!state.math) return;
    const input = readCurrentInputs();
    const fn = {
      pl: state.math.profitLoss, risk: state.math.positionRisk, compound: state.math.compoundGrowth,
      average: state.math.averagePurchase, dividend: state.math.dividendYield, cagr: state.math.cagr,
      inflation: state.math.inflationAdjustedReturn, fx: state.math.currencyConvert,
    }[state.active];
    try {
      state.result = fn ? fn(input) : { ok: false, error: "الحاسبة غير متاحة" };
    } catch {
      state.result = { ok: false, error: "تعذر إجراء الحساب. راجِع الأرقام المدخلة." };
    }
    const output = root.querySelector("#calc-output");
    if (output) output.innerHTML = resultMarkup();
    bindOutputEvents();
  }

  function updateInput(event) {
    const element = event.target;
    if (!element || !element.dataset) return;
    const key = state.active;
    if (element.dataset.input) state.inputs[key][element.dataset.input] = element.value;
    if (element.dataset.lotQuantity !== undefined) state.inputs.average.lots[Number(element.dataset.lotQuantity)].quantity = element.value;
    if (element.dataset.lotPrice !== undefined) state.inputs.average.lots[Number(element.dataset.lotPrice)].price = element.value;
    calculate();
  }

  function rerender() {
    root.innerHTML = shellMarkup();
    bindShellEvents();
    calculate();
    if (state.active === "fx" && !state.fx.rates && !state.fx.loading) loadFxRates();
    loadScenarios();
  }

  function switchCalculator(key) {
    if (!calculatorByKey[key]) return;
    state.active = key;
    state.result = null;
    state.quoteNotice = "";
    rerender();
  }

  function bindShellEvents() {
    root.querySelectorAll("[data-calculator]").forEach((button) => button.addEventListener("click", () => switchCalculator(button.dataset.calculator)));
    const mobilePicker = root.querySelector("#calc-mobile-picker");
    if (mobilePicker) mobilePicker.addEventListener("change", (event) => switchCalculator(event.target.value));
    root.querySelectorAll("[data-input], [data-lot-quantity], [data-lot-price]").forEach((field) => field.addEventListener("input", updateInput));
    root.querySelectorAll("[data-live-price]").forEach((button) => button.addEventListener("click", () => applyLivePrice(button.dataset.livePrice)));
    const addLot = root.querySelector("[data-add-lot]");
    if (addLot) addLot.addEventListener("click", () => { if (state.inputs.average.lots.length < 1_500) { state.inputs.average.lots.push({ quantity: "", price: "" }); rerender(); } else toast("وصلت لحد الأمان للحساب في جلسة واحدة.", "error"); });
    root.querySelectorAll("[data-remove-lot]").forEach((button) => button.addEventListener("click", () => { const index = Number(button.dataset.removeLot); if (state.inputs.average.lots.length > 1) { state.inputs.average.lots.splice(index, 1); rerender(); } }));
    const reset = root.querySelector("[data-reset]");
    if (reset) reset.addEventListener("click", () => { state.inputs[state.active] = JSON.parse(JSON.stringify(defaults[state.active])); state.result = null; state.quoteNotice = ""; rerender(); });
    const scenariosButton = root.querySelector("[data-show-scenarios]");
    if (scenariosButton) scenariosButton.addEventListener("click", toggleScenarios);
    const historyButton = root.querySelector("[data-show-history]");
    if (historyButton) historyButton.addEventListener("click", toggleHistory);
    const refreshFx = root.querySelector("[data-refresh-fx]");
    if (refreshFx) refreshFx.addEventListener("click", () => loadFxRates(true));
  }

  function bindOutputEvents() {
    const copy = root.querySelector("[data-copy]"); if (copy) copy.addEventListener("click", copyResult);
    const save = root.querySelector("[data-save]"); if (save) save.addEventListener("click", saveScenario);
    const pdf = root.querySelector("[data-pdf]"); if (pdf) pdf.addEventListener("click", printResult);
  }

  async function apiFetch(path, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(`${API}${path}`, { credentials: "same-origin", headers: { "Content-Type": "application/json", ...(options.headers || {}) }, ...options, signal: controller.signal });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || "تعذر الاتصال بالخدمة");
      return payload;
    } finally { clearTimeout(timer); }
  }

  async function applyLivePrice(target) {
    const symbol = String(state.inputs[state.active].quoteSymbol || "").trim().toUpperCase();
    if (!symbol) { state.quoteNotice = "اكتب رمز سهم EGX أولًا ثم جرّب مرة أخرى."; refreshQuoteNotice(); return; }
    state.quoteNotice = "جارٍ طلب السعر من المصدر…"; refreshQuoteNotice();
    try {
      const payload = await apiFetch(`/quote?symbol=${encodeURIComponent(symbol)}`);
      const price = payload?.quote?.price;
      if (typeof price !== "number") throw new Error("السعر غير متاح حاليًا");
      state.inputs[state.active][target] = String(price);
      const freshness = payload.quote.delayed ? "متأخر — ليس سعرًا لحظيًا" : "محدّث";
      state.quoteNotice = `<span class="${payload.quote.delayed ? "stale-tag" : "fresh-tag"}">${freshness}</span> تم استخدام ${formatNumber(price)} ${escapeHtml(payload.quote.currency || "")}: ${escapeHtml(payload.quote.source)} · ${escapeHtml(payload.quote.asOf)}`;
      setInputValue(target, price);
      calculate();
    } catch (error) {
      state.quoteNotice = `السعر الحالي غير متاح حاليًا. يمكنك إدخال السعر يدويًا. ${escapeHtml(error.message || "")}`;
    }
    refreshQuoteNotice();
  }

  function refreshQuoteNotice() {
    const notice = root.querySelector("#calc-quote-notice");
    if (notice) notice.innerHTML = state.quoteNotice;
  }

  async function loadFxRates(force = false) {
    if (state.fx.loading) return;
    state.fx.loading = true; state.fx.error = "";
    rerenderFxMeta();
    try {
      const payload = await apiFetch(`/fx${force ? "?refresh=1" : ""}`);
      if (!payload.available || !payload.rates) throw new Error(payload.message || "أسعار الصرف غير متاحة حاليًا");
      state.fx.rates = payload.rates;
      state.fx.metadata = payload.metadata || null;
      state.fx.error = "";
    } catch (error) {
      state.fx.rates = null;
      state.fx.metadata = null;
      state.fx.error = `أسعار الصرف غير متاحة حاليًا. لا يتم استخدام سعر بديل أو ثابت. ${error.message || ""}`;
    } finally {
      state.fx.loading = false;
      rerenderFxMeta();
      calculate();
    }
  }

  function rerenderFxMeta() {
    const node = root.querySelector("#calc-fx-meta"); if (node) node.innerHTML = fxMetaMarkup();
  }

  function copyText() {
    const result = state.result;
    const title = getActiveCalculator().title;
    const primary = root.querySelector(".calc-primary");
    const text = `${title}\n${primary ? primary.innerText : ""}\nالنتائج تقديرية ولا تمثل نصيحة استثمارية.`;
    return text;
  }

  async function copyResult() {
    try {
      const text = copyText();
      if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
      else {
        const textarea = document.createElement("textarea"); textarea.value = text; document.body.appendChild(textarea); textarea.select(); document.execCommand("copy"); textarea.remove();
      }
      const logged = await recordActivity("copied");
      toast(logged ? "تم نسخ النتيجة." : "تم نسخ النتيجة، لكن تعذر حفظها في سجل العمليات.", logged ? "success" : "error");
    } catch { toast("تعذر النسخ تلقائيًا. حدّد النص وانسخه يدويًا.", "error"); }
  }

  function cleanPayload(value) {
    return JSON.parse(JSON.stringify(value));
  }

  /* Chart points are reproducible from the saved inputs. Persisting only the
     summary keeps server payloads bounded without changing the shown result. */
  function resultForPersistence() {
    const summary = cleanPayload(state.result);
    delete summary.monthlySeries;
    delete summary.yearlyRows;
    return summary;
  }

  async function saveScenario() {
    if (!state.result || !state.result.ok) { toast("أدخل بيانات صحيحة قبل الحفظ.", "error"); return; }
    const name = window.prompt("اكتب اسمًا واضحًا للسيناريو (حتى 80 حرفًا):");
    if (name === null) return;
    if (!name.trim()) { toast("اسم السيناريو مطلوب.", "error"); return; }
    try {
      await apiFetch("/scenarios", { method: "POST", body: JSON.stringify({ calculatorKey: state.active, name: name.trim(), inputs: cleanPayload(readCurrentInputs()), result: resultForPersistence() }) });
      toast("اتحفظ السيناريو بأمان في حسابك.", "success");
      loadScenarios();
    } catch (error) { toast(`تعذر حفظ السيناريو: ${error.message || "حاول مرة أخرى"}`, "error"); }
  }

  async function recordActivity(action) {
    if (!state.result || !state.result.ok) return false;
    try {
      await apiFetch("/history", { method: "POST", body: JSON.stringify({ calculatorKey: state.active, action, inputs: cleanPayload(readCurrentInputs()), result: resultForPersistence() }) });
      return true;
    } catch { return false; }
  }

  async function printResult() {
    if (!state.result || !state.result.ok) { toast("أدخل بيانات صحيحة قبل التصدير.", "error"); return; }
    const printable = root.querySelector(".calc-output");
    if (!printable) return;
    /* Open synchronously from the click so browsers keep the popup gesture,
       then authorize the actual export server-side before putting data in it. */
    const popup = window.open("", "calculator-pdf", "width=820,height=900");
    if (!popup) { toast("السماح بالنوافذ المنبثقة مطلوب لفتح خيار حفظ PDF.", "error"); return; }
    try {
      await apiFetch("/export", { method: "POST", body: JSON.stringify({ calculatorKey: state.active, inputs: cleanPayload(readCurrentInputs()), result: resultForPersistence() }) });
    } catch (error) {
      popup.close();
      toast(`تعذر تأكيد التصدير: ${error.message || "حاول مرة أخرى"}`, "error");
      return;
    }
    const title = escapeHtml(getActiveCalculator().title);
    popup.document.write(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>${title}</title><style>body{font-family:Arial,sans-serif;padding:34px;color:#11243a;direction:rtl}h1{color:#096b5b}.calc-result-actions{display:none}.calc-output{border:1px solid #dce7e3;border-radius:18px;padding:22px}.calc-primary b{display:block;font-size:32px;margin:10px 0}.calc-stats{display:flex;flex-wrap:wrap;gap:10px}.calc-stat{border:1px solid #e0e7e5;border-radius:10px;padding:12px;min-width:150px}.calc-stat span,.calc-stat b{display:block}.positive{color:#08754f}.negative{color:#bd3345}.calc-disclaimer{margin-top:24px;color:#687784}.calc-table-wrap table{width:100%;border-collapse:collapse;margin-top:16px}.calc-table-wrap th,.calc-table-wrap td{padding:8px;border-bottom:1px solid #ddd;text-align:right}@media print{body{padding:0}}</style></head><body><h1>${title}</h1>${printable.innerHTML}<p class="calc-disclaimer">النتائج تقديرية ولا تمثل نصيحة استثمارية.</p></body></html>`);
    popup.document.close();
    setTimeout(() => { popup.focus(); popup.print(); }, 250);
    toast("افتح نافذة الطباعة واختر «حفظ كـ PDF».", "success");
  }

  async function loadScenarios() {
    try {
      const payload = await apiFetch(`/scenarios?calculator=${encodeURIComponent(state.active)}`);
      state.scenarios = Array.isArray(payload.scenarios) ? payload.scenarios : [];
      state.scenarioError = "";
    } catch (error) {
      state.scenarios = [];
      state.scenarioError = error.message || "تعذر تحميل السيناريوهات حاليًا.";
    }
  }

  async function toggleScenarios() {
    const panel = root.querySelector("#calc-scenarios-panel");
    if (!panel) return;
    if (!panel.hidden) { panel.hidden = true; return; }
    panel.hidden = false; panel.innerHTML = `<div class="calc-history-card"><h3>السيناريوهات المحفوظة</h3><p>جارٍ التحميل…</p></div>`;
    await loadScenarios();
    panel.innerHTML = `<div class="calc-history-card"><button type="button" class="calc-history-close" data-close-scenarios>×</button><h3>السيناريوهات المحفوظة</h3>${state.scenarioError ? `<p class="calc-panel-error">${escapeHtml(state.scenarioError)}</p>` : state.scenarios.length ? `<ul>${state.scenarios.map((item) => `<li class="calc-scenario-row"><div><b>${escapeHtml(item.name)}</b><span>${escapeHtml(displayTime(item.updatedAt))}</span></div><div><button type="button" class="calc-mini-button" data-load-scenario="${escapeHtml(item.id)}">فتح</button><button type="button" class="calc-archive-scenario" data-archive-scenario="${escapeHtml(item.id)}" aria-label="أرشفة السيناريو">أرشفة</button></div></li>`).join("")}</ul>` : "<p>لا توجد سيناريوهات محفوظة لهذه الحاسبة بعد.</p>"}</div>`;
    const close = panel.querySelector("[data-close-scenarios]"); if (close) close.addEventListener("click", () => { panel.hidden = true; });
    panel.querySelectorAll("[data-load-scenario]").forEach((button) => button.addEventListener("click", () => {
      const scenario = state.scenarios.find((item) => item.id === button.dataset.loadScenario);
      if (!scenario || !scenario.inputs || typeof scenario.inputs !== "object") return;
      const restored = JSON.parse(JSON.stringify(scenario.inputs));
      if (state.active === "average" && !Array.isArray(restored.lots)) return;
      if (state.inputs[state.active].quoteSymbol !== undefined && restored.quoteSymbol === undefined) restored.quoteSymbol = "";
      state.inputs[state.active] = restored; state.result = null; panel.hidden = true; rerender(); toast("تم فتح السيناريو وإعادة حسابه محليًا.", "success");
    }));
    panel.querySelectorAll("[data-archive-scenario]").forEach((button) => button.addEventListener("click", async () => {
      const id = button.dataset.archiveScenario;
      if (!id || !window.confirm("سيتم أرشفة السيناريو بدل حذفه. هل تريد المتابعة؟")) return;
      try { await apiFetch(`/scenarios/${encodeURIComponent(id)}`, { method: "DELETE" }); toast("تمت أرشفة السيناريو.", "success"); toggleScenarios(); }
      catch (error) { toast(`تعذر أرشفة السيناريو: ${error.message || "حاول مرة أخرى"}`, "error"); }
    }));
  }

  async function loadHistory() {
    try {
      const payload = await apiFetch("/history");
      state.history = Array.isArray(payload.history) ? payload.history : [];
      state.historyError = "";
    } catch (error) {
      state.history = [];
      state.historyError = error.message || "تعذر تحميل سجل العمليات حاليًا.";
    }
  }

  async function toggleHistory() {
    const panel = root.querySelector("#calc-history-panel");
    if (!panel) return;
    if (!panel.hidden) { panel.hidden = true; return; }
    panel.hidden = false; panel.innerHTML = `<div class="calc-history-card"><h3>آخر العمليات</h3><p>جارٍ التحميل…</p></div>`;
    await loadHistory();
    const actionLabel = { saved: "حفظ سيناريو", copied: "نسخ نتيجة", exported: "تصدير PDF", calculated: "حساب" };
    panel.innerHTML = `<div class="calc-history-card"><button type="button" class="calc-history-close" data-close-history>×</button><h3>آخر العمليات</h3>${state.historyError ? `<p class="calc-panel-error">${escapeHtml(state.historyError)}</p>` : state.history.length ? `<ul>${state.history.map((item) => `<li><b>${escapeHtml((calculatorByKey[item.calculatorKey] || {}).title || item.calculatorKey)}</b><span>${escapeHtml(actionLabel[item.action] || item.action)} · ${escapeHtml(displayTime(item.createdAt))}</span></li>`).join("")}</ul>` : "<p>لا توجد عمليات محفوظة بعد. انسخ نتيجة أو احفظ سيناريو أو صدّر PDF لإضافتها هنا.</p>"}</div>`;
    const close = panel.querySelector("[data-close-history]"); if (close) close.addEventListener("click", () => { panel.hidden = true; });
  }

  function toast(message, type) {
    let node = root.querySelector(".calc-toast");
    if (!node) { node = document.createElement("div"); node.className = "calc-toast"; root.appendChild(node); }
    node.className = `calc-toast ${type || ""}`; node.textContent = message; node.hidden = false;
    clearTimeout(node._timer); node._timer = setTimeout(() => { node.hidden = true; }, 4200);
  }

  function styles() {
    return `
      .calc-app{--ink:#f0f6ff;--muted:#6b85a0;--line:rgba(255,255,255,.09);--paper:#060f1c;--green:#10b981;--green-dark:#34d399;--mint:rgba(16,185,129,.10);--red:#ef4444;--shadow:0 16px 42px rgba(0,0,0,.22);color:var(--ink);font-family:inherit;direction:rtl}.calc-app *{box-sizing:border-box}.calc-topline{border:1px solid #b9e3d3;background:linear-gradient(90deg,#f0faf6,#f9fffc);padding:10px 13px;border-radius:12px;font-size:12px;color:#356154;display:flex;gap:8px;align-items:center;margin:0 0 14px}.calc-vip-badge{border-radius:99px;background:#d5f3e6;color:#056348;padding:3px 8px;font-weight:800;letter-spacing:.7px}.calc-layout{display:grid;grid-template-columns:252px minmax(0,1fr);gap:18px}.calc-sidebar,.calc-card{background:var(--paper);border:1px solid var(--line);box-shadow:var(--shadow);border-radius:18px}.calc-sidebar{padding:18px;height:max-content;position:sticky;top:14px}.calc-sidebar h2{font-size:18px;margin:0 0 5px}.calc-sidebar>p{font-size:12px;color:var(--muted);margin:0 0 13px}.calc-nav-item{width:100%;display:flex;text-align:right;gap:10px;padding:11px 10px;border:0;background:transparent;border-radius:12px;color:var(--ink);cursor:pointer;margin:2px 0;transition:.18s}.calc-nav-item:hover,.calc-nav-item.active{background:var(--mint);color:var(--green-dark)}.calc-nav-item i{font-style:normal;border-radius:9px;width:30px;height:30px;display:grid;place-items:center;background:#edf2f2;font-weight:800}.calc-nav-item.active i{background:#c7eadb}.calc-nav-item b,.calc-nav-item small{display:block}.calc-nav-item b{font-size:13px}.calc-nav-item small{font-size:10px;line-height:1.4;color:var(--muted);margin-top:2px}.calc-main{min-width:0}.calc-mobile-select{display:none}.calc-header{display:flex;align-items:start;justify-content:space-between;gap:15px;margin:2px 2px 14px}.calc-eyebrow{font-size:11px;font-weight:700;letter-spacing:.6px;color:var(--green)}.calc-header h2{font-size:25px;letter-spacing:-.3px;margin:3px 0}.calc-header p{color:var(--muted);font-size:13px;margin:0}.calc-header-actions{display:flex;gap:7px;flex-wrap:wrap;justify-content:flex-end}.calc-card{padding:18px;margin-bottom:14px}.calc-card h3{font-size:15px;margin:0 0 15px}.calc-form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:13px}.calc-field{display:block;min-width:0}.calc-field.wide{grid-column:span 2}.calc-field>span,.calc-lot-row label>span{font-size:12px;font-weight:700;display:block;margin:0 0 6px;color:#385265}.calc-field b{color:var(--red)}.calc-field small{display:block;color:var(--muted);font-size:10px;margin-top:5px;line-height:1.4}.calc-input-wrap{position:relative;display:flex;align-items:center;gap:5px}.calc-input-wrap input,.calc-input-wrap select,.calc-lot-row input{width:100%;height:42px;border:1px solid #cbdad5;background:#fff;border-radius:10px;padding:8px 10px;color:var(--ink);font:inherit;font-size:14px;outline:none;transition:border .15s,box-shadow .15s}.calc-input-wrap input:focus,.calc-input-wrap select:focus,.calc-lot-row input:focus{border-color:#158a6d;box-shadow:0 0 0 3px rgba(21,138,109,.13)}.calc-input-wrap em{font-style:normal;color:var(--muted);font-size:11px;position:absolute;left:10px;pointer-events:none}.calc-input-wrap input:has(+ em){padding-left:38px}.calc-live-price{border:1px solid #bce3d4;background:#f3fbf7;color:#08755d;border-radius:8px;font:inherit;font-weight:700;font-size:10px;white-space:nowrap;padding:7px 8px;cursor:pointer}.calc-live-price:hover{background:#dff4e9}.calc-quote-notice{font-size:11px;color:#586f7b;min-height:18px;margin-top:12px;line-height:1.55}.stale-tag,.fresh-tag{font-size:10px;border-radius:99px;padding:3px 7px;margin-left:4px}.stale-tag{background:#fff0d7;color:#8b5700}.fresh-tag{background:#ddf5e8;color:#086544}.calc-data-unavailable{color:var(--red)}.calc-output{min-height:180px}.calc-empty-result,.calc-error-result{text-align:center;padding:22px 8px}.calc-empty-result>span,.calc-error-result>span{display:grid;place-items:center;width:38px;height:38px;border-radius:50%;background:#edf5f3;color:var(--green);font-size:22px;margin:0 auto 7px}.calc-error-result>span{background:#fff0f0;color:var(--red);font-weight:800}.calc-empty-result h3,.calc-error-result h3{margin:0 0 4px}.calc-empty-result p,.calc-error-result p{color:var(--muted);font-size:12px;margin:0}.calc-primary{text-align:center;padding:8px 8px 19px;border-bottom:1px solid var(--line)}.calc-primary span,.calc-primary small{display:block}.calc-primary span{font-size:12px;color:var(--muted)}.calc-primary b{font-size:31px;letter-spacing:-.8px;margin:7px 0 3px;display:block}.calc-primary small{font-size:13px}.positive{color:var(--green)!important}.negative{color:var(--red)!important}.neutral{color:var(--ink)}.calc-stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px;padding-top:15px}.calc-stat{border:1px solid #e3ece9;background:#fbfdfc;border-radius:10px;padding:11px;min-width:0}.calc-stat span{color:var(--muted);font-size:10px;display:block;line-height:1.3}.calc-stat b{font-size:14px;display:block;margin-top:5px;overflow-wrap:anywhere}.calc-targets,.calc-warning,.calc-source-detail,.calc-chart-wrap,.calc-table-wrap{grid-column:1/-1}.calc-targets{padding:12px;background:#f7faf9;border-radius:10px;font-size:12px}.calc-targets>b{display:block;margin-bottom:8px}.calc-targets span{display:inline-block;margin-left:15px;color:#426173}.calc-targets strong{color:var(--ink)}.calc-targets small{font-size:10px}.calc-warning{border-right:3px solid #d7901c;background:#fff8e9;color:#7f570d;padding:10px;font-size:12px;line-height:1.5}.calc-source-detail{font-size:11px;padding:10px;background:#f4f8fa;border-radius:9px;color:#496070}.calc-result-actions{display:flex;gap:8px;margin-top:16px;justify-content:center;flex-wrap:wrap}.calc-primary-button,.calc-soft-button,.calc-mini-button{border-radius:9px;padding:9px 12px;font:inherit;font-size:12px;font-weight:700;cursor:pointer;transition:.16s}.calc-primary-button{border:1px solid var(--green);background:var(--green);color:#fff}.calc-primary-button:hover{background:var(--green-dark)}.calc-soft-button,.calc-mini-button{background:#fff;border:1px solid #cbdad5;color:#345165}.calc-soft-button:hover,.calc-mini-button:hover{border-color:#75bfa5;background:#f4faf7}.calc-formula{background:linear-gradient(135deg,#f6fbf9,#fbfdfd)}.calc-formula code{display:block;white-space:normal;word-break:break-word;line-height:1.8;padding:11px;background:#fff;border:1px dashed #bad8cd;border-radius:10px;font-size:12px;color:#175a49}.calc-formula p{margin:11px 0 0;color:var(--muted);font-size:11px}.calc-disclaimer{text-align:center;color:#7c8790;font-size:11px;margin:18px 0}.calc-average-lots .lot-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:9px;font-size:13px;font-weight:700}.calc-lot-row{display:grid;grid-template-columns:1fr 1fr 32px;gap:9px;align-items:end;padding:9px;background:#f9fbfa;border:1px solid #e4eeea;border-radius:11px;margin-bottom:8px}.calc-lot-row label{min-width:0}.calc-remove{height:40px;border:0;background:#ffecef;color:#b92f42;border-radius:8px;font-size:22px;cursor:pointer}.average-bottom{margin-top:11px}.calc-fx-source{padding:6px 0}.calc-fx-source #calc-fx-meta{font-size:11px;min-height:21px;color:#547080;line-height:1.65}.calc-chart-wrap{margin-top:8px;border:1px solid #e1ece8;border-radius:10px;padding:10px}.calc-chart-key{display:flex;gap:14px;font-size:10px;color:#637888;margin-bottom:5px}.calc-chart-key i{display:inline-block;width:8px;height:8px;border-radius:50%;margin-left:4px}.calc-chart-key .balance{background:#08755d}.calc-chart-key .contrib{background:#78a7d3}.calc-chart-wrap svg{width:100%;height:auto;display:block}.calc-chart-wrap path{fill:none;stroke-width:3;stroke-linecap:round;stroke-linejoin:round}.calc-chart-wrap .grid{stroke:#dae6e1;stroke-width:1}.calc-chart-wrap .balance-line{stroke:#08755d}.calc-chart-wrap .contrib-line{stroke:#78a7d3}.calc-table-wrap{overflow:auto;border:1px solid #e3ece8;border-radius:10px}.calc-table-wrap table{width:100%;border-collapse:collapse;min-width:450px;font-size:11px}.calc-table-wrap th,.calc-table-wrap td{text-align:right;padding:9px;border-bottom:1px solid #edf2f0}.calc-table-wrap th{background:#f7faf9;color:#5e7380}.calc-history-panel{margin-bottom:14px}.calc-history-card{position:relative;background:#fff;border:1px solid #b7dccc;border-radius:15px;padding:16px;box-shadow:var(--shadow)}.calc-history-card h3{margin:0 0 11px}.calc-history-card p{font-size:12px;color:var(--muted)}.calc-panel-error{color:#fca5a5!important;line-height:1.65}.calc-history-card ul{list-style:none;margin:0;padding:0}.calc-history-card li{border-top:1px solid #edf0ef;padding:9px 0}.calc-history-card li b,.calc-history-card li span{display:block}.calc-history-card li b{font-size:12px}.calc-history-card li span{font-size:10px;color:var(--muted);margin-top:3px}.calc-scenario-row{display:flex;align-items:center;justify-content:space-between;gap:9px}.calc-scenario-row>div:last-child{display:flex;gap:5px;flex-shrink:0}.calc-archive-scenario{border:1px solid #f3c8cd;background:#fff5f6;color:#ad3342;border-radius:8px;padding:7px 8px;font:inherit;font-size:10px;font-weight:700;cursor:pointer}.calc-history-close{position:absolute;left:11px;top:9px;border:0;background:#f2f6f4;border-radius:7px;width:28px;height:28px;font-size:19px;cursor:pointer}.calc-toast{position:fixed;bottom:20px;left:20px;z-index:30;max-width:min(360px,calc(100vw - 40px));border-radius:11px;padding:12px 14px;background:#18364a;color:#fff;box-shadow:0 12px 30px rgba(0,0,0,.18);font-size:12px}.calc-toast.success{background:#08755d}.calc-toast.error{background:#a62f42}.calc-app .calc-topline{border-color:rgba(16,185,129,.25);background:linear-gradient(90deg,rgba(16,185,129,.09),rgba(16,185,129,.025));color:#a8cdbc}.calc-app .calc-vip-badge{background:rgba(16,185,129,.17);color:#6ee7b7}.calc-app .calc-nav-item i{background:#0b1628;color:#b8c9de}.calc-app .calc-nav-item.active i{background:rgba(16,185,129,.18);color:#6ee7b7}.calc-app .calc-field>span,.calc-app .calc-lot-row label>span{color:#b8c9de}.calc-app .calc-input-wrap input,.calc-app .calc-input-wrap select,.calc-app .calc-lot-row input{border-color:rgba(255,255,255,.13);background:#0b1628;color:var(--ink)}.calc-app .calc-input-wrap input:focus,.calc-app .calc-input-wrap select:focus,.calc-app .calc-lot-row input:focus{border-color:#10b981;box-shadow:0 0 0 3px rgba(16,185,129,.13)}.calc-app .calc-live-price{border-color:rgba(16,185,129,.3);background:rgba(16,185,129,.1);color:#6ee7b7}.calc-app .calc-live-price:hover{background:rgba(16,185,129,.18)}.calc-app .calc-quote-notice{color:#9ab1c8}.calc-app .fresh-tag{background:rgba(16,185,129,.17);color:#6ee7b7}.calc-app .stale-tag{background:rgba(245,158,11,.18);color:#fcd34d}.calc-app .calc-empty-result>span{background:rgba(16,185,129,.12);color:#6ee7b7}.calc-app .calc-error-result>span{background:rgba(239,68,68,.13);color:#fca5a5}.calc-app .calc-stat{border-color:rgba(255,255,255,.08);background:#0b1628}.calc-app .calc-targets{background:#0b1628}.calc-app .calc-targets span{color:#9ab1c8}.calc-app .calc-warning{border-color:#f59e0b;background:rgba(245,158,11,.1);color:#fcd34d}.calc-app .calc-source-detail{background:#0b1628;color:#9ab1c8}.calc-app .calc-soft-button,.calc-app .calc-mini-button{background:#0b1628;border-color:rgba(255,255,255,.14);color:#b8c9de}.calc-app .calc-soft-button:hover,.calc-app .calc-mini-button:hover{border-color:rgba(16,185,129,.6);background:rgba(16,185,129,.09)}.calc-app .calc-formula{background:linear-gradient(135deg,#071b18,#07121f)}.calc-app .calc-formula code{background:#0b1628;border-color:rgba(16,185,129,.35);color:#9de6ca}.calc-app .calc-lot-row{background:#0b1628;border-color:rgba(255,255,255,.08)}.calc-app .calc-remove{background:rgba(239,68,68,.12);color:#fca5a5}.calc-app .calc-fx-source #calc-fx-meta{color:#9ab1c8}.calc-app .calc-chart-wrap,.calc-app .calc-table-wrap{border-color:rgba(255,255,255,.1)}.calc-app .calc-chart-wrap .grid{stroke:rgba(255,255,255,.13)}.calc-app .calc-chart-wrap .balance-line{stroke:#10b981}.calc-app .calc-table-wrap th{background:#0b1628;color:#9ab1c8}.calc-app .calc-table-wrap th,.calc-app .calc-table-wrap td{border-color:rgba(255,255,255,.08)}.calc-app .calc-history-card{background:#060f1c;border-color:rgba(16,185,129,.28)}.calc-app .calc-history-card li{border-color:rgba(255,255,255,.08)}.calc-app .calc-archive-scenario{border-color:rgba(239,68,68,.28);background:rgba(239,68,68,.1);color:#fca5a5}.calc-app .calc-history-close{background:#0b1628;color:#b8c9de}.calc-app .calc-mobile-select select{background:#0b1628;border-color:rgba(255,255,255,.13);color:var(--ink)}@media(max-width:800px){.calc-layout{display:block}.calc-sidebar{display:none}.calc-mobile-select{display:block;margin-bottom:11px}.calc-mobile-select label{font-size:11px;color:var(--muted);display:block;margin-bottom:4px}.calc-mobile-select select{width:100%;height:42px;border:1px solid #cbdad5;border-radius:10px;background:#fff;padding:0 10px;font:inherit}.calc-header{align-items:flex-start}.calc-header h2{font-size:21px}.calc-header-actions{max-width:164px}.calc-card{padding:14px;border-radius:14px}.calc-form-grid{grid-template-columns:1fr}.calc-field.wide{grid-column:auto}.calc-stats{grid-template-columns:repeat(2,minmax(0,1fr))}.calc-live-price{font-size:9px;padding:7px 6px}.calc-primary b{font-size:26px}.calc-topline{align-items:flex-start}.calc-lot-row{grid-template-columns:1fr 1fr 30px}.calc-targets span{display:block;margin:6px 0}.calc-header p{font-size:12px}}@media(max-width:420px){.calc-header{display:block}.calc-header-actions{margin-top:10px;max-width:none;justify-content:flex-start}.calc-stats{grid-template-columns:1fr}.calc-result-actions{justify-content:stretch}.calc-result-actions button{flex:1}.calc-lot-row{grid-template-columns:1fr 30px}.calc-lot-row label:first-child{grid-column:span 2}.calc-topline{font-size:10px}}
    `;
  }

  async function boot() {
    try {
      state.math = await import("/api/calculators/math.js");
      rerender();
    } catch {
      root.innerHTML = `<div style="padding:18px;border:1px solid #f0b7bb;border-radius:14px;color:#a52f42;background:#fff6f6">تعذر تحميل أدوات الحاسبات للمشترك حاليًا. أعد المحاولة، وإذا استمرت المشكلة تواصل معنا.</div>`;
    }
  }
  boot();
}

export function getCalculatorRuntimeModuleSource(): string {
  return `${mountCalculatorRuntime.toString()}\n\nexport { mountCalculatorRuntime };\n`;
}
