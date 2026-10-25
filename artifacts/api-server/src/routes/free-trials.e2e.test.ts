import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { after, before, test } from "node:test";
import jwt from "jsonwebtoken";
import { and, eq } from "drizzle-orm";
import {
  appUsersTable,
  appSettingsTable,
  emailVerificationTokensTable,
  employeesTable,
  paymentRequestsTable,
  subscriptionRemindersSentTable,
  trialClaimsTable,
  userSubscriptionsTable,
} from "@workspace/db/schema";
import { createMemoryDatabase } from "../test-support/memory-db";
import { cairoCalendarDaysUntil } from "../lib/subscription-time";

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

/* A complete settings payload for the admin PUT contract. Every field the
 * validator requires is present so a rejection can only come from a value. */
function trialSettingsPayload(overrides: Record<string, unknown> = {}) {
  return { enabled: true, durationDays: 7, startMode: "manual", featureScope: "all", aiDailyLimit: 5, recentlyExpiredAudienceDays: 7, ...overrides };
}

function trialSpan(trial: { startsAt?: string; endsAt?: string }): number {
  return new Date(String(trial.endsAt)).getTime() - new Date(String(trial.startsAt)).getTime();
}

/* The end is one Cairo *calendar* day per configured day, so a term crossing a
 * DST change is 14×24h ± 1h; the API's daysLeft is the contract a member sees. */
function assertCalendarSpan(trial: { startsAt?: string; endsAt?: string; daysLeft?: number }, days: number) {
  assert.equal(trial.daysLeft, days, "the API reports the configured remaining days");
  const span = trialSpan(trial);
  assert.ok(Math.abs(span - days * 24 * 60 * 60 * 1000) <= 60 * 60 * 1000 + 1000,
    `${days} calendar days must span ~${days * 24}h, got ${span}ms`);
}

