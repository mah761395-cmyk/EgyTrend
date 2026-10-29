import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { after, before, test } from "node:test";
import { and, eq } from "drizzle-orm";
import type { AiBudgets } from "../lib/ai-costs";
import {
  appSettingsTable,
  auditLogsTable,
  aiUsageTable,
  employeesTable,
} from "@workspace/db/schema";
import { createMemoryDatabase } from "../test-support/memory-db";

/* TASK L C1+C2 — AI metering + costs + budgets.
 *
 * In-process pg-mem with synthetic data only. A synthetic GEMINI key makes
 * the paid path ACTIVE so the /chat reservation path is exercised; the
 * sandbox has no egress to Google and pg-mem has no advisory lock, so the
 * paid reservation fails CLOSED (503, zero rows, zero upstream calls) — the
 * honesty guarantee under test. Function-level metering, cost estimation,
 * no-double-count, budget exhaustion and the admin cost API are tested
 * directly on the same test database.
 *
 * Every dollar figure here is an ESTIMATE (tokens × editable price table);
 * the assertions demand the API keep saying so (costBasis === "estimate"). */
process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "test-only-ai-costs-secret-not-for-deployment";
process.env.LOG_LEVEL = "silent";
process.env.GEMINI_API_KEY = "synthetic-not-a-real-key-costs-e2e";
delete process.env.ANTHROPIC_API_KEY;
delete process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY;
delete process.env.SMTP_HOST;
delete process.env.SMTP_USER;

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

const SUPER_ADMIN = { email: "super.costs@example.test", password: "SuperCostsSynth1!" };
const ADMIN = { email: "admin.costs@example.test", password: "AdminCostsSynth1!" };
const SUPPORT = { email: "support.costs@example.test", password: "SupportCostsSynth1!" };

let superJar: CookieJar;
let adminJar: CookieJar;
let supportJar: CookieJar;

type CostsApi = typeof import("../lib/ai-costs");
let costs: CostsApi;

/* Seed plan (all rows land inside the 30-day default window):
 *  R1 u-meter/chat   gemini  ok      1_000_000/1_000_000 tokens  $0.50  estimate
 *  R2 u-meter/chat   gemini  failed  (no tokens, no cost)
 *  R3 u-spend/assist anthropic ok    100_000/50_000 tokens      $1.05  estimate
 *  R4 u-spend/assist anthropic ok    50_000/25_000 tokens       $2.00  estimate
 * ⇒ requests 4, ok 3, failed 1, cost $3.55, metered 3. */
const GEMINI_COST = 0.5;
const CLAUDE_COST_3 = 1.05;
const CLAUDE_COST_4 = 2.0;
const TOTAL_COST = Math.round((GEMINI_COST + CLAUDE_COST_3 + CLAUDE_COST_4) * 1e6) / 1e6;

async function seedUsage(values: Array<Partial<typeof aiUsageTable.$inferInsert>>) {
  await memory.db.insert(aiUsageTable).values(values as never);
}

