import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { after, before, test } from "node:test";
import jwt from "jsonwebtoken";
import { eq } from "drizzle-orm";
import {
  appSettingsTable,
  appUsersTable,
  couponsTable,
  employeesTable,
  passwordResetsTable,
  paymentRequestsTable,
  portfolioPositionsTable,
  userPriceAlertsTable,
  userCalculatorActivityTable,
  userCalculatorScenariosTable,
  opportunities,
  planPriceOffersTable,
  subscriptionPlansTable,
  subscriptionLifecycleEventsTable,
  subscriptionRemindersSentTable,
  trialClaimsTable,
  freeTrialMessageStepsTable,
  userNotificationsTable,
  userSubscriptionsTable,
} from "@workspace/db/schema";
import { createMemoryDatabase } from "../test-support/memory-db";

/* This is intentionally an in-process pg-mem database with synthetic data.
 * It has no DATABASE_URL, no network listener, and cannot reach a Neon/Vercel
 * database. The application is imported only after the test DB is injected. */
process.env.NODE_ENV = "test";
/* This scenario pins the no-provider contract: the restored legacy free feeds
 * must stay off so the portfolio quote below can only be a fake. */
process.env.LEGACY_MARKET_FEEDS_DISABLED = "true";
process.env.SESSION_SECRET = "test-only-session-secret-not-for-deployment";
process.env.LOG_LEVEL = "silent";

type MemoryDatabase = Awaited<ReturnType<typeof createMemoryDatabase>>;
let memory: MemoryDatabase;
let server: http.Server;
let baseUrl = "";

function employeePasswordHash(password: string): string {
  const salt = "00112233445566778899aabbccddeeff";
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

type CookieJar = { value?: string };

async function api(path: string, jar: CookieJar, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Origin", baseUrl);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (jar.value) headers.set("Cookie", jar.value);
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) jar.value = setCookie.split(";")[0];
  const raw = await response.text();
  let body: Record<string, unknown> | null = null;
  try { body = raw ? JSON.parse(raw) as Record<string, unknown> : null; } catch { /* non-JSON error response */ }
  return { response, body, raw };
}

async function paymentPricingToken(jar: CookieJar, planKey: string): Promise<string> {
  const config = await api("/api/payments/config", jar);
  assert.equal(config.response.status, 200);
  const plans = (config.body?.plans as Array<{ key?: string; pricingToken?: string }>) || [];
  const token = plans.find((plan) => plan.key === planKey)?.pricingToken || "";
  assert.ok(token, "a payment submission must use the fresh server-rendered pricing token");
  return token;
}

