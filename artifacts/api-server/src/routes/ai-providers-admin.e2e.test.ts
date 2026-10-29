import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { after, before, test } from "node:test";
import { eq } from "drizzle-orm";
import {
  appSettingsTable,
  auditLogsTable,
  employeesTable,
} from "@workspace/db/schema";
import { createMemoryDatabase } from "../test-support/memory-db";
import type { effectiveEngine as EffectiveEngineFn } from "../lib/ai-engine";

/* In-process pg-mem with synthetic data only. Covers TASK J stage 4:
 * AI provider management — presence-only key state (never the value),
 * settings-gated disable that degrades the chain honestly (never down),
 * bounded probes with zero side effects, and permissions.
 *
 * A synthetic GEMINI key is set so the env order resolves to "gemini";
 * the sandbox has no egress to Google, so probes fail FAST and honestly
 * (unavailable/timeout) — which is exactly the assertion under test. */
process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "test-only-session-secret-not-for-deployment";
process.env.LOG_LEVEL = "silent";
process.env.GEMINI_API_KEY = "synthetic-not-a-real-key-e2e";
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

const SUPER_ADMIN = { email: "super.ai@example.test", password: "SuperAiSynth1!" };
const ADMIN = { email: "admin.ai@example.test", password: "AdminAiSynth1!" };
const SUPPORT = { email: "support.ai@example.test", password: "SupportAiSynth1!" };

let superJar: CookieJar;
let adminJar: CookieJar;
let supportJar: CookieJar;
let effectiveEngineFn: typeof EffectiveEngineFn;

