import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { after, before, test } from "node:test";
import jwt from "jsonwebtoken";
import { eq } from "drizzle-orm";
import {
  appSettingsTable,
  appUsersTable,
  employeesTable,
  paymentRequestsTable,
  portfolioPositionsTable,
  userPriceAlertsTable,
  opportunities,
  subscriptionPlansTable,
  userSubscriptionsTable,
} from "@workspace/db/schema";
import { createMemoryDatabase } from "../test-support/memory-db";

/* This is intentionally an in-process pg-mem database with synthetic data.
 * It has no DATABASE_URL, no network listener, and cannot reach a Neon/Vercel
 * database. The application is imported only after the test DB is injected. */
process.env.NODE_ENV = "test";
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

before(async () => {
  memory = await createMemoryDatabase();
  (globalThis as typeof globalThis & { __egytrendTestDatabase?: typeof memory.db }).__egytrendTestDatabase = memory.db;

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
    permissions: [],
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
  const positions = (portfolio.body?.positions as Array<{ id?: string; symbol?: string; averageCost?: number; market?: unknown }>) || [];
  assert.equal(positions.length, 1);
  assert.equal(positions[0]?.id, positionId);
  assert.equal(positions[0]?.symbol, "COMI");
  assert.equal(positions[0]?.averageCost, 42.5);
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
  assert.equal(staleVipAttempt.response.status, 401, "stale JWT VIP must not grant paid access");

  /* A public status probe cannot trigger a provider health call. */
  const anonymousProbe = await api("/api/ai/status?verify=1", {});
  assert.equal(anonymousProbe.response.status, 403);

  /* With no licensed market provider configured, the API must be transparent:
   * no Yahoo/TradingView/other unlicensed fallback and no fabricated price. */
  const markets = await api("/api/markets", {});
  assert.equal(markets.response.status, 200);
  assert.equal(markets.body?.status, "ok");
  const marketPayload = markets.body?.markets as Record<string, unknown[]>;
  assert.deepEqual(marketPayload.eg, []);
  assert.deepEqual(marketPayload.gl, []);
  assert.equal((markets.body?.freshness as { sections?: Record<string, { unavailable?: boolean }> }).sections?.eg?.unavailable, true);

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
