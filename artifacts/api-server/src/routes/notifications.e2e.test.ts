import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import jwt from "jsonwebtoken";
import { createMemoryDatabase } from "../test-support/memory-db";
import { __newsTest } from "./news";

/* Notification center end-to-end: per-account feed (list/read/delete are
 * strictly owner-scoped), delivery prefs, catalog-validated follows, the
 * scheduled news cycle through the REAL news pipeline (stubbed feed
 * fetcher), and cron authentication. In-process pg-mem; no repo data files
 * are touched (the real approved source inventory is embedded). */
process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "test-only-session-secret-not-for-deployment";
process.env.LOG_LEVEL = "silent";
process.env.MARKET_SNAPSHOT_CRON_SECRET = "notify-e2e-secret";

const CRON_SECRET = "notify-e2e-secret";
const phoneA = "01050000001";
const phoneB = "01050000002";

type MemoryDatabase = Awaited<ReturnType<typeof createMemoryDatabase>>;
let memory: MemoryDatabase;
let server: http.Server;
let baseUrl = "";
let cookieA = "";
let cookieB = "";

function sessionCookie(sub: number, phone: string, name: string, plan: string): string {
  return `et_user_session=${jwt.sign({ sub, phone, name, role: "user", plan }, process.env.SESSION_SECRET!, { expiresIn: "1h" })}`;
}

async function api(path: string, init: RequestInit = {}, cookie = "") {
  const headers = new Headers(init.headers);
  headers.set("Origin", baseUrl);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (cookie) headers.set("Cookie", cookie);
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
  const raw = await response.text();
  let body: Record<string, any> | null = null;
  try { body = raw ? JSON.parse(raw) : null; } catch { /* non-JSON only on failure paths */ }
  return { response, body, raw };
}

