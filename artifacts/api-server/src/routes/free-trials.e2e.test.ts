import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { after, before, test } from "node:test";
import jwt from "jsonwebtoken";
import { and, eq } from "drizzle-orm";
import {
  appUsersTable,
  appSettingsTable,
  employeesTable,
  paymentRequestsTable,
  subscriptionRemindersSentTable,
  trialClaimsTable,
  userSubscriptionsTable,
} from "@workspace/db/schema";
import { createMemoryDatabase } from "../test-support/memory-db";

/* The free-trial suite uses only a per-file pg-mem DB and a loopback app. */
process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "free-trial-test-session-secret-not-for-deployment";
process.env.LOG_LEVEL = "silent";

type MemoryDatabase = Awaited<ReturnType<typeof createMemoryDatabase>>;
type CookieJar = { value?: string };
let memory: MemoryDatabase;
let server: http.Server;
let baseUrl = "";
let adminJar: CookieJar;

function passwordHash(password: string): string {
  const salt = "aabbccddeeff00112233445566778899";
  return `scrypt$${salt}$${crypto.scryptSync(password, salt, 64).toString("hex")}`;
}

function userJar(user: { id: number; phone: string; name: string }): CookieJar {
  return {
    value: `et_user_session=${jwt.sign({ sub: user.id, phone: user.phone, name: user.name, role: "user", plan: "free" }, process.env.SESSION_SECRET!, { expiresIn: "1h" })}`,
  };
}

async function api(path: string, jar: CookieJar = {}, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Origin", baseUrl);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (jar.value) headers.set("Cookie", jar.value);
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
  const raw = await response.text();
  let body: Record<string, unknown> | null = null;
  try { body = raw ? JSON.parse(raw) as Record<string, unknown> : null; } catch { /* no-op */ }
  return { response, body, raw };
}

async function syntheticUser(input: { phone: string; email: string; name?: string; verified?: boolean; at?: Date }) {
  const at = input.at || new Date();
  const [user] = await memory.db.insert(appUsersTable).values({
    phone: input.phone,
    email: input.email,
    emailVerifiedAt: input.verified === false ? null : at,
    name: input.name || "مستخدم تجربة",
    passwordHash: passwordHash("FreeTrialPass1!"),
    plan: "free",
    status: "active",
    createdAt: at,
    updatedAt: at,
  }).returning();
  return user;
}

before(async () => {
  memory = await createMemoryDatabase();
  (globalThis as typeof globalThis & { __egytrendTestDatabase?: typeof memory.db }).__egytrendTestDatabase = memory.db;
  const [employee] = await memory.db.insert(employeesTable).values({
    name: "Trial Admin",
    email: "trial.admin@example.test",
    role: "admin",
    status: "active",
    passwordHash: passwordHash("TrialAdminPass1!"),
    permissions: [],
  }).returning();
  await memory.db.insert(appSettingsTable).values({
    key: "free_vip_trial_v1",
    value: JSON.stringify({
      enabled: true,
      durationDays: 7,
      startMode: "manual",
      featureScope: "all",
      aiDailyLimit: 4,
      recentlyExpiredAudienceDays: 7,
    }),
    updatedAt: new Date(),
  });
  await memory.db.insert((await import("@workspace/db/schema")).subscriptionPlansTable).values({
    key: "trial-paid-plan",
    nameAr: "باقة مدفوعة للاختبار",
    price: 100,
    durationMonths: 1,
    features: ["ميزة اختبار"],
    isActive: true,
  });
  adminJar = { value: `et_admin_session=${jwt.sign({ sub: employee.id, name: employee.name, role: "admin", email: employee.email }, process.env.SESSION_SECRET!, { expiresIn: "1h" })}` };
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
  if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (memory) await memory.close();
  delete (globalThis as typeof globalThis & { __egytrendTestDatabase?: typeof memory.db }).__egytrendTestDatabase;
  delete (globalThis as typeof globalThis & { __egytrendTestClock?: Date }).__egytrendTestClock;
});