before(async () => {
  memory = await createMemoryDatabase();
  (globalThis as typeof globalThis & { __egytrendTestDatabase?: typeof memory.db }).__egytrendTestDatabase = memory.db;

  await memory.db.insert(employeesTable).values([
    { name: "AI Super", email: SUPER_ADMIN.email, role: "super_admin", status: "active", passwordHash: employeePasswordHash(SUPER_ADMIN.password) },
    { name: "AI Admin", email: ADMIN.email, role: "admin", status: "active", passwordHash: employeePasswordHash(ADMIN.password) },
    { name: "AI Support", email: SUPPORT.email, role: "support", status: "active", passwordHash: employeePasswordHash(SUPPORT.password) },
  ]);

  /* ai-engine (via local-ai → route modules) loads the DB barrel, so it is
   * imported only after the test database is injected. */
  const engine = await import("../lib/ai-engine");
  effectiveEngineFn = engine.effectiveEngine;

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

async function togglesRow(): Promise<string | null> {
  const [row] = await memory.db.select().from(appSettingsTable).where(eq(appSettingsTable.key, "ai_provider_toggles"));
  return row?.value ?? null;
}

test("overview reports presence state, fixed order and the active engine — never a key value", async () => {
  const r = await api("/api/admin/ai-providers", superJar);
  assert.equal(r.response.status, 200);
  const info = r.body?.info as Record<string, unknown>;
  assert.ok(info, "info payload present");
  assert.equal(info.engine, "gemini", "env order makes Gemini the active engine");
  const providers = (info.providers as Array<Record<string, unknown>>) || [];
  const byId = new Map(providers.map((p) => [String(p.id), p]));
  assert.equal(byId.get("gemini")?.["keyPresent"], true, "synthetic env key → presence true");
  assert.equal(byId.get("gemini")?.["role"], "primary");
  assert.equal(byId.get("gemini")?.["active"], true);
  assert.equal(byId.get("anthropic")?.["keyPresent"], false, "no anthropic env key → presence false");
  assert.equal(byId.get("anthropic")?.["active"], false);
  assert.equal(byId.get("local")?.["role"], "safety-net");
  assert.equal(byId.get("local")?.["adminDisabled"], false, "local is never disable-able");
  assert.equal(byId.get("local")?.["keyPresent"], true, "local needs no key (built-in)");
  /* The key value must never appear in any admin payload. */
  assert.ok(!r.raw.includes("synthetic-not-a-real-key-e2e"), "key value never serialized");
  assert.equal(typeof r.body?.assistantGateEnabled, "boolean");
});

test("probes are bounded, honest, and leave no side effects; last test persists", async () => {
  /* Gemini: key present but the sandbox cannot reach Google → honest
   * failure category, with a timestamp, and without leaking the key. */
  const g = await api("/api/admin/ai-providers/gemini/test", adminJar, { method: "POST", body: "{}" });
  assert.equal(g.response.status, 200);
  const gres = g.body?.result as Record<string, unknown>;
  assert.ok(gres, "probe result present");
  assert.equal(gres.ok, false);
  assert.equal(typeof gres.testedAt, "number", "probe carries its own timestamp");
  assert.ok(typeof gres.error === "string" && gres.error.length > 0, "stable error category, not an exception");
  assert.ok(!g.raw.includes("synthetic-not-a-real-key-e2e"), "key value never serialized in probe result");

  /* Anthropic: no key → answered honestly WITHOUT any upstream call. */
  const a = await api("/api/admin/ai-providers/anthropic/test", adminJar, { method: "POST", body: "{}" });
  const ares = a.body?.result as Record<string, unknown>;
  assert.equal(ares.ok, false);
  assert.equal(ares.error, "no_api_key", "missing key is a clear, specific message");

  /* Local: bounded; whatever the outcome, it is reported honestly. */
  const l = await api("/api/admin/ai-providers/local/test", adminJar, { method: "POST", body: "{}" });
  const lres = l.body?.result as Record<string, unknown>;
  assert.equal(typeof lres.ok, "boolean");
  assert.equal(typeof lres.testedAt, "number");
  if (lres.ok === false) assert.ok(typeof lres.error === "string" && lres.error.length > 0);

  /* The probe result is persisted as the last test (proven state). */
  const overview = await api("/api/admin/ai-providers", superJar);
  const lastTests = (overview.body?.lastTests as Record<string, Record<string, unknown>>) || {};
  assert.equal(lastTests.gemini?.ok, false, "last gemini test persisted as failure");
  assert.equal(typeof lastTests.gemini?.at, "string");
  assert.equal(lastTests.anthropic?.ok, false);
  assert.equal(lastTests.anthropic?.error, "no_api_key");
});

test("disable drops the provider from the chain (test + revert), never down", async () => {
  /* Baseline: Gemini active (synthetic key, nothing disabled). */
  assert.equal(await effectiveEngineFn(), "gemini");

  const dis = await api("/api/admin/ai-providers/gemini/set-disabled", adminJar, { method: "POST", body: JSON.stringify({ disabled: true }) });
  assert.equal(dis.response.status, 200, JSON.stringify(dis.body));
  assert.equal(dis.body?.["disabled"], true);
  const disInfo = dis.body?.info as Record<string, unknown>;
  assert.equal(disInfo?.engine, "local", "with Anthropic unconfigured, the chain degrades to the local safety net — not down");

  const stored = await togglesRow();
  assert.ok(stored && stored.includes("gemini"), "disable persisted in app_settings");

  const overview = await api("/api/admin/ai-providers", superJar);
  const providers = ((overview.body?.info as Record<string, unknown>).providers as Array<Record<string, unknown>>) || [];
  const gemini = providers.find((p) => p.id === "gemini");
  const local = providers.find((p) => p.id === "local");
  assert.equal(gemini?.adminDisabled, true);
  assert.equal(gemini?.active, false);
  assert.equal(local?.active, true, "local safety net now active");
  assert.equal(await effectiveEngineFn(), "local", "server-side selection honours the admin disable");

  /* Revert: Gemini is active again. */
  const en = await api("/api/admin/ai-providers/gemini/set-disabled", adminJar, { method: "POST", body: JSON.stringify({ disabled: false }) });
  assert.equal(en.response.status, 200);
  const storedAfter = await togglesRow();
  assert.ok(!storedAfter?.includes("gemini"), "revert removed the id from app_settings");
  assert.equal(await effectiveEngineFn(), "gemini", "re-enabled provider is active again");

  /* Both external providers disabled → still local, never an error state. */
  await api("/api/admin/ai-providers/gemini/set-disabled", adminJar, { method: "POST", body: JSON.stringify({ disabled: true }) });
  await api("/api/admin/ai-providers/anthropic/set-disabled", adminJar, { method: "POST", body: JSON.stringify({ disabled: true }) });
  assert.equal(await effectiveEngineFn(), "local", "disabling everything degrades, does not break");
  await api("/api/admin/ai-providers/gemini/set-disabled", adminJar, { method: "POST", body: JSON.stringify({ disabled: false }) });
  await api("/api/admin/ai-providers/anthropic/set-disabled", adminJar, { method: "POST", body: JSON.stringify({ disabled: false }) });

  const rows = await memory.db.select().from(auditLogsTable).where(eq(auditLogsTable.action, "ai_provider_disable"));
  assert.ok(rows.length >= 2, "ai_provider_disable audited");
  assert.ok(rows.some((row) => row.target === "gemini"), "audit names the provider");
});

test("local cannot be disabled; unknown ids are 404", async () => {
  const local = await api("/api/admin/ai-providers/local/set-disabled", superJar, { method: "POST", body: JSON.stringify({ disabled: true }) });
  assert.equal(local.response.status, 409, "the safety net is never disable-able");
  const stored = await togglesRow();
  assert.ok(!stored?.includes("local"), "no state written for the refused toggle");

  const unknown = await api("/api/admin/ai-providers/openai/set-disabled", superJar, { method: "POST", body: JSON.stringify({ disabled: true }) });
  assert.equal(unknown.response.status, 404);
});

test("permissions: mutations admin+ only; reads for staff; tests audited", async () => {
  const noAuth = await api("/api/admin/ai-providers/gemini/set-disabled", {}, { method: "POST", body: JSON.stringify({ disabled: true }) });
  assert.equal(noAuth.response.status, 401);

  const supportMut = await api("/api/admin/ai-providers/gemini/set-disabled", supportJar, { method: "POST", body: JSON.stringify({ disabled: true }) });
  assert.equal(supportMut.response.status, 403, "support cannot toggle AI providers");

  const supportTest = await api("/api/admin/ai-providers/gemini/test", supportJar, { method: "POST", body: "{}" });
  assert.equal(supportTest.response.status, 403, "support cannot run probes (they spend quota)");

  const supportRead = await api("/api/admin/ai-providers", supportJar);
  assert.equal(supportRead.response.status, 200, "read is available to staff roles");

  const testRows = await memory.db.select().from(auditLogsTable).where(eq(auditLogsTable.action, "ai_provider_test"));
  assert.ok(testRows.length >= 3, "probes audited (gemini/anthropic/local)");
});
