import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { after, before, test } from "node:test";
import jwt from "jsonwebtoken";
import { eq } from "drizzle-orm";
import {
  appUsersTable,
  auditLogsTable,
  broadcastMessageUserStatesTable,
  employeesTable,
  userSubscriptionsTable,
} from "@workspace/db/schema";
import { createMemoryDatabase } from "../test-support/memory-db";
import { parseCairoDateTime } from "../lib/subscription-time";

let broadcastEffectiveState: typeof import("../lib/broadcasts").broadcastEffectiveState;

/* This test uses only pg-mem and a loopback test server. It never receives a
 * DATABASE_URL and cannot mutate a shared/production database. */
process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "broadcast-test-session-secret-not-for-deployment";
process.env.LOG_LEVEL = "silent";

type MemoryDatabase = Awaited<ReturnType<typeof createMemoryDatabase>>;
type CookieJar = { value?: string };
let memory: MemoryDatabase;
let server: http.Server;
let baseUrl = "";
let adminJar: CookieJar;
let freeUserJar: CookieJar;
let freeUserId = 0;

function passwordHash(password: string): string {
  const salt = "00112233445566778899aabbccddeeff";
  return `scrypt$${salt}$${crypto.scryptSync(password, salt, 64).toString("hex")}`;
}

async function api(path: string, jar: CookieJar = {}, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Origin", baseUrl);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (jar.value) headers.set("Cookie", jar.value);
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
  const raw = await response.text();
  let body: Record<string, unknown> | null = null;
  try { body = raw ? JSON.parse(raw) as Record<string, unknown> : null; } catch { /* binary/non-json response */ }
  return { response, body, raw };
}

function publishedPayload(overrides: Record<string, unknown> = {}) {
  return {
    title: "رسالة اختبار",
    contentMarkdown: "**مرحبًا** يا {{name}}\n\n- بند آمن\n- [تفاصيل](/vip)",
    messageType: "important",
    audience: "all",
    priority: 0,
    status: "published",
    startsAt: new Date(Date.now() - 60_000).toISOString(),
    endsAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    action: { kind: "link", label: "افتح VIP", url: "/vip" },
    ...overrides,
  };
}

async function createBroadcast(overrides: Record<string, unknown> = {}) {
  const result = await api("/api/admin/broadcasts", adminJar, {
    method: "POST",
    body: JSON.stringify(publishedPayload(overrides)),
  });
  assert.equal(result.response.status, 201, result.raw);
  assert.equal(result.body?.status, "ok");
  const id = String((result.body?.message as { id?: string } | undefined)?.id || "");
  assert.match(id, /^broadcast-/);
  return id;
}

before(async () => {
  memory = await createMemoryDatabase();
  (globalThis as typeof globalThis & { __egytrendTestDatabase?: typeof memory.db }).__egytrendTestDatabase = memory.db;

  const [employee] = await memory.db.insert(employeesTable).values({
    name: "Broadcast Admin",
    email: "broadcast.admin@example.test",
    role: "admin",
    status: "active",
    passwordHash: passwordHash("BroadcastAdminPass1!"),
    permissions: [],
  }).returning();
  const [user] = await memory.db.insert(appUsersTable).values({
    phone: "01022223333",
    email: "broadcast.user@example.test",
    name: "مستخدم اختبار",
    passwordHash: passwordHash("BroadcastUserPass1!"),
    plan: "free",
    status: "active",
    createdAt: new Date(),
    updatedAt: new Date(),
  }).returning();
  freeUserId = user.id;
  adminJar = {
    value: `et_admin_session=${jwt.sign({ sub: employee.id, name: employee.name, role: "admin", email: employee.email }, process.env.SESSION_SECRET!, { expiresIn: "1h" })}`,
  };
  freeUserJar = {
    value: `et_user_session=${jwt.sign({ sub: user.id, phone: user.phone, name: user.name, role: "user", plan: "free" }, process.env.SESSION_SECRET!, { expiresIn: "1h" })}`,
  };

  ({ broadcastEffectiveState } = await import("../lib/broadcasts"));
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
});

