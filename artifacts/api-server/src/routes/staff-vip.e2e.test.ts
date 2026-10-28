import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { after, before, test } from "node:test";
import jwt from "jsonwebtoken";
import { eq } from "drizzle-orm";
import { appSettingsTable, appUsersTable, employeesTable, userSubscriptionsTable } from "@workspace/db/schema";
import { createMemoryDatabase } from "../test-support/memory-db";
import { EGX_STOCKS } from "../lib/market-data/catalog";
import { staffPhoneFor } from "../lib/userAuth";

/* Staff-VIP suite: a verified privileged staff session (admin login) unlocks
 * the paid app features and stores its user-scoped data in a dedicated,
 * unreachable staff-linked row. Per-file pg-mem DB + loopback app. */
process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "staff-vip-test-session-secret-not-for-deployment";
process.env.REFERRAL_COOKIE_SECRET = "staff-vip-test-cookie-secret-not-for-deployment";
process.env.REFERRAL_SIGNAL_SECRET = "staff-vip-test-signal-secret-not-for-deployment";
process.env.LOG_LEVEL = "silent";

type Memory = Awaited<ReturnType<typeof createMemoryDatabase>>;
type CookieJar = { value?: string };
let memory: Memory;
let server: http.Server;
let baseUrl = "";
let adminEmployeeId = 0;
let editorEmployeeId = 0;

function passwordHash(password: string): string {
  const salt = "ffeeddccbbaa99887766554433221100";
  return `scrypt$${salt}$${crypto.scryptSync(password, salt, 64).toString("hex")}`;
}

async function seedUser(phone: string, email: string, vip: boolean): Promise<{ id: number; jar: CookieJar }> {
  const now = new Date();
  const [user] = await memory.db.insert(appUsersTable).values({
    phone, name: "Staff Probe", email, emailVerifiedAt: now,
    passwordHash: passwordHash("StaffProbePass1!"), plan: vip ? "vip" : "free", status: "active", createdAt: now, updatedAt: now,
  }).returning();
  if (vip) {
    await memory.db.insert(userSubscriptionsTable).values({
      id: crypto.randomUUID(), userId: user!.id, planKey: "vip_monthly", planNameAr: "VIP",
      planDurationMonths: 1, planFeatures: [], subscriptionType: "paid",
      status: "active", cycleId: crypto.randomUUID(), startsAt: now,
      expiresAt: new Date(now.getTime() + 30 * 86_400_000), source: "payment",
    });
  }
  const jar: CookieJar = {
    value: `et_user_session=${jwt.sign({ sub: user!.id, phone: user!.phone, name: user!.name, role: "user", plan: vip ? "vip" : "free" }, process.env.SESSION_SECRET!, { expiresIn: "1h" })}`,
  };
  return { id: user!.id, jar };
}

function staffJar(employeeId: number, role: "admin" | "editor"): CookieJar {
  return {
    value: `et_admin_session=${jwt.sign({ sub: employeeId, name: "Staff Probe", role, email: `staff${employeeId}@example.test` }, process.env.SESSION_SECRET!, { expiresIn: "1h" })}`,
  };
}

async function api(path: string, jar: CookieJar, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Origin", baseUrl);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (jar.value) headers.set("Cookie", jar.value);
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
  const raw = await response.text();
  let body: Record<string, any> | null = null;
  try { body = raw ? JSON.parse(raw) : null; } catch { /* non-JSON only checked on failure */ }
  return { response, body, raw };
}

const SYMBOL = EGX_STOCKS[0]?.sym || "COMI";
const sampleItems = [
  { key: "broker_commission", labelAr: "عمولة الوساطة", side: "both", percent: 0.1, minimum: 25 },
  { key: "stamp_duty", labelAr: "ضريبة الدمغة", side: "sell", percent: 0, minimum: 0 },
];

before(async () => {
  memory = await createMemoryDatabase();
  (globalThis as typeof globalThis & { __egytrendTestDatabase?: typeof memory.db }).__egytrendTestDatabase = memory.db;
  /* The fee catalog is admin-managed data (seeded by migration 0015 in real
   * databases); the in-memory suite seeds the same row directly. */
  await memory.db.insert(appSettingsTable).values({
    key: "calculator_fee_items",
    value: JSON.stringify([
      { key: "broker_commission", labelAr: "عمولة الوساطة" },
      { key: "exchange_fee", labelAr: "رسوم البورصة" },
      { key: "cma_fee", labelAr: "رسوم الرقابة المالية" },
      { key: "clearing_fee", labelAr: "رسوم مصر للمقاصة" },
      { key: "stamp_duty", labelAr: "ضريبة الدمغة" },
    ]),
  });
  const now = new Date();
  const [admin] = await memory.db.insert(employeesTable).values({
    name: "Admin Probe", email: "admin-probe@example.test", role: "admin", status: "active",
    passwordHash: passwordHash("AdminProbePass1!"), createdAt: now, updatedAt: now,
  }).returning();
  adminEmployeeId = admin!.id;
  const [editor] = await memory.db.insert(employeesTable).values({
    name: "Editor Probe", email: "editor-probe@example.test", role: "editor", status: "active",
    passwordHash: passwordHash("EditorProbePass1!"), createdAt: now, updatedAt: now,
  }).returning();
  editorEmployeeId = editor!.id;
  const { default: app } = await import("../app");
  server = http.createServer(app);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
  const address = server.address(); assert.ok(address && typeof address !== "string"); baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (memory) await memory.close();
  delete (globalThis as typeof globalThis & { __egytrendTestDatabase?: unknown }).__egytrendTestDatabase;
});

