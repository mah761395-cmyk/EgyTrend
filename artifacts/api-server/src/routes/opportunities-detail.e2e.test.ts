import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import jwt from "jsonwebtoken";
import { opportunities, appUsersTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { createMemoryDatabase } from "../test-support/memory-db";
import {
  MarketDataService,
  resetMarketDataServiceForTest,
  setMarketDataServiceForTest,
} from "../lib/market-data/service";
import { cacheEntry, MemoryJsonCache } from "../lib/market-data/cache";
import type {
  CanonicalQuote,
  DailyOhlc,
  MarketDataProvider,
  MarketInstrument,
  ProviderDescriptor,
  ProviderQuoteResult,
} from "../lib/market-data/types";

/* ═══════════════════════════════════════════════════════════════════════
 * Opportunity detail page (GET /api/opportunities/:id) end to end:
 *   • the detail answers from the STORED row — fields match the original
 *     exactly (no drift, no recomputation of saved levels);
 *   • the explanation quotes only stored numbers (anti-fabrication);
 *   • a non-VIP reader gets the same masked view as the list, and the
 *     explanation leaks nothing;
 *   • terminal (history) cards stay readable — outcomes are not deleted;
 *   • unknown ids are 404, never invented details.
 * ═══════════════════════════════════════════════════════════════════════ */

process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "test-only-opp-detail-secret";
process.env.LOG_LEVEL = "silent";

/* Hermetic market layer: one provider that serves nothing — the detail
 * route's live-status enrichment must degrade to "no verified price"
 * without touching the real market stack. */
class EmptyBoardProvider implements MarketDataProvider {
  readonly id = "empty-board";
  get name(): string { return "Empty Board"; }
  descriptor = (): ProviderDescriptor => ({
    id: this.id, name: this.name, state: "configured",
    note: "synthetic empty board", coverage: ["crypto"], externalDisplayConfirmed: true,
  });
  canServe = (item: MarketInstrument): boolean => item.id === "crypto:BTC";
  async getQuotes(instruments: MarketInstrument[]): Promise<ProviderQuoteResult> {
    const quotes: CanonicalQuote[] = instruments.map((item) => ({
      instrumentId: item.id, price: 1, currency: "USD", asOf: Date.now(),
      sourceId: this.id, sourceName: this.name, freshness: "real-time",
    }));
    return { quotes, requestedCount: instruments.length };
  }
  async getDailyOhlc(): Promise<DailyOhlc[]> { return []; }
}

type MemoryDatabase = Awaited<ReturnType<typeof createMemoryDatabase>>;
let memory: MemoryDatabase;
let server: http.Server;
let baseUrl = "";
let vipCookie = "";
let freeCookie = "";

const VIP = { phone: "01022220001", name: "VIP Detail" };
const FREE = { phone: "01022220002", name: "Free Detail" };

const SIGNAL = {
  signalType: "breakout",
  signalTypeAr: "اختراق مقاومة",
  name: "سوديك",
  symbol: "SWDY",
  price: 12.4,
  priceAsOf: 1761579600000,
  priceTimeBasis: "fetch",
  changePercent: 1.8,
  strength: 68,
  strengthLabelAr: "متوسطة+",
  factors: [
    { id: "trend_sma20", labelAr: "السعر فوق المتوسط المتحرك 20 (12.1)", points: 15 },
    { id: "volume_surge", labelAr: "حجم تداول أعلى من المتوسط بـ 1.9 مرة", points: 12 },
  ],
  entry: { low: 12.1, high: 12.4, noteAr: "استقرار فوق 12.1" },
  stopLoss: 11.7,
  targets: { t1: 13.1, t2: 13.8 },
  rewardRisk: 1.1,
  timeframeAr: "5–15 يوم تداول",
  scenarioPositiveAr: "زخم الاستمرار يدفع نحو الهدف الأول.",
  scenarioNegativeAr: "كسر 11.7 يلغي الفكرة.",
  dataSources: [
    { name: "سجل التداول الموثق", asOf: 1761493200000, basis: "history" },
    { name: "لوحة الأسعار", asOf: 1761579600000, basis: "fetch" },
  ],
};

const SIGNAL_ROW = {
  id: "det-signal-1",
  title: "اختراق مقاومة على سوديك بحجم مرتفع",
  summary: "اختراق فوق المقاومة مع تضخم الحجم.",
  details: "النوع: اختراق مقاومة — القوة: 68/100",
  type: "stock",
  market: "egypt",
  expectedReturn: null,
  riskLevel: 3,
  sector: "[SIGNAL] عقارية",
  duration: null,
  deadline: null,
  status: "active",
  featured: false,
  vipOnly: true,
  createdAt: new Date(1761579600000),
  updatedAt: new Date(1761579600000),
  instrumentId: "stock:egx:SWDY",
  signal: SIGNAL as unknown as Record<string, unknown>,
  firstPrice: 12.4,
  result: null,
  realizedAt: null,
};

const DESC_ROW = {
  ...SIGNAL_ROW,
  id: "det-desc-1",
  title: "لقطة وصفية عن الطروحات",
  summary: "ملخص لقطة وصفية.",
  details: "تفاصيل نصية.",
  sector: "[AUTO] شركات",
  vipOnly: false,
  instrumentId: null,
  signal: null,
  firstPrice: null,
};

const REALIZED_ROW = {
  ...SIGNAL_ROW,
  id: "det-realized-1",
  title: "فرصة قديمة تحققت",
  status: "realized",
  result: "target_hit",
  realizedAt: new Date(1761700000000),
  vipOnly: false,
};

async function api(path: string, init: RequestInit = {}, cookie = "") {
  const headers = new Headers(init.headers);
  headers.set("Origin", baseUrl);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (cookie) headers.set("Cookie", cookie);
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
  const raw = await response.text();
  let body: Record<string, any> | null = null;
  try { body = raw ? JSON.parse(raw) : null; } catch { /* non-JSON */ }
  return { response, body, raw };
}

function sessionCookie(sub: number, phone: string, name: string, plan: string): string {
  return `et_user_session=${jwt.sign({ sub, phone, name, role: "user", plan }, process.env.SESSION_SECRET!, { expiresIn: "1h" })}`;
}

before(async () => {
  memory = await createMemoryDatabase();
  (globalThis as typeof globalThis & { __egytrendTestDatabase?: typeof memory.db }).__egytrendTestDatabase = memory.db;

  setMarketDataServiceForTest(new MarketDataService([new EmptyBoardProvider()], [], new MemoryJsonCache()));

  const now = new Date();
  const [vipUser] = await memory.db.insert(appUsersTable).values({
    phone: VIP.phone, name: VIP.name, email: null, emailVerifiedAt: null,
    passwordHash: "x", plan: "vip", vipExpiresAt: new Date(now.getTime() + 86_400_000),
    status: "active", createdAt: now, updatedAt: now,
  }).returning({ id: appUsersTable.id });
  const [freeUser] = await memory.db.insert(appUsersTable).values({
    phone: FREE.phone, name: FREE.name, email: null, emailVerifiedAt: null,
    passwordHash: "x", plan: "free", vipExpiresAt: null,
    status: "active", createdAt: now, updatedAt: now,
  }).returning({ id: appUsersTable.id });
  vipCookie = sessionCookie(vipUser.id, VIP.phone, VIP.name, "vip");
  freeCookie = sessionCookie(freeUser.id, FREE.phone, FREE.name, "free");

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
  resetMarketDataServiceForTest();
  if (server) {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
  if (memory) await memory.close();
  delete (globalThis as typeof globalThis & { __egytrendTestDatabase?: typeof memory.db }).__egytrendTestDatabase;
});

test("an unknown id is a 404 — no invented details (DB still empty)", async () => {
  const res = await api("/api/opportunities/does-not-exist", {}, vipCookie);
  assert.equal(res.response.status, 404);
  const bad = await api("/api/opportunities/bad id!!", {}, vipCookie);
  assert.equal(bad.response.status, 400);
});

test("seed the stored rows", async () => {
  await memory.db.insert(opportunities).values([SIGNAL_ROW, DESC_ROW, REALIZED_ROW] as any);
  const all = await memory.db.select().from(opportunities);
  assert.equal(all.length, 3);
});

test("the detail matches the stored row exactly (VIP reader)", async () => {
  const res = await api("/api/opportunities/det-signal-1", {}, vipCookie);
  assert.equal(res.response.status, 200, res.raw);
  assert.equal(res.body?.status, "ok");
  assert.equal(res.body?.origin, "db");
  const o = res.body?.opportunity;
  assert.equal(o.title, SIGNAL_ROW.title);
  assert.equal(o.summary, SIGNAL_ROW.summary);
  assert.equal(o.sector, SIGNAL_ROW.sector);
  assert.equal(o.riskLevel, SIGNAL_ROW.riskLevel);
  assert.equal(o.vipOnly, true);
  assert.equal(o.signal.stopLoss, SIGNAL.stopLoss);
  assert.equal(o.signal.targets.t1, SIGNAL.targets.t1);
  assert.equal(o.signal.targets.t2, SIGNAL.targets.t2);
  assert.equal(o.signal.entry.low, SIGNAL.entry.low);
  assert.equal(o.createdAt, new Date(1761579600000).toISOString());

  const ex = res.body?.explanation;
  assert.equal(ex.masked, false);
  assert.equal(ex.technical.present, true);
  assert.equal(ex.technical.stopLoss, 11.7);
  assert.equal(ex.identity.symbol, "SWDY");
  assert.equal(ex.identity.sector, "عقارية");
  assert.equal(ex.identity.createdPrice, 12.4);
  // the empty board verified no current price — the page must say so, not invent one
  assert.equal(ex.identity.currentPrice, null);

  // anti-fabrication: every number in the narrative pre-exists in storage
  const allowed = new Set<number>();
  const addAll = (blob: string) => {
    for (const m of blob.match(/\d+(?:\.\d+)?/g) || []) allowed.add(Number(m));
  };
  addAll(JSON.stringify(SIGNAL_ROW));
  addAll(String(SIGNAL.factors.length));
  allowed.add(100);
  for (const sentence of ex.narrative) {
    for (const n of sentence.match(/\d+(?:\.\d+)?/g) || []) {
      assert.ok(allowed.has(Number(n)), `invented number "${n}" in: ${sentence}`);
    }
  }
  assert.match(ex.narrative[ex.narrative.length - 1], /لا ضمانًا/);
});

test("a non-VIP reader gets the masked row AND a masked explanation", async () => {
  const res = await api("/api/opportunities/det-signal-1", {}, freeCookie);
  assert.equal(res.response.status, 200, res.raw);
  const o = res.body?.opportunity;
  assert.equal(o.details, null);
  assert.equal(o.signal, null);
  assert.equal(o.liveUpdate, null);
  // title/summary stay (same as the list); everything paid is hidden
  assert.equal(o.title, SIGNAL_ROW.title);

  const ex = res.body?.explanation;
  assert.equal(ex.masked, true);
  assert.equal(ex.technical.present, false);
  assert.equal(ex.identity.createdPrice, null);
  assert.equal(ex.news.present, false);
  const joined = JSON.stringify(ex);
  assert.ok(!joined.includes("12.4"), "masked explanation must not leak stored levels");
  assert.ok(!joined.includes("11.7"));
  assert.ok(!joined.includes("13.1"));
});

test("descriptive cards: honest not-available technical sections", async () => {
  const res = await api("/api/opportunities/det-desc-1", {}, freeCookie);
  assert.equal(res.response.status, 200, res.raw);
  const ex = res.body?.explanation;
  assert.equal(ex.masked, false);
  assert.equal(ex.technical.present, false);
  assert.equal(ex.fundamental.present, false);
  assert.match(ex.fundamental.note, /لا توجد بيانات أساسية/);
  assert.equal(ex.news.present, false);
  assert.match(ex.news.note, /لا توجد أخبار/);
  assert.ok(ex.narrative.some((s: string) => s.includes("لقطة وصفية")));
});

test("terminal (history) cards stay readable with their result", async () => {
  const res = await api("/api/opportunities/det-realized-1", {}, freeCookie);
  assert.equal(res.response.status, 200, res.raw);
  assert.equal(res.body?.opportunity.status, "realized");
  assert.equal(res.body?.opportunity.result, "target_hit");
  assert.ok(res.body?.opportunity.realizedAt);
});

test("an id that exists in the DB but is deleted/closed still answers from storage", async () => {
  await memory.db.update(opportunities).set({ status: "closed" }).where(eq(opportunities.id, "det-desc-1"));
  const res = await api("/api/opportunities/det-desc-1", {}, vipCookie);
  assert.equal(res.response.status, 200, res.raw);
  assert.equal(res.body?.opportunity.status, "closed");
});
