/* Runtime smoke test for the professional admin panel (no browser in this
 * sandbox): load the whole admin.html inline script under a Proxy-based DOM
 * stub, drive renderAdmUsers() + renderAdmSources() with honest synthetic
 * API data, and assert the produced HTML — including the guarded final-delete
 * and the server-driven news-source health — is sane. */
import vm from "node:vm";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("./admin.html", import.meta.url), "utf8");
const scripts = [...html.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const app = scripts.find((s) => s.length > 100000);
assert.ok(app, "admin inline script found");

function makeEl() {
  /* textContent/innerHTML/value keep real state so round-trips through the
   * app's `sanitize` and the delete-confirm gate behave like a browser. */
  const state = { text: null, html: "", value: "", disabled: false, id: "", listeners: {} };
  const escapeHtml = (v) => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const handler = {
    get(t, prop) {
      if (prop === Symbol.toPrimitive) return () => "";
      if (prop === "textContent") return state.text ?? "";
      if (prop === "innerHTML") return state.text !== null ? escapeHtml(state.text) : state.html;
      if (prop === "value") return state.value;
      if (prop === "id") return state.id || "";
      if (prop === "classList") return { add() {}, remove() {}, toggle() {}, contains: () => false };
      if (prop === "style") return new Proxy({}, { get: () => "", set: () => true });
      if (prop === "dataset") return {};
      if (prop === "disabled") return state.disabled || false;
      if (prop === "querySelectorAll" || prop === "children" || prop === "childNodes") return [];
      if (prop === "clientWidth" || prop === "offsetWidth" || prop === "offsetHeight") return 100;
      if (prop === "getBoundingClientRect") return () => ({ left: 0, top: 0, width: 100, height: 100 });
      if (prop === "querySelector") return () => makeEl();
      if (prop === "getAttribute" || prop === "getContext") return () => null;
      if (prop === "addEventListener") return (type, fn) => { state.listeners[String(type)] = fn; };
      if (["removeEventListener", "focus", "blur", "click", "scrollIntoView", "append", "appendChild", "remove", "select", "setSelectionRange", "insertAdjacentHTML", "closest", "contains", "dispatchEvent"].includes(prop)) return () => {};
      return makeEl();
    },
    set(t, prop, value) {
      if (prop === "textContent") { state.text = String(value); state.html = ""; return true; }
      if (prop === "innerHTML") { state.html = String(value); state.text = null; return true; }
      if (prop === "value") {
        state.value = String(value);
        /* fire the app's real input listeners (the delete gate). */
        const fn = state.listeners.input;
        if (typeof fn === "function") { try { fn({ target: makeEl(), currentTarget: t }); } catch { /* stub target is minimal */ } }
        return true;
      }
      if (prop === "id") { state.id = String(value); return true; }
      if (prop === "disabled") { state.disabled = Boolean(value); return true; }
      return true;
    },
    apply() { return makeEl(); },
  };
  return new Proxy(function () {}, handler);
}

/* Stable per-id registry: the renderer writes through
 * document.getElementById(...) and the assertions read the same nodes. */
const elements = new Map();
function byId(id) {
  if (!elements.has(id)) elements.set(id, makeEl());
  return elements.get(id);
}

const documentStub = new Proxy({}, {
  get(t, prop) {
    if (prop === "getElementById") return (id) => byId(String(id));
    if (prop === "createElement") return () => makeEl();
    if (prop === "querySelector" || prop === "createTextNode") return () => makeEl();
    if (prop === "querySelectorAll" || prop === "getElementsByClassName" || prop === "getElementsByName" || prop === "elements") return () => [];
    if (prop === "addEventListener" || prop === "removeEventListener" || prop === "write" || prop === "cookie") return () => {};
    if (prop === "body" || prop === "documentElement" || prop === "head" || prop === "activeElement") return makeEl();
    return makeEl();
  },
  set() { return true; },
});

/* Honest synthetic payload matching the real
 * GET /api/admin/settings/market-providers contract. */
const mktOverview = {
  generatedAt: Date.now(),
  cache: { mode: "memory", available: true },
  board: { fetchedAt: Date.now() - 60_000, stale: false, fromCache: true, quoteCount: 12, expired: false },
  providers: [
    { id: "mkt-good", name: "مزوّد سليم", kind: "quotes", state: "configured", adminDisabled: false, note: "", coverage: ["index", "fx"], externalDisplayConfirmed: true, servesInstrumentCount: 8, health: { lastSuccessAt: Date.now() - 300_000, lastFailureAt: null, consecutiveFailures: 0, degraded: false }, lastQuoteAsOf: Date.now() - 300_000, lastQuoteFreshness: "real-time" },
    { id: "mkt-bad", name: "مزوّد متعثر", kind: "quotes", state: "configured", adminDisabled: false, note: "", coverage: ["index"], externalDisplayConfirmed: true, servesInstrumentCount: 3, health: { lastSuccessAt: Date.now() - 86_400_000, lastFailureAt: Date.now() - 600_000, consecutiveFailures: 4, degraded: true }, lastQuoteAsOf: Date.now() - 86_400_000, lastQuoteFreshness: "delayed" },
    { id: "mkt-off", name: "مزوّد معطل", kind: "quotes", state: "configured", adminDisabled: true, note: "", coverage: ["fx"], externalDisplayConfirmed: true, servesInstrumentCount: 4, health: { lastSuccessAt: null, lastFailureAt: null, consecutiveFailures: 0, degraded: false }, lastQuoteAsOf: null, lastQuoteFreshness: null },
    { id: "mkt-none", name: "مزوّد بلا مفاتيح", kind: "quotes", state: "not_configured", adminDisabled: false, note: "", coverage: ["crypto"], externalDisplayConfirmed: false, servesInstrumentCount: 0, health: { lastSuccessAt: null, lastFailureAt: null, consecutiveFailures: 0, degraded: false }, lastQuoteAsOf: null, lastQuoteFreshness: null },
    { id: "mkt-cal", name: "تقويم اقتصادي", kind: "calendar", state: "configured", adminDisabled: false, note: "", coverage: ["calendar"], externalDisplayConfirmed: true, servesInstrumentCount: 0, health: { lastSuccessAt: Date.now() - 1_800_000, lastFailureAt: null, consecutiveFailures: 0, degraded: false }, lastQuoteAsOf: null, lastQuoteFreshness: null },
  ],
  instruments: [
    { instrumentId: "egx:EGX30", symbol: "EGX30", name: "EGX30", kind: "index", state: "fresh", asOf: Date.now() - 60_000, freshness: "real-time" },
    { instrumentId: "fx:USD-EGP", symbol: "USD/EGP", name: "دولار/جنيه", kind: "fx", state: "end-of-day", asOf: Date.now() - 7_200_000, freshness: "end-of-day" },
    { instrumentId: "cm:GOLD", symbol: "XAU", name: "ذهب", kind: "commodity", state: "stale", asOf: Date.now() - 90_000_000, freshness: "real-time" },
    { instrumentId: "cr:BTC", symbol: "BTC", name: "بيتكوين", kind: "crypto", state: "no-verified-quote" },
  ],
};

/* Honest synthetic payload matching GET /api/admin/ai-providers. */
const aiProvidersPayload = {
  status: "ok",
  info: {
    engine: "gemini",
    providers: [
      { id: "gemini", name: "Google Gemini", order: 1, role: "primary", keyPresent: true, model: "gemini-3.5-flash-lite", adminDisabled: false, active: true, features: ["المساعد الذكي"] },
      { id: "anthropic", name: "Anthropic Claude", order: 2, role: "fallback", keyPresent: false, model: "claude-sonnet-4-6", adminDisabled: false, active: false, features: ["المساعد الذكي"] },
      { id: "local", name: "محرك EgyTrend المحلي", order: 3, role: "safety-net", keyPresent: true, model: "egytrend-local", adminDisabled: false, active: false, features: ["المساعد الذكي"] },
    ],
  },
  lastTests: { gemini: { ok: true, at: new Date(Date.now() - 3_600_000).toISOString(), latencyMs: 812 } },
  assistantGateEnabled: true,
};

/* Honest synthetic payload matching GET /api/admin/audit-logs
 * (admin-only, result/cause detail, dynamic action meta). */
const auditPayload = {
  status: "ok",
  total: 4,
  page: 0,
  limit: 25,
  actions: [
    { action: "login", count: 3 },
    { action: "ban_user", count: 1 },
    { action: "update_ai_config", count: 1 },
    { action: "ai_provider_disable", count: 1 },
  ],
  logs: [
    { id: 1, action: "ai_provider_disable", actorId: 2, actorName: "Super Smoke", actorRole: "super_admin", target: "gemini", detail: { effectiveEngine: "local" }, ip: "41.9.1.2", createdAt: "2026-10-29T12:06:00.000Z" },
    { id: 2, action: "update_ai_config", actorId: 2, actorName: "Super Smoke", actorRole: "super_admin", target: "ai_config", detail: { analyzerEnabled: false, updatedBy: "Super Smoke" }, ip: "41.9.1.2", createdAt: "2026-10-29T12:05:00.000Z" },
    { id: 3, action: "ban_user", actorId: 2, actorName: "Super Smoke", actorRole: "super_admin", target: "user:77", detail: {}, ip: "41.9.1.2", createdAt: "2026-10-29T12:00:00.000Z" },
    { id: 4, action: "login", actorId: 2, actorName: "Super Smoke", actorRole: "super_admin", target: "staff:2", detail: {}, ip: "41.9.1.2", createdAt: "2026-10-29T11:59:00.000Z" },
  ],
};

/* Honest synthetic rows matching the real /api/admin/users contract. */
const usersData = [
  { id: 1, phone: "01011111111", email: "sara@example.test", name: "Sara Smoke", plan: "free", vipExpiresAt: null, subscriptionStatus: "legacy", subscriptionPlanKey: null, status: "active", lastLoginAt: "2026-10-28T10:00:00.000Z", createdAt: "2026-09-01T08:00:00.000Z" },
  { id: 2, phone: "01022222222", email: "omar@example.test", name: "Omar Smoke", plan: "vip", vipExpiresAt: "2026-11-28T00:00:00.000Z", subscriptionStatus: "active", subscriptionPlanKey: "vip-monthly", status: "active", lastLoginAt: null, createdAt: "2026-08-01T08:00:00.000Z" },
  { id: 3, phone: "01033333333", email: null, name: "Laila Smoke", plan: "free", vipExpiresAt: null, subscriptionStatus: null, subscriptionPlanKey: null, status: "banned", lastLoginAt: "2026-10-01T08:00:00.000Z", createdAt: "2026-07-01T08:00:00.000Z" },
];

/* Honest synthetic inventory matching the real /api/admin/sources contract:
 * server-side health (written only after real fetches), legal state, archive. */
const sourcesData = [
  { id: "ok-src", name: "مصدر سليم", icon: "📰", lang: "ar", cat: "egypt", color: "#10b981", url: "https://ok.example.test/feed.xml", commercialRedisplay: { status: "approved", evidence: "ok" }, disabled: false, archivedAt: null, health: { lastAttemptAt: "2026-10-29T17:55:00.000Z", lastSuccessAt: "2026-10-26T17:55:00.000Z", consecutiveFailures: 0, itemsFetched: 42, lastError: null } },
  { id: "fail-src", name: "مصدر فاشل", icon: "📉", lang: "ar", cat: "egypt", color: "#ef4444", url: "https://fail.example.test/feed.xml", commercialRedisplay: { status: "approved", evidence: "ok" }, disabled: false, archivedAt: null, health: { lastAttemptAt: "2026-10-29T17:50:00.000Z", lastSuccessAt: "2026-10-29T17:00:00.000Z", consecutiveFailures: 3, itemsFetched: 10, lastError: "upstream timeout" } },
  { id: "stop-src", name: "مصدر متوقف", icon: "⏸", lang: "ar", cat: "egypt", color: "#64748b", url: "https://stop.example.test/feed.xml", commercialRedisplay: { status: "approved", evidence: "ok" }, disabled: true, archivedAt: null, health: null },
  { id: "new-src", name: "مصدر جديد", icon: "🆕", lang: "ar", cat: "egypt", color: "#10b981", url: "https://new.example.test/feed.xml", commercialRedisplay: { status: "pending" }, disabled: false, archivedAt: null, health: null },
  { id: "arch-src", name: "مصدر مؤرشف", icon: "🗃", lang: "ar", cat: "egypt", color: "#64748b", url: "https://arch.example.test/feed.xml", commercialRedisplay: { status: "approved", evidence: "ok" }, disabled: false, archivedAt: "2026-10-20T08:00:00.000Z", health: null },
];
let smokeSessionRole = "super_admin";
const fetchedUrls = [];
const fetchedMeta = []; /* {url, method} — the sources tab needs verbs */
const never = () => new Promise(() => {});
function jsonResp(obj, status = 200) {
  return Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(obj), headers: { get: () => null } });
}
const fetchStub = (url, opts) => {
  const u = String(url);
  fetchedUrls.push(u);
  fetchedMeta.push({ url: u, method: (opts && opts.method) || "GET" });
  if (u.startsWith("/api/admin/sources")) {
    if (u.includes("/test")) {
      return jsonResp({
        status: "ok",
        result: u.includes("fail-src")
          ? { ok: false, testedAt: "2026-10-29T18:20:00.000Z", error: "upstream timeout" }
          : { ok: true, testedAt: "2026-10-29T18:20:00.000Z", itemCount: 3, firstTitle: "عنوان تجريبي" },
      });
    }
    if (u.includes("/set-disabled")) return jsonResp({ status: "ok", source: { id: "stop-src", disabled: false } });
    if (u === "/api/admin/sources") return jsonResp({ status: "ok", sources: sourcesData });
    return jsonResp({ status: "ok", source: { id: "ok-src", disabled: false, health: {} } });
  }
  if (u.startsWith("/api/admin/users")) {
    if (u.includes("/delete")) return jsonResp({ status: "ok", deleted: 2, phone: "01022222222" });
    return jsonResp({ status: "ok", users: usersData, total: usersData.length, page: 1, pageSize: 25, totalPages: 1 });
  }
  if (u.startsWith("/api/admin/ai-config")) return jsonResp({ status: "ok", config: { analyzerEnabled: true, summaryEnabled: true, rewriterEnabled: false, dailyRequestLimit: 500 } });
  if (u.startsWith("/api/admin/ai-usage")) return jsonResp({ status: "ok", totalRequests: 42, byType: [], topUsers: [] });
  if (u.startsWith("/api/admin/ai-providers")) {
    if (u.includes("/test")) {
      const pid = u.split("/")[4];
      if (pid === "gemini") return jsonResp({ status: "ok", result: { ok: true, testedAt: new Date().toISOString(), provider: "gemini", latencyMs: 700, model: "gemini-3.5-flash-lite", sample: "OK" } });
      if (pid === "anthropic") return jsonResp({ status: "ok", result: { ok: false, testedAt: new Date().toISOString(), provider: "anthropic", error: "no_api_key" } });
      return jsonResp({ status: "ok", result: { ok: true, testedAt: new Date().toISOString(), provider: "local", latencyMs: 120, model: "egytrend-local", sample: "جاهز" } });
    }
    if (u.includes("/set-disabled")) return jsonResp({ status: "ok", disabled: true, info: aiProvidersPayload.info });
    return jsonResp(aiProvidersPayload);
  }
  if (u.startsWith("/api/admin/settings/market-providers")) {
    if (u.includes("/impact")) return jsonResp({ status: "ok", impact: { instrumentSymbols: ["EGX30", "USD/EGP"], otherConfiguredProviders: [{ id: "mkt-bad", name: "مزوّد متعثر" }] } });
    if (u.includes("/test")) {
      const pid = u.split("/")[5];
      if (pid === "mkt-good") return jsonResp({ status: "ok", result: { ok: true, testedAt: new Date().toISOString(), kind: "quotes", symbol: "EGX30", price: 50123.4, currency: "EGP", asOf: Date.now(), freshness: "real-time" } });
      if (pid === "mkt-cal") return jsonResp({ status: "ok", result: { ok: true, testedAt: new Date().toISOString(), kind: "calendar", eventCount: 2, firstEventTitle: "اجتماع المركزي" } });
      return jsonResp({ status: "ok", result: { ok: false, testedAt: new Date().toISOString(), kind: "quotes", error: "upstream timeout" } });
    }
    if (u.includes("/set-disabled")) return jsonResp({ status: "ok", disabled: true, impact: { instrumentSymbols: [], otherConfiguredProviders: [] } });
    return jsonResp({ status: "ok", overview: mktOverview });
  }
  if (u.startsWith("/api/admin/audit-logs")) return jsonResp(auditPayload);
  if (u.startsWith("/api/admin/session")) {
    return jsonResp({ status: "ok", employee: { id: 1, name: "Super Smoke", role: smokeSessionRole, email: "super@example.test", permissions: null } });
  }
  if (u.startsWith("/api/admin/stats")) return jsonResp({ status: "ok", stats: { employees: 1, plans: 1, coupons: 0, auditLogs: 0, aiUsage30d: 0 }, recentAudit: [] });
  if (u.startsWith("/api/admin/requests")) return jsonResp({ status: "ok", requests: [] });
  /* syncSources() (called after every sources-tab mutation) fetches the
   * public feed list — stub it so the post-op re-render resolves. */
  if (u.startsWith("/api/news/sources")) return jsonResp({ status: "ok", sources: sourcesData.filter((s) => !s.archivedAt && !s.disabled).map((s) => ({ id: s.id, name: s.name, icon: s.icon, color: s.color, lang: s.lang, cat: s.cat })) });
  if (u.startsWith("/api/news")) return jsonResp({ status: "ok", items: [] });
  return never(); /* unrelated app fetches hang: no unhandled rejections */
};