before(async () => {
  memory = await createMemoryDatabase();
  (globalThis as typeof globalThis & { __egytrendTestDatabase?: typeof memory.db }).__egytrendTestDatabase = memory.db;

  /* pg-mem cannot run the history repository's window-function query; this
   * plain-select equivalent carries the same contract (same table, same
   * rows). The market history route must stay honest in both engines: an
   * empty store yields an explicit empty state, never a fabricated chart. */
  const { setMarketHistoryReadRepositoryForTest } = await import("../lib/market-data/history");
  const { marketDailyOhlcTable } = await import("@workspace/db/schema");
  setMarketHistoryReadRepositoryForTest({
    async list(instrumentIds: string[], fromDate?: string) {
      const rows = await memory.db.select().from(marketDailyOhlcTable);
      return rows
        .filter((row) => instrumentIds.includes(row.instrumentId) && (!fromDate || row.tradingDate >= fromDate))
        .sort((a, b) => a.tradingDate.localeCompare(b.tradingDate));
    },
  });

  await memory.db.insert(subscriptionPlansTable).values({
    key: "synthetic-vip",
    nameAr: "باقة اختبار معزولة",
    price: 137,
    durationMonths: 1,
    features: [],
    isActive: true,
  });
  await memory.db.insert(appSettingsTable).values([
    { key: "payment_vodafone_number", value: "01000000000" },
    { key: "payment_vodafone_enabled", value: "1" },
  ]);
  await memory.db.insert(employeesTable).values({
    name: "Synthetic Admin",
    email: "admin.synthetic@example.test",
    role: "admin",
    status: "active",
    passwordHash: employeePasswordHash("SyntheticAdminPass1!"),
    /* An explicit list narrows the role: pricing stays a separate gate, and
     * /admin/requests + /admin/subscriptions need the payments permission. */
    permissions: ["pricing.manage", "payments"],
  });

  const { default: app } = await import("../app");
  server = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  const { setMarketHistoryReadRepositoryForTest } = await import("../lib/market-data/history");
  setMarketHistoryReadRepositoryForTest(null);
  if (server) {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
  if (memory) await memory.close();
  delete (globalThis as typeof globalThis & { __egytrendTestDatabase?: typeof memory.db }).__egytrendTestDatabase;
});

test("isolated synthetic user payment lifecycle is server-authorized end to end", async () => {
  const userJar: CookieJar = {};
  const adminJar: CookieJar = {};

  const registration = await api("/api/user/register", userJar, {
    method: "POST",
    body: JSON.stringify({
      name: "Synthetic User",
      phone: "01012345678",
      password: "SyntheticUserPass1!",
      email: "user.synthetic@example.test",
    }),
  });
  assert.equal(registration.response.status, 201, "synthetic user registration should succeed");
  assert.equal(registration.body?.status, "ok");
  assert.match(userJar.value || "", /^et_user_session=/);
  assert.match(registration.response.headers.get("set-cookie") || "", /HttpOnly/i);

  const profileBefore = await api("/api/user/me", userJar);
  assert.equal(profileBefore.response.status, 200);
  assert.equal((profileBefore.body?.user as { plan?: string }).plan, "free");
  const freePortfolio = await api("/api/portfolio", userJar);
  assert.equal(freePortfolio.response.status, 403, "portfolio data is server-gated for VIP");
  const freeAlerts = await api("/api/price-alerts", userJar);
  assert.equal(freeAlerts.response.status, 403, "price alerts are server-gated for VIP");

  /* The former weaker path must not accept a payment even from a session. */
  const retiredPath = await api("/api/admin/requests", userJar, {
    method: "POST",
    body: JSON.stringify({ planKey: "synthetic-vip", price: 1 }),
  });
  assert.equal(retiredPath.response.status, 410);

  const payment = await api("/api/payments", userJar, {
    method: "POST",
    body: JSON.stringify({
      planKey: "synthetic-vip",
      pricingToken: await paymentPricingToken(userJar, "synthetic-vip"),
      method: "vodafone",
      tx: "synthetic-transfer-001",
      proofImage: "data:image/png;base64,iVBORw0KGgo=",
      proofName: "synthetic-proof.png",
    }),
  });
  assert.equal(payment.response.status, 200);
  assert.equal(payment.body?.status, "ok");
  const paymentId = String(payment.body?.id || "");
  assert.match(paymentId, /^req-/);

  const [storedPayment] = await memory.db.select().from(paymentRequestsTable)
    .where(eq(paymentRequestsTable.id, paymentId));
  assert.equal(storedPayment?.price, 137, "price must come from the server plan, never the client");
  assert.equal(storedPayment?.status, "pending");

  const adminLogin = await api("/api/admin/login", adminJar, {
    method: "POST",
    body: JSON.stringify({ email: "admin.synthetic@example.test", password: "SyntheticAdminPass1!" }),
  });
  assert.equal(adminLogin.response.status, 200);
  assert.equal(adminLogin.body?.status, "ok");
  assert.match(adminJar.value || "", /^et_admin_session=/);

  /* Opportunity removal is archival, never a destructive data delete. The
   * deprecated target-return input is ignored rather than stored anew. */
  const observationCreate = await api("/api/opportunities", adminJar, {
    method: "POST",
    body: JSON.stringify({
      title: "Synthetic observation",
      summary: "Synthetic source-backed test content",
      type: "stock",
      market: "egypt",
      expectedReturn: "99% fabricated input",
    }),
  });
  assert.equal(observationCreate.response.status, 200);
  assert.equal(observationCreate.body?.status, "ok");
  const observationId = String(observationCreate.body?.id || "");
  const archive = await api(`/api/opportunities/${encodeURIComponent(observationId)}`, adminJar, { method: "DELETE" });
  assert.equal(archive.response.status, 200);
  assert.equal(archive.body?.archived, true);
  const [archivedObservation] = await memory.db.select().from(opportunities)
    .where(eq(opportunities.id, observationId));
  assert.equal(archivedObservation?.status, "closed");
  assert.equal(archivedObservation?.expectedReturn, null);

  const requests = await api("/api/admin/requests", adminJar);
  assert.equal(requests.response.status, 200);
  const listed = (requests.body?.requests as Array<{ id?: string }>) || [];
  assert.ok(listed.some((request) => request.id === paymentId));

  const approval = await api(`/api/admin/requests/${encodeURIComponent(paymentId)}`, adminJar, {
    method: "PUT",
    body: JSON.stringify({ status: "approved" }),
  });
  assert.equal(approval.response.status, 200);
  assert.equal(approval.body?.status, "ok");

  /* The original free-plan cookie must receive the server-side VIP state. */
  const profileAfter = await api("/api/user/me", userJar);
  assert.equal(profileAfter.response.status, 200);
  assert.equal((profileAfter.body?.user as { plan?: string }).plan, "vip");

  /* Portfolio positions live in the isolated server database. Entry cost is
   * user input; a missing licensed quote must remain `market: null`. */
  const createPosition = await api("/api/portfolio/positions", userJar, {
    method: "POST",
    body: JSON.stringify({ symbol: "COMI", quantity: 25, averageCost: 42.5 }),
  });
  assert.equal(createPosition.response.status, 201);
  const positionId = String(createPosition.body?.id || "");
  const portfolio = await api("/api/portfolio", userJar);
  assert.equal(portfolio.response.status, 200);
  const positions = (portfolio.body?.positions as Array<{ id?: string; symbol?: string; name?: string | null; sector?: string | null; averageCost?: number; market?: unknown }>) || [];
  assert.equal(positions.length, 1);
  assert.equal(positions[0]?.id, positionId);
  assert.equal(positions[0]?.symbol, "COMI");
  assert.equal(positions[0]?.averageCost, 42.5);
  /* The portfolio charts group by the server's own catalog label, so the
   * response must carry it: a browser may not invent a sector for a symbol. */
  assert.equal(positions[0]?.sector, "بنوك");
  assert.equal(positions[0]?.name, "البنك التجاري الدولي");
  assert.equal(positions[0]?.market, null, "no provider must not create a fake quote");
  const updatePosition = await api(`/api/portfolio/positions/${encodeURIComponent(positionId)}`, userJar, {
    method: "PUT",
    body: JSON.stringify({ symbol: "COMI", quantity: 30, averageCost: 41.25 }),
  });
  assert.equal(updatePosition.response.status, 200);
  const archivePosition = await api(`/api/portfolio/positions/${encodeURIComponent(positionId)}`, userJar, { method: "DELETE" });
  assert.equal(archivePosition.response.status, 200);
  const [archivedPosition] = await memory.db.select().from(portfolioPositionsTable)
    .where(eq(portfolioPositionsTable.id, positionId));
  assert.equal(archivedPosition?.status, "archived", "portfolio records are archived, not deleted");
  const restorePosition = await api("/api/portfolio/positions", userJar, {
    method: "POST",
    body: JSON.stringify({ symbol: "COMI", quantity: 30, averageCost: 41.25 }),
  });
  assert.equal(restorePosition.response.status, 200);
  assert.equal(restorePosition.body?.restored, true);

  const createAlert = await api("/api/price-alerts", userJar, {
    method: "POST",
    body: JSON.stringify({ symbol: "COMI", condition: "price_above", targetValue: 55, emailEnabled: false }),
  });
  assert.equal(createAlert.response.status, 201);
  const alertId = String(createAlert.body?.id || "");
  const ownAlerts = await api("/api/price-alerts", userJar);
  assert.equal(ownAlerts.response.status, 200);
  assert.equal(((ownAlerts.body?.alerts as Array<{ id?: string; status?: string }>) || []).find((alert) => alert.id === alertId)?.status, "active");
  const archiveAlert = await api(`/api/price-alerts/${encodeURIComponent(alertId)}`, userJar, { method: "DELETE" });
  assert.equal(archiveAlert.response.status, 200);
  const [archivedAlert] = await memory.db.select().from(userPriceAlertsTable)
    .where(eq(userPriceAlertsTable.id, alertId));
  assert.equal(archivedAlert?.status, "archived", "price alert records are archived, not deleted");
  const restoreAlert = await api("/api/price-alerts", userJar, {
    method: "POST",
    body: JSON.stringify({ symbol: "COMI", condition: "price_above", targetValue: 55, emailEnabled: false }),
  });
  assert.equal(restoreAlert.response.status, 200);
  assert.equal(restoreAlert.body?.restored, true);

  /* An active member may submit one server-priced renewal before expiry;
   * it remains pending until a separate admin approval stacks the duration. */
  const renewalWhileVip = await api("/api/payments", userJar, {
    method: "POST",
    body: JSON.stringify({
      planKey: "synthetic-vip",
      pricingToken: await paymentPricingToken(userJar, "synthetic-vip"),
      method: "vodafone",
      tx: "synthetic-transfer-002",
      proofImage: "data:image/png;base64,iVBORw0KGgo=",
    }),
  });
  assert.equal(renewalWhileVip.response.status, 200);
  assert.equal(renewalWhileVip.body?.status, "ok");
  const renewalId = String(renewalWhileVip.body?.id || "");
  assert.match(renewalId, /^req-/);
  const membershipView = await api("/api/payments/my", userJar);
  assert.equal(membershipView.response.status, 200);
  assert.equal((membershipView.body?.subscription as { active?: boolean }).active, true);
  assert.ok(((membershipView.body?.requests as unknown[]) || []).length >= 2, "own payment history is returned");

  const [user] = await memory.db.select().from(appUsersTable)
    .where(eq(appUsersTable.phone, "01012345678"));
  assert.ok(user);
  const [subscription] = await memory.db.select().from(userSubscriptionsTable)
    .where(eq(userSubscriptionsTable.userId, user.id));
  assert.equal(subscription?.status, "active", "approval must write the server entitlement record");
  assert.equal(subscription?.planKey, "synthetic-vip");
  assert.ok(subscription?.expiresAt && subscription.expiresAt > new Date());

  const renewalApproval = await api(`/api/admin/requests/${encodeURIComponent(renewalId)}`, adminJar, {
    method: "PUT",
    body: JSON.stringify({ status: "approved" }),
  });
  assert.equal(renewalApproval.response.status, 200);
  const [renewedSubscription] = await memory.db.select().from(userSubscriptionsTable)
    .where(eq(userSubscriptionsTable.userId, user.id));
  assert.ok(renewedSubscription?.expiresAt && subscription?.expiresAt && renewedSubscription.expiresAt > subscription.expiresAt,
    "approved renewal must extend the same central entitlement");

  /* The entitlement table wins over both the legacy projection and a forged
   * JWT. Cancelling it must fail closed even while app_users still says VIP. */
  await memory.db.update(userSubscriptionsTable).set({
    status: "cancelled",
    cancelledAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(userSubscriptionsTable.userId, user.id));

  const staleVipJar: CookieJar = {
    value: `et_user_session=${jwt.sign({ sub: user.id, phone: user.phone, name: user.name, role: "user", plan: "vip" }, process.env.SESSION_SECRET!, { expiresIn: "1h" })}`,
  };
  const staleVipAttempt = await api("/api/ai/chat", staleVipJar, {
    method: "POST",
    body: JSON.stringify({ messages: [{ role: "user", content: "test" }] }),
  });
  /* 403, not 401: the session IS valid, the entitlement is not. 401 stays
   * reserved for missing/invalid sessions so the client can offer "log in"
   * vs "renew subscription" vs "server hiccup" accordingly. */
  assert.equal(staleVipAttempt.response.status, 403, "stale JWT VIP must not grant paid access (denied as non-VIP, not anonymous)");

  /* A public status probe cannot trigger a provider health call. */
  const anonymousProbe = await api("/api/ai/status?verify=1", {});
  assert.equal(anonymousProbe.response.status, 403);

  /* With no licensed market provider configured, the API must be transparent:
   * no Yahoo/TradingView/other unlicensed fallback and no fabricated price.
   * The openly-licensed daily FX reference feed (open.er-api.com) is the only
   * enabled provider here, but it is a third-party free endpoint: in
   * environments where it is unreachable (offline CI, runner egress limits)
   * the board has no verified snapshot and MUST fail closed with a clear
   * unavailable state — never with invented rows. Both outcomes are asserted;
   * neither may fabricate data. */
  const markets = await api("/api/markets", {});
  if (markets.response.status === 200) {
    assert.equal(markets.body?.status, "ok");
    const marketPayload = markets.body?.markets as Record<string, unknown[]>;
    /* The only enabled provider is the openly-licensed daily FX reference
     * feed, which serves the board's `fx` section (the pre-M1 shape put it
     * in `eg` — the audit caught the stale pin failing on CI, where the
     * feed is reachable and the 200 branch actually runs). Every rate must
     * carry its provider name, its end-of-day classification and the
     * provider's own timestamp; nothing is invented for the keyed sections
     * (Egypt index, global indices, commodities, crypto), which stay
     * explicitly empty + unavailable rather than silently green. */
    const fxRows = marketPayload.fx as Array<Record<string, unknown>>;
    assert.ok(fxRows.length > 0, "reference FX rates are served");
    for (const raw of fxRows) {
      assert.equal(raw.source, "ExchangeRate-API");
      assert.equal(raw.freshness, "end-of-day");
      assert.ok(Number.isFinite(raw.asOf) && (raw.asOf as number) > 0, "every rate carries a provider timestamp");
      assert.equal(raw.flat, true, "no change direction is invented for a daily reference rate");
    }
    assert.deepEqual(marketPayload.eg, []);
    assert.deepEqual(marketPayload.gl, []);
    assert.deepEqual(marketPayload.cm, []);
    assert.deepEqual(marketPayload.cr, []);
    const sections = (markets.body?.freshness as { sections?: Record<string, { unavailable?: boolean }> }).sections ?? {};
    assert.equal(sections.fx?.unavailable, false, "the FX reference section is available");
    assert.equal(sections.eg?.unavailable, true, "the Egypt index section is honestly unavailable without its licensed provider");
    assert.equal(sections.cm?.unavailable, true);
  } else {
    /* Reference feed unreachable from this environment: fail closed. */
    assert.equal(markets.response.status, 503, `unlicensed-board must fail closed when the reference feed is unreachable, got ${markets.response.status}`);
    assert.equal(markets.body?.status, "error", "unavailable state is explicit, not a silent empty board");
    assert.equal(markets.body?.markets, undefined, "no market payload is served when the board is unavailable");
  }

  /* Historical chart reads are also fail-closed. With no currently-approved
   * external-display provider, old/missing DB rows cannot become a fabricated
   * chart and the basic free endpoint remains an explicit empty state. */
  const history = await api("/api/markets/history/index%3ASPX?range=1M&indicators=1", {});
  assert.equal(history.response.status, 200);
  assert.equal(history.body?.status, "ok");
  assert.equal(history.body?.available, false);
  assert.deepEqual(history.body?.points, []);
  assert.equal(history.body?.indicatorAccess, "vip_required");

  const sparklines = await api("/api/markets/sparklines?ids=index%3ASPX%2Cstock%3Aegx%3ACOMI", {});
  assert.equal(sparklines.response.status, 200);
  assert.equal(sparklines.body?.status, "ok");
  assert.ok(Array.isArray(sparklines.body?.series));
  assert.ok((sparklines.body?.series as Array<{ available?: boolean }>).every((series) => series.available === false));

  const marketSources = await api("/api/markets/sources", {});
  assert.equal(marketSources.response.status, 200);
  assert.equal(marketSources.body?.status, "ok");
  assert.ok(Array.isArray(marketSources.body?.providers));

  const snapshotAttempt = await api("/api/markets/internal/daily-snapshot", {}, { method: "POST" });
  assert.equal(snapshotAttempt.response.status, 404, "history writing route stays invisible without a configured cron secret");

  const logout = await api("/api/user/logout", userJar, { method: "POST" });
  assert.equal(logout.response.status, 204);
  const profileAfterLogout = await api("/api/user/me", userJar);
  assert.equal(profileAfterLogout.response.status, 401);
});

test("VIP calculator runtime, persistence and direct asset access are server-gated", async () => {
  const freeJar: CookieJar = {};
  const freeRegistration = await api("/api/user/register", freeJar, {
    method: "POST",
    body: JSON.stringify({
      name: "Calculator Free User",
      phone: "01066660001",
      password: "CalculatorFreePass1!",
      email: "calculator.free@example.test",
    }),
  });
  assert.equal(freeRegistration.response.status, 201);

  /* A free authenticated user must fail every route individually. In
   * particular, a copied JS module URL cannot disclose calculation code. */
  for (const path of ["/api/calculators/bootstrap", "/api/calculators/runtime.js", "/api/calculators/math.js", "/api/calculators/scenarios?calculator=pl", "/api/calculators/history"]) {
    const denied = await api(path, freeJar);
    assert.equal(denied.response.status, 403, `${path} must reject a free user`);
  }
  const deniedExport = await api("/api/calculators/export", freeJar, {
    method: "POST",
    body: JSON.stringify({ calculatorKey: "pl", inputs: { buyPrice: 100 }, result: { ok: true, net: 1000 } }),
  });
  assert.equal(deniedExport.response.status, 403, "PDF export authorization must reject a free user");
  const deniedSave = await api("/api/calculators/scenarios", freeJar, {
    method: "POST",
    body: JSON.stringify({ calculatorKey: "pl", name: "محاولة مجانية", inputs: { buyPrice: 100 }, result: { ok: true, net: 1000 } }),
  });
  assert.equal(deniedSave.response.status, 403, "scenario saving must reject a free user");
  const deniedHistory = await api("/api/calculators/history", freeJar, {
    method: "POST",
    body: JSON.stringify({ calculatorKey: "pl", action: "copied", inputs: { buyPrice: 100 }, result: { ok: true, net: 1000 } }),
  });
  assert.equal(deniedHistory.response.status, 403, "history writing must reject a free user");
  const anonymousAsset = await api("/api/calculators/runtime.js", {});
  assert.equal(anonymousAsset.response.status, 401, "runtime asset must reject an anonymous direct request");

  const [freeUser] = await memory.db.select().from(appUsersTable).where(eq(appUsersTable.phone, "01066660001"));
  assert.ok(freeUser);
  const now = new Date();
  await memory.db.insert(userSubscriptionsTable).values({
    id: "sub-calculator-vip-test",
    userId: freeUser.id,
    planKey: "synthetic-vip",
    planNameAr: "باقة اختبار الحاسبات",
    planDurationMonths: 1,
    planFeatures: [],
    status: "active",
    cycleId: "cycle-calculator-vip-test",
    startsAt: now,
    expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
    source: "test",
    createdAt: now,
    updatedAt: now,
  });

  const bootstrap = await api("/api/calculators/bootstrap", freeJar);
  assert.equal(bootstrap.response.status, 200);
  assert.equal(bootstrap.body?.status, "ok");
  assert.equal(bootstrap.response.headers.get("cache-control"), "private, no-store, max-age=0");

  const runtime = await api("/api/calculators/runtime.js", freeJar);
  assert.equal(runtime.response.status, 200);
  assert.match(runtime.raw, /mountCalculatorRuntime/);
  assert.match(runtime.response.headers.get("content-type") || "", /javascript/);
  assert.match(runtime.response.headers.get("cache-control") || "", /no-store/);
  const math = await api("/api/calculators/math.js", freeJar);
  assert.equal(math.response.status, 200);
  assert.match(math.raw, /function profitLoss/);

  const scenario = await api("/api/calculators/scenarios", freeJar, {
    method: "POST",
    body: JSON.stringify({
      calculatorKey: "pl", name: "اختبار ربح", inputs: { buyPrice: 100, sellPrice: 120, quantity: 50, commissionPercent: 0 },
      result: { ok: true, net: 1000, returnPercent: 20 },
    }),
  });
  assert.equal(scenario.response.status, 201);
  const scenarioId = String(scenario.body?.id || "");
  assert.match(scenarioId, /^[a-f0-9-]{20,80}$/i);
  const scenarios = await api("/api/calculators/scenarios?calculator=pl", freeJar);
  assert.equal(scenarios.response.status, 200);
  const saved = (scenarios.body?.scenarios as Array<{ id?: string; name?: string }>) || [];
  assert.equal(saved.find((item) => item.id === scenarioId)?.name, "اختبار ربح");
  const [savedRow] = await memory.db.select().from(userCalculatorScenariosTable).where(eq(userCalculatorScenariosTable.id, scenarioId));
  assert.equal(savedRow?.status, "active");

  const exportAuthorization = await api("/api/calculators/export", freeJar, {
    method: "POST",
    body: JSON.stringify({ calculatorKey: "pl", inputs: { buyPrice: 100 }, result: { ok: true, net: 1000 } }),
  });
  assert.equal(exportAuthorization.response.status, 201);
  assert.equal(exportAuthorization.body?.exportAuthorized, true);
  const history = await api("/api/calculators/history", freeJar, {
    method: "POST",
    body: JSON.stringify({ calculatorKey: "pl", action: "copied", inputs: { buyPrice: 100 }, result: { ok: true, net: 1000 } }),
  });
  assert.equal(history.response.status, 201);
  const historyList = await api("/api/calculators/history", freeJar);
  assert.equal(historyList.response.status, 200);
  assert.ok(((historyList.body?.history as unknown[]) || []).length >= 3, "saving, exporting and copying produce server-owned history");
  const activities = await memory.db.select().from(userCalculatorActivityTable).where(eq(userCalculatorActivityTable.userId, freeUser.id));
  assert.ok(activities.some((activity) => activity.action === "saved"));
  assert.ok(activities.some((activity) => activity.action === "exported"));
  assert.ok(activities.some((activity) => activity.action === "copied"));

  const archive = await api(`/api/calculators/scenarios/${encodeURIComponent(scenarioId)}`, freeJar, { method: "DELETE" });
  assert.equal(archive.response.status, 200);
  const [archivedScenario] = await memory.db.select().from(userCalculatorScenariosTable).where(eq(userCalculatorScenariosTable.id, scenarioId));
  assert.equal(archivedScenario?.status, "archived", "calculator scenarios archive rather than delete");

  /* No configured provider in this isolated harness may turn into a fake quote
   * or synthetic FX rate. Both endpoints answer transparently. */
  const quote = await api("/api/calculators/quote?symbol=COMI", freeJar);
  assert.equal(quote.response.status, 503);
  const fx = await api("/api/calculators/fx", freeJar);
  assert.equal(fx.response.status, 503);
});

test("subscription price policy schedules, targets, snapshots and authorizes edits on the server", async () => {
  const { getEffectivePrice, invalidatePricingCache, parseCairoDateTime } = await import("../lib/pricing");
  const cairoScheduledAt = parseCairoDateTime("2030-01-01T10:00", "بداية العرض");
  assert.ok(cairoScheduledAt);
  const cairoHour = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Cairo", hour: "2-digit", hourCycle: "h23" }).format(cairoScheduledAt);
  assert.equal(cairoHour, "10", "a bare admin datetime must be interpreted as Cairo wall time");
  const [plan] = await memory.db.select().from(subscriptionPlansTable)
    .where(eq(subscriptionPlansTable.key, "synthetic-vip"));
  assert.ok(plan);

  const newUserJar: CookieJar = {};
  const newRegistration = await api("/api/user/register", newUserJar, {
    method: "POST",
    body: JSON.stringify({
      name: "Pricing New User",
      phone: "01055550001",
      password: "PricingNewUserPass1!",
      email: "pricing.new@example.test",
    }),
  });
  assert.equal(newRegistration.response.status, 201);
  const [newUser] = await memory.db.select().from(appUsersTable).where(eq(appUsersTable.phone, "01055550001"));
  assert.ok(newUser);

  /* Time-aware calculation never needs a cron: before the offer it returns
   * base, during it returns the old/current display, and at end it returns
   * base immediately. The special price is visible only to its audience. */
  const start = new Date("2030-01-01T08:00:00.000Z");
  const end = new Date("2030-01-01T10:00:00.000Z");
  await memory.db.insert(planPriceOffersTable).values({
    id: "offer-pricing-schedule-new-user",
    planId: plan.id,
    audience: "new_users",
    price: 99,
    oldPrice: 137,
    badgeMode: "auto",
    startsAt: start,
    endsAt: end,
    showCountdown: true,
    priority: 10,
    status: "active",
  });
  invalidatePricingCache();
  const before = await getEffectivePrice({ sub: newUser.id, phone: newUser.phone }, plan, new Date("2030-01-01T07:59:59.000Z"));
  assert.equal(before.price, 137, "scheduled price must not start early");
  const during = await getEffectivePrice({ sub: newUser.id, phone: newUser.phone }, plan, new Date("2030-01-01T09:00:00.000Z"));
  assert.equal(during.price, 99);
  assert.equal(during.oldPrice, 137);
  assert.equal(during.discountPercent, 28);
  assert.equal(during.showCountdown, true);
  const anonymous = await getEffectivePrice(null, plan, new Date("2030-01-01T09:00:00.000Z"));
  assert.equal(anonymous.price, 137, "targeted offer must not leak to a different audience");
  const after = await getEffectivePrice({ sub: newUser.id, phone: newUser.phone }, plan, end);
  assert.equal(after.price, 137, "price must return at the exact offer end");

  const adminJar: CookieJar = {};
  const adminLogin = await api("/api/admin/login", adminJar, {
    method: "POST",
    body: JSON.stringify({ email: "admin.synthetic@example.test", password: "SyntheticAdminPass1!" }),
  });
  assert.equal(adminLogin.response.status, 200);

  /* The server rejects a fabricated strikethrough price rather than silently
   * accepting an old price below the current amount. */
  const invalidOldPrice = await api(`/api/admin/plans/${plan.id}/pricing`, adminJar, {
    method: "PUT",
    body: JSON.stringify({
      price: 137,
      oldPrice: 136,
      priceBadgeMode: "auto",
      offers: [],
    }),
  });
  assert.equal(invalidOldPrice.response.status, 400);
  const invalidSchedule = await api(`/api/admin/plans/${plan.id}/pricing`, adminJar, {
    method: "PUT",
    body: JSON.stringify({
      price: 137,
      oldPrice: null,
      priceBadgeMode: "none",
      offers: [{
        audience: "all",
        price: 99,
        oldPrice: 137,
        badgeMode: "auto",
        startsAt: "2030-01-01T11:00",
        endsAt: "2030-01-01T10:00",
        showCountdown: true,
      }],
    }),
  });
  assert.equal(invalidSchedule.response.status, 400, "end must be strictly after start in Cairo time");

  /* A staff account without pricing.manage cannot alter a paid amount even
   * with a valid server-side session. */
  await memory.db.insert(employeesTable).values({
    name: "No Pricing Permission",
    email: "no-pricing@example.test",
    role: "support",
    status: "active",
    passwordHash: employeePasswordHash("NoPricingPass1!"),
    permissions: [],
  });
  const noPricingJar: CookieJar = {};
  const noPricingLogin = await api("/api/admin/login", noPricingJar, {
    method: "POST",
    body: JSON.stringify({ email: "no-pricing@example.test", password: "NoPricingPass1!" }),
  });
  assert.equal(noPricingLogin.response.status, 200);
  const forbiddenPriceEdit = await api(`/api/admin/plans/${plan.id}/pricing`, noPricingJar, {
    method: "PUT",
    body: JSON.stringify({ price: 1, offers: [] }),
  });
  assert.equal(forbiddenPriceEdit.response.status, 403);

  /* A browser-supplied price is ignored. The effective result is stored as an
   * immutable snapshot and remains the same after an admin changes base price. */
  const initialPricingToken = await paymentPricingToken(newUserJar, "synthetic-vip");
  const submitted = await api("/api/payments", newUserJar, {
    method: "POST",
    body: JSON.stringify({
      planKey: "synthetic-vip",
      pricingToken: initialPricingToken,
      method: "vodafone",
      price: 1,
      tx: "pricing-snapshot-transfer-001",
      proofImage: "data:image/png;base64,iVBORw0KGgo=",
      proofName: "pricing-proof.png",
    }),
  });
  assert.equal(submitted.response.status, 200);
  const requestId = String(submitted.body?.id || "");
  const [initialRequest] = await memory.db.select().from(paymentRequestsTable)
    .where(eq(paymentRequestsTable.id, requestId));
  assert.equal(initialRequest?.price, 137, "the requested amount must come from the server, not price: 1");
  assert.ok(initialRequest?.priceLockedUntil && initialRequest.priceLockedUntil > new Date());
  assert.equal((initialRequest?.priceSnapshot as { effective?: { price?: number } } | null)?.effective?.price, 137);

  const basePriceEdit = await api(`/api/admin/plans/${plan.id}/pricing`, adminJar, {
    method: "PUT",
    body: JSON.stringify({
      price: 199,
      oldPrice: null,
      priceBadgeMode: "none",
      offers: [],
    }),
  });
  assert.equal(basePriceEdit.response.status, 200);
  const [afterPlanEdit] = await memory.db.select().from(paymentRequestsTable)
    .where(eq(paymentRequestsTable.id, requestId));
  assert.equal(afterPlanEdit?.price, 137, "a pending request amount must not change after a plan edit");
  assert.equal((afterPlanEdit?.priceSnapshot as { effective?: { price?: number } } | null)?.effective?.price, 137);

  /* A price response rendered before the edit cannot silently turn into a
   * request at the new amount: the server rejects the stale freshness token. */
  const staleDisplayAttempt = await api("/api/payments", newUserJar, {
    method: "POST",
    body: JSON.stringify({
      planKey: "synthetic-vip",
      pricingToken: initialPricingToken,
      method: "vodafone",
      tx: "pricing-stale-display-002",
      proofImage: "data:image/png;base64,iVBORw0KGgo=",
    }),
  });
  assert.equal(staleDisplayAttempt.response.status, 409);

  const revert = await api(`/api/admin/plans/${plan.id}/pricing/revert`, adminJar, { method: "POST", body: "{}" });
  assert.equal(revert.response.status, 200, "the latest price change must be reversible");
  const [revertedPlan] = await memory.db.select().from(subscriptionPlansTable).where(eq(subscriptionPlansTable.id, plan.id));
  assert.equal(revertedPlan?.price, 137);
  const [restoredOffer] = await memory.db.select().from(planPriceOffersTable)
    .where(eq(planPriceOffersTable.id, "offer-pricing-schedule-new-user"));
  assert.equal(restoredOffer?.status, "active", "revert restores an archived offer instead of deleting history");
});

test("price-alert evaluator requires a fresh source-backed quote and honors price/change rules", async () => {
  const { evaluatePriceAlert, quoteEligibleForAlert } = await import("./price-alerts");
  const now = Date.now();
  const quote = {
    instrumentId: "stock:egx:COMI",
    sym: "COMI",
    name: "Synthetic COMI",
    sector: "Banks",
    price: 55,
    chgPct: -2.4,
    ts: now - 60_000,
    source: "Synthetic licensed test source",
    freshness: "real-time" as const,
  };
  assert.equal(evaluatePriceAlert("price_above", 55, quote), true);
  assert.equal(evaluatePriceAlert("price_below", 54, quote), false);
  assert.equal(evaluatePriceAlert("change_percent_below", -2, quote), true);
  assert.equal(evaluatePriceAlert("change_percent_above", -2, quote), false);
  assert.equal(quoteEligibleForAlert(quote, now), true);
  assert.equal(quoteEligibleForAlert({ ...quote, freshness: "end-of-day" }, now), false);
  assert.equal(quoteEligibleForAlert({ ...quote, ts: now - 25 * 60_000 }, now), false);
});

test("subscription lifecycle uses one Cairo calendar reminder per threshold and retains locked user data", async () => {
  const {
    calculateApprovedSubscriptionEnd,
    runSubscriptionLifecycle,
    saveSubscriptionLifecycleSettings,
  } = await import("../lib/subscription-lifecycle");
  const { getVipEntitlement } = await import("../lib/userAuth");
  const day0 = new Date("2026-01-01T10:00:00.000Z");
  const day30 = calculateApprovedSubscriptionEnd(day0, 1);
  assert.equal(day30.getTime() - day0.getTime(), 30 * 24 * 60 * 60 * 1000, "monthly entitlement is exactly 30 elapsed UTC days");

  const [user] = await memory.db.insert(appUsersTable).values({
    phone: "01077770001",
    name: "Lifecycle Synthetic User",
    email: "lifecycle.synthetic@example.test",
    /* The day+3 winback is marketing: this synthetic recipient explicitly
     * opted in so the lifecycle regression still exercises its email outbox. */
    marketingEmailOptIn: true,
    passwordHash: "test-only-hash",
    plan: "vip",
    vipExpiresAt: day30,
    status: "active",
    createdAt: day0,
    updatedAt: day0,
  }).returning();
  await memory.db.insert(userSubscriptionsTable).values({
    id: "sub-lifecycle-synthetic",
    userId: user.id,
    planKey: "synthetic-vip",
    planNameAr: "باقة دورة الحياة",
    planDurationMonths: 1,
    planFeatures: ["MA و RSI", "تنبيهات VIP"],
    status: "active",
    cycleId: "cycle-lifecycle-0",
    startsAt: day0,
    expiresAt: day30,
    graceEndsAt: null,
    source: "test",
    createdAt: day0,
    updatedAt: day0,
  });
  /* Entitlement expiry must not archive/delete private rows. */
  await memory.db.insert(portfolioPositionsTable).values({
    id: "portfolio-lifecycle-retained",
    userId: user.id,
    instrumentId: "stock:egx:SYN",
    symbol: "SYN",
    quantity: 7,
    averageCost: "12.500000",
    currency: "EGP",
    status: "active",
    createdAt: day0,
    updatedAt: day0,
  });
  await memory.db.insert(userCalculatorScenariosTable).values({
    id: "scenario-lifecycle-retained",
    userId: user.id,
    calculatorKey: "pl",
    name: "سيناريو محفوظ",
    inputs: { buyPrice: 10 },
    result: { net: 20 },
    status: "active",
    createdAt: day0,
    updatedAt: day0,
  });

  await saveSubscriptionLifecycleSettings({ graceDays: 0, winbackMarketingEnabled: true }, day0);
  const sent: string[] = [];
  const fakeMailer = async (_to: string, subject: string) => {
    sent.push(subject);
    return { delivered: true as const };
  };
  const runAt = async (days: number) => runSubscriptionLifecycle({
    now: new Date(day0.getTime() + days * 24 * 60 * 60 * 1000),
    mailer: fakeMailer,
  });

  for (const [days, expected] of [[23, "monthly_7d"], [27, "monthly_3d"], [29, "monthly_1d"], [30, "expiry"], [33, "winback_3d"]] as const) {
    const result = await runAt(days);
    assert.equal(result.queued, 1, `day ${days} reserves exactly one ${expected} message`);
    assert.equal(result.inAppDelivered, 1, `day ${days} internal delivery is independent of e-mail`);
    assert.equal(result.emailSent, 1, `day ${days} e-mail is delivered through its own outbox attempt`);
  }
  const duplicateDay23 = await runAt(23);
  assert.equal(duplicateDay23.queued, 0, "a repeated scheduler invocation cannot reserve a duplicate reminder");

  const reminderRows = await memory.db.select().from(subscriptionRemindersSentTable)
    .where(eq(subscriptionRemindersSentTable.subscriptionCycleId, "cycle-lifecycle-0"));
  assert.deepEqual(reminderRows.map((row) => row.reminderType).sort(), [
    "expiry", "monthly_1d", "monthly_3d", "monthly_7d", "winback_3d",
  ]);
  assert.equal(new Set(reminderRows.map((row) => row.id)).size, 5);
  assert.equal(sent.length, 5, "the duplicate execution does not e-mail the member again");

  const [afterExpiry] = await memory.db.select().from(appUsersTable).where(eq(appUsersTable.id, user.id));
  assert.equal(afterExpiry?.plan, "free", "the lifecycle expiry projects the account back to Free");
  const entitlementAfterExpiry = await getVipEntitlement({ sub: user.id }, new Date(day30.getTime() + 1));
  assert.equal(entitlementAfterExpiry.active, false, "authorization fails closed immediately after the term ends");
  const [retainedPosition] = await memory.db.select().from(portfolioPositionsTable).where(eq(portfolioPositionsTable.id, "portfolio-lifecycle-retained"));
  const [retainedScenario] = await memory.db.select().from(userCalculatorScenariosTable).where(eq(userCalculatorScenariosTable.id, "scenario-lifecycle-retained"));
  assert.equal(retainedPosition?.status, "active");
  assert.equal(retainedScenario?.status, "active");
  const inAppRows = await memory.db.select().from(userNotificationsTable).where(eq(userNotificationsTable.phone, user.phone));
  assert.equal(inAppRows.filter((row) => row.kind === "subscription").length, 5);
  assert.ok(inAppRows.some((row) => row.actionUrl === "/vip?plan=synthetic-vip&renew=1"), "in-app CTA preserves the chosen renewal plan");
});

test("approved pre-expiry renewal starts from current end, rotates cycle, and cancels pending prior reminders", async () => {
  const { calculateApprovedSubscriptionEnd } = await import("../lib/subscription-lifecycle");
  const day0 = new Date("2026-02-01T10:00:00.000Z");
  const day25 = new Date(day0.getTime() + 25 * 24 * 60 * 60 * 1000);
  const oldEnd = calculateApprovedSubscriptionEnd(day0, 1);
  const [user] = await memory.db.insert(appUsersTable).values({
    phone: "01077770002",
    name: "Renewal Synthetic User",
    email: "renewal.synthetic@example.test",
    passwordHash: "test-only-hash",
    plan: "vip",
    vipExpiresAt: oldEnd,
    status: "active",
    createdAt: day0,
    updatedAt: day0,
  }).returning();
  await memory.db.insert(userSubscriptionsTable).values({
    id: "sub-renewal-synthetic",
    userId: user.id,
    planKey: "synthetic-vip",
    planNameAr: "باقة التجديد",
    planDurationMonths: 1,
    planFeatures: [],
    status: "active",
    cycleId: "cycle-renewal-old",
    startsAt: day0,
    expiresAt: oldEnd,
    graceEndsAt: null,
    source: "test",
    createdAt: day0,
    updatedAt: day0,
  });
  await memory.db.insert(subscriptionRemindersSentTable).values({
    id: "reminder-renewal-old-pending",
    subscriptionId: "sub-renewal-synthetic",
    subscriptionCycleId: "cycle-renewal-old",
    userId: user.id,
    reminderType: "monthly_3d",
    reminderClass: "transactional",
    targetEndsAt: oldEnd,
    deliveryStatus: "queued",
    content: {
      title: "تذكير قديم",
      body: "لا ينبغي تسليمه بعد التجديد",
      actionUrl: "/vip?plan=synthetic-vip&renew=1",
      actionLabel: "جدّد الآن",
      emailSubject: "قديم",
      emailHtml: "<p>قديم</p>",
      transactional: true,
    },
    emailStatus: "pending",
    emailAttempts: 0,
    emailNextAttemptAt: day25,
    createdAt: day25,
    updatedAt: day25,
  });
  await memory.db.insert(paymentRequestsTable).values({
    id: "req-renewal-day-25",
    phone: user.phone,
    name: user.name,
    planKey: "synthetic-vip",
    payMethod: "vodafone",
    price: 137,
    tx: "renewal-day-25-transaction",
    status: "pending",
    createdAt: day25,
    updatedAt: day25,
  });

  const adminJar: CookieJar = {};
  const login = await api("/api/admin/login", adminJar, {
    method: "POST",
    body: JSON.stringify({ email: "admin.synthetic@example.test", password: "SyntheticAdminPass1!" }),
  });
  assert.equal(login.response.status, 200);
  (globalThis as typeof globalThis & { __egytrendTestClock?: Date }).__egytrendTestClock = day25;
  try {
    const approval = await api("/api/admin/requests/req-renewal-day-25", adminJar, {
      method: "PUT",
      body: JSON.stringify({ status: "approved" }),
    });
    assert.equal(approval.response.status, 200, approval.raw);
  } finally {
    delete (globalThis as typeof globalThis & { __egytrendTestClock?: Date }).__egytrendTestClock;
  }

  const [renewed] = await memory.db.select().from(userSubscriptionsTable).where(eq(userSubscriptionsTable.userId, user.id));
  assert.equal(renewed?.startsAt.getTime(), day0.getTime(), "pre-expiry renewal preserves the current term start");
  assert.equal(renewed?.expiresAt.getTime(), day0.getTime() + 60 * 24 * 60 * 60 * 1000, "day-25 renewal ends exactly on day 60");
  assert.notEqual(renewed?.cycleId, "cycle-renewal-old", "each renewal receives a fresh cycle id");
  const [cancelled] = await memory.db.select().from(subscriptionRemindersSentTable)
    .where(eq(subscriptionRemindersSentTable.id, "reminder-renewal-old-pending"));
  assert.equal(cancelled?.deliveryStatus, "cancelled");
  assert.equal(cancelled?.emailStatus, "cancelled");
  const events = await memory.db.select().from(subscriptionLifecycleEventsTable)
    .where(eq(subscriptionLifecycleEventsTable.subscriptionCycleId, renewed!.cycleId));
  assert.equal(events.some((event) => event.eventType === "renewed"), true);
});

test("Cairo scheduling compares local calendar dates through the DST transition", async () => {
  const { cairoCalendarDaysUntil, cairoParts, cairoWallClockToUtc } = await import("../lib/subscription-time");
  const before = cairoWallClockToUtc({ year: 2026, month: 4, day: 23, hour: 23, minute: 30, second: 0 });
  const after = cairoWallClockToUtc({ year: 2026, month: 4, day: 25, hour: 0, minute: 30, second: 0 });
  assert.equal(cairoParts(before).day, 23);
  assert.equal(cairoParts(after).day, 25);
  assert.equal(cairoCalendarDaysUntil(after, before), 2, "a Cairo DST hour change cannot skip a reminder calendar day");
  const skippedMidnight = cairoWallClockToUtc({ year: 2026, month: 4, day: 24, hour: 0, minute: 0, second: 0 });
  assert.equal(cairoParts(skippedMidnight).day, 24, "a skipped Cairo wall time normalizes forward, never to the prior date");
});

test("subscription email outbox records a terminal failure only after three bounded attempts", async () => {
  const { calculateApprovedSubscriptionEnd, listSubscriptionEmailFailures, runSubscriptionLifecycle } = await import("../lib/subscription-lifecycle");
  const day0 = new Date("2026-03-01T09:00:00.000Z");
  const end = calculateApprovedSubscriptionEnd(day0, 1);
  const [user] = await memory.db.insert(appUsersTable).values({
    phone: "01077770003",
    name: "Email Retry Synthetic User",
    email: "email.retry.synthetic@example.test",
    passwordHash: "test-only-hash",
    plan: "vip",
    vipExpiresAt: end,
    status: "active",
    createdAt: day0,
    updatedAt: day0,
  }).returning();
  await memory.db.insert(userSubscriptionsTable).values({
    id: "sub-email-retry",
    userId: user.id,
    planKey: "synthetic-vip",
    planNameAr: "باقة البريد",
    planDurationMonths: 1,
    planFeatures: [],
    status: "active",
    cycleId: "cycle-email-retry",
    startsAt: day0,
    expiresAt: end,
    source: "test",
    createdAt: day0,
    updatedAt: day0,
  });
  const failMailer = async () => ({ delivered: false as const, error: "send_failed" as const });
  const first = new Date(day0.getTime() + 23 * 24 * 60 * 60 * 1000);
  await runSubscriptionLifecycle({ now: first, mailer: failMailer });
  await runSubscriptionLifecycle({ now: new Date(first.getTime() + 5 * 60 * 1000), mailer: failMailer });
  await runSubscriptionLifecycle({ now: new Date(first.getTime() + 35 * 60 * 1000), mailer: failMailer });
  const [row] = await memory.db.select().from(subscriptionRemindersSentTable)
    .where(eq(subscriptionRemindersSentTable.subscriptionCycleId, "cycle-email-retry"));
  assert.equal(row?.emailAttempts, 3);
  assert.equal(row?.emailStatus, "failed");
  const failures = await listSubscriptionEmailFailures();
  assert.equal(failures.some((failure) => failure.reminderId === row?.id && failure.emailStatus === "failed"), true);
});

test("admin lifecycle dry run is non-mutating and exposes only simulated actions", async () => {
  const adminJar: CookieJar = {};
  const login = await api("/api/admin/login", adminJar, {
    method: "POST",
    body: JSON.stringify({ email: "admin.synthetic@example.test", password: "SyntheticAdminPass1!" }),
  });
  assert.equal(login.response.status, 200);
  const before = await memory.db.select({ count: subscriptionRemindersSentTable.id }).from(subscriptionRemindersSentTable);
  const dry = await api("/api/admin/subscriptions/dry-run", adminJar, {
    method: "POST",
    body: JSON.stringify({ at: "2026-03-24T11:00" }),
  });
  assert.equal(dry.response.status, 200);
  assert.equal(dry.body?.status, "ok");
  const result = dry.body?.result as { dryRun?: boolean; previews?: unknown[] } | undefined;
  assert.equal(result?.dryRun, true);
  assert.ok(Array.isArray(result?.previews));
  const after = await memory.db.select({ count: subscriptionRemindersSentTable.id }).from(subscriptionRemindersSentTable);
  assert.equal(after.length, before.length, "dry run must not write reminder rows");
});


test("admin authorization ignores static headers, revokes disabled staff, and archives records", async () => {
  const staticHeader = await api("/api/admin/employees", {}, {
    headers: { "x-admin-token": "not-an-admin-session" },
  });
  assert.equal(staticHeader.response.status, 401, "a removed static header must not authorize any admin route");

  const [revocable] = await memory.db.insert(employeesTable).values({
    name: "Revocable Synthetic Admin",
    email: "revocable.synthetic@example.test",
    role: "admin",
    status: "active",
    passwordHash: employeePasswordHash("RevocableAdminPass1!"),
    permissions: [],
  }).returning();
  const revokedJar: CookieJar = {};
  const revokedLogin = await api("/api/admin/login", revokedJar, {
    method: "POST",
    body: JSON.stringify({ email: revocable.email, password: "RevocableAdminPass1!" }),
  });
  assert.equal(revokedLogin.response.status, 200);
  assert.equal((await api("/api/admin/session", revokedJar)).response.status, 200);
  await memory.db.update(employeesTable).set({ status: "disabled", updatedAt: new Date() })
    .where(eq(employeesTable.id, revocable.id));
  assert.equal((await api("/api/admin/session", revokedJar)).response.status, 401,
    "a cookie issued before disablement must be rechecked against the employee row");

  const [superAdmin] = await memory.db.insert(employeesTable).values({
    name: "Security Test Super Admin",
    email: "security.superadmin@example.test",
    role: "super_admin",
    status: "active",
    passwordHash: employeePasswordHash("SecuritySuperAdminPass1!"),
    permissions: ["pricing.manage"],
  }).returning();
  const superJar: CookieJar = {};
  const superLogin = await api("/api/admin/login", superJar, {
    method: "POST",
    body: JSON.stringify({ email: superAdmin.email, password: "SecuritySuperAdminPass1!" }),
  });
  assert.equal(superLogin.response.status, 200);
  const staleBreakGlassJar: CookieJar = {
    value: `et_admin_session=${jwt.sign({
      sub: 0,
      name: "Bootstrap",
      role: "super_admin",
      email: "bootstrap@example.test",
      authSource: "break_glass",
    }, process.env.SESSION_SECRET!, { expiresIn: "15m" })}`,
  };
  assert.equal((await api("/api/admin/session", staleBreakGlassJar)).response.status, 401,
    "an emergency session is revoked as soon as an active staff super_admin exists");

  const employeeCreate = await api("/api/admin/employees", superJar, {
    method: "POST",
    body: JSON.stringify({
      name: "Archive Target",
      email: "archive.target@example.test",
      role: "editor",
      password: "ArchiveTargetPass1!",
    }),
  });
  assert.equal(employeeCreate.response.status, 200);
  const archivedEmployeeId = Number((employeeCreate.body?.employee as { id?: unknown } | undefined)?.id);
  assert.ok(Number.isSafeInteger(archivedEmployeeId) && archivedEmployeeId > 0);
  const employeeArchive = await api(`/api/admin/employees/${archivedEmployeeId}`, superJar, { method: "DELETE" });
  assert.equal(employeeArchive.response.status, 200);
  assert.equal(employeeArchive.body?.archived, true);
  const [archivedEmployee] = await memory.db.select().from(employeesTable)
    .where(eq(employeesTable.id, archivedEmployeeId));
  assert.equal(archivedEmployee?.status, "archived", "employee DELETE must preserve the row as an archive");

  const couponCreate = await api("/api/admin/coupons", superJar, {
    method: "POST",
    body: JSON.stringify({ code: "ARCHIVE-ONLY", discountType: "percent", discountValue: 10 }),
  });
  assert.equal(couponCreate.response.status, 200);
  const couponId = Number((couponCreate.body?.coupon as { id?: unknown } | undefined)?.id);
  assert.ok(Number.isSafeInteger(couponId) && couponId > 0);
  const couponArchive = await api(`/api/admin/coupons/${couponId}`, superJar, { method: "DELETE" });
  assert.equal(couponArchive.response.status, 200);
  assert.equal(couponArchive.body?.archived, true);
  const [archivedCoupon] = await memory.db.select().from(couponsTable).where(eq(couponsTable.id, couponId));
  assert.equal(archivedCoupon?.isActive, false, "coupon DELETE must disable future use without deleting history");
});

test("payment routes reject a suspended account and a disabled collection method", async () => {
  const suspendedJar: CookieJar = {};
  const suspendedRegistration = await api("/api/user/register", suspendedJar, {
    method: "POST",
    body: JSON.stringify({
      name: "Suspended Payment User",
      phone: "01055550011",
      email: "suspended.payment@example.test",
      password: "SuspendedPaymentPass1!",
    }),
  });
  assert.equal(suspendedRegistration.response.status, 201);
  const [suspended] = await memory.db.select().from(appUsersTable)
    .where(eq(appUsersTable.phone, "01055550011"));
  assert.ok(suspended);
  const suspendedToken = await paymentPricingToken(suspendedJar, "synthetic-vip");
  await memory.db.update(appUsersTable).set({ status: "banned", updatedAt: new Date() })
    .where(eq(appUsersTable.id, suspended!.id));
  assert.equal((await api("/api/payments/my", suspendedJar)).response.status, 401,
    "a banned user cannot read payment history through an old session");
  const suspendedSubmission = await api("/api/payments", suspendedJar, {
    method: "POST",
    body: JSON.stringify({
      planKey: "synthetic-vip",
      pricingToken: suspendedToken,
      method: "vodafone",
      tx: "suspended-payment-attempt",
      proofImage: "data:image/png;base64,iVBORw0KGgo=",
    }),
  });
  assert.equal(suspendedSubmission.response.status, 401, "a banned user cannot submit a payment through an old session");

  const activeJar: CookieJar = {};
  const activeRegistration = await api("/api/user/register", activeJar, {
    method: "POST",
    body: JSON.stringify({
      name: "Disabled Method User",
      phone: "01055550012",
      email: "disabled.method@example.test",
      password: "DisabledMethodPass1!",
    }),
  });
  assert.equal(activeRegistration.response.status, 201);
  const activeToken = await paymentPricingToken(activeJar, "synthetic-vip");
  try {
    await memory.db.update(appSettingsTable).set({ value: "0", updatedAt: new Date() })
      .where(eq(appSettingsTable.key, "payment_vodafone_enabled"));
    const disabledMethod = await api("/api/payments", activeJar, {
      method: "POST",
      body: JSON.stringify({
        planKey: "synthetic-vip",
        pricingToken: activeToken,
        method: "vodafone",
        tx: "disabled-method-attempt",
        proofImage: "data:image/png;base64,iVBORw0KGgo=",
      }),
    });
    assert.equal(disabledMethod.response.status, 400, "a wallet disabled after rendering cannot accept a stale client form");
  } finally {
    await memory.db.update(appSettingsTable).set({ value: "1", updatedAt: new Date() })
      .where(eq(appSettingsTable.key, "payment_vodafone_enabled"));
  }
});

test("payment transaction references are idempotent across concurrent requests", async () => {
  const paymentJar: CookieJar = {};
  const registration = await api("/api/user/register", paymentJar, {
    method: "POST",
    body: JSON.stringify({
      name: "Payment Race User",
      phone: "01055550014",
      email: "payment.race@example.test",
      password: "PaymentRacePass1!",
    }),
  });
  assert.equal(registration.response.status, 201);
  const pricingToken = await paymentPricingToken(paymentJar, "synthetic-vip");
  const request = (tx: string) => api("/api/payments", paymentJar, {
    method: "POST",
    body: JSON.stringify({
      planKey: "synthetic-vip",
      pricingToken,
      method: "vodafone",
      tx,
      proofImage: "data:image/png;base64,iVBORw0KGgo=",
    }),
  });
  const [first, second] = await Promise.all([request("PAYMENT-RACE-001"), request("payment-race-001")]);
  assert.equal([first.response.status, second.response.status].filter((status) => status === 200).length, 1);
  assert.equal([first.response.status, second.response.status].filter((status) => status === 409).length, 1,
    "a repeated reference must be rejected even if its case differs");
  const stored = await memory.db.select().from(paymentRequestsTable)
    .where(eq(paymentRequestsTable.phone, "01055550014"));
  assert.equal(stored.length, 1, "only one request can be created for the transfer reference");

  /* Exercise the DB invariant directly; endpoint pre-checks are deliberately
   * friendly but the unique index is what protects a multi-instance race. */
  const direct = await Promise.allSettled([
    memory.db.insert(paymentRequestsTable).values({
      id: "direct-tx-race-1", phone: "01055559991", name: "Direct Test", planKey: "synthetic-vip", tx: "CASE-RACE-001",
    }),
    memory.db.insert(paymentRequestsTable).values({
      id: "direct-tx-race-2", phone: "01055559992", name: "Direct Test", planKey: "synthetic-vip", tx: "case-race-001",
    }),
  ]);
  assert.equal(direct.filter((outcome) => outcome.status === "fulfilled").length, 1);
  assert.equal(direct.filter((outcome) => outcome.status === "rejected").length, 1,
    "the normalized DB unique index closes a race outside one API process");
});

test("password-reset links are single-use even when submitted concurrently", async () => {
  const [user] = await memory.db.insert(appUsersTable).values({
    phone: "01055550013",
    name: "Reset Race User",
    email: "reset.race@example.test",
    passwordHash: "placeholder-before-reset",
    status: "active",
  }).returning();
  const rawToken = "reset-race-token-for-isolated-test";
  await memory.db.insert(passwordResetsTable).values({
    userId: user.id,
    tokenHash: crypto.createHash("sha256").update(rawToken).digest("hex"),
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  });

  const [first, second] = await Promise.all([
    api("/api/user/reset-password", {}, {
      method: "POST",
      body: JSON.stringify({ token: rawToken, password: "ResetRaceWinnerOne1!" }),
    }),
    api("/api/user/reset-password", {}, {
      method: "POST",
      body: JSON.stringify({ token: rawToken, password: "ResetRaceWinnerTwo2!" }),
    }),
  ]);
  const successes = [first, second].filter((result) => result.response.status === 200);
  assert.equal(successes.length, 1, "only one concurrent request may claim a reset token");
  const failures = [first, second].filter((result) => result.response.status !== 200);
  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.response.status, 400, "the loser receives the ordinary already-used response");
  const [claimedToken] = await memory.db.select().from(passwordResetsTable)
    .where(eq(passwordResetsTable.userId, user.id));
  assert.ok(claimedToken?.usedAt, "the reset token must be durably claimed");

  const loginOne = await api("/api/user/login", {}, {
    method: "POST",
    body: JSON.stringify({ phone: user.phone, password: "ResetRaceWinnerOne1!" }),
  });
  const loginTwo = await api("/api/user/login", {}, {
    method: "POST",
    body: JSON.stringify({ phone: user.phone, password: "ResetRaceWinnerTwo2!" }),
  });
  assert.equal([loginOne.response.status, loginTwo.response.status].filter((status) => status === 200).length, 1,
    "exactly the password from the successful reset may authenticate");
  const replay = await api("/api/user/reset-password", {}, {
    method: "POST",
    body: JSON.stringify({ token: rawToken, password: "ResetRaceReplay3!" }),
  });
  assert.equal(replay.response.status, 400, "a claimed token cannot be replayed");
});
