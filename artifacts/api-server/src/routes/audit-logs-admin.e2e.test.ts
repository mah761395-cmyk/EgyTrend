import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { after, before, test } from "node:test";
import {
  appUsersTable,
  employeesTable,
} from "@workspace/db/schema";
import { createMemoryDatabase } from "../test-support/memory-db";

/* In-process pg-mem with synthetic data only. Covers TASK J stage 5:
 * the audit-log surface — server-side admin-only access, coverage of the
 * operations that matter (user ban/unban/delete, AI settings, AI provider
 * disables), result/reason detail payloads, dynamic action meta, search and
 * filters, deletion-retention guarantees, and the absence of ANY mutation
 * endpoint on the audit log itself (no uncontrolled deletion).
 *
 * A synthetic GEMINI key is set so ai-provider operations resolve to a
 * configured provider; the key value must NEVER leak into audit detail or
 * the serialized log list. */
process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "test-only-session-secret-not-for-deployment";
process.env.LOG_LEVEL = "silent";
const SYNTHETIC_GEMINI_KEY = "synthetic-gemini-key-XYZ-123-audit";
process.env.GEMINI_API_KEY = SYNTHETIC_GEMINI_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY;

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

const SUPER_ADMIN = { email: "super.audit@example.test", name: "Audit E2E Super", password: "SuperAuditSynth1!" };
const ADMIN = { email: "admin.audit@example.test", name: "Audit E2E Admin", password: "AdminAuditSynth1!" };
const SUPPORT = { email: "support.audit@example.test", name: "Audit E2E Support", password: "SupportAuditSynth1!" };

let superJar: CookieJar;
let adminJar: CookieJar;
let supportJar: CookieJar;
const BAN_PHONE = "20100001234";

type LogRow = Record<string, unknown>;

function findLog(logs: LogRow[], action: string, targetIncludes?: string): LogRow {
  const hits = logs.filter((l) => l.action === action && (targetIncludes ? String(l.target).includes(targetIncludes) : true));
  assert.ok(hits.length > 0, `expected an audit log for action=${action}${targetIncludes ? ` target~${targetIncludes}` : ""}`);
  return hits[0];
}