test("broadcast scheduling respects exact Cairo-derived start/end boundaries", () => {
  /* 2026 Cairo DST transition coverage: a bare datetime is interpreted by the
   * Cairo converter, then message activation compares only stored instants. */
  const start = parseCairoDateTime("2026-04-24T00:00");
  assert.ok(start, "Cairo datetime must parse");
  const end = new Date(start.getTime() + 60_000);
  const base = { status: "published", startsAt: start, endsAt: end, archivedAt: null } as const;
  assert.equal(broadcastEffectiveState(base, new Date(start.getTime() - 1)), "scheduled");
  assert.equal(broadcastEffectiveState(base, start), "active");
  assert.equal(broadcastEffectiveState(base, new Date(end.getTime() - 1)), "active");
  assert.equal(broadcastEffectiveState(base, end), "ended");
});

test("only a current server-side admin can create a broadcast", async () => {
  const denied = await api("/api/admin/broadcasts", freeUserJar, {
    method: "POST",
    body: JSON.stringify(publishedPayload()),
  });
  assert.ok(denied.response.status === 401 || denied.response.status === 403, denied.raw);

  const id = await createBroadcast({ audience: "guests", priority: 50, title: "<img src=x onerror=alert(1)> إعلان آمن", contentMarkdown: "<script>alert(1)</script> **نص آمن** [رابط خبيث](javascript:alert(1))" });
  const [audit] = await memory.db.select().from(auditLogsTable).where(eq(auditLogsTable.target, `broadcast:${id}`));
  assert.equal(audit?.action, "create_broadcast", "admin CRUD must be auditable");
});

test("image upload validates the declared type, signature and safe dimensions", async () => {
  const malformed = await api("/api/admin/broadcasts/media", adminJar, {
    method: "POST",
    body: JSON.stringify({ dataUrl: "data:image/png;base64,iVBORw0KGgo=" }),
  });
  assert.equal(malformed.response.status, 400);
  const validPng = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIW2Nk+M/wHwAF/gL+XOtj4QAAAABJRU5ErkJggg==";
  const accepted = await api("/api/admin/broadcasts/media", adminJar, {
    method: "POST",
    body: JSON.stringify({ dataUrl: validPng }),
  });
  assert.equal(accepted.response.status, 201, accepted.raw);
  assert.match(String((accepted.body?.media as { id?: string } | undefined)?.id || ""), /^broadcast-media-/);
});

