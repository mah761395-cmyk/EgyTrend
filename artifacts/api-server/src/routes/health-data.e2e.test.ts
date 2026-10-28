import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { after, before, test } from "node:test";
import jwt from "jsonwebtoken";
import { appUsersTable, dataQualityEventsTable, employeesTable } from "@workspace/db/schema";
import { createMemoryDatabase } from "../test-support/memory-db";

/* The admin data-quality drill-down uses a per-file pg-mem DB and a loopback
 * app. Telemetry rows are seeded directly: the fire-and-forget write path is
 * unit-tested separately in market-data/quality.test.ts. */
process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "health-data-test-session-secret-not-for-deployment";
process.env.REFERRAL_COOKIE_SECRET = "health-data-test-cookie-secret-not-for-deployment";
process.env.REFERRAL_SIGNAL_SECRET = "health-data-test-signal-secret-not-for-deployment";
process.env.LOG_LEVEL = "silent";

type Memory = Awaited<ReturnType<typeof createMemoryDatabase>>;
let memory: Memory;
let server: http.Server;
let baseUrl = "";
let adminJar: { value?: string } = {};
let userJar: { value?: string } = {};

function passwordHash(password: string): string {
  const salt = "ffeeddccbbaa99887766554433221100";
  return `scrypt$${salt}$${crypto.scryptSync(password, salt, 64).toString("hex")}`;
}

async function api(path: string, jar: { value?: string }, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Origin", baseUrl);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (jar.value) headers.set("Cookie", jar.value);
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
  const raw = await response.text();
  let body: Record<string, any> | null = null;
  try { body = raw ? JSON.parse(raw) : null; } catch { /* non-JSON only on failure */ }
  return { response, body, raw };
}

before(async () => {
  memory = await createMemoryDatabase();
  (globalThis as typeof globalThis & { __egytrendTestDatabase?: typeof memory.db }).__egytrendTestDatabase = memory.db;
  const [employee] = await memory.db.insert(employeesTable).values({
    name: "Health Admin",
    email: "health.admin@example.test",
    role: "admin",
    status: "active",
    passwordHash: passwordHash("HealthAdminPass1!"),
    permissions: [],
  }).returning();
  const [user] = await memory.db.insert(appUsersTable).values({
    phone: "01093100011",
    name: "مستخدم عام",
    email: "hd-user@example.test",
    emailVerifiedAt: new Date(),
    passwordHash: passwordHash("HealthUserPass1!"),
    plan: "free",
    status: "active",
    createdAt: new Date(),
    updatedAt: new Date(),
  }).returning();
  adminJar = {
    value: `et_admin_session=${jwt.sign({ sub: employee!.id, name: employee!.name, role: "admin", email: employee!.email }, process.env.SESSION_SECRET!, { expiresIn: "1h" })}`,
  };
  userJar = {
    value: `et_user_session=${jwt.sign({ sub: user!.id, phone: user!.phone, name: user!.name, role: "user", plan: "free" }, process.env.SESSION_SECRET!, { expiresIn: "1h" })}`,
  };
  /* Two rows share one incident (the one-alert-per-incident unit) and one row
   * is a different source/kind, so incident grouping is observable. */
  const now = Date.now();
  await memory.db.insert(dataQualityEventsTable).values([
    {
      sourceId: "trading-economics", kind: "fetch_failure",
      message: "upstream HTTP 503", latencyMs: 8000,
      incidentKey: "trading-economics:fetch_failure", recordedAt: new Date(now - 3600 * 1000),
    },
    {
      sourceId: "trading-economics", kind: "fetch_failure",
      message: "upstream HTTP 503", latencyMs: 8100,
      incidentKey: "trading-economics:fetch_failure", recordedAt: new Date(now - 1800 * 1000),
    },
    {
      sourceId: "dostor", kind: "future_dated",
      message: "3 item(s) with a future pubDate were treated as undated",
      incidentKey: "dostor:future_dated", recordedAt: new Date(now - 7200 * 1000),
    },
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
});

after(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  if (memory) await memory.close();
  delete (globalThis as typeof globalThis & { __egytrendTestDatabase?: typeof memory.db }).__egytrendTestDatabase;
});

test("the data-quality drill-down is admin-only and groups incidents", async () => {
  const anon = await api("/api/health/data", {});
  assert.ok([401, 403].includes(anon.response.status), `anonymous is rejected (got ${anon.response.status})`);

  const user = await api("/api/health/data", userJar);
  assert.equal(user.response.status, 403, "a regular user cannot open the drill-down");

  const admin = await api("/api/health/data", adminJar);
  assert.equal(admin.response.status, 200, admin.raw);
  assert.equal(admin.body?.status, "ok");
  assert.equal(admin.body?.eventCount, 3);
  assert.equal(admin.body?.incidents.length, 2, "rows group into per-incident summaries");
  assert.equal(admin.body.incidents[0].incidentKey, "trading-economics:fetch_failure");
  assert.equal(admin.body.incidents[0].count, 2, "one incident = one summary with a count");
  assert.equal(admin.body.incidents[0].kind, "fetch_failure");
  assert.ok(admin.body.incidents[0].firstSeenAt <= admin.body.incidents[0].lastSeenAt);
});

test("the drill-down lists events newest first and stays bounded", async () => {
  const admin = await api("/api/health/data?window=24h", adminJar);
  assert.equal(admin.response.status, 200, admin.raw);
  assert.equal(admin.body?.window, "24h");
  assert.ok(admin.body.events.length <= 200, "the event list is capped");
  for (let i = 1; i < admin.body.events.length; i += 1) {
    assert.ok(
      new Date(admin.body.events[i - 1].recordedAt) >= new Date(admin.body.events[i].recordedAt),
      "events are ordered newest first",
    );
  }
  /* The payload only ever carries the sanitized, bounded columns. */
  const payload = JSON.stringify(admin.body);
  for (const forbidden of ["password", "session_secret", "http://", "https://"]) {
    assert.ok(!payload.toLowerCase().includes(forbidden), `payload leaks ${forbidden}`);
  }
});
