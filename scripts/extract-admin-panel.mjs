/**
 * EgyTrend — extract the admin panel out of the PUBLIC bundle.
 *
 * Audit finding: `artifacts/egytrend/index.html` (served to every visitor)
 * contained the whole admin interface — markup, tab bar and ~1,200 lines of
 * JS covering users, payments, subscriptions, coupons, employees and the
 * audit log. Anyone could read it with "view source" and map every admin
 * endpoint. The endpoints themselves were protected, but shipping the panel
 * publicly is unnecessary information disclosure and attack surface.
 *
 * This script performs the extraction ONCE, deterministically:
 *   • pulls the admin markup + admin JS out of index.html
 *   • writes them to artifacts/api-server/assets/admin-panel.js wrapped in a
 *     tiny registry (`window.__egytrendAdminPanel`)
 *   • leaves the public page with only a loader that fetches the panel from
 *     GET /api/admin/panel.js — a route that 401s without a staff session
 *
 * Run:  node scripts/extract-admin-panel.mjs
 * Afterwards verify the build: the SPA must no longer contain "renderAdmUsers".
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INDEX = path.join(root, "artifacts", "egytrend", "index.html");
const PANEL = path.join(root, "artifacts", "api-server", "assets", "admin-panel.js");

/* 1-based inclusive ranges in the pre-extraction index.html. */
const MARKUP = [1085, 1106];
const DASHBOARD_JS = [4066, 4900];
const OPPORTUNITIES_JS = [5343, 5500];

const lines = fs.readFileSync(INDEX, "utf8").split(/\r?\n/);
const slice = ([a, b]) => lines.slice(a - 1, b);

const markup = slice(MARKUP).join("\n");
const dashboardJs = slice(DASHBOARD_JS).join("\n");
const opportunitiesJs = slice(OPPORTUNITIES_JS).join("\n");

if (!markup.includes('id="adm"')) throw new Error("markup range does not contain #adm — aborting");
if (!dashboardJs.includes("renderAdmUsers")) throw new Error("dashboard range looks wrong — aborting");
if (!opportunitiesJs.includes("renderAdmOpps")) throw new Error("opportunities range looks wrong — aborting");

const panelSource = `/**
 * EgyTrend — ADMIN PANEL (server-gated asset).
 *
 * This file is NOT part of the public site bundle. It is served only by
 * GET /api/admin/panel.js, which requires a verified staff session
 * (httpOnly cookie signed by SESSION_SECRET). A visitor or a logged-in
 * regular user gets 401 and never receives this code.
 *
 * It is loaded on demand by the public bundle through loadAdminPanel(), and
 * it registers itself on window.__egytrendAdminPanel. All admin API calls go
 * through admFetch() (defined in the public bundle) and are re-authorised by
 * the server on every single request.
 *
 * Generated from the former inline block by scripts/extract-admin-panel.mjs —
 * edit here, not in index.html.
 */
(function () {
  "use strict";
  var MARKUP = ${JSON.stringify(markup)};

  /* Injected on first mount so the panel markup never ships with the page. */
  function mountAdminPanel() {
    var existing = document.getElementById("adm");
    if (existing) return existing;
    var host = document.createElement("div");
    host.innerHTML = MARKUP;
    var el = host.firstElementChild;
    document.body.appendChild(el);
    return el;
  }

  window.__egytrendAdminPanel = {
    mount: mountAdminPanel,
    open: function () {
      mountAdminPanel();
      document.getElementById("adm").classList.add("open");
      renderAdmStats();
      admTab("dash");
    },
    close: function () {
      var a = document.getElementById("adm");
      if (a) a.classList.remove("open");
    },
  };
})();

/* ────────────────── dashboard (verbatim from the former inline block) ────────────────── */
${dashboardJs}

/* ────────────────── opportunities admin (verbatim) ────────────────── */
${opportunitiesJs}
`;

fs.mkdirSync(path.dirname(PANEL), { recursive: true });
fs.writeFileSync(PANEL, panelSource.replace(/\r\n/g, "\n"), "utf8");

/* ── rewrite the public page without the three ranges (descending order) ── */
const cuts = [OPPORTUNITIES_JS, DASHBOARD_JS, MARKUP].sort((a, b) => b[0] - a[0]);
let kept = lines.slice();
for (const [a, b] of cuts) kept = [...kept.slice(0, a - 1), ...kept.slice(b)];

let out = kept.join("\n");

/* ── patch the remaining call sites (exact-match, fail loudly if absent) ── */
const patches = [
  [
    'onclick="openAdm()">⚙️ لوحة التحكم</button>',
    'onclick="openAdmPanel()">⚙️ لوحة التحكم</button>',
  ],
  [
    `  const r = await fetch(url, Object.assign({}, opts, {headers, credentials:"same-origin"}));
  if(r.status===401){
    showToast("⚠️ انتهت صلاحية جلسة المدير");
    closeAdm();
    throw new Error("unauthorized");
  }`,
    `  const r = await fetch(url, Object.assign({}, opts, {headers, credentials:"same-origin"}));
  if(r.status===401){
    showToast("⚠️ انتهت صلاحية جلسة المدير");
    if(typeof closeAdm==="function")closeAdm(); /* panel may not be loaded */
    throw new Error("unauthorized");
  }`,
  ],
  [
    `function loadAdminPanel(){
  if(window.__egytrendAdminPanel) return Promise.resolve(window.__egytrendAdminPanel);`,
    `function openAdmPanel(){
  loadAdminPanel()
    .then(p=>{p.mount&&p.mount();p.open();})
    .catch(()=>showToast("⚠️ تعذر تحميل لوحة التحكم — تأكد من صلاحيتك"));
}
function loadAdminPanel(){
  if(window.__egytrendAdminPanel) return Promise.resolve(window.__egytrendAdminPanel);`,
  ],
  [
    `        if(ad.status==="ok"&&ad.actor){U={name:ad.actor.name||"المدير",phone:"admin",plan:"admin",role:ad.actor.role};restored=true;}`,
    `        if(ad.status==="ok"&&ad.actor){
          U={name:ad.actor.name||"المدير",phone:"admin",plan:"admin",role:ad.actor.role};
          await loadAdminPanel(); /* session probe is the ONLY way the panel is fetched */
          restored=true;
        }`,
  ],
];

for (const [from, to] of patches) {
  if (!out.includes(from)) throw new Error(`patch anchor not found: ${from.slice(0, 60)}…`);
  out = out.replace(from, to);
}

/* ── guard: the public bundle must no longer mention admin renderers ── */
for (const needle of ["renderAdmUsers", "renderAdmEmployees", "loadAdmAudit", "admRej("]) {
  if (out.includes(needle)) throw new Error(`public bundle still contains ${needle}`);
}

fs.writeFileSync(INDEX, out, "utf8");

/* ── top-level name collision report (classic scripts share one scope) ── */
const declRe = /^(?:async\s+function|function|let|const|var)\s+([A-Za-z_$][\w$]*)/gm;
const names = (src) => {
  const set = new Set();
  for (const m of src.matchAll(declRe)) set.add(m[1]);
  return set;
};
const publicNames = names(out);
const panelNames = names(panelSource);
const shared = [...panelNames].filter((n) => publicNames.has(n));

console.log(`✔ panel written: ${path.relative(root, PANEL)} (${panelSource.split("\n").length} lines)`);
console.log(`✔ index.html cut from ${lines.length} to ${out.split("\n").length} lines`);
console.log(`• top-level names declared in both (must be empty): ${shared.length ? shared.join(", ") : "none"}`);