test("trial settings persist the duration, apply to new trials only, and reject invalid values", async () => {
  const { startFreeTrial } = await import("../lib/free-trials");

  const saved = await api("/api/admin/free-trial/settings", adminJar, {
    method: "PUT", body: JSON.stringify(trialSettingsPayload({ durationDays: 14 })),
  });
  assert.equal(saved.response.status, 200, saved.raw);
  assert.equal((saved.body?.settings as { durationDays?: number })?.durationDays, 14, "the save response echoes what was stored");
  const readBack = await api("/api/admin/free-trial/settings", adminJar);
  assert.equal(readBack.response.status, 200);
  assert.equal((readBack.body?.settings as { durationDays?: number })?.durationDays, 14, "the saved duration is read back from storage");

  for (const bad of [0, 32, 7.5, -3]) {
    const rejected = await api("/api/admin/free-trial/settings", adminJar, {
      method: "PUT", body: JSON.stringify(trialSettingsPayload({ durationDays: bad })),
    });
    assert.equal(rejected.response.status, 400, `durationDays ${bad} must be refused: ${rejected.raw}`);
  }
  const partial = await api("/api/admin/free-trial/settings", adminJar, {
    method: "PUT", body: JSON.stringify({ durationDays: 20 }),
  });
  assert.equal(partial.response.status, 400, "a partial payload cannot flip settings it omits");
  const intact = await api("/api/admin/free-trial/settings", adminJar);
  assert.equal((intact.body?.settings as { durationDays?: number })?.durationDays, 14, "rejected writes leave the stored settings untouched");

  /* A date with no DST transition in the window, so a 14-day term is exact. */
  const day0 = new Date("2026-02-03T10:00:00.000Z");
  const longUser = await syntheticUser({ phone: "01081000020", email: "duration14@example.test", at: day0 });
  const started = await api("/api/user/trial/start", userJar(longUser), { method: "POST", body: JSON.stringify({ durationDays: 31 }) });
  assert.equal(started.response.status, 200, started.raw);
  const running = started.body?.trial as { startsAt?: string; endsAt?: string; daysLeft?: number };
  assertCalendarSpan(running, 14);
  assert.match(String(started.body?.message || ""), /14/, "the confirmation states the configured duration");

  /* Shortening the setting never rewrites a trial that is already running. */
  const shrink = await api("/api/admin/free-trial/settings", adminJar, {
    method: "PUT", body: JSON.stringify(trialSettingsPayload({ durationDays: 7 })),
  });
  assert.equal(shrink.response.status, 200, shrink.raw);
  const [stillRunning] = await memory.db.select().from(userSubscriptionsTable).where(eq(userSubscriptionsTable.userId, longUser.id));
  assert.equal(stillRunning?.expiresAt.getTime(), new Date(running.endsAt!).getTime(), "an active trial keeps its end date after the setting changes");
  assert.ok(trialSpan(running) >= 13 * 24 * 60 * 60 * 1000, "a 31-day body never lengthened the stored term");

  const shortUser = await syntheticUser({ phone: "01081000021", email: "duration7@example.test", at: day0 });
  const next = await startFreeTrial({ userId: shortUser.id, now: day0 });
  assert.equal(next.reason, "started");
  assertCalendarSpan({
    startsAt: next.startsAt!.toISOString(), endsAt: next.endsAt!.toISOString(),
    daysLeft: cairoCalendarDaysUntil(next.endsAt!, next.startsAt!),
  }, 7);

  /* Switching the feature off is itself persisted, blocks new starts only. */
  const off = await api("/api/admin/free-trial/settings", adminJar, {
    method: "PUT", body: JSON.stringify(trialSettingsPayload({ enabled: false })),
  });
  assert.equal(off.response.status, 200, off.raw);
  assert.equal((off.body?.settings as { enabled?: boolean })?.enabled, false, "the disabled flag is saved");
  const blockedUser = await syntheticUser({ phone: "01081000022", email: "blocked-by-setting@example.test", at: day0 });
  const blocked = await api("/api/user/trial/start", userJar(blockedUser), { method: "POST", body: "{}" });
  assert.equal(blocked.response.status, 400, blocked.raw);
  assert.equal(blocked.body?.reason, "disabled", "a disabled feature refuses new starts");
  const [unaffected] = await memory.db.select().from(userSubscriptionsTable).where(eq(userSubscriptionsTable.userId, longUser.id));
  assert.equal(unaffected?.status, "active", "disabling acquisition never cuts a running trial");
  const blockedClaims = await memory.db.select().from(trialClaimsTable).where(eq(trialClaimsTable.userId, blockedUser.id));
  assert.equal(blockedClaims.length, 0, "a refused start leaves no claim behind");

  const backOn = await api("/api/admin/free-trial/settings", adminJar, {
    method: "PUT", body: JSON.stringify(trialSettingsPayload()),
  });
  assert.equal(backOn.response.status, 200, backOn.raw);
});

