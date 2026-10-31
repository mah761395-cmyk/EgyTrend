import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { after, before, test } from "node:test";
import { getDataDir } from "../lib/dataStore";
import { createMemoryDatabase } from "../test-support/memory-db";
import { __newsTest } from "./news";

/* TASK J stage 2 — news source management: operational enable/disable,
 * real connection probes, honest per-source health, edit/archive, and source
 * isolation. In-process pg-mem for auth; the dataStore JSON files are
 * snapshotted and restored so the repo's real source inventory is untouched. */
process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "test-only-session-secret-not-for-deployment";
process.env.LOG_LEVEL = "silent";

type MemoryDatabase = Awaited<ReturnType<typeof createMemoryDatabase>>;
let memory: MemoryDatabase;
let server: http.Server;
let baseUrl = "";

/* Snapshot/restore whatever directory the dataStore actually uses (the test
 * harness points EGYTREND_DATA_DIR at a per-run scratch dir; this keeps the
 * repo's tracked data files untouched in either mode). */
const SOURCES_FILE = path.join(getDataDir(), "sources.json");
const ARTICLES_FILE = path.join(getDataDir(), "articles.json");
let sourcesBackup: string | null = null;
let articlesBackup: string | null = null;

/* The store's own saves are atomic (tmp + rename); mirror that idiom for the
 * test restore so a concurrent reader can never observe a torn file. null
 * means the file did not exist before this run (fresh scratch dir) and must
 * not be (re)created on restore. */
function restoreAtomically(file: string, backup: string | null): void {
  if (backup === null) {
    if (fs.existsSync(file)) fs.rmSync(file);
    return;
  }
  const tmp = `${file}.e2e-restore-${process.pid}`;
  fs.writeFileSync(tmp, backup, "utf8");
  fs.renameSync(tmp, file);
}

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

const SUPER_ADMIN = { email: "super.news@example.test", password: "SuperNewsPass1!" };
const EDITOR = { email: "editor.news@example.test", password: "EditorNewsPass1!" };
let superJar: CookieJar;
let editorJar: CookieJar;

const RSS_OK = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <item><title>Synthetic headline one</title><link>http://example.test/a</link><pubDate>Tue, 28 Oct 2026 10:00:00 GMT</pubDate><description>excerpt one</description></item>
  <item><title>Synthetic headline two</title><link>http://example.test/b</link><pubDate>Tue, 28 Oct 2026 09:00:00 GMT</pubDate><description>excerpt two</description></item>
  <item><title>Synthetic headline three</title><link>http://example.test/c</link><pubDate>Tue, 28 Oct 2026 08:00:00 GMT</pubDate><description>excerpt three</description></item>
</channel></rss>`;
const RSS_EMPTY = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel></channel></rss>`;

type FakeFetch = (url: string, init?: RequestInit) => Promise<Response>;

function adminLogin(jar: CookieJar, email: string, password: string) {
  return api("/api/admin/login", jar, { method: "POST", body: JSON.stringify({ email, password }) });
}

function inventoryIds(body: Record<string, unknown> | null): string[] {
  return (((body?.sources as Array<{ id?: string }>) || []).map((s) => s.id ?? "")).sort();
}

before(async () => {
  sourcesBackup = fs.existsSync(SOURCES_FILE) ? fs.readFileSync(SOURCES_FILE, "utf8") : null;
  articlesBackup = fs.existsSync(ARTICLES_FILE) ? fs.readFileSync(ARTICLES_FILE, "utf8") : null;

  memory = await createMemoryDatabase();
  (globalThis as typeof globalThis & { __egytrendTestDatabase?: typeof memory.db }).__egytrendTestDatabase = memory.db;
  const { employeesTable } = await import("@workspace/db/schema");
  await memory.db.insert(employeesTable).values([
    { name: "Synthetic Super", email: SUPER_ADMIN.email, role: "super_admin", status: "active", passwordHash: employeePasswordHash(SUPER_ADMIN.password) },
    { name: "Synthetic Editor", email: EDITOR.email, role: "editor", status: "active", passwordHash: employeePasswordHash(EDITOR.password), permissions: ["content"] },
  ]);

  const { default: app } = await import("../app");
  server = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;

  superJar = {};
  editorJar = {};
  const s = await adminLogin(superJar, SUPER_ADMIN.email, SUPER_ADMIN.password);
  assert.equal(s.response.status, 200);
  const e = await adminLogin(editorJar, EDITOR.email, EDITOR.password);
  assert.equal(e.response.status, 200);
});

