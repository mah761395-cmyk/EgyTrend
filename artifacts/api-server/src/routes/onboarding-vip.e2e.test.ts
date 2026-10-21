import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { after, before, test } from "node:test";
import jwt from "jsonwebtoken";
import { eq } from "drizzle-orm";
import { appUsersTable, userOnboardingTable, userSubscriptionsTable } from "@workspace/db/schema";
import { createMemoryDatabase } from "../test-support/memory-db";

/* The VIP-tour suite uses only a per-file pg-mem DB and a loopback app. */
process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "onboarding-vip-test-session-secret-not-for-deployment";
process.env.REFERRAL_COOKIE_SECRET = "onboarding-vip-test-cookie-secret-not-for-deployment";
process.env.REFERRAL_SIGNAL_SECRET = "onboarding-vip-test-signal-secret-not-for-deployment";
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

async function seedUser(fields: { phone: string; email: string; name: string; verified?: boolean }): Promise<{ id: number; jar: CookieJar }> {
  const now = new Date();
  const [user] = await memory.db.insert(appUsersTable).values({
    phone: fields.phone, name: fields.name, email: fields.email,
    emailVerifiedAt: fields.verified === false ? null : now,
    passwordHash: passwordHash("VipTourPass1!"), plan: "free", status: "active", createdAt: now, updatedAt: now,
  }).returning();
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
  try { body = raw ? JSON.parse(raw) : null; } catch { /* checked as non-JSON only on failure */ }
  return { response, body, raw };
}

const state = (jar: CookieJar) => api("/api/user/onboarding", jar);
const tour = (jar: CookieJar, action: string, kind?: "user" | "vip") =>
  api("/api/user/onboarding/tour", jar, { method: "POST", body: JSON.stringify(kind ? { action, tour: kind } : { action }) });

before(async () => {
  memory = await createMemoryDatabase();
  (globalThis as typeof globalThis & { __egytrendTestDatabase?: typeof memory.db }).__egytrendTestDatabase = memory.db;
  const { saveFreeTrialSettings } = await import("../lib/trial-settings");
  await saveFreeTrialSettings({ enabled: true, durationDays: 7, startMode: "manual", featureScope: "all", aiDailyLimit: 5, recentlyExpiredAudienceDays: 7 });
  const { default: app } = await import("../app");
  server = http.createServer(app);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
  const address = server.address(); assert.ok(address && typeof address !== "string"); baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (memory) await memory.close();
  delete (globalThis as typeof globalThis & { __egytrendTestDatabase?: typeof memory.db }).__egytrendTestDatabase;
});

test("a new account sees the pending platform tour and no VIP tour, and tour APIs grant nothing", async () => {
  const anonymous = await api("/api/user/onboarding", {});
  assert.equal(anonymous.response.status, 401);

  const { id, jar } = await seedUser({ phone: "01093100001", email: "vip-new@example.test", name: "مستخدم جديد" });
  const initial = await state(jar);
  assert.equal(initial.response.status, 200, initial.raw);
  assert.equal(initial.body?.tour?.shouldShow, true, "the platform tour is pending for a new account");
  assert.equal(initial.body?.vip?.active, false);
  assert.equal(initial.body?.vipTour?.shouldShow, false, "no VIP tour without an active VIP entitlement");
  assert.ok(Object.values(initial.body?.vipFeatures || {}).every((value) => value === false), "no VIP feature is advertised to a free account");

  /* The tour endpoints are display state only: after claiming both tours the
   * account is still free and holds no subscription row. */
  await tour(jar, "started", "vip");
  const [account] = await memory.db.select().from(appUsersTable).where(eq(appUsersTable.id, id));
  assert.equal(account?.plan, "free");
  const subscriptions = await memory.db.select().from(userSubscriptionsTable).where(eq(userSubscriptionsTable.userId, id));
  assert.equal(subscriptions.length, 0, "no entitlement is ever created by a tour action");
});