const sandbox = {
  document: documentStub,
  navigator: { userAgent: "node-smoke", language: "ar-EG", clipboard: { writeText: () => Promise.resolve() } },
  location: { href: "http://localhost/admin", origin: "http://localhost", host: "localhost", protocol: "http:", pathname: "/admin", search: "", hash: "", replace() {} },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {}, clear() {} },
  fetch: fetchStub,
  AbortController,
  setTimeout, clearTimeout, setInterval, clearInterval,
  console,
  URL, URLSearchParams, Headers, Request, Response,
  crypto: { getRandomValues: (a) => a, randomUUID: () => "smoke-uuid", subtle: {} },
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
  alert() {}, confirm: () => false, prompt: () => null,
  requestAnimationFrame: () => 0, cancelAnimationFrame() {},
  Image: function () { return makeEl(); },
  performance: { now: () => Date.now() },
  MutationObserver: class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } },
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } },
  addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
  parseInt, parseFloat, isNaN, Number, String, Object, Array, Math, Date, JSON, Map, Set, Promise, RegExp, Error,
};
sandbox.window = sandbox;
sandbox.self = sandbox;
sandbox.globalThis = sandbox;

const ctx = vm.createContext(sandbox);
vm.runInContext(app, ctx, { timeout: 15000 }); /* declarations hoist; async init may hang on `never()` fetches */

