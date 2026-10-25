import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { after, before, test } from "node:test";
import jwt from "jsonwebtoken";
import { and, eq } from "drizzle-orm";
import {
  appUsersTable,
  employeesTable,
  paymentRequestsTable,
  referralAttributionsTable,
  referralRewardsTable,
  subscriptionPlansTable,
} from "@workspace/db/schema";
import { createMemoryDatabase } from "../test-support/memory-db";

process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "referral-test-session-secret-not-for-deployment";
process.env.REFERRAL_COOKIE_SECRET = "referral-test-cookie-secret-not-for-deployment";
process.env.REFERRAL_SIGNAL_SECRET = "referral-test-signals-not-for-deployment";
process.env.LOG_LEVEL = "silent";

type Memory = Awaited<ReturnType<typeof createMemoryDatabase>>;
type Jar = { value?: string };
let memory: Memory;
let server: http.Server;
let baseUrl = "";
let adminJar: Jar;

function hash(password: string): string {
  const salt = "ddeeff00112233445566778899aabbcc";
  return `scrypt$${salt}$${crypto.scryptSync(password, salt, 64).toString("hex")}`;
}
function jar(user: { id: number; phone: string; name: string }): Jar {
  return { value: `et_user_session=${jwt.sign({ sub: user.id, phone: user.phone, name: user.name, role: "user", plan: "free" }, process.env.SESSION_SECRET!, { expiresIn: "1h" })}` };
}
async function api(path: string, cookie: Jar = {}, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Origin", baseUrl);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (cookie.value) headers.set("Cookie", cookie.value);
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
  const raw = await response.text();
  let body: Record<string, any> | null = null;
  try { body = raw ? JSON.parse(raw) : null; } catch { /* intentional for non-JSON */ }
  return { response, body, raw };
}
async function user(input: { phone: string; email: string; now: Date; name?: string; verified?: boolean }) {
  const [created] = await memory.db.insert(appUsersTable).values({
    phone: input.phone, email: input.email, emailVerifiedAt: input.verified === false ? null : input.now,
    name: input.name || "مستخدم إحالة", passwordHash: hash("ReferralPass1!"), plan: "free", status: "active", createdAt: input.now, updatedAt: input.now,
  }).returning();
  return created!;
}

before(async () => {
  memory = await createMemoryDatabase();
  (globalThis as typeof globalThis & { __egytrendTestDatabase?: typeof memory.db }).__egytrendTestDatabase = memory.db;
  const [employee] = await memory.db.insert(employeesTable).values({ name: "Referral Admin", email: "ref.admin@example.test", role: "admin", status: "active", passwordHash: hash("AdminPass1!"), permissions: [] }).returning();
  await memory.db.insert(subscriptionPlansTable).values({ key: "ref-plan", nameAr: "باقة إحالة", price: 100, durationMonths: 1, features: [], isActive: true });
  adminJar = { value: `et_admin_session=${jwt.sign({ sub: employee!.id, name: employee!.name, role: "admin", email: employee!.email }, process.env.SESSION_SECRET!, { expiresIn: "1h" })}` };
  const { default: app } = await import("../app");
  server = http.createServer(app);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
  const address = server.address(); assert.ok(address && typeof address !== "string"); baseUrl = `http://127.0.0.1:${address.port}`;
});
after(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (memory) await memory.close();
  delete (globalThis as typeof globalThis & { __egytrendTestDatabase?: typeof memory.db }).__egytrendTestDatabase;
  delete (globalThis as typeof globalThis & { __egytrendTestClock?: Date }).__egytrendTestClock;
});

