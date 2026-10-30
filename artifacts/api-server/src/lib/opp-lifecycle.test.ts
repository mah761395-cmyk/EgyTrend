import assert from "node:assert/strict";
import test from "node:test";
import { evaluateOppLifecycle, type OppLifecycleVerdict } from "./opp-lifecycle";

/**
 * TASK M (M4): lifecycle transitions. The rules are deliberately strict:
 * only a verified live price (or the passage of the 10-day window) may move
 * a card, and a card with no live price never changes state.
 */

const LEVELS = {
  entry: { low: 100, high: 102, noteAr: "" },
  stopLoss: 97,
  targets: { t1: 106, t2: 112 },
};

const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);
const CREATED = NOW - 2 * 86_400_000;

function judge(price: number | null, opts: { createdAt?: number; now?: number } = {}): OppLifecycleVerdict {
  return evaluateOppLifecycle(LEVELS, price, opts.now ?? NOW, opts.createdAt ?? CREATED);
}

test("price between stop and target 1: the card stays active", () => {
  const verdict = judge(101.5);
  assert.equal(verdict.status, "active");
  assert.equal(verdict.result, null);
  assert.equal(verdict.realizedAt, null);
});

test("price reaches target 1: realized with target_hit", () => {
  const verdict = judge(106);
  assert.equal(verdict.status, "realized");
  assert.equal(verdict.result, "target_hit");
  assert.equal(verdict.realizedAt, NOW);
});

test("price above target 1: still realized", () => {
  assert.equal(judge(110).status, "realized");
  assert.equal(judge(110).result, "target_hit");
});

test("price at or below the stop: expired with stop_hit", () => {
  assert.equal(judge(97).status, "expired");
  assert.equal(judge(97).result, "stop_hit");
  assert.equal(judge(95).status, "expired");
  assert.equal(judge(95).result, "stop_hit");
});

test("no live price: the card never changes state, fresh or old", () => {
  const fresh = judge(null);
  assert.equal(fresh.status, "active");
  assert.ok(fresh.noteAr.includes("لا يوجد سعر حي"));
  /* 9 days old, no price: still active (inside the window). */
  assert.equal(judge(null, { createdAt: NOW - 9 * 86_400_000 }).status, "active");
});

test("a verified target crossing wins over the 10-day window", () => {
  const verdict = judge(108, { createdAt: NOW - 12 * 86_400_000 });
  assert.equal(verdict.status, "realized");
  assert.equal(verdict.result, "target_hit");
});

test("past the 10-day window without a crossing: expired_by_time", () => {
  const verdict = judge(101, { createdAt: NOW - 11 * 86_400_000 });
  assert.equal(verdict.status, "expired");
  assert.equal(verdict.result, "expired_by_time");
});

test("exactly at the 10-day boundary is still inside the window", () => {
  const verdict = judge(101, { createdAt: NOW - 10 * 86_400_000 });
  assert.equal(verdict.status, "active");
});

test("a verified stop crossing wins over the 10-day window", () => {
  const verdict = judge(96, { createdAt: NOW - 12 * 86_400_000 });
  assert.equal(verdict.status, "expired");
  assert.equal(verdict.result, "stop_hit");
});

test("invalid prices (0 / negative / NaN) are treated as no price", () => {
  assert.equal(judge(0).status, "active");
  assert.equal(judge(-5).status, "active");
  assert.equal(judge(Number.NaN).status, "active");
});