after(async () => {
  __newsTest.resetFeedFetcherForTest();
  restoreAtomically(SOURCES_FILE, sourcesBackup);
  restoreAtomically(ARTICLES_FILE, articlesBackup);
  await new Promise((r) => setTimeout(r, 200)); /* let the dataStore watcher settle on the restored files */
  if (server) {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
  if (memory) await memory.close();
  delete (globalThis as typeof globalThis & { __egytrendTestDatabase?: typeof memory.db }).__egytrendTestDatabase;
});

/* Approve a source in the on-disk JSON (legal review simulation for tests)
 * and wait for the dataStore file watcher to reload the cache. */
async function approveSourceInFile(id: string): Promise<void> {
  const data = JSON.parse(fs.readFileSync(SOURCES_FILE, "utf8")) as Record<string, Record<string, unknown>>;
  data[id] = {
    ...data[id],
    disabled: false,
    commercialRedisplay: {
      status: "approved",
      reviewedAt: new Date().toISOString(),
      evidence: "Synthetic test approval: headline-only display with link-back.",
    },
  };
  fs.writeFileSync(SOURCES_FILE, JSON.stringify(data, null, 2), "utf8");
  await new Promise((r) => setTimeout(r, 400));
}

test("inventory is admin-visible; unauthenticated requests are rejected", async () => {
  const anon = await api("/api/admin/sources", {});
  assert.equal(anon.response.status, 401);

  const list = await api("/api/admin/sources", superJar);
  assert.equal(list.response.status, 200);
  const ids = inventoryIds(list.body);
  assert.ok(ids.length >= 19, "real approved inventory visible to admins");
  assert.ok(!ids.includes("synthetic-feed-1"), "synthetic sources start absent");
});

test("editor can add a source; it starts pending-legal and is not fetched", async () => {
  const created = await api("/api/admin/sources", editorJar, {
    method: "POST",
    body: JSON.stringify({
      id: "synthetic-feed-1",
      name: "Synthetic Feed",
      icon: "🧪",
      lang: "ar",
      cat: "egypt",
      color: "#22c55e",
      url: "http://rss.synthetic.test/feed.xml",
    }),
  });
  assert.equal(created.response.status, 200, `create should succeed: ${created.raw}`);

  const list = await api("/api/admin/sources", superJar);
  const src = ((list.body?.sources as Array<Record<string, unknown>>) || []).find((s) => s.id === "synthetic-feed-1");
  assert.ok(src, "source appears in the admin inventory");
  assert.equal((src?.commercialRedisplay as { status?: string })?.status, "pending", "admin-created feeds start pending legal review");

  const publicList = await api("/api/news/sources", {});
  const publicIds = (((publicList.body?.sources as Array<{ id?: string }>) || []).map((s) => s.id));
  assert.ok(!publicIds.includes("synthetic-feed-1"), "pending-legal source is never advertised publicly");

  const fetchAttempt = await api("/api/news?source=synthetic-feed-1", {});
  assert.equal(fetchAttempt.response.status, 404, "pending-legal source is never fetched");
});

test("editor can edit metadata but not change the id or touch the legal review", async () => {
  const edited = await api("/api/admin/sources/synthetic-feed-1", editorJar, {
    method: "PUT",
    body: JSON.stringify({ name: "Synthetic Feed (updated)", color: "#0ea5e9" }),
  });
  assert.equal(edited.response.status, 200, `edit should succeed: ${edited.raw}`);
  const src = (edited.body?.source as Record<string, unknown>) || {};
  assert.equal(src.name, "Synthetic Feed (updated)");
  assert.equal(src.url, "http://rss.synthetic.test/feed.xml", "untouched fields survive the edit");

  const renameId = await api("/api/admin/sources/synthetic-feed-1", editorJar, {
    method: "PUT",
    body: JSON.stringify({ id: "other-id" }),
  });
  assert.equal(renameId.response.status, 400, "id change must be rejected");
});

test("operational stop/enable is admin-only and takes effect immediately", async () => {
  const editorTries = await api("/api/admin/sources/synthetic-feed-1/set-disabled", editorJar, {
    method: "POST",
    body: JSON.stringify({ disabled: true }),
  });
  assert.equal(editorTries.response.status, 403, "editor cannot stop a source");

  const disable = await api("/api/admin/sources/synthetic-feed-1/set-disabled", superJar, {
    method: "POST",
    body: JSON.stringify({ disabled: true }),
  });
  assert.equal(disable.response.status, 200);
  const list = await api("/api/admin/sources", superJar);
  const src = ((list.body?.sources as Array<Record<string, unknown>>) || []).find((s) => s.id === "synthetic-feed-1");
  assert.equal(src?.disabled, true, "disabled flag persisted in inventory");

  const enable = await api("/api/admin/sources/synthetic-feed-1/set-disabled", superJar, {
    method: "POST",
    body: JSON.stringify({ disabled: false }),
  });
  assert.equal(enable.response.status, 200);
});

test("connection probe: real fetch + data validity, with result timestamp", async () => {
  const editorTries = await api("/api/admin/sources/synthetic-feed-1/test", editorJar, {
    method: "POST",
    body: "{}",
  });
  assert.equal(editorTries.response.status, 403, "editor cannot probe sources");

  __newsTest.setFeedFetcherForTest(async () => new Response(RSS_OK, { status: 200 }));
  const ok = await api("/api/admin/sources/synthetic-feed-1/test", superJar, { method: "POST", body: "{}" });
  assert.equal(ok.response.status, 200, `probe should succeed: ${ok.raw}`);
  const okResult = (ok.body?.result as Record<string, unknown>) || {};
  assert.equal(okResult.ok, true);
  assert.equal(okResult.itemCount, 3);
  assert.equal(okResult.firstTitle, "Synthetic headline one");
  assert.ok(Number.isFinite(Date.parse(String(okResult.testedAt))), "probe result carries its own timestamp");

  __newsTest.setFeedFetcherForTest(async () => new Response("boom", { status: 500 }));
  const bad = await api("/api/admin/sources/synthetic-feed-1/test", superJar, { method: "POST", body: "{}" });
  const badResult = (bad.body?.result as Record<string, unknown>) || {};
  assert.equal(badResult.ok, false, "a 500 upstream must be reported as a failed probe");
  assert.match(String(badResult.error), /500/, "failure reason surfaced");

  __newsTest.setFeedFetcherForTest(async () => new Response(RSS_EMPTY, { status: 200 }));
  const empty = await api("/api/admin/sources/synthetic-feed-1/test", superJar, { method: "POST", body: "{}" });
  const emptyResult = (empty.body?.result as Record<string, unknown>) || {};
  assert.equal(emptyResult.ok, false, "an empty feed is a failed data-validity probe, not a success");
});

test("live fetch records honest health; sources stay isolated from each other", async () => {
  /* Make three synthetic sources legally approved in the on-disk JSON. */
  for (const id of ["synthetic-feed-1", "synthetic-feed-2", "synthetic-feed-3"]) {
    if (id !== "synthetic-feed-1") {
      const created = await api("/api/admin/sources", editorJar, {
        method: "POST",
        body: JSON.stringify({
          id,
          name: `Synthetic ${id}`,
          icon: "🧪",
          lang: "ar",
          cat: "egypt",
          color: "#22c55e",
          url: `http://rss.synthetic.test/${id}.xml`,
        }),
      });
      assert.equal(created.response.status, 200);
    }
    await approveSourceInFile(id);
  }

  const publicList = await api("/api/news/sources", {});
  const publicIds = (((publicList.body?.sources as Array<{ id?: string }>) || []).map((s) => s.id));
  for (const id of ["synthetic-feed-1", "synthetic-feed-2", "synthetic-feed-3"]) {
    assert.ok(publicIds.includes(id), `${id} advertised once approved + enabled`);
  }

  /* Feed 1 healthy, feed 2 hard failure, feed 3 empty — each behaves alone. */
  /* Route by the exact feed URLs: feed-1 was created with /feed.xml. */
  __newsTest.setFeedFetcherForTest((async (url: string) => {
    if (url === "http://rss.synthetic.test/feed.xml") return new Response(RSS_OK, { status: 200 });
    if (url.includes("synthetic-feed-2")) throw new Error("synthetic upstream timeout");
    return new Response(RSS_EMPTY, { status: 200 });
  }) as FakeFetch);

  const okFeed = await api("/api/news?source=synthetic-feed-1", {});
  assert.equal(okFeed.response.status, 200, "healthy source serves items");
  assert.equal(((okFeed.body?.items as unknown[]) || []).length, 3);

  const badFeed = await api("/api/news?source=synthetic-feed-2", {});
  assert.equal(badFeed.response.status, 502, "one source's failure returns 502 for that source only");

  const emptyFeed = await api("/api/news?source=synthetic-feed-3", {});
  assert.equal(emptyFeed.response.status, 200);
  assert.equal(((emptyFeed.body?.items as unknown[]) || []).length, 0, "empty feed is honest: 200 with zero items");

  const list = await api("/api/admin/sources", superJar);
  const sources = (list.body?.sources as Array<Record<string, unknown>>) || [];
  const h1 = (sources.find((s) => s.id === "synthetic-feed-1")?.health as Record<string, unknown>) || {};
  const h2 = (sources.find((s) => s.id === "synthetic-feed-2")?.health as Record<string, unknown>) || {};
  const h3 = (sources.find((s) => s.id === "synthetic-feed-3")?.health as Record<string, unknown>) || {};
  assert.ok(h1.lastSuccessAt, "healthy source records lastSuccessAt");
  assert.equal(h1.consecutiveFailures, 0);
  assert.equal(h1.itemsFetched, 3, "fetched items counted");
  assert.ok(h2.lastError, "failing source records lastError");
  assert.equal(h2.consecutiveFailures, 1, "failure counted");
  assert.ok(!h2.lastSuccessAt, "a never-succeeded source has no lastSuccessAt (no fake green)");
  assert.ok(h3.lastError, "empty feed recorded as a data-validity failure");
  assert.equal(h3.consecutiveFailures, 1);

  /* Stopping one source never stops the others. */
  await api("/api/admin/sources/synthetic-feed-1/set-disabled", superJar, { method: "POST", body: JSON.stringify({ disabled: true }) });
  const publicAfter = await api("/api/news/sources", {});
  const publicIdsAfter = (((publicAfter.body?.sources as Array<{ id?: string }>) || []).map((s) => s.id));
  assert.ok(!publicIdsAfter.includes("synthetic-feed-1"), "disabled source removed from the public list");
  assert.ok(publicIdsAfter.includes("synthetic-feed-2") && publicIdsAfter.includes("synthetic-feed-3"), "the others keep working");
  const deadFetch = await api("/api/news?source=synthetic-feed-1", {});
  assert.equal(deadFetch.response.status, 404, "disabled source is no longer fetchable");
});

test("archive keeps the entry for admin review and never destroys it", async () => {
  const del = await api("/api/admin/sources/synthetic-feed-2", superJar, { method: "DELETE" });
  assert.equal(del.response.status, 200, `archive should succeed: ${del.raw}`);

  const list = await api("/api/admin/sources", superJar);
  const src = ((list.body?.sources as Array<Record<string, unknown>>) || []).find((s) => s.id === "synthetic-feed-2");
  assert.ok(src, "archived source remains in the admin inventory");
  assert.ok(src?.archivedAt, "archivedAt marker set");

  const publicList = await api("/api/news/sources", {});
  const publicIds = (((publicList.body?.sources as Array<{ id?: string }>) || []).map((s) => s.id));
  assert.ok(!publicIds.includes("synthetic-feed-2"), "archived source not advertised");

  const editArchived = await api("/api/admin/sources/synthetic-feed-2", editorJar, {
    method: "PUT",
    body: JSON.stringify({ name: "nope" }),
  });
  assert.equal(editArchived.response.status, 409, "archived sources cannot be edited into life");
});
