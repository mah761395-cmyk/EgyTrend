import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { after, before, test } from "node:test";
import { employeesTable } from "@workspace/db/schema";
import { createMemoryDatabase } from "../test-support/memory-db";

/* In-process pg-mem. Covers the public coupon-validate endpoint:
 * it is an unauthenticated oracle over human-readable coupon codes, so it
 * MUST be rate-limited per IP (10 / 5 min) — otherwise coupon codes can be
 * brute-force enumerated at unlimited speed. */
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

async function api(path: string, jar: CookieJar = {}, init: RequestInit = {}) {
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

const ADMIN = { email: "admin.coupon@example.test", password: "CouponAdminSyn1!" };
let adminJar: CookieJar;

before(async () => {
  memory = await createMemoryDatabase();
  (globalThis as typeof globalThis & { __egytrendTestDatabase?: typeof memory.db }).__egytrendTestDatabase = memory.db;
  await memory.db.insert(employeesTable).values([
    { name: "Coupon Admin", email: ADMIN.email, role: "super_admin", status: "active", passwordHash: employeePasswordHash(ADMIN.password) },
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
  adminJar = {};
  const r = await api("/api/admin/login", adminJar, { method: "POST", body: JSON.stringify({ email: ADMIN.email, password: ADMIN.password }) });
  assert.equal(r.response.status, 200, `login failed: ${r.raw}`);
});

after(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
  if (memory) await memory.close();
  delete (globalThis as typeof globalThis & { __egytrendTestDatabase?: typeof memory.db }).__egytrendTestDatabase;
});

test("public validate works for a real coupon, then 429s beyond the per-IP budget", async () => {
  const created = await api("/api/admin/coupons", adminJar, {
    method: "POST",
    body: JSON.stringify({ code: "SMOKE10", discountType: "percent", discountValue: 10 }),
  });
  assert.equal(created.response.status, 200, `coupon create failed: ${created.raw}`);

  /* The endpoint is public (checkout validates before login). */
  const anon: CookieJar = {};
  const valid = await api("/api/admin/coupons/validate", anon, { method: "POST", body: JSON.stringify({ code: "SMOKE10" }) });
  assert.equal(valid.response.status, 200, `valid coupon rejected: ${valid.raw}`);
  assert.equal((valid.body?.coupon as { discountValue?: number })?.discountValue, 10);

  const missing = await api("/api/admin/coupons/validate", anon, { method: "POST", body: JSON.stringify({ code: "NOPE999" }) });
  assert.equal(missing.response.status, 404);

  /* 10 calls / 5 min per IP: the first two calls above consumed budget, so
   * the next 8 succeed (404s still count) and the 11th is throttled. */
  let last: number = 0;
  for (let i = 0; i < 8; i++) {
    const r = await api("/api/admin/coupons/validate", anon, { method: "POST", body: JSON.stringify({ code: `FILLER${i}` }) });
    last = r.response.status;
    assert.notEqual(r.response.status, 429, `call ${i + 3} should still be within budget`);
  }
  assert.equal(last, 404, "unknown codes stay 404 within budget");

  const throttled = await api("/api/admin/coupons/validate", anon, { method: "POST", body: JSON.stringify({ code: "SMOKE10" }) });
  assert.equal(throttled.response.status, 429, "budget exhaustion returns 429, not another oracle hit");
});
