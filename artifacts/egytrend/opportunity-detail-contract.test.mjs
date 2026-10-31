/**
 * Contract test — opportunity detail page (one page per opportunity).
 *
 * The page must show exactly what EXISTS for that opportunity, bound by its
 * real ID, and nothing invented:
 *  - openOppDetail fetches GET /api/opportunities/<id> FIRST; the stored row
 *    + the server-built explanation are the page's source of truth;
 *  - every section is pinned here: instrument/price, creation date+time,
 *    reason it appeared, stored technical analysis + indicators, entry/
 *    stop/targets levels, fundamental (unavailable unless stored), related
 *    news, risks, positive/negative scenarios, sources + last update;
 *  - missing stored data renders "غير متاحة" — never 0, never invented;
 *  - real data is labelled stored/verified, the live price is labelled, and
 *    the page ends with the server disclaimer (no profit guarantee);
 *  - server unreachable → the last list load is shown WITH a visible
 *    fallback note; unknown id → an honest not-found + retry, never a page
 *    of made-up details;
 *  - non-VIP: the server-masked explanation is rendered as given (the
 *    client must not re-derive levels from the list and leak them), and the
 *    locked upsell replaces the content;
 *  - the explanation builder (server) is stored-data-only: no fetch in
 *    opp-explain.ts, and the route returns 404 for unknown ids.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "index.html"), "utf8");
const oppsTs = readFileSync(join(here, "..", "api-server", "src", "routes", "opportunities.ts"), "utf8");
const explainTs = readFileSync(join(here, "..", "api-server", "src", "lib", "opp-explain.ts"), "utf8");

function functionBody(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.ok(start !== -1, `index.html must define ${name}`);
  let depth = 0;
  for (let i = html.indexOf("{", start); i < html.length; i += 1) {
    const ch = html[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return html.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

test("openOppDetail is server-first and bound by the real id", () => {
  const open = functionBody("openOppDetail");
  assert.ok(open.includes('fetch("/api/opportunities/"+encodeURIComponent(id)')
    || open.includes('fetch("/api/opportunities/" + encodeURIComponent(id)'),
    "the detail page fetches /api/opportunities/<id> keyed by the real id");
  assert.ok(open.includes('credentials:"same-origin"'), "the fetch uses the session cookie");
  assert.ok(open.includes("d.explanation"), "the server-built explanation is consumed");
  assert.ok(open.includes("d.origin"), "the origin (db vs live rebuild) is surfaced");
  assert.ok(open.includes("serverOk"), "a flag tracks whether the server answered");
});

test("the detail page has all the required sections", () => {
  const sections = functionBody("oppDetailSections");
  assert.ok(sections.includes("📈 الأداة والسعر"), "instrument + price section");
  assert.ok(sections.includes("🕐 الإنشاء"), "creation date+time section");
  assert.ok(sections.includes("🧠 لماذا ظهرت هذه الفرصة"), "reason-it-appeared section");
  assert.ok(sections.includes("💬 الشرح المبسط"), "simplified explanation section");
  assert.ok(sections.includes("📊 التحليل الفني والمؤشرات (قيم فعلية محفوظة)"), "technical + indicators section");
  assert.ok(sections.includes("🎯 المستويات (الدخول والأهداف والوقف)"), "levels section");
  assert.ok(sections.includes("🏛 التحليل الأساسي"), "fundamental section");
  assert.ok(sections.includes("📰 أخبار مرتبطة"), "related-news section");
  assert.ok(sections.includes("⚠️ المخاطر"), "risks section");
  assert.ok(sections.includes("🎬 السيناريوهات"), "scenarios section");
  assert.ok(sections.includes("📡 مصدر البيانات وآخر تحديث"), "sources + last-update section");
  /* creation timestamp is a full date+time in Cairo */
  assert.ok(sections.includes("oppFmtDateTimeCairo(o.createdAt)"), "creation shows full date+time (Cairo)");
});

test("missing stored data is shown as 'غير متاحة', never invented", () => {
  assert.ok(html.includes('const OPP_DETAIL_MISSING="غير متاحة"'), "the unavailable marker is the project's wording");
  const sections = functionBody("oppDetailSections");
  assert.ok(sections.includes("oppDetailMissing("), "sections without stored data use the missing block");
  /* prices render only when finite — a null level is never printed as 0 */
  const line = functionBody("oppPriceLine");
  assert.ok(line.includes('if(!Number.isFinite(val))return""'), "non-finite prices are never rendered");
  /* the fundamental section is always the honest note (it is never stored) */
  assert.ok(sections.includes("ex.fundamental?.note"), "fundamental renders the server's not-available note");
});