test("existing user contract is unchanged (401 anonymous, 403 free, 200 VIP)", async () => {
  const anon = await api("/api/calculators/bootstrap", {});
  assert.equal(anon.response.status, 401);
  const free = await seedUser("01094200002", "free-staffprobe@example.test", false);
  const freeBoot = await api("/api/calculators/bootstrap", free.jar);
  assert.equal(freeBoot.response.status, 403);
  const { jar } = await seedUser("01094200003", "vip2-staffprobe@example.test", true);
  const vipBoot = await api("/api/calculators/bootstrap", jar);
  assert.equal(vipBoot.response.status, 200, vipBoot.raw);
  assert.equal(vipBoot.body?.status, "ok");
  assert.equal(typeof vipBoot.body?.runtime, "string");
});

test("an admin session unlocks every paid gate without a user session", async () => {
  const jar = staffJar(adminEmployeeId, "admin");
  const boot = await api("/api/calculators/bootstrap", jar);
  assert.equal(boot.response.status, 200, boot.raw);
  assert.equal(boot.body?.status, "ok");

  const catalog = await api("/api/calculators/fee-catalog", jar);
  assert.equal(catalog.response.status, 200, catalog.raw);
  assert.equal(catalog.body?.status, "ok");

  for (const path of ["/api/calculators/fee-profiles", "/api/calculators/scenarios?calculator=pl", "/api/portfolio", "/api/price-alerts"]) {
    const res = await api(path, jar);
    assert.equal(res.response.status, 200, `${path} → ${res.raw}`);
    assert.equal(res.body?.status, "ok");
  }
});

test("admin data is stored in a dedicated staff row, isolated from every user", async () => {
  const jar = staffJar(adminEmployeeId, "admin");
  const vip = await seedUser("01094200004", "iso-vip@example.test", true);

  /* Fee profile: admin saves; the user sees none of it (and vice versa). */
  const saved = await api("/api/calculators/fee-profiles", jar, { method: "POST", body: JSON.stringify({ name: "ملف الأدمن", items: sampleItems }) });
  assert.equal(saved.response.status, 201, saved.raw);
  const listed = await api("/api/calculators/fee-profiles", jar);
  assert.equal(listed.body?.profiles.length, 1);
  assert.equal(listed.body?.profiles[0].name, "ملف الأدمن");
  const userProfiles = await api("/api/calculators/fee-profiles", vip.jar);
  assert.equal(userProfiles.body?.profiles.length, 0);

  /* Scenario: same isolation on the second data domain. */
  const scenarioSaved = await api("/api/calculators/scenarios", jar, { method: "POST", body: JSON.stringify({ name: "سيناريو الأدمن", calculatorKey: "pl", inputs: { buyPrice: 10, sellPrice: 12, quantity: 100 }, result: { ok: true, netProfit: 200 } }) });
  assert.equal(scenarioSaved.response.status, 201, scenarioSaved.raw);
  const scenarioListed = await api("/api/calculators/scenarios?calculator=pl", jar);
  assert.equal(scenarioListed.body?.scenarios.length, 1);
  const userScenarios = await api("/api/calculators/scenarios?calculator=pl", vip.jar);
  assert.equal(userScenarios.body?.scenarios.length, 0);

  /* Portfolio position: admin's row is invisible to the user's portfolio. */
  const positionSaved = await api("/api/portfolio/positions", jar, { method: "POST", body: JSON.stringify({ symbol: SYMBOL, quantity: 100, averageCost: 10 }) });
  assert.equal(positionSaved.response.status, 201, positionSaved.raw);
  const userPortfolio = await api("/api/portfolio", vip.jar);
  assert.equal(userPortfolio.body?.positions.length, 0);
  const staffPortfolio = await api("/api/portfolio", jar);
  assert.equal(staffPortfolio.body?.positions.length, 1);

  /* Price alert: admin's alert is not in the user's list. */
  const alertSaved = await api("/api/price-alerts", jar, { method: "POST", body: JSON.stringify({ symbol: SYMBOL, condition: "price_above", targetValue: 50 }) });
  assert.equal(alertSaved.response.status, 201, alertSaved.raw);
  const userAlerts = await api("/api/price-alerts", vip.jar);
  assert.equal(userAlerts.body?.alerts.length, 0);

  /* The owner row exists, carries the reserved phone namespace, and is a
   * normal active row otherwise. */
  const allUsers = await memory.db.select({ id: appUsersTable.id, phone: appUsersTable.phone, status: appUsersTable.status, plan: appUsersTable.plan })
    .from(appUsersTable);
  const row = allUsers.find((r) => r.phone === staffPhoneFor(adminEmployeeId));
  assert.ok(row, "staff-linked row must exist");
  assert.equal(row.status, "active");
  assert.equal(row.plan, "vip");
});