/* ── scenario 1: table render with search/filter/sort/pagination state ── */
const rendered = await vm.runInContext(`
  (async () => {
    const el = document.getElementById("adm-body");
    await renderAdmUsers(el);
    return {
      info: document.getElementById("adm-users-info").innerHTML,
      head: document.getElementById("adm-users-head").innerHTML,
      rows: document.getElementById("adm-users-tbody").innerHTML,
      pager: document.getElementById("adm-users-pager").innerHTML,
    };
  })()
`, ctx);

assert.ok(rendered.info.includes("3 مستخدم مسجّل") && rendered.info.includes("عرض 1–3"), "count line shows total + range");
assert.ok(rendered.head.includes("البريد") && rendered.head.includes("آخر دخول"), "table exposes email + last-login columns");
assert.ok(rendered.head.includes("▼"), "default sort (createdAt desc) shows a direction arrow");
assert.ok(rendered.rows.includes("Sara Smoke") && rendered.rows.includes("sara@example.test"), "name + email rendered");
assert.ok(rendered.rows.includes("⭐ VIP"), "VIP badge rendered");
assert.ok(rendered.rows.includes("حتى "), "VIP expiry shown with the plan");
assert.ok(rendered.rows.includes("🚫 محظور"), "banned status badge rendered");
assert.ok(rendered.rows.includes("لم يسجل بعد"), "honest 'never logged in' state, not a fabricated date");
assert.ok(rendered.rows.includes("🗑 حذف نهائي"), "final-delete action shown for a super_admin session");
assert.ok(rendered.pager.includes("صفحة 1 من 1"), "pagination footer rendered");