before(async () => {
  memory = await createMemoryDatabase();
  (globalThis as typeof globalThis & { __egytrendTestDatabase?: typeof memory.db }).__egytrendTestDatabase = memory.db;
  const { appUsersTable } = await import("@workspace/db/schema");
  const now = new Date();
  const [userA] = await memory.db
    .insert(appUsersTable)
    .values({ phone: phoneA, name: "مستخدم أ", email: null, emailVerifiedAt: null, passwordHash: "x", plan: "vip", vipExpiresAt: new Date(now.getTime() + 86_400_000), status: "active", createdAt: now, updatedAt: now })
    .returning({ id: appUsersTable.id });
  const [userB] = await memory.db
    .insert(appUsersTable)
    .values({ phone: phoneB, name: "مستخدم ب", email: null, emailVerifiedAt: null, passwordHash: "x", plan: "free", vipExpiresAt: null, status: "active", createdAt: now, updatedAt: now })
    .returning({ id: appUsersTable.id });
  cookieA = sessionCookie(userA.id, phoneA, "مستخدم أ", "vip");
  cookieB = sessionCookie(userB.id, phoneB, "مستخدم ب", "free");

  const { default: app } = await import("../app");
  server = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;

  /* Deterministic feed for every real (approved) source URL: one fresh story
   * about a followed stock, with a real pubDate and link. */
  __newsTest.setFeedFetcherForTest(async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <item>
    <title>البنك التجاري الدولي يرفع أسعار الفائدة على الإيداع</title>
    <link>http://example.test/egx-comi-1</link>
    <pubDate>${new Date(Date.now() - 10 * 60_000).toUTCString()}</pubDate>
    <description>خبر تجريبي حقيقي المصدر في بيئة الاختبار</description>
  </item>
  <item>
    <title>خبر عام عن السوق لا يخص أسهم محددة</title>
    <link>http://example.test/general-1</link>
    <pubDate>${new Date(Date.now() - 10 * 60_000).toUTCString()}</pubDate>
    <description>عام</description>
  </item>
</channel></rss>`;
    return new Response(xml, { status: 200, headers: { "content-type": "application/rss+xml; charset=utf-8" } });
  });
});

after(async () => {
  __newsTest.resetFeedFetcherForTest();
  if (server) {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
  if (memory) await memory.close();
  delete (globalThis as typeof globalThis & { __egytrendTestDatabase?: typeof memory.db }).__egytrendTestDatabase;
});

test("unauthenticated and unauthorized requests are rejected", async () => {
  for (const [path, init] of [
    ["/api/notifications", {}],
    ["/api/notifications/prefs", {}],
    ["/api/notifications/follows", {}],
    ["/api/notifications/read-all", { method: "POST" }],
    ["/api/notifications/abc123456789abcdef/read", { method: "POST" }],
    ["/api/notifications/abc123456789abcdef", { method: "DELETE" }],
    ["/api/notifications/prefs", { method: "PUT", body: JSON.stringify({ news: false }) }],
    ["/api/notifications/follows", { method: "PUT", body: JSON.stringify({ follows: ["COMI"] }) }],
  ] as Array<[string, RequestInit]>) {
    const res = await api(path, init);
    assert.equal(res.response.status, 401, `${path} should require login`);
  }
  // the scheduled cycle endpoint does not exist without the cron authorizations
  const getAnon = await api("/api/notifications/internal/run");
  assert.equal(getAnon.response.status, 404);
  const postAnon = await api("/api/notifications/internal/run", { method: "POST" });
  assert.equal(postAnon.response.status, 404);
  const postWrong = await api("/api/notifications/internal/run", { method: "POST", headers: { "x-cron-secret": "wrong" } });
  assert.equal(postWrong.response.status, 404);
});

test("follows sync is catalog-validated and per-account", async () => {
  const put = await api("/api/notifications/follows", { method: "PUT", body: JSON.stringify({ follows: ["COMI", "etel"] }) }, cookieA);
  assert.equal(put.response.status, 200, put.raw);
  assert.deepEqual(put.body?.follows, ["COMI", "ETEL"]);

  const listB = await api("/api/notifications/follows", {}, cookieB);
  assert.equal(listB.response.status, 200);
  assert.deepEqual(listB.body?.follows, []);

  const bad = await api("/api/notifications/follows", { method: "PUT", body: JSON.stringify({ follows: ["COMI", "NOTREAL"] }) }, cookieA);
  assert.equal(bad.response.status, 400);
  // rejected update leaves the previous set intact
  const still = await api("/api/notifications/follows", {}, cookieA);
  assert.deepEqual(still.body?.follows, ["COMI", "ETEL"]);
});

test("delivery prefs default on, persist, and reject bad payloads", async () => {
  const initial = await api("/api/notifications/prefs", {}, cookieB);
  assert.equal(initial.response.status, 200);
  assert.deepEqual(initial.body?.prefs, { price: true, opps: true, news: true });

  const off = await api("/api/notifications/prefs", { method: "PUT", body: JSON.stringify({ news: false }) }, cookieA);
  assert.equal(off.response.status, 200, off.raw);
  assert.deepEqual(off.body?.prefs, { price: true, opps: true, news: false });

  const recheck = await api("/api/notifications/prefs", {}, cookieA);
  assert.deepEqual(recheck.body?.prefs, { price: true, opps: true, news: false });

  const badType = await api("/api/notifications/prefs", { method: "PUT", body: JSON.stringify({ news: "yes" }) }, cookieA);
  assert.equal(badType.response.status, 400);
  const empty = await api("/api/notifications/prefs", { method: "PUT", body: JSON.stringify({}) }, cookieA);
  assert.equal(empty.response.status, 400);
  const unknown = await api("/api/notifications/prefs", { method: "PUT", body: JSON.stringify({ hack: true }) }, cookieA);
  assert.equal(unknown.response.status, 400);

  const restore = await api("/api/notifications/prefs", { method: "PUT", body: JSON.stringify({ news: true }) }, cookieA);
  assert.deepEqual(restore.body?.prefs, { price: true, opps: true, news: true });
});

test("news cycle (real pipeline) notifies only the user whose follows match", async () => {
  const run = await api("/api/notifications/internal/run", { method: "POST", headers: { "x-cron-secret": CRON_SECRET } });
  assert.equal(run.response.status, 200, run.raw);
  assert.equal(run.body?.status, "ok");
  assert.ok(run.body?.inserted >= 1, `expected at least one notification, got ${JSON.stringify(run.body)}`);
  assert.ok(run.body?.scanned >= 1);

  // user A (follows COMI + ETEL) got the COMI story, with source and time
  const feedA = await api("/api/notifications", {}, cookieA);
  assert.equal(feedA.response.status, 200);
  assert.equal(feedA.body?.status, "ok");
  const newsItems = (feedA.body?.notifications as Array<Record<string, any>> || []).filter((n) => n.kind === "news");
  assert.ok(newsItems.length >= 1, "A should have a news notification");
  const item = newsItems.find((n) => String(n.title).includes("البنك التجاري الدولي"))!;
  assert.ok(item, "the COMI story should be present for A");
  assert.match(String(item.body), /المصدر:/);
  assert.match(String(item.body), /يعني متابعتك: COMI/);
  assert.equal(item.actionUrl, null);
  assert.equal(item.read, false);
  assert.ok(feedA.body?.unread >= 1);

  // user B follows nothing: the same cycle must not have touched B
  const feedB = await api("/api/notifications", {}, cookieB);
  assert.equal(feedB.response.status, 200);
  assert.equal(feedB.body?.notifications?.length, 0);
  assert.equal(feedB.body?.unread, 0);
});

test("re-running the cycle never duplicates the same story", async () => {
  const beforeCount = (await api("/api/notifications", {}, cookieA)).body?.notifications as Array<Record<string, any>>;
  const run2 = await api("/api/notifications/internal/run", { method: "POST", headers: { "x-cron-secret": CRON_SECRET } });
  assert.equal(run2.response.status, 200, run2.raw);
  assert.equal(run2.body?.inserted, 0);
  const afterCount = (await api("/api/notifications", {}, cookieA)).body?.notifications as Array<Record<string, any>>;
  assert.equal(afterCount.length, beforeCount.length);
});

test("read / delete are owner-scoped (user B cannot touch user A's rows)", async () => {
  const feedA = (await api("/api/notifications", {}, cookieA)).body?.notifications as Array<Record<string, any>>;
  const item = feedA.find((n) => n.kind === "news")!;
  const id = String(item.id);
  assert.ok(id.startsWith("kn-"), "server-generated deterministic id");

  // B cannot mark it read or delete it
  const readByB = await api(`/api/notifications/${id}/read`, { method: "POST" }, cookieB);
  assert.equal(readByB.response.status, 404);
  const delByB = await api(`/api/notifications/${id}`, { method: "DELETE" }, cookieB);
  assert.equal(delByB.response.status, 404);
  // A can mark it read
  const readByA = await api(`/api/notifications/${id}/read`, { method: "POST" }, cookieA);
  assert.equal(readByA.response.status, 200);
  const afterRead = (await api("/api/notifications", {}, cookieA)).body;
  assert.ok(afterRead, "feed read after mark-read");
  assert.equal(afterRead.notifications.find((n: Record<string, any>) => n.id === id)?.read, true);
  // A can delete it
  const delByA = await api(`/api/notifications/${id}`, { method: "DELETE" }, cookieA);
  assert.equal(delByA.response.status, 200);
  const afterDelete = (await api("/api/notifications", {}, cookieA)).body;
  assert.ok(afterDelete, "feed read after delete");
  assert.equal(afterDelete.notifications.some((n: Record<string, any>) => n.id === id), false);
  // deleting again -> 404 (it is gone, not a silent success)
  const delAgain = await api(`/api/notifications/${id}`, { method: "DELETE" }, cookieA);
  assert.equal(delAgain.response.status, 404);
});

test("mark-all-read reports how many rows changed", async () => {
  const run = await api("/api/notifications/internal/run", { method: "POST", headers: { "x-cron-secret": CRON_SECRET } });
  assert.equal(run.response.status, 200);
  // cycle re-run is deduped (story already seen), so create nothing new;
  // B still has no rows — mark-all must be honest about that
  const resB = await api("/api/notifications/read-all", { method: "POST" }, cookieB);
  assert.equal(resB.response.status, 200);
  assert.equal(resB.body?.marked, 0);
});