test("fake clock sends trial lifecycle day 0/5/7 and returns the account to Free", async () => {
  const { getVipEntitlement } = await import("../lib/userAuth");
  const { runFreeTrialLifecycle, startFreeTrial } = await import("../lib/free-trials");
  const day0 = new Date("2026-01-10T10:00:00.000Z");
  const user = await syntheticUser({ phone: "01081000001", email: "day0@example.test", at: day0 });
  const started = await startFreeTrial({ userId: user.id, now: day0 });
  assert.equal(started.reason, "started");
  assert.equal((await getVipEntitlement({ sub: user.id }, day0)).active, true, "trial grants VIP server-side from day 0");

  const day5 = new Date(day0.getTime() + 5 * 24 * 60 * 60 * 1000);
  const reminder = await runFreeTrialLifecycle({ now: day5 });
  assert.equal(reminder.queued, 1, "the default 2-days-before-end message is due on day 5");

  const day7 = new Date(day0.getTime() + 7 * 24 * 60 * 60 * 1000);
  const expiry = await runFreeTrialLifecycle({ now: day7 });
  assert.equal(expiry.expired, 1);
  assert.equal(expiry.queued, 1, "the default end message is reserved at expiration");
  assert.equal((await getVipEntitlement({ sub: user.id }, new Date(day7.getTime() + 1))).active, false, "trial expiry fails closed");
  const [account] = await memory.db.select().from(appUsersTable).where(eq(appUsersTable.id, user.id));
  assert.equal(account?.plan, "free");
  const rows = await memory.db.select().from(subscriptionRemindersSentTable).where(eq(subscriptionRemindersSentTable.userId, user.id));
  assert.deepEqual(rows.map((row) => row.trialMessageStepId).filter(Boolean).sort(), ["trial-step-before-end", "trial-step-expiry", "trial-step-welcome"]);
});

test("payment approved on trial day 3 starts paid time at day 7 and stops the trial sequence", async () => {
  const { calculateApprovedSubscriptionEnd } = await import("../lib/subscription-lifecycle");
  const { runFreeTrialLifecycle, startFreeTrial } = await import("../lib/free-trials");
  const day0 = new Date("2026-02-01T09:00:00.000Z");
  const day3 = new Date(day0.getTime() + 3 * 24 * 60 * 60 * 1000);
  const day7 = new Date(day0.getTime() + 7 * 24 * 60 * 60 * 1000);
  const user = await syntheticUser({ phone: "01081000002", email: "stacking@example.test", at: day0 });
  const start = await startFreeTrial({ userId: user.id, now: day0 });
  assert.equal(start.reason, "started");
  await memory.db.insert(paymentRequestsTable).values({
    id: "req-trial-stack",
    phone: user.phone,
    name: user.name,
    planKey: "trial-paid-plan",
    payMethod: "vodafone",
    price: 100,
    tx: "trial-stack-transaction",
    status: "pending",
    createdAt: day3,
    updatedAt: day3,
  });
  (globalThis as typeof globalThis & { __egytrendTestClock?: Date }).__egytrendTestClock = day3;
  const approved = await api("/api/admin/requests/req-trial-stack", adminJar, { method: "PUT", body: JSON.stringify({ status: "approved" }) });
  assert.equal(approved.response.status, 200, approved.raw);
  const [subscription] = await memory.db.select().from(userSubscriptionsTable).where(eq(userSubscriptionsTable.userId, user.id));
  assert.equal(subscription?.subscriptionType, "paid");
  assert.equal(subscription?.startsAt.getTime(), day7.getTime(), "paid term starts after all 7 free trial days");
  assert.equal(subscription?.expiresAt.getTime(), calculateApprovedSubscriptionEnd(day7, 1).getTime(), "one paid month stacks after the trial");
  const [claim] = await memory.db.select().from(trialClaimsTable).where(eq(trialClaimsTable.userId, user.id));
  assert.equal(claim?.convertedAt?.getTime(), day3.getTime());
  await runFreeTrialLifecycle({ now: day7 });
  const trialEndRows = await memory.db.select().from(subscriptionRemindersSentTable)
    .where(and(eq(subscriptionRemindersSentTable.userId, user.id), eq(subscriptionRemindersSentTable.trialMessageStepId, "trial-step-expiry")));
  assert.equal(trialEndRows.length, 0, "conversion cancels/suppresses later trial conversion messages");
  delete (globalThis as typeof globalThis & { __egytrendTestClock?: Date }).__egytrendTestClock;
});

