/**
 * Attempt-limiting behaviour. The Postgres store shares the same arithmetic
 * (`blockState`/`nextWindow`) and the same interface, so these cases describe
 * what both stores must do; the SQL statements themselves run against a real
 * PostgreSQL engine in auth-schema.pg.test.ts.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  blockState,
  createAttemptStore,
  createMemoryAttemptStore,
  nextWindow,
} from "./rate-limit";

const NOW = 1_800_000_000_000;
const WINDOW = 15 * 60 * 1000;

test("the first failure opens a window", () => {
  assert.deepEqual(nextWindow(null, NOW, WINDOW), { hits: 1, windowStart: NOW });
});

test("failures accumulate inside the window", () => {
  const second = nextWindow({ hits: 3, windowStart: NOW }, NOW + 1000, WINDOW);
  assert.deepEqual(second, { hits: 4, windowStart: NOW });
});

test("an expired window starts over instead of inheriting the count", () => {
  const rolled = nextWindow({ hits: 9, windowStart: NOW }, NOW + WINDOW + 1, WINDOW);
  assert.deepEqual(rolled, { hits: 1, windowStart: NOW + WINDOW + 1 });
});

test("blocking starts at the limit and reports the time left", () => {
  const state = blockState({ hits: 10, windowStart: NOW }, NOW + 60_000, 10, WINDOW);
  assert.equal(state.blocked, true);
  assert.equal(state.retryAfterSec, (WINDOW - 60_000) / 1000);
});

test("one attempt below the limit is still allowed", () => {
  assert.equal(blockState({ hits: 9, windowStart: NOW }, NOW, 10, WINDOW).blocked, false);
});

test("an expired window never blocks, even with a full count", () => {
  assert.equal(blockState({ hits: 50, windowStart: NOW }, NOW + WINDOW, 10, WINDOW).blocked, false);
});

test("a blocked caller receives a positive Retry-After", () => {
  const state = blockState({ hits: 5, windowStart: NOW }, NOW + WINDOW - 200, 5, WINDOW);
  assert.equal(state.blocked, true);
  assert.ok(state.retryAfterSec >= 1);
});

test("counting failures blocks once the limit is reached", async () => {
  const store = createMemoryAttemptStore();
  const bucket = "login:phone:01000000000";
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await store.isBlocked(bucket, 5, WINDOW)).blocked, false);
    await store.recordFailure(bucket, 5, WINDOW);
  }
  const state = await store.isBlocked(bucket, 5, WINDOW);
  assert.equal(state.blocked, true);
  assert.ok(state.retryAfterSec > 0);
});

test("a successful login clears the account counter", async () => {
  const store = createMemoryAttemptStore();
  const bucket = "login:phone:01000000000";
  for (let i = 0; i < 5; i += 1) await store.recordFailure(bucket, 5, WINDOW);
  await store.clear(bucket);
  assert.equal((await store.isBlocked(bucket, 5, WINDOW)).blocked, false);
});

test("buckets are independent (one phone cannot block another, or the IP)", async () => {
  const store = createMemoryAttemptStore();
  for (let i = 0; i < 5; i += 1) await store.recordFailure("login:phone:A", 5, WINDOW);
  assert.equal((await store.isBlocked("login:phone:A", 5, WINDOW)).blocked, true);
  assert.equal((await store.isBlocked("login:phone:B", 5, WINDOW)).blocked, false);
  assert.equal((await store.isBlocked("login:ip:1.2.3.4", 5, WINDOW)).blocked, false);
});

test("hit() allows exactly the limit and refuses the attempt after it", async () => {
  const store = createMemoryAttemptStore();
  const bucket = "register:ip:1.2.3.4";
  assert.equal((await store.hit(bucket, 3, WINDOW)).blocked, false); // 1 of 3
  assert.equal((await store.hit(bucket, 3, WINDOW)).blocked, false); // 2 of 3
  assert.equal((await store.hit(bucket, 3, WINDOW)).blocked, false); // 3 of 3 runs
  assert.equal((await store.hit(bucket, 3, WINDOW)).blocked, true); // 4th refused
});

test("without a database the limiter is per instance", async () => {
  const a = createAttemptStore({ env: {} as NodeJS.ProcessEnv });
  const b = createAttemptStore({ env: {} as NodeJS.ProcessEnv });
  for (let i = 0; i < 3; i += 1) await a.recordFailure("x", 3, WINDOW);
  assert.equal((await a.isBlocked("x", 3, WINDOW)).blocked, true);
  assert.equal((await b.isBlocked("x", 3, WINDOW)).blocked, false);
});

test("AUTH_SHARED_LIMITS=0 explicitly keeps state in memory", async () => {
  const store = createAttemptStore({
    env: { DATABASE_URL: "postgres://unused", AUTH_SHARED_LIMITS: "0" } as NodeJS.ProcessEnv,
  });
  await store.recordFailure("y", 2, WINDOW);
  assert.equal((await store.isBlocked("y", 2, WINDOW)).blocked, false);
});

test("a failing shared store degrades to memory instead of failing the request", async () => {
  let fallbacks = 0;
  const store = createAttemptStore({
    env: { DATABASE_URL: "postgres://unused" } as NodeJS.ProcessEnv,
    query: async () => {
      throw new Error("connection refused");
    },
    onFallback: () => {
      fallbacks += 1;
    },
  });
  for (let i = 0; i < 2; i += 1) {
    await store.recordFailure("z", 2, WINDOW);
    await store.isBlocked("z", 2, WINDOW);
  }
  assert.equal((await store.isBlocked("z", 2, WINDOW)).blocked, true);
  assert.equal(fallbacks, 1, "the fallback must be reported once, not per request");
});
