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
import { createMarketCache } from "../lib/market-data/cache";
import { MARKET_INSTRUMENTS, type StockDefinition } from "../lib/market-data/catalog";
import type {
  CalendarDataProvider,
  CalendarEvent,
  CanonicalQuote,
  MarketDataProvider,
  MarketInstrument,
  ProviderDescriptor,
} from "../lib/market-data/types";
/* Type-only: the service module is imported dynamically in before() AFTER
 * the pg-mem database is injected, because it (via the settings module)
 * loads the @workspace/db barrel which honours the test DB only when it is
 * already present. */
import type { MarketDataService } from "../lib/market-data/service";

/* In-process pg-mem database with synthetic data only. Covers TASK J stage 3:
 * market-data provider management — settings-gated enable/disable (persisted
 * in app_settings), honest probes (no side effects), permissions, and the
 * fail-closed guarantee that disabling the only source for an instrument
 * surfaces as "no verified quote", never an invented price. */
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

/* ── Fake providers (deterministic, no network) ─────────────────────────── */

class FakeGoodProvider implements MarketDataProvider {
  readonly id = "fake-good";
  readonly name = "Fake Good (synthetic)";
  calls = 0;
  descriptor(): ProviderDescriptor {
    return { id: this.id, name: this.name, state: "configured", note: "synthetic configured provider", coverage: ["index", "equity", "fx", "commodity", "crypto"], externalDisplayConfirmed: true };
  }
  canServe(_instrument: MarketInstrument): boolean {
    return true;
  }
  async getQuotes(instruments: MarketInstrument[]): Promise<{ quotes: CanonicalQuote[]; requestedCount: number }> {
    this.calls += 1;
    const now = Date.now();
    const quotes = instruments.map((instrument, i): CanonicalQuote => ({
      instrumentId: instrument.id,
      price: 100 + i,
      previousClose: 99 + i,
      asOf: now,
      sourceId: this.id,
      sourceName: this.name,
      freshness: "real-time",
      delayedMinutes: 0,
      currency: instrument.currency,
    }));
    return { quotes, requestedCount: instruments.length };
  }
}

class FakeBadProvider implements MarketDataProvider {
  readonly id = "fake-bad";
  readonly name = "Fake Bad (synthetic)";
  calls = 0;
  descriptor(): ProviderDescriptor {
    return { id: this.id, name: this.name, state: "configured", note: "synthetic failing provider", coverage: ["index", "equity", "fx", "commodity", "crypto"], externalDisplayConfirmed: true };
  }
  canServe(_instrument: MarketInstrument): boolean {
    return true;
  }
  async getQuotes(_instruments: MarketInstrument[]): Promise<{ quotes: CanonicalQuote[]; requestedCount: number }> {
    this.calls += 1;
    throw new Error("synthetic upstream outage");
  }
}

class FakeUnsetProvider implements MarketDataProvider {
  readonly id = "fake-unset";
  readonly name = "Fake Unset (synthetic)";
  calls = 0;
  descriptor(): ProviderDescriptor {
    return { id: this.id, name: this.name, state: "not_configured", note: "no env keys in this test", coverage: ["index"], externalDisplayConfirmed: false };
  }
  /* Real providers never claim coverage while unconfigured. */
  canServe(_instrument: MarketInstrument): boolean {
    return false;
  }
  async getQuotes(_instruments: MarketInstrument[]): Promise<{ quotes: CanonicalQuote[]; requestedCount: number }> {
    this.calls += 1;
    throw new Error("must never be called");
  }
}