async function setupCampaign(now: Date, extra: Record<string, unknown> = {}) {
  const { createReferralCampaign, saveReferralSettings, validateReferralCampaign } = await import("../lib/referrals");
  await saveReferralSettings({ enabled: true, attributionCookieDays: 30, termsText: "شروط اختبار" }, null, now);
  const input = validateReferralCampaign({
    name: `حملة ${now.toISOString()}`, status: "active", priority: 0, startsAt: null, endsAt: null,
    qualificationEvent: "first_paid", holdDays: 7, referrerRewardType: "vip_days", referrerRewardValue: 10,
    inviteeRewardType: "first_subscription_percent", inviteeRewardValue: 10, ...extra,
  });
  assert.ok(input);
  return createReferralCampaign(input!, null, now);
}
async function attach(inviter: Awaited<ReturnType<typeof user>>, phone: string, email: string, now: Date, options: { ip?: string; device?: string; code?: string } = {}) {
  const { attachReferralAtRegistration, ensureReferralCode } = await import("../lib/referrals");
  const invited = await user({ phone, email, now, verified: false });
  const code = options.code || (await ensureReferralCode(inviter.id, now)).code;
  const result = await attachReferralAtRegistration({ userId: invited.id, email, phone, code, ip: options.ip || `198.51.100.${phone.slice(-2)}`, device: options.device || `device-${phone}`, now });
  return { invited, result, code };
}
async function approve(invited: Awaited<ReturnType<typeof user>>, requestId: string, now: Date, extra: { senderPhone?: string; proofHash?: string } = {}) {
  await memory.db.insert(paymentRequestsTable).values({ id: requestId, phone: invited.phone, name: invited.name, planKey: "ref-plan", payMethod: "vodafone", price: 100, tx: `tx-${requestId}`, status: "pending", senderPhone: extra.senderPhone || null, proofHash: extra.proofHash || null, createdAt: now, updatedAt: now });
  (globalThis as typeof globalThis & { __egytrendTestClock?: Date }).__egytrendTestClock = now;
  const result = await api(`/api/admin/requests/${requestId}`, adminJar, { method: "PUT", body: JSON.stringify({ status: "approved" }) });
  assert.equal(result.response.status, 200, result.raw);
}

test("self/canonical-email is rejected, while repeated IP is placed in review instead of auto-rejected", async () => {
  const now = new Date("2026-06-02T10:00:00.000Z");
  await setupCampaign(now);
  const inviter = await user({ phone: "01092000001", email: "first.last+owner@gmail.com", now });
  const { ensureReferralCode } = await import("../lib/referrals");
  const code = (await ensureReferralCode(inviter.id, now)).code;
  const canonical = await attach(inviter, "01092000002", "firstlast@googlemail.com", now, { code });
  assert.equal(canonical.result.attached, false);
  const [blocked] = await memory.db.select().from(referralAttributionsTable).where(eq(referralAttributionsTable.invitedUserId, canonical.invited.id));
  assert.equal(blocked?.status, "blocked");
  assert.equal(blocked?.blockedReason, "same_canonical_email");

  const one = await attach(inviter, "01092000003", "same-ip-one@example.test", now, { ip: "198.51.100.7" });
  const two = await attach(inviter, "01092000004", "same-ip-two@example.test", now, { ip: "198.51.100.7" });
  assert.equal(one.result.attached, true);
  assert.equal(two.result.attached, true);
  const [review] = await memory.db.select().from(referralAttributionsTable).where(eq(referralAttributionsTable.invitedUserId, two.invited.id));
  assert.equal(review?.status, "review");
  assert.equal(review?.reviewStatus, "pending");
});

