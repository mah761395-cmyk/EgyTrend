import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { after, before, test } from "node:test";
import jwt from "jsonwebtoken";
import { appUsersTable, userSubscriptionsTable } from "@workspace/db/schema";
import { createMemoryDatabase } from "../test-support/memory-db";

/*
 * VIP plan parity suite (per-file pg-mem DB + loopback app).
 *
 * Product rule under test: ONE VIP product, ONE entitlement. Every PAID plan
 * (monthly / quarterly / yearly — any plan key) grants the exact same full
 * VIP access; the only differences between plans are duration and price.
 * Free accounts are denied. This suite creates real sessions for users on two
 * different paid plans and a free user, then hits the actual VIP-gated API
 * surface — proving the access parity in code, not just in the marketing text.
 */
process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "vip-parity-test-session-secret-not-for-deployment";
process.env.REFERRAL_COOKIE_SECRET = "vip-parity-test-cookie-secret-not-for-deployment";
process.env.REFERRAL_SIGNAL_SECRET = "vip-parity-test-signal-secret-not-for-deployment";
process.env.LOG_LEVEL = "silent";

type Memory = Awaited<ReturnType<typeof createMemoryDatabase>>;
type CookieJar = { value?: string };
let memory: Memory;
let server: http.Server;
let baseUrl = "";

function passwordHash(password: string): string {
  const salt = "ffeeddccbbaa99887766554433221100";
  return `scrypt$${salt}$${crypto.scryptSync(password, salt, 64).toString("hex")}`;
}

async function seedUser(opts: { phone: string; email: string; paidPlanKey?: string; paidMonths?: number }): Promise<{ id: number; jar: CookieJar }> {
  const now = new Date();
  const [user] = await memory.db.insert(appUsersTable).values({
    phone: opts.phone, name: "Plan Parity Probe", email: opts.email, emailVerifiedAt: now,
    passwordHash: passwordHash("PlanParityPass1!"), plan: "free", status: "active", createdAt: now, updatedAt: now,
  }).returning();
  if (opts.paidPlanKey) {
    const months = opts.paidMonths ?? 1;
    await memory.db.insert(userSubscriptionsTable).values({
      id: crypto.randomUUID(), userId: user!.id, planKey: opts.paidPlanKey, planNameAr: "VIP",
      planDurationMonths: months, planFeatures: [], subscriptionType: "paid",
      status: "active", cycleId: crypto.randomUUID(), startsAt: now,
      expiresAt: new Date(now.getTime() + months * 30 * 86_400_000), source: "payment",
    });
  }
  const jar: CookieJar = {
    value: `et_user_session=${jwt.sign({ sub: user!.id, phone: user!.phone, name: user!.name, role: "user", plan: "free" }, process.env.SESSION_SECRET!, { expiresIn: "1h" })}`,
  };
  return { id: user!.id, jar };
}

async function api(path: string, jar: CookieJar, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Origin", baseUrl);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (jar.value) headers.set("Cookie", jar.value);
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
  const raw = await response.text();
  let body: Record<string, any> | null = null;
  try { body = raw ? JSON.parse(raw) : null; } catch { /* non-JSON only checked on failure */ }
  return { response, body, raw };
}

let monthly: { id: number; jar: CookieJar };
let yearly: { id: number; jar: CookieJar };
let free: { id: number; jar: CookieJar };

before(async () => {
  memory = await createMemoryDatabase();
  (globalThis as typeof globalThis & { __egytrendTestDatabase?: typeof memory.db }).__egytrendTestDatabase = memory.db;
  const { default: app } = await import("../app");
  server = http.createServer(app);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
  const address = server.address(); assert.ok(address && typeof address !== "string"); baseUrl = `http://127.0.0.1:${address.port}`;
  monthly = await seedUser({ phone: "01095000001", email: "vip-parity-monthly@example.test", paidPlanKey: "monthly", paidMonths: 1 });
  yearly = await seedUser({ phone: "01095000002", email: "vip-parity-yearly@example.test", paidPlanKey: "yearly", paidMonths: 12 });
  free = await seedUser({ phone: "01095000003", email: "vip-parity-free@example.test" });
});

after(async () => {
  await new Promise<void>((resolve) => { server.close(() => resolve()); });
  await memory.close();
});

test("monthly and yearly paid plans get identical access to the VIP-gated API", async () => {
  for (const [label, user] of [["monthly", monthly], ["yearly", yearly]] as const) {
    /* A real VIP-gated endpoint (requireVipFeature("calculators")). */
    const calc = await api("/api/calculators/bootstrap", user.jar);
    assert.equal(calc.response.status, 200, `${label} plan: calculators/bootstrap must be open`);
    assert.equal(calc.body?.status, "ok", `${label} plan: calculators/bootstrap ok`);

    /* The entitlement itself: active for both, the plan key differs but the
     * access decision does not. */
    const me = await api("/api/user/me", user.jar);
    assert.equal(me.response.status, 200, `${label} plan: /me must be 200`);
    assert.equal(me.body?.subscription?.active, true, `${label} plan: subscription.active must be true`);
    assert.equal(me.body?.user?.plan, "vip", `${label} plan: /me user.plan must be "vip"`);
  }
  /* The plans are different products (key/duration) — same access. */
  const meMonthly = await api("/api/user/me", monthly.jar);
  const meYearly = await api("/api/user/me", yearly.jar);
  assert.equal(meMonthly.body?.subscription?.planKey, "monthly");
  assert.equal(meYearly.body?.subscription?.planKey, "yearly");
});

test("free accounts are denied the same VIP endpoint with 403 (not 401, not 200)", async () => {
  const calc = await api("/api/calculators/bootstrap", free.jar);
  assert.equal(calc.response.status, 403, "free user: calculators/bootstrap must be 403");
  const me = await api("/api/user/me", free.jar);
  assert.equal(me.response.status, 200);
  assert.equal(me.body?.subscription?.active, false, "free user: subscription.active must be false");
  assert.equal(me.body?.user?.plan, "free", "free user: /me user.plan must be \"free\"");
});
