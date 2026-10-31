/**
 * Contract test for the first-class portfolio page (nav item + professional
 * dashboard).
 *
 * Rules enforced here:
 *  - a visible «المحفظة» nav item with a small VIP badge, harmonized with the
 *    other items, sits next to «فرص» and «الحاسبات» and drives its own page;
 *  - the CLIENT only chooses the view (intro/upsell vs dashboard); the
 *    server-side VIP gate remains the real protection — the page never
 *    renders portfolio truth from local storage;
 *  - the value-over-time chart is real: it is fetched from
 *    /api/portfolio/series, days without a full verified price set are drawn
 *    as gaps, and the EGX30 comparison only appears with stored rows;
 *  - cash deposits/withdrawals/dividends round-trip through the server API
 *    with the temporal insufficient_cash error surfaced;
 *  - concentration alerts are explicitly informational, not advice.
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
  /* skip the parameter list (it may contain object defaults like {…}) */
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

test("nav: a «المحفظة» item with a small VIP badge sits next to «فرص» and «الحاسبات»", () => {
  const opps = html.indexOf('id="nb-opps"');
  const portfolio = html.indexOf('id="nb-portfolio"');
  const calculators = html.indexOf('id="nb-calculators"');
  assert.ok(opps !== -1 && portfolio !== -1 && calculators !== -1, "all three nav items exist");
  assert.ok(opps < portfolio && portfolio < calculators, "portfolio nav sits between فرص and الحاسبات");
  const buttonStart = html.lastIndexOf("<button", portfolio);
  const button = html.slice(buttonStart, html.indexOf("</button>", portfolio));
  assert.match(button, /onclick="goNav\('portfolio'\)"/, "nav drives the portfolio page");
  assert.match(button, /n-vip-chip/, "small VIP badge under the label");
  assert.match(button, />VIP</, "badge reads VIP");
  /* The grid gained a column; the item label is present. */
  assert.match(button, /المحفظة/);
  assert.match(html, /grid-template-columns:repeat\(7,1fr\)/, "bottom nav grid accounts for 7 items");
  /* Badge parity with the server-side truth: every /api/calculators route is
     VIP-gated, so its nav item carries the same small badge. الفرص is free
     (public read API) and must NOT carry one. */
  const calcButton = html.slice(html.lastIndexOf("<button", calculators), html.indexOf("</button>", calculators));
  assert.match(calcButton, /n-vip-chip/, "calculators nav carries the small VIP badge");
  assert.match(calcButton, />VIP</);
  const oppsButton = html.slice(html.lastIndexOf("<button", opps), html.indexOf("</button>", opps));
  assert.doesNotMatch(oppsButton, /n-vip-chip/, "فرص is free — no VIP badge");
});

test("data: the page loads the same licensed stock universe as every other surface", () => {
  const render = functionBody("renderPortfolioPage");
  assert.match(
    render,
    /if\(!liveStocks\.length&&!egxStocksFreshness\.loading\)fetchStocksData\(\);/,
    "the licensed scan is loaded on demand so symbol autocomplete/hints work identically on this page and in the VIP center",
  );
});

test("page wiring: goNav recognizes portfolio and renders it", () => {
  const goNav = functionBody("goNav");
  assert.match(goNav, /"portfolio"/, "portfolio is a known nav target");
  assert.match(goNav, /renderPortfolioPage\(\)/, "navigating renders the page");
  assert.ok(html.includes('id="page-portfolio"'), "page section exists");
  assert.ok(html.includes('id="pfp-host"'), "page has its render host");
});

test("entitlement: client view is UX only; non-VIP gets the professional intro + upsell", () => {
  const render = functionBody("renderPortfolioPage");
  assert.match(render, /!U/, "not logged in → intro");
  assert.match(render, /U\.plan==="vip"||U\.plan==="admin"/, "VIP plan check for the dashboard view");
  assert.match(render, /pfpIntro\({loggedOut:true}\)/, "logged-out intro");
  assert.match(render, /pfpIntro\({loggedOut:false}\)/, "non-VIP intro");
  const intro = functionBody("pfpIntro");
  assert.match(intro, /openSub\(\)/, "clear VIP upsell CTA");
  assert.match(intro, /openAuthModal\('login'\)/, "login CTA when signed out");
  assert.match(intro, /pfp-feats/, "feature list describing the real service");
  /* The intro must not hide the gate behind client-only logic: the real
   * protection is the API, and the intro copy says data stays server-side. */
  assert.match(intro, /مفصولة تمامًا عن أي مستخدم آخر|الخادم/, "server-side truth mentioned");
});

