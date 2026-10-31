/**
 * Contract test: ONE VIP product, ONE entitlement.
 *
 * Rules enforced here:
 *  - every PAID plan shows the exact same unified VIP feature list — the
 *    per-plan `features` text from the admin plan config must never create the
 *    impression of different entitlements (normalization is the single
 *    chokepoint feeding the landing cards, the comparison table and the
 *    subscription modal);
 *  - the only per-plan values that survive normalization are the real plan
 *    differences: duration, price, badges, countdowns;
 *  - the unification is stated to the user (comparison table + landing);
 *  - the unified list is the app's actual VIP feature set (real,
 *    server-gated features only — no invented capabilities).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "index.html"), "utf8");

function functionBody(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.ok(start !== -1, `index.html must define ${name}`);
  let i = html.indexOf("(", start);
  let pd = 0;
  for (; i < html.length; i += 1) {
    const ch = html[i];
    if (ch === "(") pd += 1;
    else if (ch === ")") {
      pd -= 1;
      if (pd === 0) break;
    }
  }
  let depth = 0;
  for (i = html.indexOf("{", i); i < html.length; i += 1) {
    const ch = html[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return html.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

function unifiedList() {
  const start = html.indexOf("const VIP_FEATURES_UNIFIED=[");
  assert.ok(start !== -1, "VIP_FEATURES_UNIFIED must exist");
  const end = html.indexOf("];", start);
  return new Function(html.slice(start, end + 2) + "\nreturn VIP_FEATURES_UNIFIED;")();
}

test("one unified VIP feature list exists and covers the real, server-gated features", () => {
  const list = unifiedList();
  assert.ok(Array.isArray(list) && list.length >= 6 && list.length <= 12, `sanity: ${list.length} items`);
  for (const wanted of ["المحفظة", "التنبيهات السعرية", "الفرص", "Screener", "AI", "الحاسبات", "RSI(14)"]) {
    assert.ok(list.some((f) => f.includes(wanted)), `unified list covers a real VIP feature: ${wanted}`);
  }
  for (const f of list) {
    assert.ok(typeof f === "string" && f.trim().length > 0 && f.length <= 160, `feature item is a short non-empty label: ${f}`);
  }
  assert.equal(new Set(list).size, list.length, "no duplicated feature items");
});

test("normalizeSubscriptionPlans: every paid plan gets the exact same features; only duration/price survive per-plan", () => {
  const unified = unifiedList();
  const code = functionBody("normalizeSubscriptionPlans");
  const normalizeSubscriptionPlans = new Function("VIP_FEATURES_UNIFIED", code + "\nreturn normalizeSubscriptionPlans;")(unified);
  const plans = normalizeSubscriptionPlans([
    { key: "monthly", nameAr: "شهري", price: 99, durationMonths: 1, features: ["مستشار AI", "إشارات تداول", "تقارير يومية"] },
    { key: "quarterly", nameAr: "ربع سنوي", price: 249, durationMonths: 3, features: ["مستشار AI", "إشارات تداول", "تقارير يومية", "screener"], priceBadge: "وفر 16%" },
    { key: "yearly", nameAr: "سنوي", price: 799, durationMonths: 12, features: ["كل مزايا VIP", "دعم أولوية", "تقارير حصرية"], badge: "الأفضل" },
    { key: "free", nameAr: "مجاني", price: 0, durationMonths: 1, features: ["الأسعار الحية"] },
  ]);
  assert.ok(!("free" in plans), "a zero-priced row is not a paid plan");
  for (const key of ["monthly", "quarterly", "yearly"]) {
    assert.deepEqual(plans[key].features, unified, `${key} shows the unified VIP list (not the per-plan config text)`);
  }
  assert.deepEqual(plans.monthly.features, plans.quarterly.features, "identical across plans");
  assert.deepEqual(plans.quarterly.features, plans.yearly.features, "identical across plans");
  /* The real plan differences survive untouched. */
  assert.equal(plans.monthly.p, 99); assert.equal(plans.monthly.m, 1); assert.equal(plans.monthly.per, "شهر");
  assert.equal(plans.quarterly.p, 249); assert.equal(plans.quarterly.m, 3); assert.equal(plans.quarterly.priceBadge, "وفر 16%");
  assert.equal(plans.yearly.p, 799); assert.equal(plans.yearly.m, 12); assert.equal(plans.yearly.per, "سنة"); assert.equal(plans.yearly.badge, "الأفضل");
  assert.equal(plans.monthly.l, "شهري"); assert.equal(plans.yearly.l, "سنوي");
});

test("the unification is stated to the user (comparison table + landing pricing)", () => {
  const cmp = functionBody("planComparisonHtml");
  assert.match(cmp, /كل الباقات المدفوعة تمنح كل مميزات VIP/, "comparison table note: all paid plans = full VIP");
  assert.match(cmp, /المدة والسعر فقط/, "comparison table note: only duration/price differ");
  assert.match(html, /جميع الباقات المدفوعة تمنح كل مميزات VIP خلال مدة الباقة/, "landing pricing note: full VIP for the plan duration");
  /* Every plan display surface reads from the normalized plans object. */
  const landing = html.slice(html.indexOf("function renderPricing()"), html.indexOf("function lndStartTrial("));
  assert.match(landing, /fetchSubscriptionConfig\(ctrl\.signal\)/, "landing renders only the server config");
  assert.match(landing, /\(p\.features\|\|\[\]\)\.map/, "landing feature list comes from the normalized plan");
});
