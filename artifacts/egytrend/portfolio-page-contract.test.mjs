/**
 * Contract test for the portfolio entry points (first-class nav page + the
 * VIP-center «المحفظة» tab) after the simple rebuild.
 *
 * Rules enforced here:
 *  - the visible «المحفظة» nav item (small VIP badge) still drives its own
 *    page — untouched by the rebuild;
 *  - both entry points (nav page and VIP tab) render through the SAME
 *    renderer (nfpRender) so the experience is identical;
 *  - the CLIENT only chooses the view (intro/upsell vs portfolio); the
 *    server-side VIP gate remains the real protection — the client never
 *    renders portfolio truth from local storage;
 *  - expired session / lapsed VIP / server errors degrade to the app's
 *    standard gates with a retry, and previously loaded data is kept on
 *    screen when the error is a transient network one;
 *  - data is loaded on demand from /api/portfolio (session cookie,
 *    cache: no-store).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "index.html"), "utf8");

function functionBody(name, isAsync = false) {
  const marker = (isAsync ? "async function " : "function ") + name + "(";
  const start = html.indexOf(marker);
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
  assert.match(button, /المحفظة/);
  assert.match(html, /grid-template-columns:repeat\(7,1fr\)/, "bottom nav grid accounts for 7 items");
  /* Badge parity with the real access rights: all three VIP surfaces carry
     the same small badge; free services stay unbadged. */
  const calcButton = html.slice(html.lastIndexOf("<button", calculators), html.indexOf("</button>", calculators));
  assert.match(calcButton, /n-vip-chip/, "calculators nav carries the small VIP badge");
  assert.match(calcButton, />VIP</);
  const oppsButton = html.slice(html.lastIndexOf("<button", opps), html.indexOf("</button>", opps));
  assert.match(oppsButton, /n-vip-chip/, "فرص nav carries the small VIP badge (paid service)");
  assert.match(oppsButton, />VIP</);
  for (const id of ["nb-home", "nb-markets", "nb-profile"]) {
    const start = html.indexOf(`id="${id}"`);
    assert.ok(start !== -1, `${id} exists`);
    const btn = html.slice(html.lastIndexOf("<button", start), html.indexOf("</button>", start));
    assert.doesNotMatch(btn, /n-vip-chip/, `${id} is free — no VIP badge`);
  }
});

test("page wiring: goNav recognizes portfolio and renders it into its own host", () => {
  const goNav = functionBody("goNav");
  assert.match(goNav, /"portfolio"/, "portfolio is a known nav target");
  assert.match(goNav, /renderPortfolioPage\(\)/, "navigating renders the page");
  assert.ok(html.includes('id="page-portfolio"'), "page section exists");
  assert.ok(html.includes('id="pfp-host"'), "page has its render host");
});

test("entitlement: client view is UX only; both entry points use the same renderer", () => {
  const render = functionBody("renderPortfolioPage");
  assert.match(render, /!U/, "not logged in → intro");
  assert.match(render, /U\.plan==="vip"\|\|U\.plan==="admin"/, "VIP plan check for the portfolio view");
  assert.match(render, /pfpIntro\(\{loggedOut:true\}\)/, "logged-out intro");
  assert.match(render, /pfpIntro\(\{loggedOut:false\}\)/, "non-VIP intro");
  assert.match(render, /nfpRender\(host\)/, "VIP users land in the simple renderer");
  assert.match(render, /loadServerPortfolio\(\)/, "data is loaded from the server on demand");
  assert.match(
    render,
    /if\(!liveStocks\.length&&!egxStocksFreshness\.loading\)fetchStocksData\(\);/,
    "the licensed scan is loaded on demand so symbol autocomplete works identically on this page and in the VIP center",
  );
  const tab = functionBody("vBuildPort");
  assert.match(tab, /pfpIntro\(\{loggedOut:true\}\)/, "VIP tab: same logged-out gate");
  assert.match(tab, /pfpIntro\(\{loggedOut:false\}\)/, "VIP tab: same non-VIP gate");
  assert.match(tab, /nfpRender\(b\)/, "VIP tab renders through the same renderer as the page");
  const intro = functionBody("pfpIntro");
  assert.match(intro, /openSub\(\)/, "clear VIP upsell CTA");
  assert.match(intro, /openAuthModal\('login'\)/, "login CTA when signed out");
  assert.match(intro, /مفصولة تمامًا عن أي مستخدم آخر|الخادم/, "server-side truth mentioned");
});

test("data: /api/portfolio with the session cookie, never a stale cache", () => {
  const load = functionBody("loadServerPortfolio", true);
  assert.match(load, /fetch\("\/api\/portfolio"/, "the dedicated endpoint");
  assert.match(load, /credentials:"same-origin"/, "session-authenticated fetch");
  assert.match(load, /cache:"no-store"/, "never a stale cached portfolio");
  assert.match(load, /normalizeServerPortfolio\(j\.positions\)/, "positions pass the same normalizer as everywhere else");
});

test("error states: expired session, lapsed VIP and server errors degrade to the standard gates with retry", () => {
  const render = functionBody("nfpRender");
  assert.match(render, /login_required/, "expired session → login gate");
  assert.match(render, /vip_required/, "lapsed VIP → renewal gate");
  assert.match(render, /authGateHtml\("login"/, "reuses the app's single auth-gate renderer");
  assert.match(render, /authGateHtml\("vip"/, "VIP gate via the same renderer");
  assert.match(render, /server_error/, "server error → retry card");
  assert.match(render, /nfpRetryLoad\(\)/, "explicit retry");
  /* A transient network error keeps the last known data on screen. */
  assert.match(render, /آخر بيانات محفظتك المعروفة معروضة أد/, "stale data kept visible under a network error");
});

test("the portfolio never persists its truth to localStorage", () => {
  /* Scan the whole simple-portfolio block plus the data loader: no direct
   * localStorage/indexedDB writes of portfolio data (UI preferences
   * elsewhere are out of scope). */
  const start = html.indexOf("PORTFOLIO — the simple portfolio (rebuilt from scratch)");
  assert.ok(start !== -1, "portfolio block found");
  const end = html.indexOf("function pfpVisible(");
  const block = html.slice(start, end);
  assert.doesNotMatch(block, /localStorage\.set/, "no localStorage writes in the block");
  assert.doesNotMatch(block, /DB\.set\(/, "no indexed-DB writes in the block");
  const loader = html.slice(html.indexOf("async function loadServerPortfolio("), html.indexOf("function portStats("));
  assert.doesNotMatch(loader, /localStorage\.set/, "no localStorage writes in the loader");
});
