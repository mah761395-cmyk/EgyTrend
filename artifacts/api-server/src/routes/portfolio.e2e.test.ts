import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { and, eq, isNull } from "drizzle-orm";
import {
  appUsersTable,
  portfolioPositionsTable,
  portfolioSettingsTable,
  portfolioTransactionsTable,
  userNotificationsTable,
  userSubscriptionsTable,
} from "@workspace/db/schema";
import { createMemoryDatabase } from "../test-support/memory-db";

/* Isolated in-process pg-mem database with synthetic data. No DATABASE_URL,
 * no network listener, no access to a real deployment database. The app is
 * imported only after the test database is injected. */
process.env.NODE_ENV = "test";
/* No market provider can be reached from this harness, so every portfolio
 * read must degrade honestly (market: null, totalValue: null) instead of
 * inventing prices. */
process.env.LEGACY_MARKET_FEEDS_DISABLED = "true";
process.env.SESSION_SECRET = "test-only-session-secret-not-for-deployment";
process.env.LOG_LEVEL = "silent";

type MemoryDatabase = Awaited<ReturnType<typeof createMemoryDatabase>>;
let memory: MemoryDatabase;
let server: http.Server;
let baseUrl = "";

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

async function registerVipUser(phone: string, name: string): Promise<{ jar: CookieJar; userId: number }> {
  const jar: CookieJar = {};
  const registration = await api("/api/user/register", jar, {
    method: "POST",
    body: JSON.stringify({ name, phone, password: "SyntheticUserPass1!" }),
  });
  assert.equal(registration.response.status, 201, `registration for ${phone}`);
  assert.match(jar.value || "", /^et_user_session=/);
  const [user] = await memory.db.select().from(appUsersTable).where(eq(appUsersTable.phone, phone));
  assert.ok(user, "synthetic user row");
  await memory.db.insert(userSubscriptionsTable).values({
    id: `sub-portfolio-${phone}`,
    userId: user.id,
    planKey: "synthetic-vip",
    planNameAr: "باقة اختبار محفظة",
    planDurationMonths: 1,
    planFeatures: [],
    status: "active",
    cycleId: `cycle-portfolio-${phone}`,
    startsAt: new Date(Date.now() - 86_400_000),
    expiresAt: new Date(Date.now() + 30 * 86_400_000),
    source: "test",
  });
  return { jar, userId: user.id };
}

function addTxInit(symbol: string, side: "buy" | "sell", quantity: number, price: number, extra: Record<string, unknown> = {}) {
  return { method: "POST", body: JSON.stringify({ symbol, side, quantity, price, ...extra }) };
}

function positionOf(body: Record<string, unknown> | null, symbol: string) {
  const positions = (body?.positions as Array<Record<string, unknown>>) || [];
  return positions.find((position) => position.symbol === symbol) || null;
}

function summaryOf(body: Record<string, unknown> | null) {
  return (body?.summary as Record<string, unknown>) || {};
}

const near = (actual: unknown, expected: number, eps = 0.011, label = "") => {
  assert.ok(typeof actual === "number" && Number.isFinite(actual), `${label} should be a number, got ${String(actual)}`);
  assert.ok(Math.abs((actual as number) - expected) <= eps, `${label}: expected ${(actual as number)} ≈ ${expected}`);
};

