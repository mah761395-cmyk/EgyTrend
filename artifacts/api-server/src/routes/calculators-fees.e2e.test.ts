import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { after, before, test } from "node:test";
import jwt from "jsonwebtoken";
import { appSettingsTable, appUsersTable, userSubscriptionsTable } from "@workspace/db/schema";
import { createMemoryDatabase } from "../test-support/memory-db";

/* Fee-profile suite: per-file pg-mem DB + loopback app. */
process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "calc-fees-test-session-secret-not-for-deployment";
process.env.REFERRAL_COOKIE_SECRET = "calc-fees-test-cookie-secret-not-for-deployment";
process.env.REFERRAL_SIGNAL_SECRET = "calc-fees-test-signal-secret-not-for-deployment";
process.env.LOG_LEVEL = "silent";

type Memory = Awaited<ReturnType<typeof createMemoryDatabase>>;
type CookieJar = { value?: string };
let memory: Memory;
let server: http.Server;
let baseUrl = "";

function passwordHash(password: string): string {
  const salt = "ffeeddccbbaa99887766554433221100";
  return `scrypt$${salt}$${crypto.scryptSync(password, salt, 64).toString("hex")}`;
}

async function seedVipUser(phone: string, email: string): Promise<{ id: number; jar: CookieJar }> {
  const now = new Date();
  const [user] = await memory.db.insert(appUsersTable).values({
    phone, name: "Fee Probe", email, emailVerifiedAt: now,
    passwordHash: passwordHash("FeeProbePass1!"), plan: "free", status: "active", createdAt: now, updatedAt: now,
  }).returning();
  await memory.db.insert(userSubscriptionsTable).values({
    id: crypto.randomUUID(), userId: user!.id, planKey: "vip_monthly", planNameAr: "VIP",
    planDurationMonths: 1, planFeatures: [], subscriptionType: "paid",
    status: "active", cycleId: crypto.randomUUID(), startsAt: now,
    expiresAt: new Date(now.getTime() + 30 * 86_400_000), source: "payment",
  });
  const jar: CookieJar = {
    value: `et_user_session=${jwt.sign({ sub: user!.id, phone: user!.phone, name: user!.name, role: "user", plan: "free" }, process.env.SESSION_SECRET!, { expiresIn: "1h" })}`,
  };
  return { id: user!.id, jar };
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

const sampleItems = [
  { key: "broker_commission", labelAr: "عمولة الوساطة", side: "both", percent: 0.1, minimum: 25 },
  { key: "stamp_duty", labelAr: "ضريبة الدمغة", side: "sell", percent: 0, minimum: 0 },
];

before(async () => {
  memory = await createMemoryDatabase();
  (globalThis as typeof globalThis & { __egytrendTestDatabase?: typeof memory.db }).__egytrendTestDatabase = memory.db;
  /* The catalog is admin-managed data (seeded by migration 0015 in real
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

test("fee catalog and profiles are VIP-gated (401 anonymous, 403 without VIP)", async () => {
  const anonCatalog = await api("/api/calculators/fee-catalog", {});
  assert.equal(anonCatalog.response.status, 401);
  const anonProfiles = await api("/api/calculators/fee-profiles", {});
  assert.equal(anonProfiles.response.status, 401);

  const [user] = await memory.db.insert(appUsersTable).values({
    phone: "01094100001", name: "Free", email: "free-fees@example.test", emailVerifiedAt: new Date(),
    passwordHash: passwordHash("FreePass1!"), plan: "free", status: "active", createdAt: new Date(), updatedAt: new Date(),
  }).returning();
  const freeJar: CookieJar = {
    value: `et_user_session=${jwt.sign({ sub: user!.id, phone: user!.phone, name: user!.name, role: "user", plan: "free" }, process.env.SESSION_SECRET!, { expiresIn: "1h" })}`,
  };
  const freeCatalog = await api("/api/calculators/fee-catalog", freeJar);
  assert.equal(freeCatalog.response.status, 403);
});

test("fee catalog serves the admin-managed rows without any rates", async () => {
  const { jar } = await seedVipUser("01094100011", "vip-fees-a@example.test");
  const catalog = await api("/api/calculators/fee-catalog", jar);
  assert.equal(catalog.response.status, 200, catalog.raw);
  assert.equal(catalog.body?.status, "ok");
  assert.equal(catalog.body?.items.length, 5);
  assert.deepEqual(catalog.body?.items[0], { key: "broker_commission", labelAr: "عمولة الوساطة" });
  /* Names only: the platform never carries a default rate. */
  assert.ok(!("percent" in catalog.body.items[0]));
});

test("a user saves, lists, updates and deletes their own fee profile", async () => {
  const { jar } = await seedVipUser("01094100021", "vip-fees-b@example.test");
  const saved = await api("/api/calculators/fee-profiles", jar, { method: "POST", body: JSON.stringify({ name: "سمسرتي", items: sampleItems }) });
  assert.equal(saved.response.status, 201, saved.raw);

  const listed = await api("/api/calculators/fee-profiles", jar);
  assert.equal(listed.response.status, 200, listed.raw);
  assert.equal(listed.body?.profiles.length, 1);
  assert.equal(listed.body?.profiles[0].name, "سمسرتي");
  assert.deepEqual(listed.body?.profiles[0].items, sampleItems);

  /* Same name = update, not a duplicate. */
  const updated = await api("/api/calculators/fee-profiles", jar, { method: "POST", body: JSON.stringify({ name: "سمسرتي", items: sampleItems.slice(0, 1) }) });
  assert.equal(updated.response.status, 201, updated.raw);
  const relisted = await api("/api/calculators/fee-profiles", jar);
  assert.equal(relisted.body?.profiles.length, 1);
  assert.equal(relisted.body?.profiles[0].items.length, 1);

  const deleted = await api(`/api/calculators/fee-profiles/${relisted.body.profiles[0].id}`, jar, { method: "DELETE" });
  assert.equal(deleted.response.status, 200, deleted.raw);
  const empty = await api("/api/calculators/fee-profiles", jar);
  assert.equal(empty.body?.profiles.length, 0);
});

test("fee profiles are strictly owner-scoped", async () => {
  const a = await seedVipUser("01094100031", "vip-fees-c@example.test");
  const b = await seedVipUser("01094100041", "vip-fees-d@example.test");
  const saved = await api("/api/calculators/fee-profiles", a.jar, { method: "POST", body: JSON.stringify({ name: "سر أ", items: sampleItems }) });
  assert.equal(saved.response.status, 201);
  const id = saved.body!.id as string;

  const otherList = await api("/api/calculators/fee-profiles", b.jar);
  assert.equal(otherList.body?.profiles.length, 0, "user B must not see user A's schedule");
  const otherDelete = await api(`/api/calculators/fee-profiles/${id}`, b.jar, { method: "DELETE" });
  assert.equal(otherDelete.response.status, 404);
  const stillOwns = await api("/api/calculators/fee-profiles", a.jar);
  assert.equal(stillOwns.body?.profiles.length, 1);
});

test("invalid fee profile payloads are rejected with 400", async () => {
  const { jar } = await seedVipUser("01094100051", "vip-fees-e@example.test");
  const badBodies = [
    { name: "", items: sampleItems },
    { name: "خ", items: [{ key: "x", labelAr: "بدون جانب", percent: 1, minimum: 0 }] },
    { name: "خ", items: [{ key: "x", labelAr: "سالب", side: "buy", percent: -0.1, minimum: 0 }] },
    { name: "خ", items: [{ key: "x", labelAr: "فوق المية", side: "buy", percent: 101, minimum: 0 }] },
    { name: "خ", items: [{ key: "x", labelAr: "حد أدنى سالب", side: "buy", percent: 1, minimum: -5 }] },
    { name: "خ", items: "بدون" },
  ];
  for (const body of badBodies) {
    const res = await api("/api/calculators/fee-profiles", jar, { method: "POST", body: JSON.stringify(body) });
    assert.equal(res.response.status, 400, JSON.stringify(body));
  }
  /* Blank percent/minimum is explicit user intent (zero) and must pass. */
  const ok = await api("/api/calculators/fee-profiles", jar, { method: "POST", body: JSON.stringify({ name: "بدون قيم", items: [{ key: "broker_commission", labelAr: "عمولة", side: "both" }] }) });
  assert.equal(ok.response.status, 201, ok.raw);
});