test("real data is labelled stored/verified and the disclaimer closes the page", () => {
  const sections = functionBody("oppDetailSections");
  assert.ok(sections.includes("سعر الإشارة عند الإنشاء"), "the creation-time price is labelled as creation-time");
  assert.ok(sections.includes("القيم داخل كل عامل هي المحفوظة وقت إنشاء الإشارة"), "indicators are marked as saved-at-creation values");
  assert.ok(sections.includes("يولَّد تلقائيًا من الحقول الفعلية المحفوظة للفرصة"), "the narrative is marked as built from stored fields only");
  assert.ok(sections.includes("ex.disclaimer"), "the page ends with the server disclaimer");
  assert.ok(html.includes("لا ضمانًا لأي ربح"), "no-profit-guarantee wording is present");
});

test("server-down degrades to the last list load WITH a visible note", () => {
  const open = functionBody("openOppDetail");
  assert.ok(open.includes("localExplain"), "an offline explanation fallback exists");
  assert.ok(open.includes("تعذر الوصول إلى الخادم الآن"), "the fallback is visible to the user");
  const local = functionBody("localExplain");
  assert.ok(local.includes("factors:s?.factors??[]"), "the offline fallback reuses whitelisted stored fields only");
});

test("an unknown id shows a not-found state with retry, never invented details", () => {
  const open = functionBody("openOppDetail");
  assert.ok(open.includes("تعذر تحميل تفاصيل هذه الفرصة"), "honest not-found copy");
  assert.ok(open.includes("closeOppDetail();loadOpps(true)"), "retry re-opens the list");
});

test("a live-origin row is labelled as rebuilt from market data", () => {
  const sections = functionBody("oppDetailSections");
  assert.ok(sections.includes("تُعاد بناؤها من بيانات السوق وقت الطلب"), "live rows say they are rebuilt on demand");
  assert.ok(sections.includes('origin==="live"'), "the origin flag drives the label");
});

test("the back button returns to the opportunities list", () => {
  const open = functionBody("openOppDetail");
  assert.ok(open.includes("closeOppDetail()"), "the overlay back button closes it");
  assert.ok(open.includes("← الرجوع لقائمة الفرص"), "the back control says where it goes");
  const close = functionBody("closeOppDetail");
  assert.ok(close.includes('getElementById("opp-detail-ov")') && close.includes(".remove()"), "closing removes the overlay");
});

test("non-VIP: the masked server explanation is rendered as given, and locked content shows the upsell", () => {
  const open = functionBody("openOppDetail");
  /* when the server answered, its (masked) explanation is the one used —
   * the client never re-derives levels from the list for a masked row */
  assert.ok(open.includes("serverOk=Boolean(row)"), "server rows are marked as authoritative");
  assert.ok(open.includes('onclick="document.getElementById(\'opp-detail-ov\').remove();goNav(\'vip\')"'),
    "a locked opportunity shows the VIP upsell, not the content");
});

test("the server route exposes GET /opportunities/:id with a stored-data explanation", () => {
  assert.ok(/router\.get\(\s*["']\/opportunities\/\:id["']/.test(oppsTs), "route registered");
  assert.ok(oppsTs.includes("buildOppExplanation"), "the route builds the explanation from the stored row");
  assert.ok(oppsTs.includes('res.status(404).json({ status: "error", message: "opportunity not found" })'), "unknown id → 404, never fabricated");
  assert.ok(oppsTs.includes('res.status(400).json({ status: "error", message: "invalid opportunity id" })'), "malformed id → 400");
  /* the builder itself never touches the network or the market service */
  assert.ok(!/fetch\s*\(/.test(explainTs), "opp-explain has no fetch");
  assert.ok(!explainTs.includes("marketService"), "opp-explain never calls the market service");
  assert.ok(explainTs.includes("نمط «"), "the narrative quotes the stored signal type");
  assert.ok(explainTs.includes("ليست توصية استثمارية ولا ضمانًا لأي ربح"), "the builder's disclaimer is mandatory");
});
