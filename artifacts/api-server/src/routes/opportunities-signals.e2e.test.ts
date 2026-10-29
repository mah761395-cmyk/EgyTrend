import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { after, before, test } from "node:test";
import { opportunities, employeesTable, marketDailyOhlcTable } from "@workspace/db/schema";
import { createMemoryDatabase } from "../test-support/memory-db";
import {
  MarketDataService,
  resetMarketDataServiceForTest,
  setMarketDataServiceForTest,
} from "../lib/market-data/service";
import { cacheEntry, MemoryJsonCache } from "../lib/market-data/cache";
import type { StoredMarketOhlc } from "../lib/market-data/history";
import type {
  CanonicalQuote,
  DailyOhlc,
  MarketDataProvider,
  MarketInstrument,
  ProviderDescriptor,
  ProviderQuoteResult,
} from "../lib/market-data/types";

/* ═══════════════════════════════════════════════════════════════════════
 * TASK M (M4/M5): structured opportunity signals end to end.
 *
 *   • generation fails closed while the verified history store is empty —
 *     no card, no fallback invention;
 *   • once verified bars + one live quote exist, the engine publishes an
 *     explainable, VIP-only signal card with structured levels;
 *   • regeneration on the same Cairo day never duplicates the card;
 *   • non-VIP readers get the structured payload masked;
 *   • a verified live price crossing the target realizes the card (the row
 *     is kept — history and results are never deleted);
 *   • the cron entry point mirrors the other crons (404 without auth).
 * ═══════════════════════════════════════════════════════════════════════ */

process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "test-only-opp-signals-secret";
process.env.LOG_LEVEL = "silent";
process.env.MARKET_SNAPSHOT_CRON_SECRET = "test-only-opp-signals-cron-secret";

const ADMIN = { email: "admin.opp@example.test", password: "AdminOppSynth1!" };
const USER = { phone: "01011112233", name: "Mask Tester", password: "Passw0rd!23" };
const BOARD_CACHE_KEY = "egytrend:market:quotes:v2:board";

/** Board-shaped provider: prices crypto:BTC (mutable) and nothing else. The
 * getDailyOhlc method (no-op) exists so the provider also qualifies as a
 * history-capable, display-approved source for the stored bars. */
class SignalBoardProvider implements MarketDataProvider {
  readonly id = "signal-board";
  get name(): string { return "Signal Board"; }
  btcPrice = 110_000;
  descriptor = (): ProviderDescriptor => ({
    id: this.id,
    name: this.name,
    state: "configured",
    note: "synthetic signal board",
    coverage: ["crypto"],
    externalDisplayConfirmed: true,
  });
  canServe = (item: MarketInstrument): boolean => item.id === "crypto:BTC";
  async getQuotes(instruments: MarketInstrument[]): Promise<ProviderQuoteResult> {
    const now = Date.now();
    const quotes: CanonicalQuote[] = instruments
      .filter((item) => item.id === "crypto:BTC")
      .map((item) => ({
        instrumentId: item.id,
        price: this.btcPrice,
        currency: "USD",
        asOf: now,
        sourceId: this.id,
        sourceName: this.name,
        freshness: "real-time",
      }));
    return { quotes, requestedCount: instruments.length };
  }
  async getDailyOhlc(): Promise<DailyOhlc[]> { return []; }
}

type MemoryDatabase = Awaited<ReturnType<typeof createMemoryDatabase>>;
let memory: MemoryDatabase;
let server: http.Server;
let baseUrl = "";
let adminJar: { value?: string } = {};
let userJar: { value?: string } = {};
const testCache = new MemoryJsonCache();
const provider = new SignalBoardProvider();