test("sanitizes rich content and targets guest/free/VIP/expiring audiences on the server", async () => {
  const guest = await api("/api/broadcasts/active", {});
  assert.equal(guest.response.status, 200);
  const guestMessage = guest.body?.message as { title?: string; content?: unknown; audience?: string } | null;
  assert.equal(guestMessage?.audience, "guests");
  const serializedGuest = JSON.stringify(guestMessage);
  assert.equal(serializedGuest.includes("<"), false, "raw HTML cannot survive storage/render payload");
  assert.equal(serializedGuest.toLowerCase().includes("javascript:"), false, "unsafe links cannot survive the AST");

  const freeId = await createBroadcast({ audience: "free", priority: 60, title: "رسالة مجانية" });
  const freeActive = await api("/api/broadcasts/active", freeUserJar);
  assert.equal((freeActive.body?.message as { id?: string } | null)?.id, freeId, "free account cannot receive guest-only content");

  const freeClaim = await api(`/api/broadcasts/active/${encodeURIComponent(freeId)}/claim`, freeUserJar, { method: "POST", body: "{}" });
  assert.equal(freeClaim.response.status, 200);
  const secondClaim = await api(`/api/broadcasts/active/${encodeURIComponent(freeId)}/claim`, freeUserJar, { method: "POST", body: "{}" });
  assert.equal(secondClaim.response.status, 409, "a registered user must not claim/show the same message twice");
  const states = await memory.db.select().from(broadcastMessageUserStatesTable).where(eq(broadcastMessageUserStatesTable.messageId, freeId));
  assert.equal(states.length, 1, "DB uniqueness is the no-repeat source of truth");

  await memory.db.update(appUsersTable).set({ plan: "vip", vipExpiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000) }).where(eq(appUsersTable.id, freeUserId));
  const vipId = await createBroadcast({ audience: "vip", priority: 70, title: "رسالة VIP" });
  const vipActive = await api("/api/broadcasts/active", freeUserJar);
  assert.equal((vipActive.body?.message as { id?: string } | null)?.id, vipId, "VIP audience is resolved from server entitlement");
  assert.equal((await api(`/api/broadcasts/active/${encodeURIComponent(vipId)}/claim`, freeUserJar, { method: "POST", body: "{}" })).response.status, 200);

  const now = new Date();
  await memory.db.insert(userSubscriptionsTable).values({
    id: "broadcast-subscription-test",
    userId: freeUserId,
    planKey: "test-vip",
    planNameAr: "باقة اختبار",
    planDurationMonths: 1,
    planFeatures: [],
    status: "active",
    cycleId: "broadcast-cycle-test",
    startsAt: new Date(now.getTime() - 24 * 60 * 60 * 1000),
    expiresAt: new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000),
    source: "payment",
    updatedAt: now,
  });
  const expiringId = await createBroadcast({ audience: "expiring", priority: 80, title: "رسالة قرب الانتهاء" });
  const expiringActive = await api("/api/broadcasts/active", freeUserJar);
  assert.equal((expiringActive.body?.message as { id?: string } | null)?.id, expiringId, "expiring audience uses Cairo calendar days and server entitlement");
  assert.equal((await api(`/api/broadcasts/active/${encodeURIComponent(expiringId)}/claim`, freeUserJar, { method: "POST", body: "{}" })).response.status, 200);
  const newUserId = await createBroadcast({ audience: "new_users", priority: 90, title: "رسالة أول سبعة أيام" });
  const newUserActive = await api("/api/broadcasts/active", freeUserJar);
  assert.equal((newUserActive.body?.message as { id?: string } | null)?.id, newUserId, "new-user audience uses server account creation time");
});

test("marketing consent is explicit and stores an opt-in without enabling a mail campaign", async () => {
  const missingConfirmation = await api("/api/user/marketing-email", freeUserJar, {
    method: "PUT",
    body: JSON.stringify({ optIn: true, confirmation: false }),
  });
  assert.equal(missingConfirmation.response.status, 400);
  const optedIn = await api("/api/user/marketing-email", freeUserJar, {
    method: "PUT",
    body: JSON.stringify({ optIn: true, confirmation: true }),
  });
  assert.equal(optedIn.response.status, 200);
  assert.equal(optedIn.body?.mailSendingEnabled, false, "consent alone must not start a campaign");
  const [user] = await memory.db.select().from(appUsersTable).where(eq(appUsersTable.id, freeUserId));
  assert.equal(user?.marketingEmailOptIn, true);
  assert.ok(user?.marketingEmailOptedInAt);
});

test("coupon CTAs and campaign e-mail fail closed until real redemption/consent delivery exists", async () => {
  const coupon = await api("/api/admin/broadcasts", adminJar, {
    method: "POST",
    body: JSON.stringify(publishedPayload({ action: { kind: "coupon_apply", label: "خصم", couponCode: "NOPE" } })),
  });
  assert.equal(coupon.response.status, 400);
  assert.match(String(coupon.body?.message || ""), /الكوبونات/);

  const campaign = await api("/api/admin/broadcasts", adminJar, {
    method: "POST",
    body: JSON.stringify(publishedPayload({ marketingEmailRequested: true })),
  });
  assert.equal(campaign.response.status, 400);
  assert.match(String(campaign.body?.message || ""), /الإرسال الجماعي/);
});