test("trial settings and manual grants stay admin-only, and self-start ignores a client duration", async () => {
  const ensure = await api("/api/admin/free-trial/settings", adminJar, {
    method: "PUT", body: JSON.stringify(trialSettingsPayload()),
  });
  assert.equal(ensure.response.status, 200, ensure.raw);

  /* Support reads the dashboard but never mutates policy. */
  const [support] = await memory.db.insert(employeesTable).values({
    name: "Trial Support", email: "trial.support@example.test", role: "support", status: "active",
    passwordHash: passwordHash("SupportPass1!"), permissions: [],
  }).returning();
  const supportJar = { value: `et_admin_session=${jwt.sign({ sub: support.id, name: support.name, role: "support", email: support.email }, process.env.SESSION_SECRET!, { expiresIn: "1h" })}` };
  assert.equal((await api("/api/admin/free-trial/settings", supportJar)).response.status, 200, "support may read the settings");
  const supportWrite = await api("/api/admin/free-trial/settings", supportJar, {
    method: "PUT", body: JSON.stringify(trialSettingsPayload({ durationDays: 3 })),
  });
  assert.equal(supportWrite.response.status, 403, `support must not write settings: ${supportWrite.raw}`);

  /* An ordinary member can neither read nor change policy, nor grant to self. */
  const member = await syntheticUser({ phone: "01081000023", email: "no-admin@example.test", at: new Date("2026-02-04T10:00:00.000Z") });
  const memberJar = userJar(member);
  const denied: Array<{ label: string; call: () => Promise<{ response: Response; raw: string }> }> = [
    { label: "read settings", call: () => api("/api/admin/free-trial/settings", memberJar) },
    { label: "read dashboard", call: () => api("/api/admin/free-trial", memberJar) },
    { label: "write settings", call: () => api("/api/admin/free-trial/settings", memberJar, { method: "PUT", body: JSON.stringify(trialSettingsPayload({ enabled: false, durationDays: 31 })) }) },
    { label: "grant to self", call: () => api(`/api/admin/free-trial/users/${member.id}/grant`, memberJar, { method: "POST", body: JSON.stringify({ days: 31 }) }) },
    { label: "extend self", call: () => api(`/api/admin/free-trial/users/${member.id}/extend`, memberJar, { method: "POST", body: JSON.stringify({ days: 31 }) }) },
    { label: "end-now self", call: () => api(`/api/admin/free-trial/users/${member.id}/end-now`, memberJar, { method: "POST", body: "{}" }) },
    { label: "anonymous write", call: () => api("/api/admin/free-trial/settings", {}, { method: "PUT", body: JSON.stringify(trialSettingsPayload({ enabled: false })) }) },
  ];
  for (const attempt of denied) {
    const result = await attempt.call();
    assert.ok(result.response.status === 401 || result.response.status === 403,
      `${attempt.label} must be rejected, got ${result.response.status}: ${result.raw}`);
  }
  const policy = await api("/api/admin/free-trial/settings", adminJar);
  assert.equal((policy.body?.settings as { enabled?: boolean })?.enabled, true, "the denied writes changed no setting");
  assert.equal((policy.body?.settings as { durationDays?: number })?.durationDays, 7);
  assert.equal((await memory.db.select().from(trialClaimsTable).where(eq(trialClaimsTable.userId, member.id))).length, 0, "a denied grant leaves no claim");
  assert.equal((await memory.db.select().from(userSubscriptionsTable).where(eq(userSubscriptionsTable.userId, member.id))).length, 0, "a denied grant creates no subscription");

  /* Self-service start never trusts durationDays from the request body. */
  const selfUser = await syntheticUser({ phone: "01081000024", email: "selfstart@example.test", at: new Date("2026-02-05T10:00:00.000Z") });
  const anonStart = await api("/api/user/trial/start", {}, { method: "POST", body: "{}" });
  assert.ok(anonStart.response.status === 401 || anonStart.response.status === 403, `signed-out start must be refused: ${anonStart.raw}`);
  const started = await api("/api/user/trial/start", userJar(selfUser), { method: "POST", body: JSON.stringify({ durationDays: 31 }) });
  assert.equal(started.response.status, 200, started.raw);
  assertCalendarSpan(started.body?.trial as { startsAt?: string; endsAt?: string; daysLeft?: number }, 7);
  const status = await api("/api/user/trial", userJar(selfUser));
  assert.equal((status.body?.trial as { canStart?: boolean })?.canStart, false, "a second start is refused by state, not by the client");
  assert.equal((status.body?.trial as { reason?: string })?.reason, "already_active");
});

