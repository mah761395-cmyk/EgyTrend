/**
 * Login decisions without a database or Express: a fake user table, the real
 * scrypt hashing and the real in-memory attempt store.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryAttemptStore } from "./rate-limit";
import { checkRegisterAllowed, evaluateLogin, ipBucket, phoneBucket, type LoginUser } from "./user-login";
import { hashUserPassword } from "./userAuth";

const PHONE = "01012345678";
const PASSWORD = "correct-horse-battery";

function user(overrides: Partial<LoginUser> = {}): LoginUser {
  return {
    id: 7,
    phone: PHONE,
    name: "مستخدم",
    plan: "free",
    vipExpiresAt: null,
    status: "active",
    passwordHash: hashUserPassword(PASSWORD),
    ...overrides,
  };
}

function deps(row: LoginUser | null) {
  return {
    store: createMemoryAttemptStore(),
    findUser: async () => row,
  };
}

test("the correct password logs in", async () => {
  const d = deps(user());
  const outcome = await evaluateLogin({ phone: PHONE, password: PASSWORD, ip: "1.1.1.1" }, d);
  assert.equal(outcome.kind, "ok");
  if (outcome.kind === "ok") assert.equal(outcome.user.id, 7);
});

test("a wrong password is rejected with a generic message", async () => {
  const d = deps(user());
  const outcome = await evaluateLogin({ phone: PHONE, password: "wrong-password", ip: "1.1.1.1" }, d);
  assert.equal(outcome.kind, "invalid");
  if (outcome.kind === "invalid") {
    assert.equal(outcome.status, 401);
    assert.equal(outcome.message, "invalid credentials");
  }
});

test("an unknown account answers exactly like a wrong password", async () => {
  const missing = await evaluateLogin(
    { phone: PHONE, password: PASSWORD, ip: "1.1.1.1" },
    deps(null),
  );
  const wrong = await evaluateLogin(
    { phone: PHONE, password: "nope-nope-nope", ip: "1.1.1.1" },
    deps(user()),
  );
  assert.deepEqual(missing, wrong);
});

test("a disabled account cannot log in even with the right password", async () => {
  const d = deps(user({ status: "banned" }));
  const outcome = await evaluateLogin({ phone: PHONE, password: PASSWORD, ip: "1.1.1.1" }, d);
  assert.equal(outcome.kind, "invalid");
});

test("missing fields are a 400 without touching the limiter", async () => {
  const store = createMemoryAttemptStore();
  const outcome = await evaluateLogin(
    { phone: "", password: "", ip: "1.1.1.1" },
    { store, findUser: async () => null },
  );
  assert.equal(outcome.kind, "invalid");
  if (outcome.kind === "invalid") assert.equal(outcome.status, 400);
  assert.equal((await store.isBlocked(ipBucket("1.1.1.1"), 30, 15 * 60 * 1000)).blocked, false);
});

test("repeated failures from one account are cut off", async () => {
  const d = deps(user());
  for (let i = 0; i < 20; i += 1) {
    const r = await evaluateLogin({ phone: PHONE, password: `bad-${i}`, ip: "1.1.1.1" }, d);
    assert.equal(r.kind, "invalid");
  }
  const blocked = await evaluateLogin({ phone: PHONE, password: PASSWORD, ip: "1.1.1.1" }, d);
  assert.equal(blocked.kind, "limited");
  if (blocked.kind === "limited") assert.ok(blocked.retryAfterSec > 0);
});

test("replayed requests cannot slip past the limit", async () => {
  const d = deps(user());
  const attempt = () => evaluateLogin({ phone: PHONE, password: "wrong", ip: "2.2.2.2" }, d);
  await Promise.all(Array.from({ length: 25 }, attempt));
  const outcome = await attempt();
  assert.equal(outcome.kind, "limited");
});

test("one IP spraying many accounts is cut off by the IP bucket", async () => {
  const store = createMemoryAttemptStore();
  const findUser = async () => null;
  let limited = false;
  for (let i = 0; i < 31; i += 1) {
    const r = await evaluateLogin({ phone: `0100000${String(i).padStart(4, "0")}`, password: "x", ip: "3.3.3.3" }, { store, findUser });
    if (r.kind === "limited") limited = true;
  }
  assert.equal(limited, true);
});

test("a successful login clears the account counter", async () => {
  const d = deps(user());
  for (let i = 0; i < 5; i += 1) {
    await evaluateLogin({ phone: PHONE, password: "wrong", ip: "4.4.4.4" }, d);
  }
  const ok = await evaluateLogin({ phone: PHONE, password: PASSWORD, ip: "4.4.4.4" }, d);
  assert.equal(ok.kind, "ok");
  assert.equal((await d.store.isBlocked(phoneBucket(PHONE), 20, 30 * 60 * 1000)).blocked, false);
});

test("registration is capped per phone and per IP", async () => {
  const store = createMemoryAttemptStore();
  for (let i = 0; i < 3; i += 1) {
    const gate = await checkRegisterAllowed({ phone: PHONE, ip: "5.5.5.5" }, store);
    assert.equal(gate.allowed, true);
    await store.recordFailure(`register:phone:${PHONE}`, 3, 60 * 60 * 1000);
  }
  const blocked = await checkRegisterAllowed({ phone: PHONE, ip: "5.5.5.5" }, store);
  assert.equal(blocked.allowed, false);
});