test("completing or skipping the platform tour persists across refreshes and never repeats", async () => {
  const { jar } = await seedUser({ phone: "01093100002", email: "vip-returning@example.test", name: "مستخدم عائد" });

  const started = await tour(jar, "started");
  assert.equal(started.body?.tour?.status, "new");
  assert.ok(started.body?.tour?.startedAt);
  const complete = await tour(jar, "completed");
  assert.equal(complete.body?.tour?.status, "completed");

  /* A fresh GET (page refresh / next visit) must not offer the tour again. */
  const refreshed = await state(jar);
  assert.equal(refreshed.body?.tour?.shouldShow, false, "a returning user is not re-shown the tour");
  assert.equal(refreshed.body?.tour?.status, "completed");

  const skipper = await seedUser({ phone: "01093100003", email: "vip-skipper@example.test", name: "متخطٍّ" });
  const skipped = await tour(skipper.jar, "skipped");
  assert.equal(skipped.body?.tour?.status, "skipped");
  const skipperRefreshed = await state(skipper.jar);
  assert.equal(skipperRefreshed.body?.tour?.shouldShow, false, "a user who skipped is not nagged again");
  assert.equal(skipperRefreshed.body?.tour?.status, "skipped");
});

test("a first-time VIP sees the VIP tour once, and the platform tour stays untouched", async () => {
  const { id, jar } = await seedUser({ phone: "01093100004", email: "vip-first@example.test", name: "مشترك جديد" });
  await tour(jar, "completed"); /* the platform tour was already finished */

  const { startFreeTrial } = await import("../lib/free-trials");
  const started = await startFreeTrial({ userId: id, now: new Date() });
  assert.equal(started.reason, "started", JSON.stringify(started));

  const active = await state(jar);
  assert.equal(active.body?.vip?.active, true, "the trial grants an active VIP entitlement");
  assert.equal(active.body?.vipTour?.shouldShow, true, "the VIP tour appears on the first VIP-active state");
  assert.equal(active.body?.tour?.shouldShow, false, "the finished platform tour is not replayed");
  assert.equal(active.body?.vipTour?.status, "new");
  assert.equal(active.body?.vipFeatures?.calculators, true, "a full-scope trial may see every VIP step");
  assert.equal(active.body?.vipFeatures?.portfolio, true);
  assert.equal(active.body?.vipFeatures?.indicators, true);
  assert.equal(active.body?.vipFeatures?.priceAlerts, true);

  const vipStarted = await tour(jar, "started", "vip");
  assert.equal(vipStarted.body?.vipTour?.status, "new", "starting keeps the tour pending");
  assert.ok(vipStarted.body?.vipTour?.startedAt);
  const vipDone = await tour(jar, "completed", "vip");
  assert.equal(vipDone.body?.vipTour?.status, "completed");
  assert.equal(vipDone.body?.vipTour?.shouldShow, false);

  const refreshed = await state(jar);
  assert.equal(refreshed.body?.vipTour?.shouldShow, false, "the VIP tour does not repeat after it was seen");
  assert.equal(refreshed.body?.vipTour?.status, "completed");
});

test("skipping the VIP tour persists, and a later subscription never re-arms it", async () => {
  const { id, jar } = await seedUser({ phone: "01093100005", email: "vip-skip-vip@example.test", name: "تخطى جولة VIP" });
  const { startFreeTrial, runFreeTrialLifecycle } = await import("../lib/free-trials");
  assert.equal((await startFreeTrial({ userId: id, now: new Date() })).reason, "started");

  const skipped = await tour(jar, "skipped", "vip");
  assert.equal(skipped.body?.vipTour?.status, "skipped");
  assert.equal((await state(jar)).body?.vipTour?.shouldShow, false, "a skip is final for this VIP tour version");

  /* The trial expires — no VIP tour while free… */
  const expiry = await runFreeTrialLifecycle({ now: new Date(Date.now() + 8 * 24 * 60 * 60 * 1000) });
  assert.ok(expiry.expired >= 1);
  const free = await state(jar);
  assert.equal(free.body?.vip?.active, false);
  assert.equal(free.body?.vipTour?.shouldShow, false);
  assert.ok(Object.values(free.body?.vipFeatures || {}).every((value) => value === false), "expired VIP advertises no features");

  /* …and a later paid subscription (the same converted row, as a real
   * approval writes it) does not replay the welcome tour. */
  const now = new Date();
  await memory.db.update(userSubscriptionsTable).set({
    planKey: "annual", planNameAr: "باقة سنوية", planDurationMonths: 12,
    subscriptionType: "paid", trialConvertedAt: now, status: "active",
    startsAt: now, expiresAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000),
    trialEndedAt: now, updatedAt: now,
  }).where(eq(userSubscriptionsTable.userId, id));
  const renewed = await state(jar);
  assert.equal(renewed.body?.vip?.active, true, "the paid subscription is active");
  assert.equal(renewed.body?.vipTour?.shouldShow, false, "an already-acknowledged VIP tour never returns");
  assert.equal(renewed.body?.vipFeatures?.calculators, true, "a paid plan sees every feature");
});