test("an active paid subscription blocks the trial and stays distinguishable from a trial", async () => {
  const { saveFreeTrialSettings } = await import("../lib/trial-settings");
  const day0 = new Date("2026-03-15T10:00:00.000Z");
  await saveFreeTrialSettings({ enabled: true, durationDays: 7, startMode: "manual", featureScope: "all", aiDailyLimit: 5, recentlyExpiredAudienceDays: 7 }, day0);
  const user = await syntheticUser({ phone: "01081000025", email: "already-paid@example.test", at: new Date() });
  await memory.db.insert(userSubscriptionsTable).values({
    id: "sub-paid-trial-guard", userId: user.id, planKey: "trial-paid-plan", planNameAr: "باقة مدفوعة للاختبار",
    planDurationMonths: 1, planFeatures: ["ميزة اختبار"], subscriptionType: "paid", trialFeatureScope: null,
    trialAiDailyLimit: null, trialStartedAt: null, trialEndsAt: null, trialEndedAt: null, trialConvertedAt: null,
    status: "active", cycleId: "paid-cycle-trial-guard", startsAt: new Date(Date.now() - 60 * 60 * 1000),
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), graceEndsAt: null, paymentRequestId: null,
    source: "payment", cancelledAt: null,
  });

  const start = await api("/api/user/trial/start", userJar(user), { method: "POST", body: "{}" });
  assert.equal(start.response.status, 409, start.raw);
  assert.equal(start.body?.reason, "already_paid", "a live paid term never accepts a free trial");

  const status = await api("/api/user/trial", userJar(user));
  const trial = status.body?.trial as { active?: boolean; canStart?: boolean; reason?: string; startsAt?: string | null };
  assert.equal(trial.active, false);
  assert.equal(trial.canStart, false);
  assert.equal(trial.reason, "already_paid");
  assert.equal(trial.startsAt, null, "no trial start time is recorded on a paid account");

  const me = await api("/api/user/me", userJar(user));
  const subscription = me.body?.subscription as { subscriptionType?: string; active?: boolean; trialStartedAt?: string | null };
  assert.equal(subscription.subscriptionType, "paid", "the account state says paid, not trial");
  assert.equal(subscription.active, true);
  assert.equal(subscription.trialStartedAt, null);

  const [row] = await memory.db.select().from(userSubscriptionsTable).where(eq(userSubscriptionsTable.userId, user.id));
  assert.equal(row?.subscriptionType, "paid", "the paid entitlement was not overwritten");
  assert.equal(row?.planKey, "trial-paid-plan");
  assert.equal((await memory.db.select().from(trialClaimsTable).where(eq(trialClaimsTable.userId, user.id))).length, 0, "no claim is consumed");
});

test("trial expiry ends VIP access, keeps the account and its data, and blocks a second trial", async () => {
  const { runFreeTrialLifecycle, startFreeTrial } = await import("../lib/free-trials");
  const { getVipEntitlement, hasVipFeature } = await import("../lib/userAuth");
  const { saveFreeTrialSettings } = await import("../lib/trial-settings");
  const day0 = new Date();
  await saveFreeTrialSettings({ enabled: true, durationDays: 7, startMode: "manual", featureScope: "all", aiDailyLimit: 5, recentlyExpiredAudienceDays: 7 }, day0);
  const user = await syntheticUser({ phone: "01081000026", email: "expiring@example.test", at: day0 });
  const started = await startFreeTrial({ userId: user.id, now: day0 });
  assert.equal(started.reason, "started");
  assert.equal(cairoCalendarDaysUntil(started.endsAt!, started.startsAt!), 7, "the trial runs the configured seven days");
  const live = await getVipEntitlement({ sub: user.id }, day0);
  assert.equal(live.active, true, "the trial grants VIP access while it lives");
  assert.equal(live.subscriptionType, "trial", "account state names the trial as a trial");
  assert.equal(live.trialFeatureScope, "all");
  assert.equal(await hasVipFeature({ sub: user.id }, "ai"), true, "feature gates honour the live trial");

  const day7 = new Date(started.endsAt!.getTime() + 60_000);
  const expiry = await runFreeTrialLifecycle({ now: day7 });
  assert.ok(expiry.expired >= 1, "the lifecycle expired at least this trial");
  assert.equal((await getVipEntitlement({ sub: user.id }, day7)).active, false, "VIP access ends with the trial");
  assert.equal(await hasVipFeature({ sub: user.id }, "ai"), false);

  const [account] = await memory.db.select().from(appUsersTable).where(eq(appUsersTable.id, user.id));
  assert.ok(account, "the account is never deleted");
  assert.equal(account.plan, "free");
  const [subscription] = await memory.db.select().from(userSubscriptionsTable).where(eq(userSubscriptionsTable.userId, user.id));
  assert.ok(subscription, "the trial row is retained as history");
  assert.equal(subscription.status, "expired");
  assert.ok(subscription.trialEndedAt, "the end time is recorded server-side");
  assert.ok((await memory.db.select().from(trialClaimsTable).where(eq(trialClaimsTable.userId, user.id))).length === 1, "the claim survives expiry");

  const restart = await api("/api/user/trial/start", userJar(user), { method: "POST", body: "{}" });
  assert.equal(restart.response.status, 409, restart.raw);
  assert.equal(restart.body?.reason, "already_claimed", "one trial per account, even after expiry");
  const status = await api("/api/user/trial", userJar(user));
  const trial = status.body?.trial as { active?: boolean; canStart?: boolean; reason?: string; endedAt?: string | null };
  assert.equal(trial.active, false);
  assert.equal(trial.canStart, false);
  assert.equal(trial.reason, "already_claimed");
  assert.ok(trial.endedAt, "the account can see when its trial ended");
});