class FakeCalendarProvider implements CalendarDataProvider {
  readonly id = "fake-cal";
  readonly name = "Fake Calendar (synthetic)";
  calls = 0;
  descriptor(): ProviderDescriptor {
    return { id: this.id, name: this.name, state: "configured", note: "synthetic calendar", coverage: ["calendar"], externalDisplayConfirmed: true };
  }
  async getCalendar(): Promise<{ events: CalendarEvent[] }> {
    this.calls += 1;
    const now = Date.now();
    return {
      events: [
        { title: "Synthetic CPI", titleAr: "تضخم تجريبي", at: now + 3600_000, country: "United States", countryAr: "الولايات المتحدة", flag: "🇺🇸", impact: "high", sourceId: this.id, sourceName: this.name, asOf: now, freshness: "real-time" },
        { title: "Synthetic CBE", titleAr: "اجتماع المركزي", at: now + 7200_000, country: "Egypt", countryAr: "مصر", flag: "🇪🇬", impact: "high", sourceId: this.id, sourceName: this.name, asOf: now, freshness: "real-time" },
      ],
    };
  }
}

const fakeGood = new FakeGoodProvider();
const fakeBad = new FakeBadProvider();
const fakeUnset = new FakeUnsetProvider();
const fakeCal = new FakeCalendarProvider();
let service: MarketDataService;
let serviceModule: typeof import("../lib/market-data/service");

const SUPER_ADMIN = { email: "super.mkt@example.test", password: "SuperMktSynth1!" };
const ADMIN = { email: "admin.mkt@example.test", password: "AdminMktSynth1!" };
const EDITOR = { email: "editor.mkt@example.test", password: "EditorMktSynth1!" };
const SUPPORT = { email: "support.mkt@example.test", password: "SupportMktSynth1!" };

let superJar: CookieJar;
let adminJar: CookieJar;
let editorJar: CookieJar;
let supportJar: CookieJar;

before(async () => {
  memory = await createMemoryDatabase();
  (globalThis as typeof globalThis & { __egytrendTestDatabase?: typeof memory.db }).__egytrendTestDatabase = memory.db;

  await memory.db.insert(employeesTable).values([
    { name: "Mkt Super", email: SUPER_ADMIN.email, role: "super_admin", status: "active", passwordHash: employeePasswordHash(SUPER_ADMIN.password) },
    /* No explicit permission list: role-only access (as in production). */
    { name: "Mkt Admin", email: ADMIN.email, role: "admin", status: "active", passwordHash: employeePasswordHash(ADMIN.password) },
    { name: "Mkt Editor", email: EDITOR.email, role: "editor", status: "active", passwordHash: employeePasswordHash(EDITOR.password) },
    { name: "Mkt Support", email: SUPPORT.email, role: "support", status: "active", passwordHash: employeePasswordHash(SUPPORT.password) },
  ]);

  /* Inject deterministic providers BEFORE the app is imported. */
  serviceModule = await import("../lib/market-data/service");
  service = new serviceModule.MarketDataService(
    [fakeGood, fakeBad, fakeUnset],
    [fakeCal],
    createMarketCache(),
  );
  serviceModule.setMarketDataServiceForTest(service);

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
  editorJar = await adminLogin(EDITOR.email, EDITOR.password);
  supportJar = await adminLogin(SUPPORT.email, SUPPORT.password);
});

after(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
  serviceModule?.resetMarketDataServiceForTest();
  if (memory) await memory.close();
  delete (globalThis as typeof globalThis & { __egytrendTestDatabase?: typeof memory.db }).__egytrendTestDatabase;
});

const SETTINGS_KEY = "market_provider_toggles";

async function settingsRow(): Promise<string | null> {
  const [row] = await memory.db.select().from(appSettingsTable).where(eq(appSettingsTable.key, SETTINGS_KEY));
  return row?.value ?? null;
}

test("overview lists every provider with proven state and no credentials", async () => {
  const r = await api("/api/admin/settings/market-providers", superJar);
  assert.equal(r.response.status, 200);
  const overview = r.body?.["overview"] as Record<string, unknown> | undefined;
  assert.ok(overview, "overview payload present");
  const providers = (overview?.providers as Array<Record<string, unknown>>) || [];
  const byId = new Map(providers.map((p) => [String(p.id), p]));
  assert.equal(byId.get("fake-good")?.["state"], "configured");
  assert.equal(byId.get("fake-unset")?.["state"], "not_configured");
  assert.equal(byId.get("fake-cal")?.["kind"], "calendar");
  assert.equal(byId.get("fake-good")?.["servesInstrumentCount"], MARKET_INSTRUMENTS.length, "serves the full board catalog");
  /* Board not fetched yet in this process: honest null, not invented data. */
  assert.equal(overview?.board, null, "no snapshot → board is null, not fabricated");
  const instruments = (overview?.instruments as Array<Record<string, unknown>>) || [];
  assert.ok(instruments.length === MARKET_INSTRUMENTS.length);
  assert.ok(instruments.every((i) => i.state === "no-verified-quote"), "every instrument reported as unverified before any real fetch");
  /* Credential material must never appear in the payload. */
  const raw = r.raw.toLowerCase();
  assert.ok(!raw.includes("api_key") && !raw.includes("apikey") && !raw.includes("x-cg-pro"), "no credential markers in the admin payload");
});