/* ── scenario 2: non-super session never sees the delete action ── */
vm.runInContext(`admUsersState.role = "support";`, ctx);
const noDelete = await vm.runInContext(`
  (async () => {
    await renderAdmUsers(document.getElementById("adm-body"));
    return document.getElementById("adm-users-tbody").innerHTML;
  })()
`, ctx);
assert.ok(!noDelete.includes("حذف نهائي"), "delete action hidden for non-super_admin roles");
vm.runInContext(`admUsersState.role = "super_admin";`, ctx);

/* ── scenario 3: delete confirmation gate + server call ── */
vm.runInContext(`admUserDeleteOpen(2, "Omar Smoke", "01022222222");`, ctx);
const confirmEl = byId("adm-delete-confirm");
const goEl = byId("adm-delete-go");
/* Setting the value fires the app's own input listener (the real gate). */
confirmEl.value = "";
assert.ok(goEl.disabled === true, "empty confirmation keeps delete disabled");
confirmEl.value = "01099999999";
assert.ok(goEl.disabled === true, "a wrong confirmation keeps delete disabled");
confirmEl.value = "01022222222";
assert.ok(goEl.disabled === false, "typing the account's own phone enables delete");
await vm.runInContext(`admUserDeleteGo(2)`, ctx);
assert.ok(fetchedUrls.some((u) => u === "/api/admin/users/2/delete"), "delete POSTed to the guarded server route");
assert.ok(byId("toast").textContent.includes("تم حذف الحساب"), "success toast shown after delete");