test("first paid reward holds for seven Cairo days, grants once, and refund during hold cancels", async () => {
  const day0 = new Date("2026-07-01T09:00:00.000Z");
  await setupCampaign(day0);
  const inviter = await user({ phone: "01092000011", email: "hold-referrer@example.test", now: day0 });
  const first = await attach(inviter, "01092000012", "hold-one@example.test", day0);
  const { recordReferralEvent, runReferralLifecycle } = await import("../lib/referrals");
  await memory.db.update(appUsersTable).set({ emailVerifiedAt: day0 }).where(eq(appUsersTable.id, first.invited.id));
  await recordReferralEvent({ userId: first.invited.id, event: "email_verified", now: day0 });
  await approve(first.invited, "req-hold", day0);
  const [pending] = await memory.db.select().from(referralRewardsTable).where(and(eq(referralRewardsTable.recipientUserId, inviter.id), eq(referralRewardsTable.recipientRole, "referrer")));
  assert.equal(pending?.status, "pending");
  await runReferralLifecycle({ now: new Date("2026-07-07T09:00:00.000Z") });
  assert.equal((await memory.db.select().from(referralRewardsTable).where(eq(referralRewardsTable.id, pending!.id)))[0]?.status, "pending");
  await runReferralLifecycle({ now: new Date("2026-07-08T09:00:00.000Z") });
  assert.equal((await memory.db.select().from(referralRewardsTable).where(eq(referralRewardsTable.id, pending!.id)))[0]?.status, "granted");
  const twice = await api("/api/admin/requests/req-hold", adminJar, { method: "PUT", body: JSON.stringify({ status: "approved" }) });
  assert.equal(twice.response.status, 200);
  assert.equal((await memory.db.select().from(referralRewardsTable).where(eq(referralRewardsTable.recipientUserId, inviter.id))).length, 1, "same approval creates no second reward");

  const second = await attach(inviter, "01092000013", "refund@example.test", new Date(day0.getTime() + 60_000));
  await memory.db.update(appUsersTable).set({ emailVerifiedAt: day0 }).where(eq(appUsersTable.id, second.invited.id));
  await recordReferralEvent({ userId: second.invited.id, event: "email_verified", now: day0 });
  await approve(second.invited, "req-refund", day0);
  const [refundReward] = await memory.db.select().from(referralRewardsTable).where(and(eq(referralRewardsTable.recipientUserId, inviter.id), eq(referralRewardsTable.paymentRequestId, "req-refund")));
  const refunded = await api("/api/admin/requests/req-refund", adminJar, { method: "PUT", body: JSON.stringify({ status: "refunded", notes: "اختبار" }) });
  assert.equal(refunded.response.status, 200, refunded.raw);
  assert.equal((await memory.db.select().from(referralRewardsTable).where(eq(referralRewardsTable.id, refundReward!.id)))[0]?.status, "cancelled");
  delete (globalThis as typeof globalThis & { __egytrendTestClock?: Date }).__egytrendTestClock;
});

