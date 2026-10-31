/**
 * Contract test: GET /api/user/me tells the three failure modes apart with
 * the same gate contract every VIP route uses —
 *   401 — no (valid) session / no active user row   -> "log in"
 *   503 — session is valid, entitlement store hiccup -> "retry", never "log in"
 *
 * The 503 branch is the regression behind the reported "session ended after
 * a short time" symptom: a one-off store failure (serverless cold start,
 * pool warm-up) used to surface as an unhandled 500, and the client read any
 * non-OK /me as "logged out". A valid session must survive it.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { after, before, test } from "node:test";
import jwt from "jsonwebtoken";
import { eq } from "drizzle-orm";
import { appUsersTable } from "@workspace/db/schema";
import { createMemoryDatabase } from "../test-support/memory-db";

process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "me-contract-test-session-secret-not-for-deployment";
process.env.LOG_LEVEL = "silent";

type Memory = Awaited<ReturnType<typeof createMemoryDatabase>>;
let memory: Memory;
let server: http.Server;
let baseUrl = "";
let validCookie = "";

function passwordHash(password: string): string {
  const salt = "11223344556677889900aabbccddeeff";
  return `scrypt$${salt}$${crypto.scryptSync(password, salt, 64).toString("hex")}`;
}
async function api(path: string, init: RequestInit = {}, authenticated = true) {
  const headers = new Headers(init.headers);
  headers.set("Origin", baseUrl);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (authenticated) headers.set("Cookie", validCookie);
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
  const raw = await response.text();
  let body: Record<string, any> | null = null;
  try { body = raw ? JSON.parse(raw) : null; } catch { /* non-JSON only on failure paths */ }
  return { response, body, raw };
}

before(async () => {
  memory = await createMemoryDatabase();
  (globalThis as typeof globalThis & { __egytrendTestDatabase?: typeof memory.db }).__egytrendTestDatabase = memory.db;
  const now = new Date("2026-10-31T09:00:00.000Z");
  const [user] = await memory.db.insert(appUsersTable).values({
    phone: "01094000001", name: "مستخدم الجلسة", email: "me-contract@example.test", emailVerifiedAt: now,
    passwordHash: passwordHash("MeContractPass1!"), plan: "free", status: "active", createdAt: now, updatedAt: now,
  }).returning();
  validCookie = `et_user_session=${jwt.sign({ sub: user!.id, phone: user!.phone, name: user!.name, role: "user", plan: "free" }, process.env.SESSION_SECRET!, { expiresIn: "1h" })}`;
  const { default: app } = await import("../app");
  server = http.createServer(app);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
  const address = server.address(); assert.ok(address && typeof address !== "string"); baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  try { if (memory) await memory.close(); } catch { /* already closed by the store-hiccup test */ }
  delete (globalThis as typeof globalThis & { __egytrendTestDatabase?: unknown }).__egytrendTestDatabase;
});

test("no session -> 401 login required (never a 500)", async () => {
  const res = await api("/api/user/me", {}, false);
  assert.equal(res.response.status, 401);
  assert.equal(res.body?.message, "login required");
});

test("garbage token -> 401 login required", async () => {
  const res = await api("/api/user/me", { headers: { Cookie: "et_user_session=not-a-jwt" } }, false);
  assert.equal(res.response.status, 401);
  assert.equal(res.body?.message, "login required");
});

test("valid session on a free account -> 200 with the real plan (not VIP)", async () => {
  const res = await api("/api/user/me");
  assert.equal(res.response.status, 200, res.raw);
  assert.equal(res.body?.status, "ok");
  assert.equal(res.body?.user?.plan, "free");
  assert.equal(res.body?.user?.phone, "01094000001");
});

test("deleted/inactive user row -> 401 user not found", async () => {
  await memory.db.update(appUsersTable).set({ status: "deleted", updatedAt: new Date() }).where(eq(appUsersTable.phone, "01094000001"));
  const res = await api("/api/user/me");
  assert.equal(res.response.status, 401);
  assert.equal(res.body?.message, "user not found");
});

/* Last: the store itself fails. The session cookie is still cryptographically
 * valid — the endpoint must say 503 "retry", never 401 "session ended".
 * (pg-mem outlives pool.end(), so the hiccup is simulated by rejecting the
 * pool's query — the same failure class a cold-start pool failure throws.) */
test("valid session + store hiccup -> 503 server_error (not 401, not 500)", async () => {
  const client = (memory.db as unknown as { session: { client: { query: (...a: unknown[]) => Promise<unknown> } } }).session.client;
  client.query = () => Promise.reject(new Error("test: store unavailable"));
  const res = await api("/api/user/me");
  assert.equal(res.response.status, 503, `expected 503, got ${res.response.status}: ${res.raw}`);
  assert.equal(res.body?.status, "error");
  assert.equal(res.body?.message, "server_error");
});