/* a wrong confirmation never reaches the server: fresh modal, empty input. */
fetchedUrls.length = 0;
vm.runInContext(`admUserDeleteOpen(2, "Omar Smoke", "01022222222");`, ctx);
byId("adm-delete-confirm").value = "";
assert.ok(byId("adm-delete-go").disabled === true, "button re-disables when the confirmation is cleared");
await vm.runInContext(`admUserDeleteGo(2)`, ctx);
assert.ok(!fetchedUrls.some((u) => u.includes("/delete")), "no delete request without a confirmation value");

/* ── scenario 4: news-sources table — server health, honest flags ── */
const srcRendered = await vm.runInContext(`
  (async () => {
    const el = document.getElementById("adm-body");
    await renderAdmSources(el);
    return {
      summary: document.getElementById("asrc-summary").innerHTML,
      list: document.getElementById("asrc-list").innerHTML,
    };
  })()
`, ctx);
assert.ok(srcRendered.summary.includes("المصادر: 5"), "summary shows total sources");
assert.ok(srcRendered.summary.includes("✓ فعّالة: 2"), "summary counts operational sources");
assert.ok(srcRendered.summary.includes("✕ تفشل: 1"), "summary counts failing sources");
assert.ok(srcRendered.summary.includes("⏸ متوقفة: 1"), "summary counts stopped sources");
assert.ok(srcRendered.summary.includes("بانتظار الموافقة: 1"), "summary counts pending-legal sources");
assert.ok(srcRendered.summary.includes("🗃 مؤرشفة: 1"), "summary counts archived sources");
assert.ok(srcRendered.list.includes("مصدر سليم") && srcRendered.list.includes("✓ معتمد") && srcRendered.list.includes("✓ يعمل"), "healthy approved source renders operational badges");
assert.ok(srcRendered.list.includes("⌛ قديم"), "stale success (>2h) is flagged, not hidden");
assert.ok(srcRendered.list.includes("✕ فشل ×3"), "consecutive failures are flagged with a count");
assert.ok(srcRendered.list.includes("upstream timeout"), "last error reason is surfaced");
assert.ok(srcRendered.list.includes("⏸ متوقف"), "disabled source rendered as stopped");
assert.ok(srcRendered.list.includes("قيد المراجعة") && srcRendered.list.includes("لا يُجلب"), "pending-legal source is neither 'working' nor silently listed");
assert.ok(srcRendered.list.includes("🗃 مؤرشف"), "archived source stays in the inventory");
assert.ok(srcRendered.list.includes("⚡ فحص"), "connection-test action rendered");
assert.ok(srcRendered.list.includes("⏸ إيقاف"), "admin session sees the stop action");
assert.ok(srcRendered.list.includes("🗑 أرشفة"), "admin session sees the archive action");

