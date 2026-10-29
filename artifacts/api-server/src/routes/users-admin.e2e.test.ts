import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { after, before, test } from "node:test";
import { eq } from "drizzle-orm";
import {
  appUsersTable,
  auditLogsTable,
  employeesTable,
  paymentRequestsTable,
  userSubscriptionsTable,
} from "@workspace/db/schema";
import { createMemoryDatabase } from "../test-support/memory-db";

/* In-process pg-mem database with synthetic data only. No DATABASE_URL, no
 * network listener, and no path to a real (Neon/Vercel) database. The app is
 * imported only after the test DB is injected. Covers TASK J stage 1:
 * professional user table (search/filter/sort/pagination), last-login stamp,
 * and guarded final account deletion. */
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
  try { body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null; } catch { /* non-JSON */ }
  return { response, body, raw };
}

async function adminLogin(email: string, password: string): Promise<CookieJar> {
  const jar: CookieJar = {};
  const r = await api("/api/admin/login", jar, { method: "POST", body: JSON.stringify({ email, password }) });
  assert.equal(r.response.status, 200, `admin login failed for ${email}`);
  return jar;
}

const SUPER_ADMIN = { email: "super.synthetic@example.test", password: "SuperSyntheticPass1!" };
const ADMIN = { email: "admin.synthetic@example.test", password: "AdminSyntheticPass1!" };
const SUPPORT = { email: "support.synthetic@example.test", password: "SupportSyntheticPass1!" };

let superJar: CookieJar;
let adminJar: CookieJar;
let supportJar: CookieJar;
let userOne: { id: number; phone: string; email: string };
let userTwo: { id: number; phone: string; email: string };
let userThree: { id: number; phone: string; email: string };
let staffLinkedId = 0;