test("campaign priority/special-code snapshots, caps, XSS and sender-phone review remain server controlled", async () => {
  const now = new Date("2026-09-10T10:00:00.000Z");
  const low = await setupCampaign(now, { name: "منخفضة", priority: 1, startsAt: "2026-09-01T00:00", endsAt: "2026-09-20T00:00", maxReferrerMonthly: 1 });
  const high = await setupCampaign(now, { name: "مرتفعة", priority: 9, startsAt: "2026-09-01T00:00", endsAt: "2026-09-20T00:00", referrerRewardValue: 22, maxReferrerMonthly: 1 });
  const inviter = await user({ phone: "01092000021", email: "partner-owner@example.test", now });
  const { archiveReferralCampaign, attachReferralAtRegistration, createSpecialReferralCode, ensureReferralCode, recordReferralEvent, setReferralUserProgramState, updateReferralCampaign, updateSpecialReferralCode, validateReferralCampaign } = await import("../lib/referrals");
  const special = await createSpecialReferralCode({ code: "AHMED10", label: "شريك", ownerUserId: inviter.id, campaignId: high!.id, commissionDue: 250 }, null, now);
  assert.ok(special);
  const invited = await user({ phone: "01092000022", email: "partner-invitee@example.test", now, verified: false });
  const linked = await attachReferralAtRegistration({ userId: invited.id, email: invited.email, phone: invited.phone, code: "AHMED10", ip: "198.51.100.80", device: "partner-device", now });
  assert.equal(linked.attached, true);
  const [snapshot] = await memory.db.select().from(referralAttributionsTable).where(eq(referralAttributionsTable.invitedUserId, invited.id));
  assert.equal(snapshot?.campaignId, high!.id, "special code overrides default campaign selection");
  assert.equal((snapshot?.ruleSnapshot as any)?.referrerRewardValue, 22);
  const changed = validateReferralCampaign({ name: "مرتفعة جديدة", status: "active", priority: 9, startsAt: "2026-09-01T00:00", endsAt: "2026-09-20T00:00", qualificationEvent: "first_paid", holdDays: 7, referrerRewardType: "vip_days", referrerRewardValue: 99, inviteeRewardType: "first_subscription_percent", inviteeRewardValue: 10, maxReferrerMonthly: 1 });
  assert.ok(changed); await updateReferralCampaign(high!.id, changed!, null, new Date(now.getTime() + 1));
  assert.equal(((await memory.db.select().from(referralAttributionsTable).where(eq(referralAttributionsTable.id, snapshot!.id)))[0]?.ruleSnapshot as any)?.referrerRewardValue, 22, "future edits do not rewrite snapshot");

  await memory.db.update(appUsersTable).set({ emailVerifiedAt: now }).where(eq(appUsersTable.id, invited.id));
  await recordReferralEvent({ userId: invited.id, event: "email_verified", now });
  await approve(invited, "req-sender", now, { senderPhone: inviter.phone, proofHash: "same-proof" });
  const [risky] = await memory.db.select().from(referralAttributionsTable).where(eq(referralAttributionsTable.id, snapshot!.id));
  assert.equal(risky?.reviewStatus, "pending", "same sender phone is a review signal only");
  const editedSpecial = await updateSpecialReferralCode(special!.id, { code: "AHMED11", status: "active", label: "شريك محدّث", campaignId: low!.id, ownerUserId: inviter.id, commissionDue: 300 }, null, new Date(now.getTime() + 2));
  assert.equal(editedSpecial?.campaignId, low!.id, "special-code edit updates owner/campaign metadata for future attribution");
  assert.equal(editedSpecial?.code, "AHMED11", "special code itself may be changed after reserved/unique validation");
  const renamedInvitee = await user({ phone: "01092000023", email: "renamed-special@example.test", now, verified: false });
  const renamedAttempt = await attachReferralAtRegistration({ userId: renamedInvitee.id, email: renamedInvitee.email, phone: renamedInvitee.phone, code: "AHMED11", ip: "198.51.100.81", device: "renamed-special", now });
  assert.equal(renamedAttempt.attached, true, "the renamed code applies only to future attribution");
  const disabledSpecial = await updateSpecialReferralCode(special!.id, { status: "disabled" }, null, new Date(now.getTime() + 3));
  assert.equal(disabledSpecial?.status, "disabled");
  const disabledInvitee = await user({ phone: "01092000024", email: "disabled-special@example.test", now, verified: false });
  const disabledAttempt = await attachReferralAtRegistration({ userId: disabledInvitee.id, email: disabledInvitee.email, phone: disabledInvitee.phone, code: "AHMED11", ip: "198.51.100.82", device: "disabled-special", now });
  assert.equal(disabledAttempt.attached, false, "disabled special code rejects only future attribution");
  await archiveReferralCampaign(high!.id, null, new Date(now.getTime() + 4));
  const [history] = await memory.db.select().from(referralAttributionsTable).where(eq(referralAttributionsTable.id, snapshot!.id));
  assert.equal(history?.campaignId, high!.id, "archive never rewrites existing attribution history");
  assert.equal(history?.codeSnapshot, "AHMED10", "renaming preserves the historical code snapshot");
  const originalOrdinary = await ensureReferralCode(inviter.id, now);
  const regenerated = await setReferralUserProgramState(inviter.id, "regenerate_code", null, new Date(now.getTime() + 5));
  assert.equal(regenerated.status, "regenerated");
  assert.notEqual(regenerated.code, originalOrdinary.code, "regenerate retires the old normal link");
  assert.equal((await ensureReferralCode(inviter.id, new Date(now.getTime() + 6))).code, regenerated.code, "dashboard resolves the new active link rather than archived history");

  const nonAdmin = await api("/api/admin/referrals/settings", jar(inviter), { method: "PUT", body: JSON.stringify({ enabled: true, attributionCookieDays: 30, termsText: "x" }) });
  assert.ok(nonAdmin.response.status === 401 || nonAdmin.response.status === 403);
  const xss = await api("/api/admin/referrals/templates/friend_registered", adminJar, { method: "PUT", body: JSON.stringify({ channels: ["in_app"], titleTemplate: "<img src=x onerror=alert(1)> {{name}}", bodyTemplate: "<script>alert(1)</script>{{friend_name}}", status: "active" }) });
  assert.equal(xss.response.status, 200, xss.raw);
  assert.equal(String(xss.body?.template?.titleTemplate || "").includes("<"), false);
  assert.ok(low && high);
});