/* probe: real server round-trip, result carries its own timestamp */
await vm.runInContext(`admSrcTest("ok-src")`, ctx);
assert.ok(byId("asrc-test-ok-src").innerHTML.includes("✓ 3 عنصر"), "probe success shows item count");
assert.ok(byId("asrc-test-ok-src").innerHTML.includes("↻"), "probe result offers a re-test");
await vm.runInContext(`admSrcTest("fail-src")`, ctx);
assert.ok(byId("asrc-test-fail-src").innerHTML.includes("✕") && byId("asrc-test-fail-src").innerHTML.includes("upstream timeout"), "probe failure shows the honest reason");

/* enable/disable goes through the guarded admin endpoint */
fetchedUrls.length = 0;
await vm.runInContext(`admSrcToggleDisabled("stop-src", false)`, ctx);
assert.ok(fetchedMeta.some((m) => m.url === "/api/admin/sources/stop-src/set-disabled" && m.method === "POST"), "enable toggles via POST /set-disabled");

/* archive (delete) requires the confirm() gate */
fetchedUrls.length = 0;
fetchedMeta.length = 0;
vm.runInContext(`globalThis.confirm = () => false;`, ctx);
await vm.runInContext(`delAdmSource("ok-src")`, ctx);
assert.ok(!fetchedMeta.some((m) => m.method === "DELETE"), "no archive request when the user cancels the confirmation");
vm.runInContext(`globalThis.confirm = () => true;`, ctx);
await vm.runInContext(`delAdmSource("ok-src")`, ctx);
assert.ok(fetchedMeta.some((m) => m.url === "/api/admin/sources/ok-src" && m.method === "DELETE"), "confirmed archive DELETEs the guarded route");

/* edit prefills the form and saves through PUT (never a new source) */
vm.runInContext(`admSrcEdit("ok-src")`, ctx);
assert.ok(byId("asrc-name").value === "مصدر سليم", "edit prefills the name field");
fetchedUrls.length = 0;
fetchedMeta.length = 0;
await vm.runInContext(`saveAdmSource()`, ctx);
assert.ok(fetchedMeta.some((m) => m.url === "/api/admin/sources/ok-src" && m.method === "PUT"), "edit saves via PUT on the same id");