before(async () => {
  memory = await createMemoryDatabase();
  (globalThis as typeof globalThis & { __egytrendTestDatabase?: typeof memory.db }).__egytrendTestDatabase = memory.db;

  await memory.db.insert(employeesTable).values([
    { name: "Synthetic Super Admin", email: SUPER_ADMIN.email, role: "super_admin", status: "active", passwordHash: employeePasswordHash(SUPER_ADMIN.password) },
    /* Explicit list WITHOUT "users": the role passes but the fine-grained
     * permission check must deny the users section. */
    { name: "Synthetic Admin", email: ADMIN.email, role: "admin", status: "active", passwordHash: employeePasswordHash(ADMIN.password), permissions: ["payments"] },
    /* No explicit list: role-only access, as in production for new staff. */
    { name: "Synthetic Support", email: SUPPORT.email, role: "support", status: "active", passwordHash: employeePasswordHash(SUPPORT.password) },
  ]);

  userOne = { phone: "01011111111", email: "sara.synthetic@example.test", id: 0 };
  userTwo = { phone: "01022222222", email: "omar.synthetic@example.test", id: 0 };
  userThree = { phone: "01033333333", email: "laila.synthetic@example.test", id: 0 };

  const [u1] = await memory.db.insert(appUsersTable).values({
    phone: userOne.phone, name: "Sara Synthetic", passwordHash: employeePasswordHash("SyntheticUserPass1!"), email: userOne.email,
  }).returning();
  userOne.id = u1.id;
  const [u2] = await memory.db.insert(appUsersTable).values({
    phone: userTwo.phone, name: "Omar Synthetic", passwordHash: employeePasswordHash("SyntheticUserPass1!"), email: userTwo.email,
  }).returning();
  userTwo.id = u2.id;
  const [u3] = await memory.db.insert(appUsersTable).values({
    phone: userThree.phone, name: "Laila Synthetic", passwordHash: employeePasswordHash("SyntheticUserPass1!"), email: userThree.email,
  }).returning();
  userThree.id = u3.id;
  /* A live PAID entitlement for Omar: deletion must refuse while it runs. */
  const inThirtyDays = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await memory.db.insert(userSubscriptionsTable).values({
    id: "sub-synthetic-omar",
    userId: userTwo.id,
    planKey: "vip-monthly",
    planNameAr: "باقة شهرية",
    planDurationMonths: 1,
    planFeatures: [],
    subscriptionType: "paid",
    status: "active",
    cycleId: "cycle-synthetic-omar-1",
    startsAt: new Date(),
    expiresAt: inThirtyDays,
    source: "payment",
  });
  /* Laila is banned (status filter target). */
  await memory.db.update(appUsersTable).set({ status: "banned" }).where(eq(appUsersTable.id, userThree.id));
  /* A staff-linked account row (the bridge namespace): out of scope for
     user-management deletion. */
  const [staff] = await memory.db.insert(appUsersTable).values({
    phone: "staff-99", name: "Staff Bridge Row", passwordHash: employeePasswordHash("unused"), email: null,
  }).returning();
  staffLinkedId = staff.id;
  /* Financial evidence that must survive Sara's deletion. */
  await memory.db.insert(paymentRequestsTable).values({
    id: "req-synthetic-keepme",
    phone: userOne.phone,
    name: "Sara Synthetic",
    planKey: "vip-monthly",
    payMethod: "vodafone",
    price: 137,
    tx: "keepme-transfer-001",
    status: "approved",
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

  superJar = await adminLogin(SUPER_ADMIN.email, SUPER_ADMIN.password);
  adminJar = await adminLogin(ADMIN.email, ADMIN.password);
  supportJar = await adminLogin(SUPPORT.email, SUPPORT.password);
});

after(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
  if (memory) await memory.close();
  delete (globalThis as typeof globalThis & { __egytrendTestDatabase?: typeof memory.db }).__egytrendTestDatabase;
});

test("successful login stamps last_login_at and the user table exposes email + last login", async () => {
  /* Sara has never logged in: the canonical login route stamps the column. */
  const jar: CookieJar = {};
  const login = await api("/api/user/login", jar, {
    method: "POST",
    body: JSON.stringify({ phone: userOne.phone, password: "SyntheticUserPass1!" }),
  });
  assert.equal(login.response.status, 200, "valid login should succeed");

  const [row] = await memory.db.select().from(appUsersTable).where(eq(appUsersTable.id, userOne.id));
  assert.ok(row?.lastLoginAt instanceof Date && row.lastLoginAt.getTime() > 0, "last_login_at must be stamped on successful login");

  const list = await api("/api/admin/users", superJar);
  assert.equal(list.response.status, 200);
  const users = (list.body?.users as Array<Record<string, unknown>>) || [];
  const sara = users.find((u) => u.id === userOne.id);
  assert.ok(sara, "Sara must be in the admin user list");
  assert.equal(sara?.email, userOne.email, "email must be exposed to the admin table");
  assert.ok(sara?.lastLoginAt, "lastLoginAt must be exposed to the admin table");
  assert.ok(sara?.createdAt, "createdAt must be exposed");
  assert.equal(typeof (list.body?.total as number), "number", "total count must be exposed for pagination");
  assert.equal(typeof (list.body?.totalPages as number), "number", "totalPages must be exposed");
});

test("server-side search, filter, sort and pagination", async () => {
  const byEmail = await api("/api/admin/users?q=sara.synthetic", superJar);
  assert.equal(byEmail.response.status, 200);
  const emailHits = (byEmail.body?.users as Array<Record<string, unknown>>) || [];
  assert.equal(emailHits.length, 1, "email search must match exactly Sara");
  assert.equal(emailHits[0]?.email, userOne.email);

  const byName = await api("/api/admin/users?q=Omar", superJar);
  const nameHits = ((byName.body?.users as Array<Record<string, unknown>>) || []).map((u) => u.id);
  assert.deepEqual(nameHits, [userTwo.id], "name search must match Omar");

  const banned = await api("/api/admin/users?status=banned", superJar);
  const bannedIds = ((banned.body?.users as Array<Record<string, unknown>>) || []).map((u) => u.id);
  assert.deepEqual(bannedIds, [userThree.id], "status filter must return only the banned user");

  const vip = await api("/api/admin/users?plan=vip", superJar);
  const vipIds = ((vip.body?.users as Array<Record<string, unknown>>) || []).map((u) => u.id);
  assert.deepEqual(vipIds, [userTwo.id], "plan filter must return only the live-VIP user");

  const sorted = await api("/api/admin/users?sort=name&dir=asc", superJar);
  const names = ((sorted.body?.users as Array<Record<string, unknown>>) || []).map((u) => u.name);
  assert.deepEqual(names, ["Laila Synthetic", "Omar Synthetic", "Sara Synthetic", "Staff Bridge Row"], "name ascending sort must be applied server-side");

  const page = await api("/api/admin/users?pageSize=2&page=2", superJar);
  assert.equal(page.response.status, 200);
  assert.equal((page.body?.users as unknown[]).length, 2, "page size must be honored");
  assert.equal(page.body?.total, 4, "total must count all matching users");
  assert.equal(page.body?.totalPages, 2, "totalPages must derive from total/pageSize");
});

test("authorization: no session 401; admin without users permission 403; support may view but not delete", async () => {
  const anon = await api("/api/admin/users", {});
  assert.equal(anon.response.status, 401, "anonymous access must be rejected");

  const deniedAdmin = await api("/api/admin/users", adminJar);
  assert.equal(deniedAdmin.response.status, 403, "admin role without the users permission must be denied");

  const supportView = await api("/api/admin/users", supportJar);
  assert.equal(supportView.response.status, 200, "support with role-only access may view users");

  const supportDelete = await api(`/api/admin/users/${userOne.id}/delete`, supportJar, {
    method: "POST",
    body: JSON.stringify({ confirm: userOne.phone }),
  });
  assert.equal(supportDelete.response.status, 403, "final delete is super_admin only");

  const adminDelete = await api(`/api/admin/users/${userOne.id}/delete`, adminJar, {
    method: "POST",
    body: JSON.stringify({ confirm: userOne.phone }),
  });
  assert.equal(adminDelete.response.status, 403, "a plain admin may not final-delete a user");
});

test("delete requires echoing the account's own phone number", async () => {
  const r = await api(`/api/admin/users/${userOne.id}/delete`, superJar, {
    method: "POST",
    body: JSON.stringify({ confirm: "01000000000" }),
  });
  assert.equal(r.response.status, 400, "wrong confirmation must be rejected before any change");
  const [still] = await memory.db.select().from(appUsersTable).where(eq(appUsersTable.id, userOne.id));
  assert.ok(still, "the account must remain untouched after a failed confirmation");
});

test("delete is blocked while a paid subscription is live and for staff-linked accounts", async () => {
  const paid = await api(`/api/admin/users/${userTwo.id}/delete`, superJar, {
    method: "POST",
    body: JSON.stringify({ confirm: userTwo.phone }),
  });
  assert.equal(paid.response.status, 409, "a live paid entitlement must block final deletion");
  const [stillOmar] = await memory.db.select().from(appUsersTable).where(eq(appUsersTable.id, userTwo.id));
  assert.ok(stillOmar, "Omar must remain while his subscription is live");

  const staff = await api(`/api/admin/users/${staffLinkedId}/delete`, superJar, {
    method: "POST",
    body: JSON.stringify({ confirm: "staff-99" }),
  });
  assert.equal(staff.response.status, 409, "staff-linked accounts are managed elsewhere");
  const [stillStaff] = await memory.db.select().from(appUsersTable).where(eq(appUsersTable.id, staffLinkedId));
  assert.ok(stillStaff, "the staff-linked row must remain");
});

test("final delete removes the account, preserves financial + audit records, and revokes sessions", async () => {
  /* Sara holds an open session from the first test's login path. */
  const jar: CookieJar = {};
  await api("/api/user/login", jar, {
    method: "POST",
    body: JSON.stringify({ phone: userOne.phone, password: "SyntheticUserPass1!" }),
  });
  const meBefore = await api("/api/user/me", jar);
  assert.equal(meBefore.response.status, 200, "precondition: Sara's session is live");

  const del = await api(`/api/admin/users/${userOne.id}/delete`, superJar, {
    method: "POST",
    body: JSON.stringify({ confirm: userOne.phone }),
  });
  assert.equal(del.response.status, 200, `delete should succeed: ${del.raw}`);
  assert.equal(del.body?.deleted, userOne.id);

  const [gone] = await memory.db.select().from(appUsersTable).where(eq(appUsersTable.id, userOne.id));
  assert.equal(gone, undefined, "the app_users row must be gone");

  const [keptPayment] = await memory.db.select().from(paymentRequestsTable).where(eq(paymentRequestsTable.phone, userOne.phone));
  assert.ok(keptPayment, "payment_requests must survive user deletion (financial evidence)");

  const auditRows = await memory.db.select().from(auditLogsTable).where(eq(auditLogsTable.action, "delete_user"));
  const audit = auditRows[0];
  assert.ok(audit, "a delete_user audit entry must exist");
  assert.equal(audit.target, `user:${userOne.id}`);

  const meAfter = await api("/api/user/me", jar);
  assert.equal(meAfter.response.status, 401, "the deleted user's open session must be revoked immediately");
});

test("ban through the legacy action endpoint still revokes open sessions", async () => {
  const jar: CookieJar = {};
  await api("/api/user/login", jar, {
    method: "POST",
    body: JSON.stringify({ phone: userTwo.phone, password: "SyntheticUserPass1!" }),
  });
  const meBefore = await api("/api/user/me", jar);
  assert.equal(meBefore.response.status, 200, "precondition: Omar's session is live");

  const ban = await api("/api/admin/users/action", superJar, {
    method: "POST",
    body: JSON.stringify({ action: "ban_user", phone: userTwo.phone, name: "Omar Synthetic" }),
  });
  assert.equal(ban.response.status, 200, `ban should succeed: ${ban.raw}`);

  const meAfter = await api("/api/user/me", jar);
  assert.equal(meAfter.response.status, 401, "a banned user's open session must be revoked immediately");
});
