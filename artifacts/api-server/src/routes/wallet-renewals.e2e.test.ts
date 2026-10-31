import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { after, before, test } from "node:test";
import { eq } from "drizzle-orm";
import {
  appSettingsTable,
  appUsersTable,
  employeesTable,
  paymentRequestsTable,
  subscriptionPlansTable,
  subscriptionRenewalsTable,
  userNotificationsTable,
  userSubscriptionsTable,
  userWalletsTable,
  walletTransactionsTable,
} from "@workspace/db/schema";
import { createMemoryDatabase } from "../test-support/memory-db";

/* In-process pg-mem with synthetic data only: no DATABASE_URL, no network
 * listener, no production database. The app is imported only after the test
 * database is injected. */
process.env.NODE_ENV = "test";
process.env.LEGACY_MARKET_FEEDS_DISABLED = "true";
process.env.SESSION_SECRET = "test-only-session-secret-not-for-deployment";
process.env.LOG_LEVEL = "silent";
process.env.MARKET_SNAPSHOT_CRON_SECRET = "wallet-renewals-e2e-secret";

const CRON_SECRET = "wallet-renewals-e2e-secret";
const DAY_MS = 24 * 60 * 60 * 1000;

let memory: Awaited<ReturnType<typeof createMemoryDatabase>>;
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

function setClock(date: Date | null) {
  if (date) (globalThis as typeof globalThis & { __egytrendTestClock?: Date }).__egytrendTestClock = new Date(date);
  else delete (globalThis as typeof globalThis & { __egytrendTestClock?: Date }).__egytrendTestClock;
}

async function registerUser(phone: string, name: string, email: string): Promise<CookieJar> {
  const jar: CookieJar = {};
  const res = await api("/api/user/register", jar, {
    method: "POST",
    body: JSON.stringify({ name, phone, email, password: "WalletUserPass1!" }),
  });
  assert.equal(res.response.status, 201, `registration for ${phone} should succeed`);
  return jar;
}

async function paymentToken(jar: CookieJar): Promise<string> {
  const config = await api("/api/payments/config", jar);
  assert.equal(config.response.status, 200);
  const plans = (config.body?.plans as Array<{ key?: string; pricingToken?: string }>) || [];
  const token = plans.find((plan) => plan.key === "wallet-plan")?.pricingToken || "";
  assert.ok(token, "a fresh server pricing token is required");
  return token;
}

/** Distinct synthetic proof images — one per request, as in the real flow. */
let proofCounter = 0;
function proof(tag: string): string {
  proofCounter += 1;
  return `data:image/png;base64,${Buffer.from(`proof:${tag}:${proofCounter}:${Date.now()}`).toString("base64")}`;
}
/* The proof backing test 1's request — test 2 must attempt to reuse THIS one. */
const FIRST_PROOF = `data:image/png;base64,${Buffer.from("proof:first-request-ever").toString("base64")}`;

async function approveRequest(id: string, adminJar: CookieJar) {
  const res = await api(`/api/admin/requests/${encodeURIComponent(id)}`, adminJar, {
    method: "PUT",
    body: JSON.stringify({ status: "approved" }),
  });
  return res;
}

async function runRenewalsCron(): Promise<{ response: Response; body: Record<string, unknown> | null }> {
  const res = await api("/api/subscriptions/internal/renewals/run", {}, {
    method: "POST",
    headers: { "x-cron-secret": CRON_SECRET },
    body: "{}",
  });
  return { response: res.response, body: res.body };
}

let adminJar: CookieJar;