test("the staff row is unreachable from user-facing flows", async () => {
  /* Phone login: even a lucky guess of the phone cannot authenticate, the
   * stored hash is unusable by construction. */
  const login = await api("/api/user/login", {}, { method: "POST", body: JSON.stringify({ phone: staffPhoneFor(adminEmployeeId), password: "WrongPass1!" }) });
  assert.ok(login.response.status === 401 || login.response.status === 404, `login as staff row must fail, got ${login.response.status}`);

  /* Free-trial grant: the panel refuses to create a subscription on the
   * staff row (its VIP comes from the staff session, never a subscription). */
  const allUsers = await memory.db.select({ id: appUsersTable.id, phone: appUsersTable.phone }).from(appUsersTable);
  const staffRow = allUsers.find((r) => r.phone === staffPhoneFor(adminEmployeeId));
  assert.ok(staffRow, "staff row must exist");
  const grant = await api(`/api/admin/free-trial/users/${staffRow.id}/grant`, staffJar(adminEmployeeId, "admin"), { method: "POST", body: JSON.stringify({ days: 7 }) });
  assert.equal(grant.response.status, 409, grant.raw);

  /* Payments: the payment flow keys on the customer session only — a staff
   * session can never submit a payment request. */
  const pay = await api("/api/payments", staffJar(adminEmployeeId, "admin"), { method: "POST", body: JSON.stringify({ planKey: "vip_monthly", method: "vodafone", tx: "staff-tx-1", proofImage: "data:image/png;base64,iVBORw0KGgo=" }) });
  assert.equal(pay.response.status, 401, pay.raw);
});

test("suspending the employee revokes app VIP immediately", async () => {
  const jar = staffJar(adminEmployeeId, "admin");
  await memory.db.update(employeesTable).set({ status: "suspended", updatedAt: new Date() }).where(eq(employeesTable.id, adminEmployeeId));
  const suspended = await api("/api/calculators/bootstrap", jar);
  assert.equal(suspended.response.status, 401, suspended.raw);
  await memory.db.update(employeesTable).set({ status: "active", updatedAt: new Date() }).where(eq(employeesTable.id, adminEmployeeId));
  const restored = await api("/api/calculators/bootstrap", jar);
  assert.equal(restored.response.status, 200, restored.raw);
});

test("non-privileged staff roles do not get the VIP bypass", async () => {
  const boot = await api("/api/calculators/bootstrap", staffJar(editorEmployeeId, "editor"));
  assert.equal(boot.response.status, 401, boot.raw);
});

test("a customer session always wins over a staff session (no hijack)", async () => {
  const vip = await seedUser("01094200005", "dual-vip@example.test", true);
  const free = await seedUser("01094200006", "dual-free@example.test", false);
  const dualVip: CookieJar = { value: `${vip.jar.value}; et_admin_session=${jwt.sign({ sub: adminEmployeeId, name: "Admin Probe", role: "admin", email: "admin-probe@example.test" }, process.env.SESSION_SECRET!, { expiresIn: "1h" })}` };
  const dualFree: CookieJar = { value: `${free.jar.value}; et_admin_session=${jwt.sign({ sub: adminEmployeeId, name: "Admin Probe", role: "admin", email: "admin-probe@example.test" }, process.env.SESSION_SECRET!, { expiresIn: "1h" })}` };

  /* Free user + admin cookie: the user path still applies (403, not 200). */
  const freeDual = await api("/api/calculators/bootstrap", dualFree);
  assert.equal(freeDual.response.status, 403, freeDual.raw);

  /* VIP user + admin cookie: VIP access comes from the user account, and a
   * save made with the dual jar lands in the user's account, not the staff
   * row. */
  const vipDual = await api("/api/calculators/bootstrap", dualVip);
  assert.equal(vipDual.response.status, 200, vipDual.raw);
  const saved = await api("/api/calculators/fee-profiles", dualVip, { method: "POST", body: JSON.stringify({ name: "ملف مزدوج", items: sampleItems }) });
  assert.equal(saved.response.status, 201, saved.raw);
  const userOnly = await api("/api/calculators/fee-profiles", vip.jar);
  assert.equal(userOnly.body?.profiles.length, 1);
  assert.equal(userOnly.body?.profiles[0].name, "ملف مزدوج");
  const staffOnly = await api("/api/calculators/fee-profiles", staffJar(adminEmployeeId, "admin"));
  /* The staff row still holds only its own profile from the isolation test. */
  assert.equal(staffOnly.body?.profiles.length, 1);
  assert.equal(staffOnly.body?.profiles[0].name, "ملف الأدمن");
});