test("canonical e-mail claims, extension scheduling, disable behavior and server-side selected scope are enforced", async () => {
  const { extendFreeTrial, runFreeTrialLifecycle, startFreeTrial } = await import("../lib/free-trials");
  const { hasVipFeature } = await import("../lib/userAuth");
  const { saveFreeTrialSettings } = await import("../lib/trial-settings");
  const day0 = new Date("2026-03-01T10:00:00.000Z");
  const one = await syntheticUser({ phone: "01081000003", email: "first.last+offer@gmail.com", at: day0 });
  assert.equal((await startFreeTrial({ userId: one.id, now: day0 })).reason, "started");
  assert.equal((await startFreeTrial({ userId: one.id, now: day0 })).reason, "already_active", "the same account cannot claim twice");
  const sameCanonical = await syntheticUser({ phone: "01081000004", email: "firstlast@googlemail.com", at: day0 });
  assert.equal((await startFreeTrial({ userId: sameCanonical.id, now: day0 })).reason, "already_claimed", "Gmail dots/+ and googlemail are canonicalized before eligibility");
  const temporary = await syntheticUser({ phone: "01081000005", email: "trial@mailinator.com", at: day0 });
  assert.equal((await startFreeTrial({ userId: temporary.id, now: day0 })).reason, "email_disposable");

  const extended = await syntheticUser({ phone: "01081000006", email: "extend@example.test", at: day0 });
  assert.equal((await startFreeTrial({ userId: extended.id, now: day0 })).reason, "started");
  const change = await extendFreeTrial(extended.id, 3, new Date(day0.getTime() + 3 * 24 * 60 * 60 * 1000));
  assert.equal(change.status, "extended");
  const [extendedSub] = await memory.db.select().from(userSubscriptionsTable).where(eq(userSubscriptionsTable.userId, extended.id));
  assert.equal((await runFreeTrialLifecycle({ subscriptionId: extendedSub!.id, now: new Date(day0.getTime() + 5 * 24 * 60 * 60 * 1000) })).queued, 0, "an extension shifts the future before-end message");
  assert.equal((await runFreeTrialLifecycle({ subscriptionId: extendedSub!.id, now: new Date(day0.getTime() + 8 * 24 * 60 * 60 * 1000) })).queued, 1, "the shifted before-end message fires two days before the new end");

  const activeNow = new Date();
  await saveFreeTrialSettings({ enabled: true, durationDays: 7, startMode: "manual", featureScope: ["portfolio"], aiDailyLimit: 2, recentlyExpiredAudienceDays: 7 }, activeNow);
  const scoped = await syntheticUser({ phone: "01081000007", email: "scope@example.test", at: activeNow });
  assert.equal((await startFreeTrial({ userId: scoped.id, now: activeNow })).reason, "started");
  assert.equal(await hasVipFeature({ sub: scoped.id }, "portfolio"), true);
  assert.equal(await hasVipFeature({ sub: scoped.id }, "ai"), false, "selected-scope trials are enforced by server feature gates");
  await saveFreeTrialSettings({ enabled: false, durationDays: 7, startMode: "manual", featureScope: ["portfolio"], aiDailyLimit: 2, recentlyExpiredAudienceDays: 7 }, day0);
  assert.equal(await hasVipFeature({ sub: scoped.id }, "portfolio"), true, "disabling acquisition does not cut an active trial");
  const later = await syntheticUser({ phone: "01081000008", email: "disabled@example.test", at: day0 });
  assert.equal((await startFreeTrial({ userId: later.id, now: day0 })).reason, "disabled");
});