before(async () => {
  memory = await createMemoryDatabase();
  (globalThis as typeof globalThis & { __egytrendTestDatabase?: typeof memory.db }).__egytrendTestDatabase = memory.db;

  await memory.db.insert(employeesTable).values([
    { name: SUPER_ADMIN.name, email: SUPER_ADMIN.email, role: "super_admin", status: "active", passwordHash: employeePasswordHash(SUPER_ADMIN.password) },
    { name: ADMIN.name, email: ADMIN.email, role: "admin", status: "active", passwordHash: employeePasswordHash(ADMIN.password) },
    { name: SUPPORT.name, email: SUPPORT.email, role: "support", status: "active", passwordHash: employeePasswordHash(SUPPORT.password) },
  ]);
  await memory.db.insert(appUsersTable).values({
    phone: BAN_PHONE,
    name: "Audit Ban Target",
    passwordHash: employeePasswordHash("target-pass-1!"),
    plan: "free",
    status: "active",
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
  delete process.env.GEMINI_API_KEY;
  if (memory) await memory.close();
  delete (globalThis as typeof globalThis & { __egytrendTestDatabase?: typeof memory.db }).__egytrendTestDatabase;
});

test("audit logs are admin-only: 401 unauthenticated, 403 support, 200 admin", async () => {
  const anon = await api("/api/admin/audit-logs", {});
  assert.equal(anon.response.status, 401);

  const support = await api("/api/admin/audit-logs", supportJar);
  assert.equal(support.response.status, 403);

  const ok = await api("/api/admin/audit-logs", adminJar);
  assert.equal(ok.response.status, 200);
  assert.equal(ok.body?.status, "ok");
  assert.ok(Array.isArray(ok.body?.logs), "logs is an array");
  assert.ok(Array.isArray(ok.body?.actions), "actions meta is an array");
  assert.ok(typeof ok.body?.total === "number", "total is a number");
});

test("action meta is populated from real logs (login appears after our logins)", async () => {
  const r = await api("/api/admin/audit-logs", adminJar);
  const actions = (r.body?.actions as Array<{ action: string; count: number }>) || [];
  const login = actions.find((a) => a.action === "login");
  assert.ok(login, "login action present in meta");
  assert.ok(login.count >= 3, "meta counts reflect the three logins");
});

test("user ban/unban are audited with actor, role and target", async () => {
  const ban = await api("/api/admin/users/action", adminJar, { method: "POST", body: JSON.stringify({ action: "ban_user", phone: BAN_PHONE }) });
  assert.equal(ban.response.status, 200, `ban failed: ${ban.raw}`);

  const r = await api(`/api/admin/audit-logs?action=ban_user`, adminJar);
  const hit = findLog((r.body?.logs as LogRow[]) || [], "ban_user");
  assert.ok(hit, "ban_user row present");
  assert.equal(hit.actorName, ADMIN.name);
  assert.equal(hit.actorRole, "admin");
  assert.ok(String(hit.target).startsWith("user:"), `target is user:<id>, got ${hit.target}`);
  assert.ok(hit.createdAt, "createdAt present");

  const unban = await api("/api/admin/users/action", adminJar, { method: "POST", body: JSON.stringify({ action: "unban_user", phone: BAN_PHONE }) });
  assert.equal(unban.response.status, 200);
  const r2 = await api(`/api/admin/audit-logs?action=unban_user`, adminJar);
  assert.ok(((r2.body?.logs as LogRow[]) || []).length >= 1, "unban_user row present");
});

test("AI settings + provider disable are audited with result detail — and never with key material", async () => {
  const cfg = await api("/api/admin/ai-config", adminJar, { method: "PUT", body: JSON.stringify({ analyzerEnabled: false }) });
  assert.equal(cfg.response.status, 200, `ai-config update failed: ${cfg.raw}`);

  const dis = await api("/api/admin/ai-providers/gemini/set-disabled", adminJar, { method: "POST", body: JSON.stringify({ disabled: true }) });
  assert.equal(dis.response.status, 200, `set-disabled failed: ${dis.raw}`);

  const r = await api("/api/admin/audit-logs", adminJar);
  const logs = (r.body?.logs as LogRow[]) || [];
  const cfgRow = findLog(logs, "update_ai_config", "ai_config");
  const cfgDetail = cfgRow.detail as Record<string, unknown>;
  assert.equal(cfgDetail.analyzerEnabled, false, "detail carries the resulting flag (result)");
  assert.equal(cfgDetail.updatedBy, ADMIN.name, "detail carries who applied it");

  const disRow = findLog(logs, "ai_provider_disable", "gemini");
  const disDetail = disRow.detail as Record<string, unknown>;
  assert.ok("effectiveEngine" in disDetail, "detail carries the resulting effective engine");

  /* The synthetic key value must never appear in the serialized audit
   * list — detail payloads are result/cause metadata only. */
  assert.ok(!r.raw.includes(SYNTHETIC_GEMINI_KEY), "no API key material in the audit payload");
});

test("search matches actor or target; pagination respects limit", async () => {
  const byActor = await api("/api/admin/audit-logs?search=Audit%20E2E%20Admin", adminJar);
  const logs = (byActor.body?.logs as LogRow[]) || [];
  assert.ok(logs.length > 0, "search by actor name returns rows");
  assert.ok(logs.every((l) => String(l.actorName).includes("Audit E2E Admin") || String(l.target).includes("Audit E2E Admin")));

  const paged = await api("/api/admin/audit-logs?limit=10", adminJar);
  const pagedLogs = (paged.body?.logs as LogRow[]) || [];
  assert.ok(pagedLogs.length <= 10, "limit respected");
  assert.ok(paged.body && typeof (paged.body as { total: number }).total === "number");
});

test("deleting a user audits delete_user and RETAINS their earlier audit rows", async () => {
  const list = await api("/api/admin/users?q=" + BAN_PHONE, superJar);
  const users = ((list.body?.users as Array<{ id: number; phone: string }>) || []);
  const target = users.find((u) => u.phone === BAN_PHONE);
  assert.ok(target, "ban target user listed");

  const del = await api(`/api/admin/users/${target.id}/delete`, superJar, { method: "POST", body: JSON.stringify({ confirm: target.phone }) });
  assert.equal(del.response.status, 200, `delete failed: ${del.raw}`);

  const r = await api(`/api/admin/audit-logs?action=delete_user`, superJar);
  const row = findLog((r.body?.logs as LogRow[]) || [], "delete_user");
  const detail = row.detail as Record<string, unknown>;
  assert.ok(Array.isArray(detail.retained) && detail.retained.includes("audit_logs"), "detail documents audit-log retention");

  /* The ban_user row created earlier for the same user must survive. */
  const r2 = await api(`/api/admin/audit-logs?action=ban_user`, superJar);
  assert.ok(((r2.body?.logs as LogRow[]) || []).length >= 1, "earlier audit rows survive user deletion");
});

test("no mutation endpoint exists on the audit log (no uncontrolled deletion)", async () => {
  for (const method of ["POST", "PUT", "DELETE"] as const) {
    const r = await api("/api/admin/audit-logs", superJar, { method, body: "{}" });
    assert.equal(r.response.status, 404, `${method} /api/admin/audit-logs must not exist`);
  }
});