before(async () => {
  memory = await createMemoryDatabase();
  (globalThis as typeof globalThis & { __egytrendTestDatabase?: typeof memory.db }).__egytrendTestDatabase = memory.db;
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
  if (server) {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
  if (memory) await memory.close();
  delete (globalThis as typeof globalThis & { __egytrendTestDatabase?: typeof memory.db }).__egytrendTestDatabase;
});

test("anonymous and free users cannot read or write the portfolio center", async () => {
  const anon = await api("/api/portfolio", {});
  assert.equal(anon.response.status, 401, "anonymous portfolio read is rejected");

  const anonTx = await api("/api/portfolio/transactions", {}, addTxInit("COMI", "buy", 10, 10));
  assert.equal(anonTx.response.status, 401, "anonymous transaction write is rejected");

  const anonAlert = await api("/api/price-alerts", {}, {
    method: "POST",
    body: JSON.stringify({ condition: "portfolio_value_above", targetValue: 100 }),
  });
  assert.equal(anonAlert.response.status, 401, "anonymous portfolio alert write is rejected");

  /* Free user: server-side VIP gate, not the client. */
  const freeJar: CookieJar = {};
  const freeReg = await api("/api/user/register", freeJar, {
    method: "POST",
    body: JSON.stringify({ name: "Free User", phone: "01000000001", password: "FreeUserPass123!" }),
  });
  assert.equal(freeReg.response.status, 201);
  const freeRead = await api("/api/portfolio", freeJar);
  assert.equal(freeRead.response.status, 403, "free user portfolio read is VIP-gated");
  const freeTx = await api("/api/portfolio/transactions", freeJar, addTxInit("COMI", "buy", 10, 10));
  assert.equal(freeTx.response.status, 403, "free user transaction write is VIP-gated");
});

test("multiple buys and sells compute moving-average cost, realized P/L, fees and cash", async () => {
  const { jar } = await registerVipUser("01011110001", "Portfolio Math User");

  /* Buy 100 COMI @ 10 with 10 EGP fees. */
  const buy1 = await api("/api/portfolio/transactions", jar, addTxInit("COMI", "buy", 100, 10, { fees: 10, tradeDate: "2026-09-01" }));
  assert.equal(buy1.response.status, 201, "first buy is saved");
  const tx1 = (buy1.body?.transaction as Record<string, unknown>) || {};
  assert.ok(String(tx1.id || "").length >= 20, "transaction id returned");

  /* Buy 100 COMI @ 14 without fees. */
  const buy2 = await api("/api/portfolio/transactions", jar, addTxInit("COMI", "buy", 100, 14, { tradeDate: "2026-09-05" }));
  assert.equal(buy2.response.status, 201, "second buy is saved");

  /* Sell 60 COMI @ 15 with 5 EGP fees. */
  const sell = await api("/api/portfolio/transactions", jar, addTxInit("COMI", "sell", 60, 15, { fees: 5, tradeDate: "2026-09-10" }));
  assert.equal(sell.response.status, 201, "partial sell is saved");
  const sellTx = (sell.body?.transaction as Record<string, unknown>) || {};
  near(sellTx.realizedPnl, 60 * 15 - 5 - 60 * 12.05, 0.05, "sell realized P/L in response");

  const portfolio = await api("/api/portfolio", jar);
  assert.equal(portfolio.response.status, 200);
  const body = portfolio.body as Record<string, unknown>;
  const comi = positionOf(body, "COMI");
  assert.ok(comi, "COMI position exists");
  assert.equal(comi.quantity, 140, "held quantity after partial sell");
  near(comi.averageCost, 12.05, 0.001, "moving average cost");
  near(comi.realizedPnl, 172, 0.05, "position realized P/L");
  assert.equal(comi.legacy, false);
  /* No reachable provider in this harness: the market block must be null,
   * never a fabricated price. */
  assert.equal(comi.market, null, "no provider → market is null");
  assert.equal(comi.marketValue, null);
  assert.equal(comi.weightPct, null);

  const summary = summaryOf(body);
  near(summary.cash, -2410 + 895, 0.05, "cash = −(1000+10) −1400 + (900−5)");
  near(summary.investedCost, 140 * 12.05, 0.05, "cost basis of held shares");
  near(summary.realizedPnl, 172, 0.05, "summary realized P/L");
  near(summary.totalFees, 15, 0.011, "summary total fees");
  assert.equal(summary.buyCount, 2);
  assert.equal(summary.sellCount, 1);
  assert.equal(body.marketAvailable, false, "snapshot unavailable in the isolated harness");
  assert.equal(summary.totalValue, null, "total value is not invented without prices");
  near(summary.totalValuePriced, -2410 + 895, 0.05, "priced view equals cash when no prices exist");

  /* The ledger is listed newest-first with per-trade realized P/L. */
  const transactions = (body.transactions as Array<Record<string, unknown>>) || [];
  assert.equal(transactions.length, 3);
  assert.equal(transactions[0].tradeDate, "2026-09-10");
  assert.equal(transactions[0].side, "sell");
  assert.equal(transactions[0].heldAfter, 140);
});

test("selling more than held is rejected with the exact held quantity", async () => {
  const { jar, userId } = await registerVipUser("01011110002", "Oversell User");
  await api("/api/portfolio/transactions", jar, addTxInit("COMI", "buy", 100, 10, { tradeDate: "2026-09-01" }));
  const oversell = await api("/api/portfolio/transactions", jar, addTxInit("COMI", "sell", 140, 12, { tradeDate: "2026-09-02" }));
  assert.equal(oversell.response.status, 400, "oversell rejected");
  assert.equal((oversell.body as { held?: number })?.held, 100, "response carries the held quantity");
  assert.match(String((oversell.body as { message?: string })?.message || ""), /100/);

  /* The rejected trade must not be persisted. */
  const rows = await memory.db.select().from(portfolioTransactionsTable)
    .where(and(
      eq(portfolioTransactionsTable.userId, userId),
      eq(portfolioTransactionsTable.symbol, "COMI"),
      isNull(portfolioTransactionsTable.archivedAt),
    ));
  assert.equal(rows.length, 1, "only the buy is stored");
});

test("future dates, unknown symbols and malformed input are rejected", async () => {
  const { jar } = await registerVipUser("01011110003", "Validation User");
  const tomorrow = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
  const future = await api("/api/portfolio/transactions", jar, addTxInit("COMI", "buy", 10, 10, { tradeDate: tomorrow }));
  assert.equal(future.response.status, 400, "future trade date rejected");

  const unknown = await api("/api/portfolio/transactions", jar, addTxInit("FAKETICK1", "buy", 10, 10));
  assert.equal(unknown.response.status, 400, "non-catalog symbol rejected");

  const badQty = await api("/api/portfolio/transactions", jar, addTxInit("COMI", "buy", 0, 10));
  assert.equal(badQty.response.status, 400, "zero quantity rejected");

  const badPrice = await api("/api/portfolio/transactions", jar, addTxInit("COMI", "sell", 1, -5));
  assert.equal(badPrice.response.status, 400, "negative price rejected");

  const badSide = await api("/api/portfolio/transactions", jar, {
    method: "POST", body: JSON.stringify({ symbol: "COMI", side: "hold", quantity: 1, price: 5 }),
  });
  assert.equal(badSide.response.status, 400, "unknown side rejected");

  const badDate = await api("/api/portfolio/transactions", jar, addTxInit("COMI", "buy", 10, 10, { tradeDate: "01/09/2026" }));
  assert.equal(badDate.response.status, 400, "non-ISO date rejected");
});

test("editing a transaction re-validates the whole timeline", async () => {
  const { jar } = await registerVipUser("01011110004", "Edit User");
  const buy = await api("/api/portfolio/transactions", jar, addTxInit("COMI", "buy", 100, 10, { tradeDate: "2026-09-01" }));
  const buyId = String(((buy.body?.transaction as Record<string, unknown>) || {}).id || "");
  const sell = await api("/api/portfolio/transactions", jar, addTxInit("COMI", "sell", 40, 12, { tradeDate: "2026-09-02" }));
  const sellId = String(((sell.body?.transaction as Record<string, unknown>) || {}).id || "");

  /* Enlarge the sell to 60: still ≤ 100 held → accepted. */
  const editOk = await api(`/api/portfolio/transactions/${sellId}`, jar, {
    method: "PUT", body: JSON.stringify({ symbol: "COMI", side: "sell", quantity: 60, price: 12, fees: 0, tradeDate: "2026-09-02" }),
  });
  assert.equal(editOk.response.status, 200, "valid edit accepted");

  /* Enlarge the sell to 150: exceeds held 100 → rejected, row unchanged. */
  const editBad = await api(`/api/portfolio/transactions/${sellId}`, jar, {
    method: "PUT", body: JSON.stringify({ symbol: "COMI", side: "sell", quantity: 150, price: 12, fees: 0, tradeDate: "2026-09-02" }),
  });
  assert.equal(editBad.response.status, 400, "invalid edit rejected");
  assert.equal((editBad.body as { held?: number })?.held, 100);

  /* Editing the buy itself (reducing quantity below a later sell) is rejected. */
  const editBuyBad = await api(`/api/portfolio/transactions/${buyId}`, jar, {
    method: "PUT", body: JSON.stringify({ symbol: "COMI", side: "buy", quantity: 30, price: 10, fees: 0, tradeDate: "2026-09-01" }),
  });
  assert.equal(editBuyBad.response.status, 400, "reducing the buy below the later sell is rejected");

  /* Editing someone else's transaction id is a 404, not a 400/500. */
  const foreign = await registerVipUser("01011110005", "Foreign Editor");
  const foreignEdit = await api(`/api/portfolio/transactions/${sellId}`, foreign.jar, {
    method: "PUT", body: JSON.stringify({ symbol: "COMI", side: "sell", quantity: 40, price: 12, fees: 0, tradeDate: "2026-09-02" }),
  });
  assert.equal(foreignEdit.response.status, 404, "another user's transaction is not editable");
});

test("deleting a trade is blocked when a later sell would then exceed held", async () => {
  const { jar } = await registerVipUser("01011110006", "Delete User");
  const buy = await api("/api/portfolio/transactions", jar, addTxInit("ABUK", "buy", 50, 20, { tradeDate: "2026-09-01" }));
  const buyId = String(((buy.body?.transaction as Record<string, unknown>) || {}).id || "");
  await api("/api/portfolio/transactions", jar, addTxInit("ABUK", "sell", 50, 25, { tradeDate: "2026-09-02" }));

  const del = await api(`/api/portfolio/transactions/${buyId}`, jar, { method: "DELETE" });
  assert.equal(del.response.status, 400, "deleting the only buy breaks the later sell");
  assert.match(String((del.body as { message?: string })?.message || ""), /ABUK/);

  /* The trade is still active after the rejected delete. */
  const portfolio = await api("/api/portfolio", jar);
  const abuk = positionOf(portfolio.body as Record<string, unknown>, "ABUK");
  assert.ok(abuk, "the closed symbol stays visible with its history");
  assert.equal(abuk.quantity, 0, "fully closed position shows zero held");
  assert.equal(abuk.closed, true, "closed flag is set");
  near(abuk.realizedPnl as unknown, 50 * 25 - 50 * 20, 0.05, "closed-position realized P/L remains");

  /* Its realized history stays in the summary. */
  const summary = summaryOf(portfolio.body as Record<string, unknown>);
  near(summary.realizedPnl, 250, 0.05);
});

test("user B can never read or modify user A's portfolio", async () => {
  const userA = await registerVipUser("01022220001", "Isolation User A");
  await api("/api/portfolio/transactions", userA.jar, addTxInit("COMI", "buy", 77, 11, { tradeDate: "2026-09-01" }));
  await api("/api/portfolio/settings", userA.jar, { method: "PUT", body: JSON.stringify({ startingCash: 1234 }) });

  const userB = await registerVipUser("01022220002", "Isolation User B");

  const bRead = await api("/api/portfolio", userB.jar);
  assert.equal(bRead.response.status, 200);
  assert.deepEqual((bRead.body as { positions?: unknown[] }).positions, [], "B sees no positions of A");
  assert.deepEqual((bRead.body as { transactions?: unknown[] }).transactions, [], "B sees no transactions of A");
  assert.equal(((bRead.body as { settings?: { startingCash?: number } }).settings || {}).startingCash, 0, "B has no cash settings of A");

  const aReport = await api("/api/portfolio/report?from=2026-01-01&to=2026-12-31", userB.jar);
  assert.equal((aReport.body as { buyCount?: number }).buyCount, 0, "B's report has no A trades");

  /* A's transaction ids are unknown to B: 404 on edit/delete, never data. */
  const aTx = (await api("/api/portfolio", userA.jar)).body as { transactions?: Array<{ id: string }> };
  const aTxId = aTx.transactions?.[0]?.id || "";
  assert.ok(aTxId, "A has at least one transaction");
  const bEdit = await api(`/api/portfolio/transactions/${aTxId}`, userB.jar, {
    method: "PUT", body: JSON.stringify({ symbol: "COMI", side: "buy", quantity: 77, price: 11, fees: 0, tradeDate: "2026-09-01" }),
  });
  assert.equal(bEdit.response.status, 404, "B cannot edit A's transaction");
  const bDelete = await api(`/api/portfolio/transactions/${aTxId}`, userB.jar, { method: "DELETE" });
  assert.equal(bDelete.response.status, 404, "B cannot delete A's transaction");

  /* A's portfolio is untouched by B's attempts. */
  const aAfter = await api("/api/portfolio", userA.jar);
  assert.equal(positionOf(aAfter.body as Record<string, unknown>, "COMI")?.quantity, 77);
  assert.equal(((aAfter.body as { settings?: { startingCash?: number } }).settings || {}).startingCash, 1234);
});

test("starting cash settings drive the cash line consistently", async () => {
  const { jar } = await registerVipUser("01033330001", "Cash User");
  await api("/api/portfolio/transactions", jar, addTxInit("COMI", "buy", 100, 10, { fees: 10, tradeDate: "2026-09-01" }));

  const setCash = await api("/api/portfolio/settings", jar, { method: "PUT", body: JSON.stringify({ startingCash: 5000 }) });
  assert.equal(setCash.response.status, 200);

  const portfolio = await api("/api/portfolio", jar);
  const body = portfolio.body as Record<string, unknown>;
  assert.equal((body.settings as { startingCash: number }).startingCash, 5000);
  near(summaryOf(body).cash, 5000 - 1010, 0.05, "cash = starting cash − buy outlay");
  near(summaryOf(body).totalValuePriced, 5000 - 1010, 0.05, "priced view without market prices");

  const badCash = await api("/api/portfolio/settings", jar, { method: "PUT", body: JSON.stringify({ startingCash: -5 }) });
  assert.equal(badCash.response.status, 400, "negative starting cash rejected");

  const overflow = await api("/api/portfolio/settings", jar, { method: "PUT", body: JSON.stringify({ startingCash: 1e12 }) });
  assert.equal(overflow.response.status, 400, "absurd starting cash rejected");
});

test("legacy aggregated positions merge in and the trade ledger wins per symbol", async () => {
  const { jar, userId } = await registerVipUser("01044440001", "Legacy User");
  /* Old-model rows written directly, as they exist for existing users. */
  await memory.db.insert(portfolioPositionsTable).values([
    {
      id: "legacy-legacy-symbol",
      userId,
      instrumentId: "stock:egx:ABUK",
      symbol: "ABUK",
      quantity: 10,
      averageCost: "15.000000",
      currency: "EGP",
      status: "active",
    },
    {
      id: "legacy-ledger-wins",
      userId,
      instrumentId: "stock:egx:COMI",
      symbol: "COMI",
      quantity: 99,
      averageCost: "9.000000",
      currency: "EGP",
      status: "active",
    },
  ]);
  await api("/api/portfolio/transactions", jar, addTxInit("COMI", "buy", 5, 20, { tradeDate: "2026-09-01" }));

  const portfolio = await api("/api/portfolio", jar);
  const body = portfolio.body as Record<string, unknown>;
  assert.equal(body.legacyPositions, true);

  const abuk = positionOf(body, "ABUK");
  assert.ok(abuk, "legacy-only symbol appears");
  assert.equal(abuk.legacy, true, "legacy row flagged");
  assert.equal(abuk.quantity, 10);
  near(abuk.averageCost, 15, 0.001, "legacy average cost preserved");

  const comi = positionOf(body, "COMI");
  assert.ok(comi, "traded symbol appears");
  assert.equal(comi.legacy, false, "trade ledger wins for traded symbols");
  assert.equal(comi.quantity, 5, "legacy 99 is not merged into a traded symbol");
  near(comi.averageCost, 20, 0.001);

  const positions = (body.positions as Array<Record<string, unknown>>) || [];
  assert.equal(positions.length, 2, "no duplicate COMI row");
});

test("the report endpoint aggregates a period and validates the window", async () => {
  const { jar } = await registerVipUser("01055550001", "Report User");
  await api("/api/portfolio/transactions", jar, addTxInit("COMI", "buy", 100, 10, { fees: 10, tradeDate: "2026-09-01" }));
  await api("/api/portfolio/transactions", jar, addTxInit("COMI", "sell", 100, 13, { fees: 10, tradeDate: "2026-09-15" }));
  await api("/api/portfolio/transactions", jar, addTxInit("ABUK", "buy", 10, 20, { tradeDate: "2026-10-20" }));

  const report = await api("/api/portfolio/report?from=2026-09-01&to=2026-09-30", jar);
  assert.equal(report.response.status, 200);
  const body = report.body as Record<string, unknown>;
  near(body.realizedPnl as unknown, 100 * 13 - 10 - 100 * 10.1, 0.05, "period realized P/L");
  near(body.fees as unknown, 20, 0.011, "period fees");
  assert.equal(body.buyCount, 1);
  assert.equal(body.sellCount, 1);
  const byDay = (body.byDay as Array<Record<string, unknown>>) || [];
  assert.deepEqual(byDay.map((day) => day.date), ["2026-09-01", "2026-09-15"]);
  near((byDay[1] as Record<string, unknown>).realizedPnl as unknown, 100 * 13 - 10 - 100 * 10.1, 0.05);

  /* The October buy falls outside the September window. */
  const wide = await api("/api/portfolio/report?from=2026-01-01&to=2026-12-31", jar);
  assert.equal((wide.body as { buyCount?: number }).buyCount, 2, "wide window includes the later buy");

  const inverted = await api("/api/portfolio/report?from=2026-09-30&to=2026-09-01", jar);
  assert.equal(inverted.response.status, 400, "inverted window rejected");

  const badFormat = await api("/api/portfolio/report?from=sep-1&to=2026-12-31", jar);
  assert.equal(badFormat.response.status, 400, "malformed dates rejected");
});

test("the portfolio survives logout and re-login (server-side persistence)", async () => {
  const { jar, userId } = await registerVipUser("01066660001", "Persistence User");
  await api("/api/portfolio/transactions", jar, addTxInit("COMI", "buy", 40, 9, { fees: 4, tradeDate: "2026-09-01" }));

  /* Log out and log back in with a fresh jar. */
  const logout = await api("/api/user/logout", jar, { method: "POST" });
  assert.ok(logout.response.status === 200 || logout.response.status === 204, "logout acknowledged");
  const freshJar: CookieJar = {};
  const login = await api("/api/user/login", freshJar, {
    method: "POST",
    body: JSON.stringify({ phone: "01066660001", password: "SyntheticUserPass1!" }),
  });
  assert.equal(login.response.status, 200, "re-login succeeds");
  assert.match(freshJar.value || "", /^et_user_session=/);

  const portfolio = await api("/api/portfolio", freshJar);
  assert.equal(portfolio.response.status, 200);
  const comi = positionOf(portfolio.body as Record<string, unknown>, "COMI");
  assert.equal(comi?.quantity, 40, "transaction persisted across sessions");
  near(comi?.averageCost as unknown, 9.1, 0.001, "average cost with fees persisted");

  /* The ledger row is physically in the database for this user only. */
  const rows = await memory.db.select().from(portfolioTransactionsTable).where(eq(portfolioTransactionsTable.userId, userId));
  assert.equal(rows.length, 1);
});

test("portfolio-level alerts reuse the alert system (validation, duplicates, isolation)", async () => {
  const { jar } = await registerVipUser("01077770001", "Alert User");

  /* Value alert: accepted, pseudo-symbol owned by the server. */
  const value = await api("/api/price-alerts", jar, {
    method: "POST",
    body: JSON.stringify({ condition: "portfolio_value_above", targetValue: 10_000 }),
  });
  assert.equal(value.response.status, 201, "portfolio value alert created");

  /* Concentration alert: accepted with a percentage target. */
  const conc = await api("/api/price-alerts", jar, {
    method: "POST",
    body: JSON.stringify({ condition: "concentration_above", targetValue: 40 }),
  });
  assert.equal(conc.response.status, 201, "concentration alert created");

  /* Concentration above 100% is invalid. */
  const badConc = await api("/api/price-alerts", jar, {
    method: "POST",
    body: JSON.stringify({ condition: "concentration_above", targetValue: 150 }),
  });
  assert.equal(badConc.response.status, 400, "concentration > 100 rejected");

  /* Duplicate (same condition + target) is a 409, not a second row. */
  const dup = await api("/api/price-alerts", jar, {
    method: "POST",
    body: JSON.stringify({ condition: "portfolio_value_above", targetValue: 10_000 }),
  });
  assert.equal(dup.response.status, 409, "duplicate alert rejected");

  /* Listed back with the reserved pseudo-symbols. */
  const list = await api("/api/price-alerts", jar);
  const alerts = (list.body as { alerts?: Array<Record<string, unknown>> }).alerts || [];
  assert.ok(alerts.some((a) => a.symbol === "PORTFOLIO" && a.condition === "portfolio_value_above"));
  assert.ok(alerts.some((a) => a.symbol === "CONCENTRATION" && a.condition === "concentration_above"));

  /* Another user cannot see or delete these alerts. */
  const other = await registerVipUser("01077770002", "Alert Other User");
  const otherList = await api("/api/price-alerts", other.jar);
  assert.deepEqual((otherList.body as { alerts?: unknown[] }).alerts, [], "other user's alert list is empty");
  const alertId = String((alerts.find((a) => a.symbol === "PORTFOLIO") || {}).id || "");
  const otherDelete = await api(`/api/price-alerts/${alertId}`, other.jar, { method: "DELETE" });
  assert.equal(otherDelete.response.status, 404, "other user cannot delete this alert");
});

test("portfolio alert valuation is pure, uses verified quotes only, and never invents data", async () => {
  const { computePortfolioValuation, evaluatePortfolioCondition } = await import("./price-alerts");

  const transactions = [
    { id: "t1", symbol: "COMI", side: "buy" as const, quantity: 100, price: 10, fees: 0, tradeDate: "2026-09-01", createdAtMs: 1 },
    { id: "t2", symbol: "ABUK", side: "buy" as const, quantity: 100, price: 20, fees: 0, tradeDate: "2026-09-02", createdAtMs: 2 },
  ];

  /* With verified quotes for every held symbol: exact total value and the
   * largest single-symbol weight. Cash after both buys: 4000 − 3000 = 1000. */
  const withQuotes = computePortfolioValuation(transactions, [], 4000, new Map([
    ["COMI", { price: 12, source: "synthetic" }],
    ["ABUK", { price: 18, source: "synthetic" }],
  ]));
  near(withQuotes.totalValue, 1000 + 1200 + 1800, 0.05, "portfolio total with all prices");
  near(withQuotes.topConcentrationPct, (1800 / 4000) * 100, 0.05, "top concentration weight");

  /* One missing price: total value is null (never the stale/partial total),
   * and concentration is withheld because the asset base is incomplete. */
  const partial = computePortfolioValuation(transactions, [], 4000, new Map([
    ["COMI", { price: 12, source: "synthetic" }],
  ]));
  assert.equal(partial.totalValue, null, "no invented total when a price is missing");
  assert.equal(partial.topConcentrationPct, null);

  /* No quotes at all: both are null — the alert simply waits. */
  const none = computePortfolioValuation(transactions, [], 4000, new Map());
  assert.equal(none.totalValue, null);
  assert.equal(none.topConcentrationPct, null);

  /* A price without a named source is not verified. */
  const unverified = computePortfolioValuation(transactions, [], 4000, new Map([
    ["COMI", { price: 12, source: "" }],
    ["ABUK", { price: 18, source: "synthetic" }],
  ]));
  assert.equal(unverified.totalValue, null, "sourceless quote does not price the portfolio");

  /* Legacy-only holdings participate too. */
  const legacy = computePortfolioValuation([], [{ symbol: "COMI", quantity: 10, averageCost: "15.000000" }], 100, new Map([
    ["COMI", { price: 20, source: "synthetic" }],
  ]));
  near(legacy.totalValue, 100 + 200, 0.05, "legacy holding valued");

  assert.equal(evaluatePortfolioCondition("portfolio_value_above", 1000, 1000.01), true);
  assert.equal(evaluatePortfolioCondition("portfolio_value_above", 1000, 999.99), false);
  assert.equal(evaluatePortfolioCondition("portfolio_value_below", 1000, 999.99), true);
  assert.equal(evaluatePortfolioCondition("portfolio_value_below", 1000, 1000.01), false);
  assert.equal(evaluatePortfolioCondition("concentration_above", 45, 45.01), true);
  assert.equal(evaluatePortfolioCondition("concentration_above", 45, 44.99), false);
});