test("probe performs one real call with a timestamp and never records health", async () => {
  const beforeCalls = fakeGood.calls;
  const r = await api("/api/admin/settings/market-providers/fake-good/test", superJar, { method: "POST", body: "{}" });
  assert.equal(r.response.status, 200);
  const result = r.body?.result as Record<string, unknown> | undefined;
  assert.ok(result, "probe result present");
  assert.equal(result?.ok, true);
  assert.equal(typeof result?.["testedAt"], "number", "probe result carries its own timestamp");
  assert.equal(typeof result?.price, "number");
  assert.equal(typeof result?.asOf, "number");
  assert.equal(result?.symbol, "EGX30", "first catalog instrument is the probe target");
  assert.equal(fakeGood.calls, beforeCalls + 1, "exactly one provider call");

  /* A failing configured provider reports the reason, not a success. */
  const bad = await api("/api/admin/settings/market-providers/fake-bad/test", superJar, { method: "POST", body: "{}" });
  const badResult = bad.body?.result as Record<string, unknown> | undefined;
  assert.equal(badResult?.ok, false);
  assert.equal(typeof badResult?.error, "string");

  /* Calendar probe: event count + first title. */
  const cal = await api("/api/admin/settings/market-providers/fake-cal/test", superJar, { method: "POST", body: "{}" });
  const calResult = cal.body?.result as Record<string, unknown> | undefined;
  assert.equal(calResult?.ok, true);
  assert.equal(calResult?.["eventCount"], 2);
  assert.ok(String(calResult?.firstEventTitle).includes("Synthetic"));

  /* An unconfigured provider is answered honestly WITHOUT any upstream call. */
  const unsetCallsBefore = fakeUnset.calls;
  const unset = await api("/api/admin/settings/market-providers/fake-unset/test", superJar, { method: "POST", body: "{}" });
  const unsetResult = unset.body?.result as Record<string, unknown> | undefined;
  assert.equal(unsetResult?.ok, false);
  assert.ok(String(unsetResult?.error).length > 0);
  assert.equal(fakeUnset.calls, unsetCallsBefore, "no upstream call for an unconfigured provider");

  /* Probe is read-only: no health rows for the probed providers. */
  const health = await api("/api/markets/sources", { });
  assert.equal(health.response.status, 200);
  const healthProviders = ((health.body?.health as Array<Record<string, unknown>>) || []);
  const goodHealth = healthProviders.find((h) => h.providerId === "fake-good");
  assert.equal(goodHealth?.["lastSuccessAt"], undefined, "probe must not write success health");
  assert.equal(goodHealth?.["consecutiveFailures"], 0);
});