test("trial message APIs reject non-admin/XSS and edits/archive affect future deliveries only", async () => {
  const { startFreeTrial } = await import("../lib/free-trials");
  const { saveFreeTrialSettings } = await import("../lib/trial-settings");
  const day0 = new Date("2026-04-01T10:00:00.000Z");
  await saveFreeTrialSettings({ enabled: true, durationDays: 7, startMode: "manual", featureScope: "all", aiDailyLimit: 3, recentlyExpiredAudienceDays: 7 }, day0);
  const member = await syntheticUser({ phone: "01081000009", email: "nonadmin@example.test", at: day0 });
  const denied = await api("/api/admin/free-trial/messages", userJar(member), {
    method: "POST",
    body: JSON.stringify({ titleTemplate: "x", bodyTemplate: "x" }),
  });
  assert.ok(denied.response.status === 401 || denied.response.status === 403);

  const created = await api("/api/admin/free-trial/messages", adminJar, {
    method: "POST",
    body: JSON.stringify({
      timing: "after_start", offsetDays: 1, channels: ["in_app"],
      titleTemplate: "<img src=x onerror=alert(1)> رسالة آمنة {{name}}",
      bodyTemplate: "<script>alert(1)</script> **نص آمن** {{days_left}}",
      messageType: "important", actionLabel: "عرض الباقات", actionPlanKey: "trial-paid-plan", emailMarketing: false, status: "active",
    }),
  });
  assert.equal(created.response.status, 201, created.raw);
  const step = created.body?.step as { id?: string; titleTemplate?: string; bodyTemplate?: string } | undefined;
  assert.match(String(step?.id || ""), /^trial-step-/);
  assert.equal(String(step?.titleTemplate || "").includes("<"), false);
  assert.equal(String(step?.bodyTemplate || "").includes("<"), false, "raw tags cannot be stored in editable sequence content");
  const badVariable = await api("/api/admin/free-trial/messages/preview", adminJar, {
    method: "POST",
    body: JSON.stringify({ timing: "after_start", offsetDays: 0, channels: ["in_app"], titleTemplate: "{{unknown}}", bodyTemplate: "نص", messageType: "important", status: "active" }),
  });
  assert.equal(badVariable.response.status, 400, "unknown template variables fail before save/preview");

  const first = await syntheticUser({ phone: "01081000010", email: "future-one@example.test", at: day0 });
  assert.equal((await startFreeTrial({ userId: first.id, now: day0 })).reason, "started");
  const oldWelcome = (await memory.db.select().from(subscriptionRemindersSentTable)
    .where(and(eq(subscriptionRemindersSentTable.userId, first.id), eq(subscriptionRemindersSentTable.trialMessageStepId, "trial-step-welcome"))))[0];
  assert.ok(oldWelcome?.content.trial, "first delivery stores an immutable sanitized snapshot");
  const updated = await api("/api/admin/free-trial/messages/trial-step-welcome", adminJar, {
    method: "PUT",
    body: JSON.stringify({ timing: "after_start", offsetDays: 0, channels: ["in_app"], titleTemplate: "ترحيب جديد {{name}}", bodyTemplate: "نسخة مستقبلية", messageType: "greeting", actionLabel: "عرض الباقات", actionPlanKey: "trial-paid-plan", emailMarketing: false, status: "active" }),
  });
  assert.equal(updated.response.status, 200, updated.raw);
  const unchanged = (await memory.db.select().from(subscriptionRemindersSentTable).where(eq(subscriptionRemindersSentTable.id, oldWelcome!.id)))[0];
  assert.notEqual(unchanged?.content.title, "ترحيب جديد مستخدم تجربة", "an edit never rewrites a prior sent snapshot");
  const second = await syntheticUser({ phone: "01081000011", email: "future-two@example.test", at: day0 });
  assert.equal((await startFreeTrial({ userId: second.id, now: day0 })).reason, "started");
  const newWelcome = (await memory.db.select().from(subscriptionRemindersSentTable)
    .where(and(eq(subscriptionRemindersSentTable.userId, second.id), eq(subscriptionRemindersSentTable.trialMessageStepId, "trial-step-welcome"))))[0];
  assert.equal(newWelcome?.content.title, "ترحيب جديد مستخدم تجربة", "future starts receive the new version only");
  const archived = await api(`/api/admin/free-trial/messages/${encodeURIComponent(String(step?.id))}/archive`, adminJar, { method: "POST", body: "{}" });
  assert.equal(archived.response.status, 200);
  const noSmtpTest = await api("/api/admin/free-trial/messages/trial-step-welcome/test", adminJar, { method: "POST", body: "{}" });
  assert.equal(noSmtpTest.response.status, 503, "test-send is honest when SMTP is not configured");
});