before(async () => {
  memory = await createMemoryDatabase();
  (globalThis as typeof globalThis & { __egytrendTestDatabase?: typeof memory.db }).__egytrendTestDatabase = memory.db;

  await memory.db.insert(employeesTable).values([
    { name: "Costs Super", email: SUPER_ADMIN.email, role: "super_admin", status: "active", passwordHash: employeePasswordHash(SUPER_ADMIN.password) },
    { name: "Costs Admin", email: ADMIN.email, role: "admin", status: "active", passwordHash: employeePasswordHash(ADMIN.password) },
    { name: "Costs Support", email: SUPPORT.email, role: "support", status: "active", passwordHash: employeePasswordHash(SUPPORT.password) },
  ]);

  costs = await import("../lib/ai-costs");

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

/* ── A. cost estimation + row semantics ─────────────────────────────────── */

test("estimateCallCostUsd: exact for known models, null (never $0) when unmetered", async () => {
  const prices = await costs.readAiModelPrices();
  const c1 = costs.estimateCallCostUsd("gemini-3.5-flash-lite", 1_000_000, 1_000_000, prices);
  assert.equal(c1, GEMINI_COST, "1M in + 1M out at 0.1/0.4 per M = $0.50");
  const c2 = costs.estimateCallCostUsd("claude-sonnet-4-6", 100_000, 50_000, prices);
  assert.equal(c2, CLAUDE_COST_3, "100k in + 50k out at 3/15 per M = $1.05");
  assert.equal(costs.estimateCallCostUsd("no-such-model", 1000, 1000, prices), null, "unknown model → unmetered");
  assert.equal(costs.estimateCallCostUsd("gemini-3.5-flash-lite", null, 1000, prices), null, "missing tokens → unmetered");
  assert.equal(costs.estimateCallCostUsd(null, 1000, 1000, prices), null, "missing model → unmetered");
});

test("row lifecycle: one row per external request, updated in place, never double-counted", async () => {
  const prices = await costs.readAiModelPrices();
  const [row] = await memory.db
    .insert(aiUsageTable)
    .values({ userId: "u-meter", requestType: "chat", tokensEstimate: 900, provider: "gemini", status: "reserved" })
    .returning({ id: aiUsageTable.id });
  assert.ok(row && row.id > 0, "reservation created exactly one row");

  /* Success: tokens + estimate land on the SAME row. */
  const cost = costs.estimateCallCostUsd("gemini-3.5-flash-lite", 1_000_000, 1_000_000, prices);
  await costs.updateAiUsageRow(row.id, {
    provider: "gemini",
    model: "gemini-3.5-flash-lite",
    tokensIn: 1_000_000,
    tokensOut: 1_000_000,
    status: "ok",
    costEstUsd: cost,
    costSource: "estimate",
  });

  /* A retry of the SAME row (defensive double-close) must not add cost. */
  await costs.updateAiUsageRow(row.id, {
    provider: "gemini",
    model: "gemini-3.5-flash-lite",
    tokensIn: 1_000_000,
    tokensOut: 1_000_000,
    status: "ok",
    costEstUsd: cost,
    costSource: "estimate",
  });

  const rows = await memory.db
    .select()
    .from(aiUsageTable)
    .where(and(eq(aiUsageTable.userId, "u-meter"), eq(aiUsageTable.status, "ok")));
  assert.equal(rows.length, 1, "exactly one ok row after update-in-place");
  assert.equal(rows[0].costEstUsd, GEMINI_COST, "cost recorded once, not doubled");
  assert.equal(rows[0].costSource, "estimate");
  assert.equal(rows[0].provider, "gemini");
  assert.equal(rows[0].tokensIn, 1_000_000);

  /* The failed attempt of the same feature stays a failed row (cost null). */
  await seedUsage([{ userId: "u-meter", requestType: "chat", tokensEstimate: 900, provider: "gemini", status: "failed" }]);
});

test("providerSpendSince counts only confirmed (status='ok') metered spend", async () => {
  await seedUsage([
    { userId: "u-spend", requestType: "assistant", tokensEstimate: 400, provider: "anthropic", model: "claude-sonnet-4-6", tokensIn: 100_000, tokensOut: 50_000, status: "ok", costEstUsd: CLAUDE_COST_3, costSource: "estimate" },
    { userId: "u-spend", requestType: "assistant", tokensEstimate: 400, provider: "anthropic", model: "claude-sonnet-4-6", tokensIn: 50_000, tokensOut: 25_000, status: "ok", costEstUsd: CLAUDE_COST_4, costSource: "estimate" },
  ]);
  const anthropic = await costs.providerSpendSince(memory.db, "anthropic", new Date(Date.now() - 30 * 24 * 3600 * 1000));
  assert.equal(anthropic, Math.round((CLAUDE_COST_3 + CLAUDE_COST_4) * 1e6) / 1e6, "both ok rows count");
  const gemini = await costs.providerSpendSince(memory.db, "gemini", new Date(Date.now() - 30 * 24 * 3600 * 1000));
  assert.equal(gemini, GEMINI_COST, "gemini counts only its ok row — the failed row adds nothing");
  const none = await costs.providerSpendSince(memory.db, "no-such-provider", new Date());
  assert.equal(none, 0);
});

test("budget state: auto-stop makes exhaustion a hard block; without it budgets are advisory", async () => {
  const exhaustedBudgets: AiBudgets = { autoStop: true, providers: { gemini: { dailyUsd: 0.4, monthlyUsd: null } } };
  const stateHard = await costs.providerBudgetState(memory.db, exhaustedBudgets, "gemini");
  assert.ok(stateHard.dailyPct !== null && stateHard.dailyPct >= 1, "daily spend $0.50 vs $0.40 limit");
  assert.equal(stateHard.exhausted, true, "auto-stop ON + over budget → exhausted");

  const advisory: AiBudgets = { autoStop: false, providers: { gemini: { dailyUsd: 0.4, monthlyUsd: null } } };
  const stateSoft = await costs.providerBudgetState(memory.db, advisory, "gemini");
  assert.equal(stateSoft.exhausted, false, "auto-stop OFF → advisory only, never a hard block");

  const unlimited = await costs.providerBudgetState(memory.db, { autoStop: true, providers: {} }, "gemini");
  assert.equal(unlimited.exhausted, false, "no budget configured → never exhausted");
});

test("pickBudgetedEngine: falls to the next provider, then to the free local engine", async () => {
  const overBudget: AiBudgets = { autoStop: true, providers: { gemini: { dailyUsd: 0.4, monthlyUsd: null } } };
  const both: AiBudgets = {
    autoStop: true,
    providers: {
      gemini: { dailyUsd: 0.4, monthlyUsd: null },
      anthropic: { dailyUsd: 0.5, monthlyUsd: null },
    },
  };
  const onlyGemini = await costs.pickBudgetedEngine(memory.db, { gemini: true, anthropic: false }, overBudget);
  assert.equal(onlyGemini.engine, "local", "gemini exhausted, anthropic unconfigured → local safety net");
  assert.deepEqual(onlyGemini.skipped, { gemini: "budget" });

  const toAnthropic = await costs.pickBudgetedEngine(memory.db, { gemini: true, anthropic: true }, overBudget);
  assert.equal(toAnthropic.engine, "anthropic", "gemini exhausted → anthropic serves");

  const toLocal = await costs.pickBudgetedEngine(memory.db, { gemini: true, anthropic: true }, both);
  assert.equal(toLocal.engine, "local", "both exhausted → local (the site never goes down)");

  const advisoryPick = await costs.pickBudgetedEngine(memory.db, { gemini: true, anthropic: false }, { autoStop: false, providers: { gemini: { dailyUsd: 0.4, monthlyUsd: null } } });
  assert.equal(advisoryPick.engine, "gemini", "auto-stop OFF → over-budget gemini still serves (alerts only)");

  const noKeys = await costs.pickBudgetedEngine(memory.db, { gemini: false, anthropic: false }, overBudget);
  assert.equal(noKeys.engine, "local", "no keys → local");
});

test("price + budget persistence round-trips with validation caps", async () => {
  const ok = await costs.saveAiModelPrices({ "gemini-3.5-flash-lite": { inPerM: 0.1, outPerM: 0.4 }, custom: { inPerM: 1, outPerM: 2 } });
  assert.deepEqual(ok, { ok: true });
  const read = await costs.readAiModelPrices();
  assert.equal(read.custom?.inPerM, 1);
  assert.equal(read["gemini-3.6-flash"]?.inPerM, 0.3, "defaults merge with stored overrides");

  const badPrice = await costs.saveAiModelPrices({ x: { inPerM: 5000, outPerM: 1 } });
  assert.equal(badPrice.ok, false, "price above the $1000/M cap is refused");

  const okB = await costs.saveAiBudgets({ autoStop: false, providers: { gemini: { dailyUsd: 25, monthlyUsd: 500 }, anthropic: { dailyUsd: null, monthlyUsd: 900 } } });
  assert.deepEqual(okB, { ok: true });
  const readB = await costs.readAiBudgets();
  assert.equal(readB.providers.gemini?.dailyUsd, 25);
  assert.equal(readB.providers.anthropic?.monthlyUsd, 900);

  const badB = await costs.saveAiBudgets({ autoStop: true, providers: { gemini: { dailyUsd: 99_999, monthlyUsd: null } } });
  assert.equal(badB.ok, false, "daily budget above the $10k cap is refused");
});

/* ── B. admin cost API ──────────────────────────────────────────────────── */

test("GET /ai-costs: window totals, per provider/model/feature/user, honest estimate label", async () => {
  const r = await api("/api/admin/ai-costs?window=30", superJar);
  assert.equal(r.response.status, 200, JSON.stringify(r.body));
  assert.equal(r.body?.costBasis, "estimate", "every figure is labeled an estimate");
  const t = r.body?.totals as Record<string, unknown>;
  assert.equal(t.requests, 4);
  assert.equal(t.ok, 3);
  assert.equal(t.failed, 1);
  assert.equal(t.costEstUsd, TOTAL_COST, "sum of confirmed metered spend only");
  assert.equal(t.meteredRequests, 3, "the failed row is unmetered, never $0");
  assert.equal(t.tokensIn, 1_000_000 + 100_000 + 50_000);
  assert.equal(t.tokensOut, 1_000_000 + 50_000 + 25_000);
  assert.ok(typeof r.body?.prevWindow === "object", "period comparison present");

  const byProvider = (r.body?.byProvider as Array<Record<string, unknown>>) || [];
  const gem = byProvider.find((p) => p.key === "gemini");
  const ant = byProvider.find((p) => p.key === "anthropic");
  assert.equal(gem?.count, 2);
  assert.equal(gem?.costEstUsd, GEMINI_COST, "failed gemini row adds no cost");
  assert.equal(ant?.costEstUsd, Math.round((CLAUDE_COST_3 + CLAUDE_COST_4) * 1e6) / 1e6);

  const byFeature = (r.body?.byFeature as Array<Record<string, unknown>>) || [];
  assert.equal(byFeature.find((f) => f.key === "chat")?.count, 2);
  assert.equal(byFeature.find((f) => f.key === "assistant")?.count, 2);

  const byUser = (r.body?.byUser as Array<Record<string, unknown>>) || [];
  assert.equal(byUser.length, 2);
  assert.equal(byUser[0].user, "u-spend", "top spender first");
  assert.equal(byUser[0].costEstUsd, Math.round((CLAUDE_COST_3 + CLAUDE_COST_4) * 1e6) / 1e6);

  const byDay = (r.body?.byDay as Array<Record<string, unknown>>) || [];
  const today = new Date().toISOString().slice(0, 10);
  assert.ok(byDay.some((d) => d.day === today && d.count === 4), "all seed rows grouped under today");
  assert.ok(!r.raw.includes("synthetic-not-a-real-key-costs-e2e"), "no key material in the payload");
});

test("GET /ai-costs/rows: filters + pagination over the metering log", async () => {
  const r = await api("/api/admin/ai-costs/rows?window=30&provider=gemini&status=ok", adminJar);
  assert.equal(r.response.status, 200, JSON.stringify(r.body));
  assert.equal(r.body?.total, 1, "one gemini ok row");
  const rows = r.body?.rows as Array<Record<string, unknown>>;
  assert.equal(rows[0].model, "gemini-3.5-flash-lite");
  assert.equal(rows[0].costEstUsd, GEMINI_COST);
  assert.equal(rows[0].costSource, "estimate");
  assert.equal(rows[0].provider, "gemini");

  const all = await api("/api/admin/ai-costs/rows?window=30&limit=10", adminJar);
  assert.equal(all.body?.total, 4);
  assert.equal((all.body?.rows as unknown[]).length, 4);

  const failed = await api("/api/admin/ai-costs/rows?window=30&status=failed", adminJar);
  assert.equal(failed.body?.total, 1);
  assert.equal((failed.body?.rows as Array<Record<string, unknown>>)[0].costEstUsd, null, "failed rows are unmetered, never $0");
});

test("GET /ai-costs/export: real CSV download with BOM, filters applied", async () => {
  const r = await api("/api/admin/ai-costs/export?window=30&provider=anthropic", superJar);
  assert.equal(r.response.status, 200);
  assert.ok(String(r.response.headers.get("content-type") || "").includes("text/csv"));
  assert.ok(String(r.response.headers.get("content-disposition") || "").includes("attachment"));

  /* fetch().text() strips a leading UTF-8 BOM by spec — verify the bytes. */
  const headers = new Headers();
  headers.set("Origin", baseUrl);
  if (superJar.value) headers.set("Cookie", superJar.value);
  const bytes = new Uint8Array(await (await fetch(`${baseUrl}/api/admin/ai-costs/export?window=30&provider=anthropic`, { headers })).arrayBuffer());
  assert.equal(bytes[0], 0xef, "BOM byte 1");
  assert.equal(bytes[1], 0xbb, "BOM byte 2");
  assert.equal(bytes[2], 0xbf, "BOM byte 3");

  const text = r.raw.replace(/^\uFEFF/, "");
  assert.ok(text.startsWith("date_iso,user_id,feature,provider,model,tokens_in,tokens_out,status,cost_est_usd,cost_basis"));
  assert.ok(text.includes("u-spend,assistant,anthropic"));
  assert.ok(text.includes("estimate"), "cost basis column present in every row");
  assert.ok(!text.includes("u-meter"), "provider filter applied to the export");
});

test("PUT /ai-prices + /ai-budgets: persistence, audit, caps; refresh-alerts computes honest state", async () => {
  const putPrices = await api("/api/admin/ai-prices", adminJar, {
    method: "PUT",
    body: JSON.stringify({ "gemini-3.5-flash-lite": { inPerM: 0.2, outPerM: 0.5 } }),
  });
  assert.equal(putPrices.response.status, 200, JSON.stringify(putPrices.body));
  const getPrices = await api("/api/admin/ai-prices", adminJar);
  assert.equal((getPrices.body?.prices as Record<string, { inPerM: number }>)["gemini-3.5-flash-lite"].inPerM, 0.2);

  const badPrices = await api("/api/admin/ai-prices", adminJar, {
    method: "PUT",
    body: JSON.stringify({ x: { inPerM: 1234, outPerM: 1 } }),
  });
  assert.equal(badPrices.response.status, 400, "over-cap price refused");

  const putBudgets = await api("/api/admin/ai-budgets", adminJar, {
    method: "PUT",
    body: JSON.stringify({ autoStop: true, providers: { gemini: { dailyUsd: 0.4, monthlyUsd: null }, anthropic: { dailyUsd: null, monthlyUsd: null } } }),
  });
  assert.equal(putBudgets.response.status, 200, JSON.stringify(putBudgets.body));
  const state = putBudgets.body?.state as Record<string, Record<string, unknown>>;
  assert.equal(state.gemini.exhausted, true, "$0.50 confirmed spend vs $0.40 daily with auto-stop");
  assert.equal(state.anthropic.exhausted, false, "anthropic has no limit");

  const badBudgets = await api("/api/admin/ai-budgets", adminJar, {
    method: "PUT",
    body: JSON.stringify({ autoStop: true, providers: { gemini: { dailyUsd: 99_999, monthlyUsd: null } } }),
  });
  assert.equal(badBudgets.response.status, 400, "over-cap budget refused");

  /* Alerts: over-budget gemini → 'over' entry with a notification stamp.
   * No SMTP in tests → the email is skipped honestly, never a crash. */
  const refresh = await api("/api/admin/ai-budgets/refresh-alerts", adminJar, { method: "POST", body: "{}" });
  assert.equal(refresh.response.status, 200, JSON.stringify(refresh.body));
  const alerts = refresh.body?.alerts as Record<string, Record<string, unknown>>;
  assert.equal(alerts.gemini?.level, "over");
  assert.ok((alerts.gemini?.pct as number) >= 1);
  assert.equal(typeof alerts.gemini?.lastNotifiedAt, "string", "notification attempted (cooled 24h)");
  assert.ok(!alerts.anthropic, "unlimited provider has no alert");

  const audit = await memory.db.select().from(auditLogsTable).where(inAction("update_ai_budgets"));
  assert.ok(audit.length >= 1, "budget change audited");
  const auditPrices = await memory.db.select().from(auditLogsTable).where(inAction("update_ai_model_prices"));
  assert.ok(auditPrices.length >= 1, "price change audited");

  /* Second refresh within the 24h cooldown must not re-notify. */
  const before = alerts.gemini?.lastNotifiedAt as string;
  const refresh2 = await api("/api/admin/ai-budgets/refresh-alerts", adminJar, { method: "POST", body: "{}" });
  const alerts2 = refresh2.body?.alerts as Record<string, Record<string, unknown>>;
  assert.equal(alerts2.gemini?.lastNotifiedAt, before, "cooldown respected");
});

function inAction(action: string) {
  return eq(auditLogsTable.action, action);
}

test("permissions: cost section is admin+ (financial + per-user spend), unauthenticated denied", async () => {
  /* Cost figures include per-user spend → same sensitivity class as the
   * audit log: super_admin/admin read, support denied (provider STATUS
   * remains readable by staff in /ai-providers). */
  const read = await api("/api/admin/ai-costs", supportJar);
  assert.equal(read.response.status, 403, "support cannot read cost figures");
  const rows = await api("/api/admin/ai-costs/rows", supportJar);
  assert.equal(rows.response.status, 403);
  const exp = await api("/api/admin/ai-costs/export", supportJar);
  assert.equal(exp.response.status, 403, "export is as sensitive as the rows");
  const putPrices = await api("/api/admin/ai-prices", supportJar, { method: "PUT", body: JSON.stringify({ a: { inPerM: 1, outPerM: 1 } }) });
  assert.equal(putPrices.response.status, 403, "support cannot edit prices");
  const putBudgets = await api("/api/admin/ai-budgets", supportJar, { method: "PUT", body: JSON.stringify({ autoStop: true }) });
  assert.equal(putBudgets.response.status, 403, "support cannot edit budgets");
  const noAuth = await api("/api/admin/ai-costs", {});
  assert.equal(noAuth.response.status, 401);
  const noAuthExport = await api("/api/admin/ai-costs/export", {});
  assert.equal(noAuthExport.response.status, 401);
  const adminRead = await api("/api/admin/ai-costs", adminJar);
  assert.equal(adminRead.response.status, 200, "admin can read");
});

/* ── C. /chat wiring: paid path fails closed without a locked DB ───────── */

test("POST /chat: reservation unavailable → free local engine, zero usage rows, zero upstream calls", async () => {
  /* The paid path is never admitted without a secured reservation, but the
   * FREE local engine needs no lock, no budget and no row — so a metering
   * failure degrades to it instead of taking the request (or the site) down. */
  const countBefore = (await memory.db.select().from(aiUsageTable)).length;
  const t0 = Date.now();
  const r = await api(
    "/api/ai/chat",
    superJar,
    {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: "موجز السوق" }], feature: "assistant" }),
    },
  );
  const ms = Date.now() - t0;
  assert.equal(r.response.status, 200, JSON.stringify(r.body));
  assert.equal(r.body?.engine, "local", "degraded to the free data-driven engine");
  assert.equal(r.body?.degraded, true, "the degradation is reported honestly");
  assert.ok(typeof r.body?.text === "string" && (r.body.text as string).length > 0, "an answer (or an honest data note) is returned");
  assert.ok(ms < 20_000, `answered without an external provider round-trip (${ms}ms)`);
  const countAfter = (await memory.db.select().from(aiUsageTable)).length;
  assert.equal(countAfter, countBefore, "no usage row — the free engine is never metered or charged");
  assert.ok(!r.raw.includes("synthetic-not-a-real-key-costs-e2e"), "key value never leaks");
});

test("app_settings rows hold only settings — never secrets", async () => {
  const rows = await memory.db.select().from(appSettingsTable);
  const all = rows.map((r) => r.value).join("\n");
  assert.ok(!all.includes("synthetic-not-a-real-key-costs-e2e"), "no API key stored in app_settings");
});