before(async () => {
  memory = await createMemoryDatabase();
  (globalThis as typeof globalThis & { __egytrendTestDatabase?: typeof memory.db }).__egytrendTestDatabase = memory.db;

  await memory.db.insert(subscriptionPlansTable).values({
    key: "wallet-plan",
    nameAr: "باقة المحفظة التجريبية",
    price: 100,
    durationMonths: 1,
    features: [],
    isActive: true,
  });
  await memory.db.insert(appSettingsTable).values([
    { key: "payment_vodafone_number", value: "01000000000" },
    { key: "payment_vodafone_enabled", value: "1" },
  ]);
  await memory.db.insert(employeesTable).values({
    name: "Wallet Test Admin",
    email: "admin.wallet@example.test",
    role: "admin",
    status: "active",
    passwordHash: employeePasswordHash("WalletAdminPass1!"),
    permissions: ["payments"],
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

  adminJar = {};
  const login = await api("/api/admin/login", adminJar, {
    method: "POST",
    body: JSON.stringify({ email: "admin.wallet@example.test", password: "WalletAdminPass1!" }),
  });
  assert.equal(login.response.status, 200);
});

after(async () => {
  setClock(null);
  if (server) {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
  if (memory) await memory.close();
  delete (globalThis as typeof globalThis & { __egytrendTestDatabase?: typeof memory.db }).__egytrendTestDatabase;
  delete process.env.MARKET_SNAPSHOT_CRON_SECRET;
});

test("manual payment no longer requires the transfer number; proof stays required", async () => {
  const userJar = await registerUser("01020000001", "No-Tx User", "notx.wallet@example.test");
  const token = await paymentToken(userJar);

  const withoutTx = await api("/api/payments", userJar, {
    method: "POST",
    body: JSON.stringify({
      planKey: "wallet-plan",
      pricingToken: token,
      method: "vodafone",
      proofImage: FIRST_PROOF,
      proofName: "notx.png",
    }),
  });
  assert.equal(withoutTx.response.status, 200, "a payment without tx must be accepted");
  assert.equal(withoutTx.body?.status, "ok");
  const id = String(withoutTx.body?.id || "");
  const [stored] = await memory.db.select().from(paymentRequestsTable).where(eq(paymentRequestsTable.id, id));
  assert.equal(stored?.tx, "", "the retired field is stored empty, keeping legacy rows untouched");
  assert.equal(stored?.price, 100);
  assert.equal(stored?.status, "pending");

  const withoutProof = await api("/api/payments", userJar, {
    method: "POST",
    body: JSON.stringify({
      planKey: "wallet-plan",
      pricingToken: token,
      method: "vodafone",
      proofImage: "",
    }),
  });
  assert.equal(withoutProof.response.status, 400, "proof remains mandatory");

  const approval = await approveRequest(id, adminJar);
  assert.equal(approval.response.status, 200);
  const [afterApproval] = await memory.db.select().from(paymentRequestsTable).where(eq(paymentRequestsTable.id, id));
  assert.equal(afterApproval?.status, "approved");
  const [user] = await memory.db.select().from(appUsersTable).where(eq(appUsersTable.phone, "01020000001"));
  const [sub] = await memory.db.select().from(userSubscriptionsTable).where(eq(userSubscriptionsTable.userId, user!.id));
  assert.equal(sub?.status, "active", "the term activates only by admin approval");
});

test("one proof image cannot back more than one request (submit + approval guards)", async () => {
  const otherJar = await registerUser("01020000002", "Proof Reuser", "reuser.wallet@example.test");
  const token = await paymentToken(otherJar);

  const reuse = await api("/api/payments", otherJar, {
    method: "POST",
    body: JSON.stringify({
      planKey: "wallet-plan",
      pricingToken: token,
      method: "vodafone",
      proofImage: FIRST_PROOF,
    }),
  });
  /* The proof was already used by the previous test's APPROVED request. */
  assert.equal(reuse.response.status, 409, "reusing an approved proof is rejected at submit time");

  /* Approval-time guard: two rows sharing a proofHash can only be created by
   * bypassing the endpoint; the in-transaction check must still block the
   * second approval. */
  const directProof = proof("direct-shared");
  const hash = crypto.createHash("sha256").update(directProof).digest("hex");
  const [userA] = await memory.db.select().from(appUsersTable).where(eq(appUsersTable.phone, "01020000002"));
  const [userB] = await memory.db.select().from(appUsersTable).where(eq(appUsersTable.phone, "01020000001"));
  const now = new Date();
  await memory.db.insert(paymentRequestsTable).values({
    id: "req-wlt-direct-a",
    phone: userA.phone,
    name: userA.name,
    planKey: "wallet-plan",
    payMethod: "vodafone",
    price: 100,
    tx: "",
    status: "pending",
    proofImage: directProof,
    proofHash: hash,
    priceLockedUntil: new Date(now.getTime() + 24 * 60 * 60 * 1000),
    priceSnapshot: {
      version: 1,
      calculatedAt: now.toISOString(),
      lockHours: 24,
      effective: { price: 100, oldPrice: null, discountPercent: null, source: "base" },
      templateVariables: { price: "100", old_price: "", discount_percent: "" },
      plan: { key: "wallet-plan", nameAr: "باقة المحفظة التجريبية", durationMonths: 1, features: [] },
    },
  });
  await memory.db.insert(paymentRequestsTable).values({
    id: "req-wlt-direct-b",
    phone: userB.phone,
    name: userB.name,
    planKey: "wallet-plan",
    payMethod: "vodafone",
    price: 100,
    tx: "",
    status: "pending",
    proofImage: directProof,
    proofHash: hash,
    priceLockedUntil: new Date(now.getTime() + 24 * 60 * 60 * 1000),
    priceSnapshot: {
      version: 1,
      calculatedAt: now.toISOString(),
      lockHours: 24,
      effective: { price: 100, oldPrice: null, discountPercent: null, source: "base" },
      templateVariables: { price: "100", old_price: "", discount_percent: "" },
      plan: { key: "wallet-plan", nameAr: "باقة المحفظة التجريبية", durationMonths: 1, features: [] },
    },
  });
  const first = await approveRequest("req-wlt-direct-a", adminJar);
  assert.equal(first.response.status, 200, "the first approval of a proof succeeds");
  const second = await approveRequest("req-wlt-direct-b", adminJar);
  assert.equal(second.response.status, 409, "the same proof cannot be approved for a second request");
  const [bRow] = await memory.db.select().from(paymentRequestsTable).where(eq(paymentRequestsTable.id, "req-wlt-direct-b"));
  assert.equal(bRow?.status, "pending", "the blocked request stays pending, not silently approved");
});

test("wallet top-up: validation, pending state, single credit, ledger row", async () => {
  const jar = await registerUser("01020000003", "Topup User", "topup.wallet@example.test");

  const tooSmall = await api("/api/payments/wallet/topup", jar, {
    method: "POST",
    body: JSON.stringify({ amount: 4, method: "vodafone", proofImage: proof("too-small") }),
  });
  assert.equal(tooSmall.response.status, 400);
  const tooBig = await api("/api/payments/wallet/topup", jar, {
    method: "POST",
    body: JSON.stringify({ amount: 99999, method: "vodafone", proofImage: proof("too-big") }),
  });
  assert.equal(tooBig.response.status, 400);
  const noProof = await api("/api/payments/wallet/topup", jar, {
    method: "POST",
    body: JSON.stringify({ amount: 10, method: "vodafone", proofImage: "" }),
  });
  assert.equal(noProof.response.status, 400);

  const topup = await api("/api/payments/wallet/topup", jar, {
    method: "POST",
    body: JSON.stringify({ amount: 250, method: "vodafone", proofImage: proof("topup-250"), proofName: "topup.png" }),
  });
  assert.equal(topup.response.status, 200);
  const topupId = String(topup.body?.id || "");

  const beforeApproval = await api("/api/payments/wallet", jar);
  assert.equal(beforeApproval.response.status, 200);
  assert.equal((beforeApproval.body?.wallet as { balance?: number }).balance, 0, "nothing is credited before admin approval");

  const approval = await approveRequest(topupId, adminJar);
  assert.equal(approval.response.status, 200);

  const [user] = await memory.db.select().from(appUsersTable).where(eq(appUsersTable.phone, "01020000003"));
  const [wallet] = await memory.db.select().from(userWalletsTable).where(eq(userWalletsTable.userId, user!.id));
  assert.equal(wallet?.balance, 250);
  const [subscription] = await memory.db.select().from(userSubscriptionsTable).where(eq(userSubscriptionsTable.userId, user!.id));
  assert.equal(subscription, undefined, "a top-up never activates or extends a subscription");
  const ledger = await memory.db.select().from(walletTransactionsTable).where(eq(walletTransactionsTable.userId, user!.id));
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].kind, "topup");
  assert.equal(ledger[0].amount, 250);
  assert.equal(ledger[0].balanceAfter, 250);
  assert.equal(ledger[0].refKind, "payment_request");

  /* Re-approving the same request cannot credit twice. */
  const again = await approveRequest(topupId, adminJar);
  assert.equal(again.response.status, 200);
  const [afterAgain] = await memory.db.select().from(userWalletsTable).where(eq(userWalletsTable.userId, user!.id));
  assert.equal(afterAgain?.balance, 250, "a second admin click never double-credits");
});

test("explicit checkout consent creates an active renewal at the current term end", async () => {
  const jar = await registerUser("01020000004", "Consent User", "consent.wallet@example.test");
  const token = await paymentToken(jar);
  const payment = await api("/api/payments", jar, {
    method: "POST",
    body: JSON.stringify({
      planKey: "wallet-plan",
      pricingToken: token,
      method: "vodafone",
      autoRenew: true,
      proofImage: proof("consent"),
    }),
  });
  assert.equal(payment.response.status, 200);
  const id = String(payment.body?.id || "");
  const approval = await approveRequest(id, adminJar);
  assert.equal(approval.response.status, 200);

  const [user] = await memory.db.select().from(appUsersTable).where(eq(appUsersTable.phone, "01020000004"));
  const [sub] = await memory.db.select().from(userSubscriptionsTable).where(eq(userSubscriptionsTable.userId, user!.id));
  const [renewal] = await memory.db.select().from(subscriptionRenewalsTable).where(eq(subscriptionRenewalsTable.userId, user!.id));
  assert.ok(sub?.expiresAt, "the term exists");
  assert.equal(renewal?.status, "active");
  assert.equal(renewal?.consentSource, "checkout");
  assert.ok(renewal?.nextRenewalAt && Math.abs(renewal.nextRenewalAt.getTime() - sub!.expiresAt.getTime()) < 1000,
    "the first scheduled debit is the current term's end");
  assert.equal(renewal?.lastKnownPrice, 100);

  const walletView = await api("/api/payments/wallet", jar);
  assert.equal((walletView.body?.renewal as { status?: string } | null)?.status, "active");

  /* Enabling without a live paid term is refused. */
  const nobodyJar = await registerUser("01020000005", "No Sub User", "nosub.wallet@example.test");
  const denied = await api("/api/payments/wallet/auto-renew", nobodyJar, {
    method: "PUT",
    body: JSON.stringify({ enabled: true }),
  });
  assert.equal(denied.response.status, 409, "auto-renewal requires a live paid term");
});

test("the 3-day-ahead notification fires once with amount and date", async () => {
  const [user] = await memory.db.select().from(appUsersTable).where(eq(appUsersTable.phone, "01020000004"));
  const [renewal] = await memory.db.select().from(subscriptionRenewalsTable).where(eq(subscriptionRenewalsTable.userId, user!.id));
  assert.ok(renewal?.nextRenewalAt);

  const unauthorized = await api("/api/subscriptions/internal/renewals/run", {}, { method: "POST", body: "{}" });
  assert.equal(unauthorized.response.status, 401, "the cron endpoint is secret-protected");

  setClock(new Date(renewal.nextRenewalAt!.getTime() - 2 * DAY_MS));
  const run1 = await runRenewalsCron();
  assert.equal(run1.response.status, 200);
  assert.equal(run1.body?.upcomingNotified, 1);

  const notices = await memory.db.select().from(userNotificationsTable).where(eq(userNotificationsTable.phone, "01020000004"));
  const pre = notices.filter((n) => n.kind === "renewal_upcoming");
  assert.equal(pre.length, 1, "exactly one pre-renewal notification");
  assert.ok(pre[0].body.includes("100"), "the amount is stated");
  assert.ok(pre[0].body.includes("محفظ"), "the wallet is named as the funding source");

  const run2 = await runRenewalsCron();
  assert.equal(run2.body?.upcomingNotified, 0, "a repeated run never double-notifies");
  setClock(null);
});

test("the due renewal debits once, extends the term, and records the ledger", async () => {
  const jar: CookieJar = {};
  const login = await api("/api/user/login", jar, {
    method: "POST",
    body: JSON.stringify({ phone: "01020000004", password: "WalletUserPass1!" }),
  });
  assert.equal(login.response.status, 200);

  /* Fund the wallet before the renewal moment (250 > the 100 plan price). */
  const topup = await api("/api/payments/wallet/topup", jar, {
    method: "POST",
    body: JSON.stringify({ amount: 250, method: "vodafone", proofImage: proof("fund-250") }),
  });
  assert.equal(topup.response.status, 200);
  const topupApproval = await approveRequest(String(topup.body?.id), adminJar);
  assert.equal(topupApproval.response.status, 200);
  const [user] = await memory.db.select().from(appUsersTable).where(eq(appUsersTable.phone, "01020000004"));
  const [walletBefore] = await memory.db.select().from(userWalletsTable).where(eq(userWalletsTable.userId, user!.id));
  const [subBefore] = await memory.db.select().from(userSubscriptionsTable).where(eq(userSubscriptionsTable.userId, user!.id));
  const [renewal] = await memory.db.select().from(subscriptionRenewalsTable).where(eq(subscriptionRenewalsTable.userId, user!.id));
  assert.ok(renewal?.nextRenewalAt);

  setClock(new Date(renewal.nextRenewalAt!.getTime() + 60 * 60 * 1000));
  const run = await runRenewalsCron();
  assert.equal(run.response.status, 200);
  assert.equal(run.body?.renewed, 1);

  const [walletAfter] = await memory.db.select().from(userWalletsTable).where(eq(userWalletsTable.userId, user!.id));
  assert.equal(walletAfter?.balance, (walletBefore?.balance ?? 0) - 100, "the plan amount is debited once");
  const ledger = await memory.db.select().from(walletTransactionsTable).where(eq(walletTransactionsTable.userId, user!.id));
  const debits = ledger.filter((t) => t.kind === "renewal_debit");
  assert.equal(debits.length, 1, "exactly one debit posting for the slot");
  assert.equal(debits[0].amount, 100);
  assert.equal(debits[0].balanceAfter, walletAfter?.balance);
  const [subAfter] = await memory.db.select().from(userSubscriptionsTable).where(eq(userSubscriptionsTable.userId, user!.id));
  const expectedNewEnd = new Date(new Date(renewal.nextRenewalAt!.getTime() + 60 * 60 * 1000).getTime() + 30 * DAY_MS);
  assert.ok(
    Math.abs(subAfter!.expiresAt.getTime() - expectedNewEnd.getTime()) < 1000,
    "the term stacks 30 days from the renewal moment (post-expiry rule)",
  );
  const [renewalAfter] = await memory.db.select().from(subscriptionRenewalsTable).where(eq(subscriptionRenewalsTable.userId, user!.id));
  assert.equal(renewalAfter?.status, "active");
  assert.ok(renewalAfter?.nextRenewalAt && Math.abs(renewalAfter.nextRenewalAt.getTime() - subAfter!.expiresAt.getTime()) < 1000,
    "the next slot moves to the new term end");

  const notices = await memory.db.select().from(userNotificationsTable).where(eq(userNotificationsTable.phone, "01020000004"));
  assert.ok(notices.some((n) => n.kind === "renewal_done"), "a success notification is recorded");

  /* A repeated run at the same moment must NOT debit again. */
  const runAgain = await runRenewalsCron();
  assert.equal(runAgain.body?.renewed, 0, "the advanced slot is no longer due");
  const [walletUnchanged] = await memory.db.select().from(userWalletsTable).where(eq(userWalletsTable.userId, user!.id));
  assert.equal(walletUnchanged?.balance, walletAfter?.balance, "no second debit for the same slot");
  const ledgerAgain = await memory.db.select().from(walletTransactionsTable).where(eq(walletTransactionsTable.userId, user!.id));
  assert.equal(ledgerAgain.filter((t) => t.kind === "renewal_debit").length, 1, "the ledger stays single-posted per slot");
  setClock(null);
});

test("insufficient balance never debits, notifies, and keeps the slot for retry", async () => {
  const jar = await registerUser("01020000006", "Low Balance User", "lowbalance.wallet@example.test");
  /* Fund 50 (less than the 100 plan price) and buy the plan separately. */
  const topup = await api("/api/payments/wallet/topup", jar, {
    method: "POST",
    body: JSON.stringify({ amount: 50, method: "vodafone", proofImage: proof("low-50") }),
  });
  assert.equal(topup.response.status, 200);
  const topupApproval = await approveRequest(String(topup.body?.id), adminJar);
  assert.equal(topupApproval.response.status, 200);

  const token = await paymentToken(jar);
  const payment = await api("/api/payments", jar, {
    method: "POST",
    body: JSON.stringify({ planKey: "wallet-plan", pricingToken: token, method: "vodafone", proofImage: proof("low-plan") }),
  });
  assert.equal(payment.response.status, 200);
  const paymentApproval = await approveRequest(String(payment.body?.id), adminJar);
  assert.equal(paymentApproval.response.status, 200);

  const enable = await api("/api/payments/wallet/auto-renew", jar, {
    method: "PUT",
    body: JSON.stringify({ enabled: true }),
  });
  assert.equal(enable.response.status, 200, "the user can enable from settings at any time");

  const [user] = await memory.db.select().from(appUsersTable).where(eq(appUsersTable.phone, "01020000006"));
  const [renewal] = await memory.db.select().from(subscriptionRenewalsTable).where(eq(subscriptionRenewalsTable.userId, user!.id));
  assert.ok(renewal?.nextRenewalAt);

  setClock(new Date(renewal.nextRenewalAt!.getTime() + 60 * 60 * 1000));
  const run = await runRenewalsCron();
  assert.equal(run.response.status, 200);
  assert.equal(run.body?.insufficient, 1);

  const [wallet] = await memory.db.select().from(userWalletsTable).where(eq(userWalletsTable.userId, user!.id));
  assert.equal(wallet?.balance, 50, "NOTHING is debited when the balance is insufficient");
  const ledger = await memory.db.select().from(walletTransactionsTable).where(eq(walletTransactionsTable.userId, user!.id));
  assert.equal(ledger.filter((t) => t.kind === "renewal_debit").length, 0, "no debit row exists");
  const [sub] = await memory.db.select().from(userSubscriptionsTable).where(eq(userSubscriptionsTable.userId, user!.id));
  const [renewalAfter] = await memory.db.select().from(subscriptionRenewalsTable).where(eq(subscriptionRenewalsTable.userId, user!.id));
  assert.equal(renewalAfter?.status, "active", "the slot stays scheduled for retry");
  assert.ok(renewalAfter?.nextRenewalAt && Math.abs(renewalAfter.nextRenewalAt.getTime() - sub!.expiresAt!.getTime()) < 1000);
  const notices = await memory.db.select().from(userNotificationsTable).where(eq(userNotificationsTable.phone, "01020000006"));
  assert.ok(notices.some((n) => n.kind === "renewal_failed"), "the user is told the renewal could not be funded");
  setClock(null);
});

test("disabling stops future debits but the current term keeps running to its end", async () => {
  const jar: CookieJar = {};
  const login = await api("/api/user/login", jar, {
    method: "POST",
    body: JSON.stringify({ phone: "01020000006", password: "WalletUserPass1!" }),
  });
  assert.equal(login.response.status, 200);

  const disable = await api("/api/payments/wallet/auto-renew", jar, {
    method: "PUT",
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(disable.response.status, 200);
  assert.ok(String(disable.body?.note || "").includes("يستمر"), "the UI is told the current term is unaffected");

  const [user] = await memory.db.select().from(appUsersTable).where(eq(appUsersTable.phone, "01020000006"));
  const [subBefore] = await memory.db.select().from(userSubscriptionsTable).where(eq(userSubscriptionsTable.userId, user!.id));
  const [renewal] = await memory.db.select().from(subscriptionRenewalsTable).where(eq(subscriptionRenewalsTable.userId, user!.id));
  assert.equal(renewal?.status, "disabled");

  /* The renewal moment passes: no debit happens. */
  setClock(new Date(renewal?.nextRenewalAt ? renewal.nextRenewalAt.getTime() + 60 * 60 * 1000 : subBefore!.expiresAt.getTime() + 60 * 60 * 1000));
  const run = await runRenewalsCron();
  assert.equal(run.response.status, 200);
  const [wallet] = await memory.db.select().from(userWalletsTable).where(eq(userWalletsTable.userId, user!.id));
  assert.equal(wallet?.balance, 50, "a disabled renewal never debits");
  const [subAfter] = await memory.db.select().from(userSubscriptionsTable).where(eq(userSubscriptionsTable.userId, user!.id));
  assert.equal(subAfter?.status, "active", "disabling does not cancel the current term");
  assert.ok(
    Math.abs(subAfter!.expiresAt.getTime() - subBefore!.expiresAt.getTime()) < 1000,
    "the term end is untouched — it simply runs to its stored end",
  );

  const myView = await api("/api/payments/my", jar);
  assert.equal(myView.response.status, 200);
  const requests = (myView.body?.requests as Array<{ status?: string }>) || [];
  assert.ok(requests.length >= 2, "the user's request status log (top-up + payment) is visible");
  assert.ok(requests.every((r) => ["pending", "approved", "rejected", "expired", "refunded", "cancelled"].includes(r.status || "")));
  setClock(null);
});

test("ledger integrity: balance equals posted history, no negative, one row per ref", async () => {
  const wallets = await memory.db.select().from(userWalletsTable);
  for (const wallet of wallets) {
    const ledger = await memory.db.select().from(walletTransactionsTable).where(eq(walletTransactionsTable.userId, wallet.userId));
    const credit = ledger.filter((t) => t.kind === "topup").reduce((sum, t) => sum + t.amount, 0);
    const debit = ledger.filter((t) => t.kind === "renewal_debit").reduce((sum, t) => sum + t.amount, 0);
    assert.equal(wallet.balance, credit - debit, "the balance equals posted credits minus debits");
    assert.ok(wallet.balance >= 0, "the balance is never negative");
    for (const row of ledger) assert.ok(row.balanceAfter >= 0, "no ledger row shows a negative balance");
    const refs = ledger.map((t) => `${t.refKind}:${t.refId}`);
    assert.equal(new Set(refs).size, refs.length, "each operation posts exactly once");
  }

  /* The unique index is the last line of defence even for direct inserts. */
  const [user] = await memory.db.select().from(appUsersTable).where(eq(appUsersTable.phone, "01020000003"));
  const direct = await Promise.allSettled([
    memory.db.insert(walletTransactionsTable).values({
      id: "wtx-direct-1", userId: user!.id, phone: user!.phone, kind: "topup", amount: 10, balanceAfter: 260,
      refKind: "payment_request", refId: "req-wlt-direct-1",
    }),
    memory.db.insert(walletTransactionsTable).values({
      id: "wtx-direct-2", userId: user!.id, phone: user!.phone, kind: "topup", amount: 10, balanceAfter: 270,
      refKind: "payment_request", refId: "req-wlt-direct-1",
    }),
  ]);
  assert.equal(direct.filter((r) => r.status === "fulfilled").length, 1, "a duplicate (ref_kind, ref_id) posting is impossible");

  /* Anonymous access is refused across the whole wallet surface. */
  const anonWallet = await api("/api/payments/wallet", {});
  assert.equal(anonWallet.response.status, 401);
  const anonToggle = await api("/api/payments/wallet/auto-renew", {}, { method: "PUT", body: JSON.stringify({ enabled: true }) });
  assert.equal(anonToggle.response.status, 401);
  const anonTopup = await api("/api/payments/wallet/topup", {}, {
    method: "POST",
    body: JSON.stringify({ amount: 10, method: "vodafone", proofImage: proof("anon") }),
  });
  assert.equal(anonTopup.response.status, 401);
});