test("disable persists to app_settings, blocks the provider, and re-enabling reverts", async () => {
  const usDefs: StockDefinition[] = [{ id: "us:aapl", sym: "AAPL", name: "Apple", sector: "Tech" }];
  const egxDefs: StockDefinition[] = [{ id: "egx:COMI", sym: "COMI", name: "Commercial International", sector: "بنوك" }];

  /* Disable first (fresh snapshot keys in this process): admin allowed,
   * persisted, impact computed. */
  const dis = await api("/api/admin/settings/market-providers/fake-good/set-disabled", adminJar, { method: "POST", body: JSON.stringify({ disabled: true }) });
  assert.equal(dis.response.status, 200, JSON.stringify(dis.body));
  assert.equal(dis.body?.["disabled"], true);
  const impact = dis.body?.impact as Record<string, unknown>;
  assert.ok(Array.isArray(impact?.instrumentSymbols) && (impact.instrumentSymbols as string[]).includes("EGX30"), "impact lists the affected instruments");
  assert.ok(((impact?.otherConfiguredProviders as Array<Record<string, unknown>>) || []).some((p) => p.id === "fake-bad"), "impact names the remaining configured provider");

  const stored = await settingsRow();
  assert.ok(stored && stored.includes("fake-good"), "disable persisted in app_settings");

  const overview = await api("/api/admin/settings/market-providers", superJar);
  const providers = (overview.body?.overview as Record<string, unknown>)?.providers as Array<Record<string, unknown>>;
  const good = providers.find((p) => p.id === "fake-good");
  assert.equal(good?.adminDisabled, true, "overview reflects the admin-disabled state");

  /* Fail-closed: with the only good source disabled, fresh snapshots must
   * refuse rather than invent a price. fake-bad throws, fake-unset is
   * unconfigured (canServe=false) → no accepted quotes. */
  await assert.rejects(
    () => service.getStocks("us", usDefs),
    /failed/i,
    "no verified source → explicit failure, never a fabricated quote",
  );
  await assert.rejects(
    () => service.getStocks("egx", egxDefs),
    /failed/i,
    "EGX instruments fail closed too",
  );

  /* Re-enable (revert): the same instruments are served again. */
  const en = await api("/api/admin/settings/market-providers/fake-good/set-disabled", adminJar, { method: "POST", body: JSON.stringify({ disabled: false }) });
  assert.equal(en.response.status, 200);
  const storedAfter = await settingsRow();
  assert.ok(!storedAfter?.includes("fake-good"), "re-enable removed the id from app_settings");
  const restored = await service.getStocks("us", usDefs);
  assert.equal(restored.quotes.length, 1, "re-enabled provider serves again");
  const restoredEgx = await service.getStocks("egx", egxDefs);
  assert.equal(restoredEgx.quotes.length, 1, "EGX served again after revert");
});

test("unconfigured providers cannot be toggled; probing them never calls upstream", async () => {
  const r = await api("/api/admin/settings/market-providers/fake-unset/set-disabled", superJar, { method: "POST", body: JSON.stringify({ disabled: true }) });
  assert.equal(r.response.status, 409, "unconfigured provider is not selectable");
  const stored = await settingsRow();
  assert.ok(!stored?.includes("fake-unset"), "no state written for the refused toggle");

  const unknown = await api("/api/admin/settings/market-providers/no-such-provider/set-disabled", superJar, { method: "POST", body: JSON.stringify({ disabled: true }) });
  assert.equal(unknown.response.status, 404);
});

test("permissions: mutations admin+ only; reads for any staff; audit recorded", async () => {
  const noAuth = await api("/api/admin/settings/market-providers/fake-good/set-disabled", {}, { method: "POST", body: JSON.stringify({ disabled: true }) });
  assert.equal(noAuth.response.status, 401);

  const editorMut = await api("/api/admin/settings/market-providers/fake-good/set-disabled", editorJar, { method: "POST", body: JSON.stringify({ disabled: true }) });
  assert.equal(editorMut.response.status, 403, "editor cannot toggle market providers");

  const supportMut = await api("/api/admin/settings/market-providers/fake-good/set-disabled", supportJar, { method: "POST", body: JSON.stringify({ disabled: true }) });
  assert.equal(supportMut.response.status, 403, "support cannot toggle market providers");

  const editorRead = await api("/api/admin/settings/market-providers", editorJar);
  assert.equal(editorRead.response.status, 200, "read is available to staff roles");

  /* The admin toggle from the previous test must be audit-logged. */
  const rows = await memory.db.select().from(auditLogsTable).where(eq(auditLogsTable.action, "market_provider_disable"));
  assert.ok(rows.length >= 1, "market_provider_disable audited");
  assert.ok(rows.some((row) => row.target === "fake-good"), "audit names the provider");
});