test("auto-start after e-mail verification applies the configured duration and start mode", async () => {
  const { saveFreeTrialSettings } = await import("../lib/trial-settings");
  const now = new Date();
  await saveFreeTrialSettings({ enabled: true, durationDays: 10, startMode: "after_email_verification", featureScope: "all", aiDailyLimit: 5, recentlyExpiredAudienceDays: 7 }, now);

  const pending = await syntheticUser({ phone: "01081000027", email: "autostart@example.test", verified: false, at: now });
  const raw = crypto.randomBytes(32).toString("hex");
  assert.match(raw, /^[a-f0-9]{64}$/);
  await memory.db.insert(emailVerificationTokensTable).values({
    id: `evt-trial-duration-${pending.id}`,
    userId: pending.id,
    tokenHash: crypto.createHash("sha256").update(raw).digest("hex"),
    expiresAt: new Date(now.getTime() + 15 * 60 * 1000),
    createdAt: now,
  });

  const confirm = await api("/api/user/email-verification/confirm", {}, { method: "POST", body: JSON.stringify({ token: raw }) });
  assert.equal(confirm.response.status, 200, confirm.raw);
  assert.equal(confirm.body?.emailVerified, true);
  assert.equal(confirm.body?.trialStarted, true, "the configured mode starts the trial server-side");
  assert.match(String(confirm.body?.message || ""), /10/, "the confirmation quotes the configured duration, not 7");

  const status = await api("/api/user/trial", userJar(pending));
  const trial = status.body?.trial as { active?: boolean; daysLeft?: number; startsAt?: string; endsAt?: string };
  assert.equal(trial.active, true, "the auto-started trial is live immediately");
  assert.equal(trial.daysLeft, 10, "the member sees the configured remaining days");
  assert.ok(Math.abs(trialSpan(trial) - 10 * 24 * 60 * 60 * 1000) <= 60 * 60 * 1000 + 1000, "ten configured days span ten days");

  const me = await api("/api/user/me", userJar(pending));
  const subscription = me.body?.subscription as { subscriptionType?: string; active?: boolean; trialEndsAt?: string | null };
  assert.equal(subscription.subscriptionType, "trial", "auto-start still reports itself as a trial, not a paid term");
  assert.equal(subscription.active, true);

  /* Restore the policy this file's remaining assertions rely on. */
  const restore = await api("/api/admin/free-trial/settings", adminJar, {
    method: "PUT", body: JSON.stringify(trialSettingsPayload()),
  });
  assert.equal(restore.response.status, 200, restore.raw);
});