test("email verification gates trial rewards; Cairo schedule, caps and dashboard reporting remain durable", async () => {
  const now = new Date("2026-10-01T08:00:00.000Z");
  const capped = await setupCampaign(now, { name: "سقف شهري", priority: 500, qualificationEvent: "trial_started", holdDays: 0, maxReferrerMonthly: 1, maxReferrerTotal: 10 });
  const scheduled = await setupCampaign(now, { name: "نافذة القاهرة", priority: 600, startsAt: "2026-10-01T00:00", endsAt: "2026-10-03T00:00", qualificationEvent: "trial_started", holdDays: 0, maxReferrerMonthly: 10 });
  const inviter = await user({ phone: "01092000041", email: "cap-owner@example.test", now });
  const { adminReferralDashboard, recordReferralEvent } = await import("../lib/referrals");
  const one = await attach(inviter, "01092000042", "cap-one@example.test", new Date("2026-10-02T10:00:00.000Z"));
  const [scheduledAttribution] = await memory.db.select().from(referralAttributionsTable).where(eq(referralAttributionsTable.invitedUserId, one.invited.id));
  assert.equal(scheduledAttribution?.campaignId, scheduled!.id, "highest-priority in-window campaign wins in Cairo time");
  await recordReferralEvent({ userId: one.invited.id, event: "trial_started", now });
  assert.equal((await memory.db.select().from(referralRewardsTable).where(eq(referralRewardsTable.attributionId, one.result.attributionId!))).length, 0, "unverified email cannot earn a trial reward");
  assert.equal((await memory.db.select().from(referralAttributionsTable).where(eq(referralAttributionsTable.id, one.result.attributionId!)))[0]?.blockedReason, "email_not_verified", "qualification before confirmation is rejected automatically");
  const verifiedScheduled = await attach(inviter, "01092000045", "verified-window@example.test", new Date("2026-10-02T11:00:00.000Z"));
  await memory.db.update(appUsersTable).set({ emailVerifiedAt: now }).where(eq(appUsersTable.id, verifiedScheduled.invited.id));
  await recordReferralEvent({ userId: verifiedScheduled.invited.id, event: "email_verified", now });
  await recordReferralEvent({ userId: verifiedScheduled.invited.id, event: "trial_started", now });
  assert.equal((await memory.db.select().from(referralRewardsTable).where(and(eq(referralRewardsTable.attributionId, verifiedScheduled.result.attributionId!), eq(referralRewardsTable.recipientRole, "referrer"))))[0]?.status, "granted");

  const afterWindow = await attach(inviter, "01092000043", "after-window@example.test", new Date("2026-10-04T10:00:00.000Z"));
  const [afterWindowAttribution] = await memory.db.select().from(referralAttributionsTable).where(eq(referralAttributionsTable.invitedUserId, afterWindow.invited.id));
  assert.equal(afterWindowAttribution?.campaignId, capped!.id, "expired campaign cannot win attribution after its Cairo end");
  await memory.db.update(appUsersTable).set({ emailVerifiedAt: now }).where(eq(appUsersTable.id, afterWindow.invited.id));
  await recordReferralEvent({ userId: afterWindow.invited.id, event: "email_verified", now });
  await recordReferralEvent({ userId: afterWindow.invited.id, event: "trial_started", now });
  assert.equal((await memory.db.select().from(referralRewardsTable).where(and(eq(referralRewardsTable.attributionId, afterWindow.result.attributionId!), eq(referralRewardsTable.recipientRole, "referrer"))))[0]?.status, "granted");
  const overCap = await attach(inviter, "01092000044", "over-cap@example.test", new Date("2026-10-04T11:00:00.000Z"));
  await memory.db.update(appUsersTable).set({ emailVerifiedAt: now }).where(eq(appUsersTable.id, overCap.invited.id));
  await recordReferralEvent({ userId: overCap.invited.id, event: "email_verified", now });
  await recordReferralEvent({ userId: overCap.invited.id, event: "trial_started", now });
  const [cappedAttribution] = await memory.db.select().from(referralAttributionsTable).where(eq(referralAttributionsTable.id, overCap.result.attributionId!));
  assert.equal(cappedAttribution?.reviewReason, "monthly_cap");
  await recordReferralEvent({ userId: overCap.invited.id, event: "email_verified", now });
  const dashboard = await adminReferralDashboard(now);
  assert.ok(dashboard.referrers.some((row) => row.userId === inviter.id && row.invited >= 4 && row.granted >= 2), "admin funnel reports aggregated referrer counts without exposing invitee identities");
  const dashboardResponse = await api("/api/admin/referrals", adminJar);
  assert.equal(dashboardResponse.response.status, 200, dashboardResponse.raw);
  assert.ok(Array.isArray(dashboardResponse.body?.referrers));
});