test("a scoped trial only advertises the VIP tour steps its scope actually unlocks", async () => {
  const { id, jar } = await seedUser({ phone: "01093100006", email: "vip-scoped@example.test", name: "تجربة بنطاق محدود" });
  const { startFreeTrial } = await import("../lib/free-trials");
  const { saveFreeTrialSettings } = await import("../lib/trial-settings");
  await saveFreeTrialSettings({ enabled: true, durationDays: 7, startMode: "manual", featureScope: ["ai"], aiDailyLimit: 5, recentlyExpiredAudienceDays: 7 });
  assert.equal((await startFreeTrial({ userId: id, now: new Date() })).reason, "started");
  await saveFreeTrialSettings({ enabled: true, durationDays: 7, startMode: "manual", featureScope: "all", aiDailyLimit: 5, recentlyExpiredAudienceDays: 7 });

  const scoped = await state(jar);
  assert.equal(scoped.body?.vip?.active, true);
  assert.equal(scoped.body?.vipTour?.shouldShow, true, "the welcome tour still applies to a scoped trial");
  assert.equal(scoped.body?.vipFeatures?.ai, true, "the chosen scope unlocks its own feature");
  assert.equal(scoped.body?.vipFeatures?.calculators, false, "an out-of-scope feature is never advertised");
  assert.equal(scoped.body?.vipFeatures?.portfolio, false);
  assert.equal(scoped.body?.vipFeatures?.indicators, false);
  assert.equal(scoped.body?.vipFeatures?.priceAlerts, false);
  assert.equal(scoped.body?.vipFeatures?.opportunities, false);
});

test("tour inputs are validated and each tour replays independently from settings", async () => {
  const { jar } = await seedUser({ phone: "01093100007", email: "vip-validation@example.test", name: "تحقق من المدخلات" });

  assert.equal((await api("/api/user/onboarding/tour", jar, { method: "POST", body: JSON.stringify({ action: "explode" }) })).response.status, 400);
  assert.equal((await api("/api/user/onboarding/tour", jar, { method: "POST", body: JSON.stringify({ action: "started", tour: "root" }) })).response.status, 400);
  assert.equal((await api("/api/user/onboarding/reset", jar, { method: "POST", body: JSON.stringify({ tour: "everyone" }) })).response.status, 400);
  assert.equal((await api("/api/user/onboarding", {})).response.status, 401);
  assert.equal((await api("/api/user/onboarding/tour", {}, { method: "POST", body: JSON.stringify({ action: "started" }) })).response.status, 401);

  /* Complete the platform tour, then replay each tour alone. */
  await tour(jar, "completed");
  const replayVipReset = await api("/api/user/onboarding/reset", jar, { method: "POST", body: JSON.stringify({ tour: "vip" }) });
  assert.equal(replayVipReset.response.status, 200, replayVipReset.raw);
  assert.equal(replayVipReset.body?.tour?.status, "completed", "resetting the VIP tour leaves the platform tour alone");
  assert.equal(replayVipReset.body?.vipTour?.status, "new");
  assert.equal(replayVipReset.body?.vipTour?.shouldShow, false, "a non-VIP account still cannot trigger the VIP tour by resetting");

  const replayUser = await api("/api/user/onboarding/reset", jar, { method: "POST", body: "{}" });
  assert.equal(replayUser.body?.tour?.status, "new", "the default reset replays only the platform tour");
  assert.equal(replayUser.body?.vipTour?.status, "new", "the default reset never re-arms the VIP tour");
});