/* ── scenario 5: market-data providers — proven state, gated toggles ── */
const mktRendered = await vm.runInContext(`
  (async () => {
    const el = document.getElementById("adm-body");
    await renderAdmMarket(el);
    return document.getElementById("adm-body").innerHTML;
  })()
`, ctx);
assert.ok(mktRendered.includes("المزوّدون: 5"), "summary shows provider count");
assert.ok(mktRendered.includes("✓ مهيّأ: 4"), "summary counts configured providers");
assert.ok(mktRendered.includes("⏸ معطّل إداريًا: 1"), "summary counts admin-disabled providers");
assert.ok(mktRendered.includes("بلا مفاتيح: 1"), "summary counts unconfigured providers");
assert.ok(mktRendered.includes("⚠ متدهور: 1"), "summary counts degraded providers");
assert.ok(mktRendered.includes("مزوّد سليم") && mktRendered.includes("✓ مفاتيح موجودة"), "configured provider shows key-presence state (not the key)");
assert.ok(mktRendered.includes("✕ ×4"), "consecutive failures flagged with count");
assert.ok(mktRendered.includes("⌛ بيانات قديمة"), "stale instrument listed for attention");
assert.ok(mktRendered.includes("لا يوجد سعر موثّق"), "instrument without any verified price is named, not priced");
assert.ok(mktRendered.includes("مرجع نهاية اليوم"), "end-of-day reference labelled honestly");
assert.ok(!mktRendered.includes(">EGX30</td>"), "fresh instrument is NOT in the attention list");
assert.ok(mktRendered.includes("⏸ إيقاف"), "admin session sees the stop action");
assert.ok(mktRendered.includes("12 سعر موثّق"), "board snapshot quote count shown");

/* probe: inline result with its own timestamp */
await vm.runInContext(`admMktTest("mkt-good")`, ctx);
assert.ok(byId("amkt-test-mkt-good").innerHTML.includes("✓ EGX30"), "probe success shows instrument + price context");
await vm.runInContext(`admMktTest("mkt-bad")`, ctx);
assert.ok(byId("amkt-test-mkt-bad").innerHTML.includes("✕") && byId("amkt-test-mkt-bad").innerHTML.includes("upstream timeout"), "probe failure shows the honest reason");
await vm.runInContext(`admMktTest("mkt-cal")`, ctx);
assert.ok(byId("amkt-test-mkt-cal").innerHTML.includes("✓ 2 حدث"), "calendar probe reports event count");

/* disable gate: the impact (affected instruments + remaining providers)
 * is fetched, and without confirm() no mutation request goes out. */
fetchedUrls.length = 0;
fetchedMeta.length = 0;
vm.runInContext(`globalThis.confirm = () => false;`, ctx);
await vm.runInContext(`admMktToggleFormless("mkt-good", true)`, ctx);
await new Promise((r) => setTimeout(r, 20));
assert.ok(fetchedMeta.some((m) => m.url === "/api/admin/settings/market-providers/mkt-good/impact"), "impact preview fetched for the confirmation dialog");
assert.ok(!fetchedMeta.some((m) => m.url.includes("/set-disabled")), "cancel keeps the provider enabled (no mutation request)");

/* confirm → the guarded mutation route is called */
vm.runInContext(`globalThis.confirm = () => true;`, ctx);
fetchedMeta.length = 0;
await vm.runInContext(`admMktToggleFormless("mkt-good", true)`, ctx);
await new Promise((r) => setTimeout(r, 30));
assert.ok(fetchedMeta.some((m) => m.url === "/api/admin/settings/market-providers/mkt-good/set-disabled" && m.method === "POST"), "confirmed disable hits the guarded route");

/* non-admin role never sees mutation buttons (role is cached client-side,
 * so the cache is set directly like scenario 2 does) */
smokeSessionRole = "support";
vm.runInContext(`admUsersState.role = "support";`, ctx);
const mktNoMut = await vm.runInContext(`
  (async () => {
    await renderAdmMarket(document.getElementById("adm-body"));
    return document.getElementById("adm-body").innerHTML;
  })()
`, ctx);
assert.ok(!mktNoMut.includes("⏸ إيقاف") && !mktNoMut.includes(">✓ تفعيل<"), "mutation buttons hidden for non-admin roles");
vm.runInContext(`admUsersState.role = "super_admin";`, ctx);
smokeSessionRole = "super_admin";