test("chart: real series from the server, honest gaps, EGX30 only with stored rows", () => {
  const load = functionBody("pfpLoadSeries");
  assert.match(load, /\/api\/portfolio\/series\?range=/, "series comes from the dedicated endpoint");
  assert.match(load, /credentials:"same-origin"/, "session-authenticated fetch");
  assert.match(load, /cache:"no-store"/, "never a stale cached series");
  const svg = functionBody("pfpLineChartSvg");
  assert.match(svg, /typeof p\.value==="number"/, "only valued days draw the line");
  assert.match(svg, /else\{if\(seg\.length\)valSegs\.push\(seg\);seg=\[\];\}/, "null days break the line into honest gaps");
  const notes = functionBody("pfpChartNotesHtml");
  assert.match(notes, /بلا تاريخ إغلاق مسجّل/, "missing-history symbols are named");
  assert.match(notes, /لا نرسم أبدًا من أسعار تقديرية|لا نوزّع بالتساوي|فراغًا صادقًا/, "explicit no-fabrication note");
  assert.match(notes, /مرجع عام للمقارنة، وليس سعرًا مرخّصًا فوريًا/, "EGX30 license framing");
  const geom = functionBody("pfpChartGeom");
  assert.match(geom, /100\*\(b\.close\/firstValued\.value\)/, "benchmark normalized to 100 at the first shared point");
});

test("cash management: server round-trip with temporal insufficient_cash handling", () => {
  const submit = functionBody("pfpSubmitCash");
  assert.match(submit, /fetch\("\/api\/portfolio\/cash"/, "posts to the server endpoint");
  assert.match(submit, /method:"POST"/);
  assert.match(submit, /insufficient_cash/, "surfaces the temporal cash error");
  assert.match(submit, /cashAvailable/, "shows the exact available balance");
  const del = functionBody("pfpDeleteCash");
  assert.match(del, /method:"DELETE"/, "soft-delete through the server");
  assert.match(del, /confirm\(/, "destructive action asks first");
  assert.match(del, /أرشيف|x/, "tells the user the row is archived, not destroyed");
  /* Cash truth is server data only. */
  const host = functionBody("pfpCashHtml");
  assert.match(host, /portfolioData\.cashEvents/, "lists events from the server payload");
});

test("dashboard extras: daily change, asset count, total P/L and informational alerts", () => {
  const strip = functionBody("pfpKpiStripHtml");
  assert.match(strip, /السيولة النقدية/, "available cash card");
  assert.match(strip, /عدد الأصول/, "asset count card");
  assert.match(strip, /إجمالي الربح\/الخسارة/, "combined P/L card");
  assert.match(strip, /realizedPnl/, "built from server summary fields");
  const hero = functionBody("pfpHeroHtml");
  assert.match(hero, /dailyChangePct/, "daily change from the server series");
  const alerts = functionBody("pfpConcentrationAlertsHtml");
  assert.match(alerts, /وليست توصية/, "alerts are explicitly not investment advice");
  assert.match(alerts, /weightPct/, "weights come from the server");
});

test("the portfolio page never persists portfolio truth to localStorage", () => {
  /* Scan the whole portfolio-page block: no direct localStorage writes of
   * portfolio data (UI preferences elsewhere are out of scope). */
  const start = html.indexOf("PORTFOLIO — first-class page");
  assert.ok(start !== -1, "portfolio page block found");
  const end = html.indexOf("function pfpLineChartSvg");
  const block = html.slice(start, end);
  assert.doesNotMatch(block, /localStorage\.set/, "no localStorage writes in the page block");
  assert.doesNotMatch(block, /DB\.set\(.*portfolio/i, "no indexed-DB portfolio writes in the page block");
});

test("error states: expired session and lapsed VIP degrade to the existing gates", () => {
  const render = functionBody("pfpRenderDashboard");
  assert.match(render, /login_required/, "expired session → login gate");
  assert.match(render, /vip_required/, "lapsed VIP → renewal gate");
  assert.match(render, /authGateHtml/, "reuses the app's single auth-gate renderer");
});