test("public landing cookie is consumed only by a newly registered account", async () => {
  const now = new Date("2026-10-02T10:00:00.000Z");
  await setupCampaign(now);
  const inviter = await user({ phone: "01092000031", email: "landing-owner@example.test", now });
  const { ensureReferralCode } = await import("../lib/referrals");
  const code = await ensureReferralCode(inviter.id, now);
  const landing = await api(`/api/referrals/landing/${code.code}`);
  const unknownLanding = await api("/api/referrals/landing/DOESNOT1");
  assert.equal(landing.response.status, 200);
  assert.equal(unknownLanding.response.status, 200);
  assert.deepEqual(Object.keys(landing.body || {}).sort(), Object.keys(unknownLanding.body || {}).sort(), "landing response shape cannot reveal code validity");
  assert.equal(Object.prototype.hasOwnProperty.call(landing.body || {}, "available"), false);
  const setCookie = landing.response.headers.get("set-cookie") || "";
  assert.match(setCookie, /egytrend_referral=/);
  assert.doesNotMatch(unknownLanding.response.headers.get("set-cookie") || "", /egytrend_referral=/);
  const signup = await api("/api/user/register", { value: setCookie.split(";")[0] }, { method: "POST", body: JSON.stringify({ name: "مدعو رابط", phone: "01092000032", password: "ReferralPass1!", email: "landing-invitee@example.test" }) });
  assert.equal(signup.response.status, 201, signup.raw);
  assert.equal(signup.body?.referral?.attached, true);
  const userId = Number(signup.body?.user?.id);
  assert.equal((await memory.db.select().from(referralAttributionsTable).where(eq(referralAttributionsTable.invitedUserId, userId))).length, 1);
  const existing = await api("/api/user/register", { value: setCookie.split(";")[0] }, { method: "POST", body: JSON.stringify({ name: "موجود", phone: "01092000032", password: "ReferralPass1!", email: "other@example.test", referralCode: code.code }) });
  assert.equal(existing.response.status, 409, "existing accounts cannot be attributed after registration");
});