function employeePasswordHash(password: string): string {
  const salt = "00112233445566778899aabbccddeeff";
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

async function api(path: string, jar: { value?: string }, init: RequestInit = {}, extraHeaders: Record<string, string> = {}) {
  const headers = new Headers(init.headers);
  headers.set("Origin", baseUrl);
  for (const [key, value] of Object.entries(extraHeaders)) headers.set(key, value);
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

async function setBoardPrice(price: number): Promise<void> {
  provider.btcPrice = price;
  /* Age the board snapshot the way time does so the next read re-fetches. */
  await testCache.set(BOARD_CACHE_KEY, cacheEntry([], 0, 0, Date.now() - 61_000));
}

async function insertBtcHistory(): Promise<void> {
  const now = Date.now();
  const rows = [];
  for (let i = 0; i < 25; i += 1) {
    const ts = now - (25 - i) * 86_400_000;
    const day = new Date(ts).toISOString().slice(0, 10);
    const close = 100_000 + i * 400;
    rows.push({
      id: `hist-signal-board-btc-${day}`,
      instrumentId: "crypto:BTC",
      sourceId: "signal-board",
      sourceName: "Signal Board",
      tradingDate: day,
      open: close,
      high: close + 1_000,
      low: close - 1_000,
      close,
      volume: 1_000_000,
      currency: "USD",
      asOf: new Date(ts),
    });
  }
  await memory.db.insert(marketDailyOhlcTable).values(rows);
}

async function signalRows(): Promise<Array<Record<string, unknown>>> {
  const rows = await memory.db.select().from(opportunities);
  return rows.filter((r) => String(r.sector || "").startsWith("[SIGNAL]"));
}

before(async () => {
  memory = await createMemoryDatabase();
  (globalThis as typeof globalThis & { __egytrendTestDatabase?: typeof memory.db }).__egytrendTestDatabase = memory.db;

  await memory.db.insert(employeesTable).values([
    { name: "Opp Admin", email: ADMIN.email, role: "admin", status: "active", passwordHash: employeePasswordHash(ADMIN.password) },
  ]);

  setMarketDataServiceForTest(new MarketDataService([provider], [], testCache));

  const { setOpportunityHistoryReaderForTest } = await import("./opportunities");
  setOpportunityHistoryReaderForTest({
    async list(instrumentIds: string[], fromDate?: string): Promise<StoredMarketOhlc[]> {
      /* Plain equivalent of the real reader (pg-mem cannot run its ranked
       * window-function query). Same contract, same data. */
      const rows = await memory.db.select().from(marketDailyOhlcTable);
      return rows
        .filter((r) => instrumentIds.includes(r.instrumentId) && (!fromDate || r.tradingDate >= fromDate))
        .sort((a, b) => a.tradingDate.localeCompare(b.tradingDate))
        .map((r) => ({
          instrumentId: r.instrumentId,
          sourceId: r.sourceId,
          sourceName: r.sourceName,
          tradingDate: r.tradingDate,
          open: r.open,
          high: r.high,
          low: r.low,
          close: r.close,
          volume: r.volume,
          currency: r.currency,
          delayedMinutes: r.delayedMinutes,
          asOf: r.asOf,
        }));
    },
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

  const login = await api("/api/admin/login", adminJar, { method: "POST", body: JSON.stringify(ADMIN) });
  assert.equal(login.response.status, 200, JSON.stringify(login.body));
});

after(async () => {
  const { setOpportunityHistoryReaderForTest } = await import("./opportunities");
  setOpportunityHistoryReaderForTest(null);
  resetMarketDataServiceForTest();
  if (server) {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
  if (memory) await memory.close();
  delete (globalThis as typeof globalThis & { __egytrendTestDatabase?: typeof memory.db }).__egytrendTestDatabase;
});

test("GET /api/opportunities: nothing is served before any generation", async () => {
  const r = await api("/api/opportunities", adminJar);
  assert.equal(r.response.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body?.opportunities, []);
});

test("generation with an empty verified history fails closed — no invented cards", async () => {
  const r = await api("/api/opportunities/generate", adminJar, { method: "POST", body: "{}" });
  assert.equal(r.response.status, 200, JSON.stringify(r.body));
  assert.equal(r.body?.signals, 0, "no history, no signal — the engine refuses to guess");
  assert.equal(r.body?.inserted, 0);
  assert.ok(typeof r.body?.noteAr === "string" && r.body.noteAr.length > 0, "an honest Arabic reason is returned");
  assert.equal((await signalRows()).length, 0);
});

test("admin without admin role cannot generate", async () => {
  const r = await api("/api/opportunities/generate", { value: "" }, { method: "POST", body: "{}" });
  assert.equal(r.response.status, 401);
});

test("verified history + live quote produce an explainable signal card", async () => {
  await insertBtcHistory();
  const r = await api("/api/opportunities/generate", adminJar, { method: "POST", body: "{}" });
  assert.equal(r.response.status, 200, JSON.stringify(r.body));
  assert.equal(r.body?.signals, 1, JSON.stringify(r.body));

  const rows = await signalRows();
  assert.equal(rows.length, 1);
  const row = rows[0] as any;
  assert.equal(row.market, "crypto");
  assert.equal(row.type, "crypto");
  assert.equal(row.vipOnly, true, "signal cards stay behind the VIP gate");
  assert.equal(row.status, "active");
  assert.equal(row.expectedReturn, null, "no projected-return claims, ever");
  assert.ok(row.title.includes("اختراق") || row.title.includes("ارتداد") || row.title.includes("اتجاه صاعد"));

  const sig = row.signal;
  assert.ok(sig && typeof sig === "object", "the structured payload is persisted");
  assert.equal(sig.instrumentId, "crypto:BTC");
  assert.equal(sig.price, 110_000, "the card states the verified price it was built from");
  assert.ok(typeof sig.priceAsOf === "number");
  assert.equal(sig.priceTimeBasis, "source");
  assert.ok(sig.signalType === "uptrend", `expected the uptrend reading, got ${sig.signalType}`);
  assert.ok(sig.reasonAr.length > 20, "the reason names the evidence");
  assert.ok(Array.isArray(sig.factors) && sig.factors.length >= 2, "factors are listed");
  for (const f of sig.factors) {
    assert.ok(typeof f.labelAr === "string" && typeof f.points === "number");
  }
  assert.ok(sig.strength >= 5 && sig.strength <= 95, "strength stays away from certainties");
  assert.ok(sig.entry.low < sig.entry.high);
  assert.ok(sig.stopLoss > 0 && sig.stopLoss < sig.entry.high, "the stop sits below the entry zone");
  assert.ok(sig.targets.t1 > sig.price && sig.targets.t2 > sig.targets.t1, "ordered targets");
  assert.ok(sig.rewardRisk > 0);
  assert.ok(sig.timeframeAr.length > 3);
  assert.ok(sig.scenarioPositiveAr.length > 20 && sig.scenarioNegativeAr.length > 20);
  assert.ok(sig.scenarioNegativeAr.includes("لا ضمان"), "no-guarantee wording is mandatory");
  assert.ok(Array.isArray(sig.dataSources) && sig.dataSources.length >= 2, "history + live source are named");
  assert.match(sig.dedupeKey, /^crypto:BTC:uptrend:\d{4}-\d{2}-\d{2}$/);
  assert.equal(row.firstPrice, 110_000);
});

test("regeneration on the same Cairo day never duplicates the card", async () => {
  const r = await api("/api/opportunities/generate", adminJar, { method: "POST", body: "{}" });
  assert.equal(r.response.status, 200, JSON.stringify(r.body));
  assert.equal(r.body?.signals, 0);
  assert.equal((r.body?.skipped as { duplicate?: number } | undefined)?.duplicate, 1, JSON.stringify(r.body?.skipped));
  assert.equal((await signalRows()).length, 1, "still exactly one card");
});

test("a plain registered user sees the card masked (no structured payload)", async () => {
  const reg = await api("/api/user/register", { value: "" }, {
    method: "POST",
    body: JSON.stringify(USER),
  });
  assert.equal(reg.response.status, 201, JSON.stringify(reg.body));
  const login = await api("/api/user/login", userJar, {
    method: "POST",
    body: JSON.stringify({ phone: USER.phone, password: USER.password }),
  });
  assert.equal(login.response.status, 200, JSON.stringify(login.body));

  const r = await api("/api/opportunities", userJar);
  assert.equal(r.response.status, 200, JSON.stringify(r.body));
  const list = (r.body?.opportunities || []) as any[];
  assert.equal(list.length, 1, "the VIP upsell view still sees the title");
  assert.ok(list[0].title.length > 0);
  assert.equal(list[0].details, null, "details are masked");
  assert.equal(list[0].signal, null, "the structured payload is masked");
  assert.equal(list[0].liveUpdate, null, "the live update is masked");
});

test("admin GET: the active signal card carries a read-only live update", async () => {
  const r = await api("/api/opportunities", adminJar);
  assert.equal(r.response.status, 200, JSON.stringify(r.body));
  const list = (r.body?.opportunities || []) as any[];
  const card = list.find((o) => String(o.sector || "").startsWith("[SIGNAL]"));
  assert.ok(card, "the signal card is visible to the admin");
  assert.ok(card.liveUpdate, "a live update is attached");
  assert.equal(card.liveUpdate.statusNow, "active", JSON.stringify(card.liveUpdate));
  assert.equal(card.liveUpdate.price, 110_000, "the live price comes from the verified quote");
  assert.ok(typeof card.liveUpdate.priceAsOf === "number");
});

test("a verified live price reaching the target realizes the card, and the row is kept", async () => {
  await setBoardPrice(120_000);
  const r = await api("/api/opportunities/generate", adminJar, { method: "POST", body: "{}" });
  assert.equal(r.response.status, 200, JSON.stringify(r.body));
  assert.equal((r.body?.lifecycle as { realized?: number } | undefined)?.realized, 1, JSON.stringify(r.body?.lifecycle));

  const rows = await signalRows();
  /* The realized uptrend card stays (history is never deleted). The same
   * price move — now above the 20-day high — legitimately opens a NEW
   * regime: a breakout card, deduped by its own type+day key. */
  assert.equal(rows.length, 2, JSON.stringify(rows.map((row) => ({ s: row.status, t: (row.signal as any)?.signalType }))));
  const realized = rows.filter((row) => row.status === "realized");
  assert.equal(realized.length, 1, "the realized card is kept — history is never deleted");
  assert.equal(realized[0].result, "target_hit");
  assert.ok(realized[0].realizedAt, "the crossing time is recorded");
  const active = rows.filter((row) => row.status === "active");
  assert.equal(active.length, 1);
  assert.equal((active[0].signal as any)?.signalType, "breakout", "above the 20-day high the reading is a breakout");
});

test("the cron entry point mirrors the other crons (404 without auth, 200 with the secret)", async () => {
  const open = await api("/api/opportunities/cron", { value: "" });
  assert.equal(open.response.status, 404, "existence is not advertised");

  const wrong = await api("/api/opportunities/cron", { value: "" }, { method: "POST", body: "{}" }, { "x-cron-secret": "wrong-secret" });
  assert.equal(wrong.response.status, 404);

  const ok = await api("/api/opportunities/cron", { value: "" }, { method: "POST", body: "{}" }, { "x-cron-secret": "test-only-opp-signals-cron-secret" });
  assert.equal(ok.response.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body?.status, "ok");
});

test("cron cycles are idempotent and no row is ever deleted", async () => {
  const beforeCount = (await signalRows()).length;
  const ok = await api("/api/opportunities/cron", { value: "" }, { method: "POST", body: "{}" }, { "x-cron-secret": "test-only-opp-signals-cron-secret" });
  assert.equal(ok.response.status, 200);
  assert.equal((await signalRows()).length, beforeCount, "re-running the cycle changes nothing");
  const all = await memory.db.select().from(opportunities);
  for (const row of all) {
    assert.ok(["active", "coming", "closed", "realized", "expired", "cancelled"].includes(String(row.status)), `unexpected status ${row.status}`);
  }
});
