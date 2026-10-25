import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { after, before, test } from "node:test";
import jwt from "jsonwebtoken";
import { eq } from "drizzle-orm";
import { appUsersTable, userOnboardingTable } from "@workspace/db/schema";
import { createMemoryDatabase } from "../test-support/memory-db";

process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "onboarding-test-session-secret-not-for-deployment";
process.env.REFERRAL_COOKIE_SECRET = "onboarding-test-cookie-secret-not-for-deployment";
process.env.REFERRAL_SIGNAL_SECRET = "onboarding-test-signal-secret-not-for-deployment";
process.env.LOG_LEVEL = "silent";

type Memory = Awaited<ReturnType<typeof createMemoryDatabase>>;
let memory: Memory;
let server: http.Server;
let baseUrl = "";
let cookie = "";
let userId = 0;

function passwordHash(password: string): string {
  const salt = "11223344556677889900aabbccddeeff";
  return `scrypt$${salt}$${crypto.scryptSync(password, salt, 64).toString("hex")}`;
}
async function api(path: string, init: RequestInit = {}, authenticated = true) {
  const headers = new Headers(init.headers);
  headers.set("Origin", baseUrl);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (authenticated) headers.set("Cookie", cookie);
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
  const raw = await response.text();
  let body: Record<string, any> | null = null;
  try { body = raw ? JSON.parse(raw) : null; } catch { /* checked as non-JSON only on failure */ }
  return { response, body, raw };
}

before(async () => {
  memory = await createMemoryDatabase();
  (globalThis as typeof globalThis & { __egytrendTestDatabase?: typeof memory.db }).__egytrendTestDatabase = memory.db;
  const now = new Date("2026-10-17T09:00:00.000Z");
  const [user] = await memory.db.insert(appUsersTable).values({
    phone: "01093000001", name: "مستخدم البداية", email: "onboarding@example.test", emailVerifiedAt: now,
    passwordHash: passwordHash("OnboardingPass1!"), plan: "free", status: "active", createdAt: now, updatedAt: now,
  }).returning();
  userId = user!.id;
  cookie = `et_user_session=${jwt.sign({ sub: user!.id, phone: user!.phone, name: user!.name, role: "user", plan: "free" }, process.env.SESSION_SECRET!, { expiresIn: "1h" })}`;
  const { saveFreeTrialSettings } = await import("../lib/trial-settings");
  const { saveReferralSettings } = await import("../lib/referrals");
  await saveFreeTrialSettings({ enabled: true, durationDays: 7, startMode: "manual", featureScope: "all", aiDailyLimit: 5, recentlyExpiredAudienceDays: 7 }, now);
  await saveReferralSettings({ enabled: true, attributionCookieDays: 30, termsText: "شروط" }, null, now);
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

test("onboarding state is account-persistent, resettable, and gates optional trial/referral UI from admin settings", async () => {
  const anonymous = await api("/api/user/onboarding", {}, false);
  assert.equal(anonymous.response.status, 401);

  const initial = await api("/api/user/onboarding");
  assert.equal(initial.response.status, 200, initial.raw);
  assert.equal(initial.body?.tour?.shouldShow, true);
  assert.equal(initial.body?.features?.freeTrial?.enabled, true);
  assert.equal(initial.body?.features?.referrals?.enabled, true);
  assert.equal(initial.body?.checklist?.length, 4, "the enabled free trial is the fourth honest checklist item");
  assert.equal(initial.body?.checklist?.find((item: any) => item.id === "watchlist")?.progress?.current, 0);

  const two = await api("/api/user/onboarding/events", { method: "POST", body: JSON.stringify({ event: "watchlist_progress", payload: { count: 2 } }) });
  assert.equal(two.response.status, 200, two.raw);
  assert.equal(two.body?.checklist?.find((item: any) => item.id === "watchlist")?.completed, false);
  const three = await api("/api/user/onboarding/events", { method: "POST", body: JSON.stringify({ event: "watchlist_progress", payload: { count: 3 } }) });
  assert.equal(three.body?.checklist?.find((item: any) => item.id === "watchlist")?.completed, true);
  assert.equal(three.body?.checklist?.find((item: any) => item.id === "watchlist")?.progress?.current, 3);

  const notification = await api("/api/user/onboarding/events", { method: "POST", body: JSON.stringify({ event: "notifications_enabled", payload: {} }) });
  const news = await api("/api/user/onboarding/events", { method: "POST", body: JSON.stringify({ event: "news_explored", payload: {} }) });
  assert.equal(notification.body?.checklist?.find((item: any) => item.id === "notifications")?.completed, true);
  assert.equal(news.body?.checklist?.find((item: any) => item.id === "news")?.completed, true);

  const started = await api("/api/user/onboarding/tour", { method: "POST", body: JSON.stringify({ action: "started" }) });
  assert.equal(started.body?.tour?.status, "new");
  assert.ok(started.body?.tour?.startedAt);
  const complete = await api("/api/user/onboarding/tour", { method: "POST", body: JSON.stringify({ action: "completed" }) });
  assert.equal(complete.body?.tour?.shouldShow, false);
  assert.equal(complete.body?.tour?.status, "completed");

  const reset = await api("/api/user/onboarding/reset", { method: "POST", body: "{}" });
  assert.equal(reset.body?.tour?.shouldShow, true, "settings reset replays only the tour");
  assert.equal(reset.body?.checklist?.find((item: any) => item.id === "watchlist")?.completed, true, "reset never invents or erases actual checklist progress");
  const [stored] = await memory.db.select().from(userOnboardingTable).where(eq(userOnboardingTable.userId, userId));
  assert.equal(stored?.watchlistCount, 3);

  const { saveFreeTrialSettings } = await import("../lib/trial-settings");
  const { saveReferralSettings } = await import("../lib/referrals");
  await saveFreeTrialSettings({ enabled: false, durationDays: 7, startMode: "manual", featureScope: "all", aiDailyLimit: 5, recentlyExpiredAudienceDays: 7 });
  await saveReferralSettings({ enabled: false, attributionCookieDays: 30, termsText: "" }, null);
  const disabled = await api("/api/user/onboarding");
  assert.equal(disabled.body?.features?.freeTrial?.enabled, false);
  assert.equal(disabled.body?.features?.referrals?.enabled, false);
  assert.equal(disabled.body?.checklist?.some((item: any) => item.id === "free_trial"), false, "disabled promotion never appears as a promised task");
});