/* ── scenario 6: AI providers — presence only, honest chain ── */
const aiRendered = await vm.runInContext(`
  (async () => {
    const el = document.getElementById("adm-body");
    await renderAdmAIConfig(el);
    return document.getElementById("adm-body").innerHTML;
  })()
`, ctx);
assert.ok(aiRendered.includes("المحرك الفعّال الآن") && aiRendered.includes("gemini"), "active engine banner from the server");
assert.ok(aiRendered.includes("Google Gemini") && aiRendered.includes("✓ مفاتيح موجودة"), "configured provider shows key PRESENCE");
assert.ok(aiRendered.includes("بلا مفاتيح"), "unconfigured provider shows missing keys honestly");
assert.ok(aiRendered.includes("الاحتياطي") || aiRendered.includes("احتياطي"), "fallback role labelled");
assert.ok(aiRendered.includes("شبكة أمان"), "local safety net labelled as such");
assert.ok(aiRendered.includes("gemini-3.5-flash-lite"), "active model shown (config, not a secret)");
assert.ok(aiRendered.includes("نجح") , "last test result rendered with time");
assert.ok(!aiRendered.includes("synthetic") && !aiRendered.toLowerCase().includes("api_key="), "no credential material in the panel");
assert.ok(aiRendered.includes("تحليل الفرص في الموقع يعمل بقواعد محلية"), "feature mapping is honest: opps are rule-based, not AI");
assert.ok(aiRendered.includes("غير مرتبطة بوظيفة حية"), "legacy toggles labelled as stored-but-unwired");
assert.ok(aiRendered.includes("⏸ إيقاف"), "admin sees provider toggle");

/* probe: inline result + timestamp */
await vm.runInContext(`admAiProbe("gemini")`, ctx);
assert.ok(byId("aai-test-gemini").innerHTML.includes("✓ gemini-3.5-flash-lite"), "probe success shows model + latency");
await vm.runInContext(`admAiProbe("anthropic")`, ctx);
assert.ok(byId("aai-test-anthropic").innerHTML.includes("✕") && byId("aai-test-anthropic").innerHTML.includes("لا توجد مفاتيح"), "missing key gives the clear specific message");

/* toggle gate: confirm() required before the guarded route */
fetchedUrls.length = 0;
fetchedMeta.length = 0;
vm.runInContext(`globalThis.confirm = () => false;`, ctx);
await vm.runInContext(`admAiToggle("gemini", true)`, ctx);
assert.ok(!fetchedMeta.some((m) => m.url.includes("/set-disabled")), "cancel keeps the provider in the chain");
vm.runInContext(`globalThis.confirm = () => true;`, ctx);
fetchedMeta.length = 0;
await vm.runInContext(`admAiToggle("gemini", true)`, ctx);
assert.ok(fetchedMeta.some((m) => m.url === "/api/admin/ai-providers/gemini/set-disabled" && m.method === "POST"), "confirmed disable hits the guarded route");
vm.runInContext(`globalThis.confirm = () => false;`, ctx);

/* ── scenario 7: audit log — admin-only, dynamic filter, result/reason detail ── */
const auditRendered = await vm.runInContext(`
  (async () => {
    const el = document.getElementById("adm-body");
    await renderAdmAudit(el);
    return {
      body: document.getElementById("adm-body").innerHTML,
      list: document.getElementById("aadit-list").innerHTML,
      filter: document.getElementById("aadit-action").innerHTML,
    };
  })()
`, ctx);
assert.ok(auditRendered.filter.includes('value="ban_user"'), "action filter populated from server meta");
assert.ok(auditRendered.filter.includes("حظر مستخدم"), "Arabic action label rendered in the filter");
assert.ok(auditRendered.filter.includes("(1)"), "per-action count shown");
assert.ok(auditRendered.body.includes("هذا القسم للمدير فقط") === false, "admin session is not locked out");
assert.ok(auditRendered.body.includes("لا يمكن تعديل السجل أو حذفه"), "honest note: the log is not mutable from any UI");
assert.ok(auditRendered.list.includes("Super Smoke"), "actor name rendered (not an opaque id)");
assert.ok(auditRendered.list.includes("user:77"), "target element rendered");
assert.ok(auditRendered.list.includes("المحرك الفعّال: local"), "result detail (effective engine) surfaced as a chip");
assert.ok(auditRendered.list.includes("بواسطة: Super Smoke"), "who applied the change surfaced from detail");
assert.ok(auditRendered.list.includes("→ staff:2"), "login rows keep the staff target identifier");

/* non-admin sessions get the honest lockout, not an error page */
smokeSessionRole = "support";
vm.runInContext(`admUsersState.role = "support";`, ctx);
const auditLocked = await vm.runInContext(`
  (async () => {
    const el = document.getElementById("adm-body");
    await renderAdmAudit(el);
    return document.getElementById("adm-body").innerHTML;
  })()
`, ctx);
assert.ok(auditLocked.includes("هذا القسم للمدير فقط"), "support role sees the admin-only lockout");
assert.ok(!auditLocked.includes("aadit-search"), "no audit controls rendered for a support session");
vm.runInContext(`admUsersState.role = "super_admin";`, ctx);
smokeSessionRole = "super_admin";
