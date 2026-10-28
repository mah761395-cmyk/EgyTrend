import assert from "node:assert/strict";
import test from "node:test";
import {
  __recordWithPool,
  __resetDataQualityTelemetry,
  type DataQualityEventInput,
} from "./quality";

/* The write path is fire-and-forget by design; these tests exercise the core
 * with an injected pool so no database (and no network) is required. */

function fakePool(): {
  calls: Array<{ text: string; params: unknown[] }>;
  query: (text: string, params: unknown[]) => Promise<unknown>;
} {
  const calls: Array<{ text: string; params: unknown[] }> = [];
  return {
    calls,
    query: async (text: string, params: unknown[]) => {
      calls.push({ text, params });
      return { rows: [] };
    },
  };
}

const valid: DataQualityEventInput = {
  sourceId: "trading-economics",
  kind: "fetch_failure",
  message: "upstream HTTP 503",
  latencyMs: 1234,
};

test("a valid event inserts one bounded row with an incident key", async () => {
  __resetDataQualityTelemetry();
  const pool = fakePool();
  await __recordWithPool(pool, {
    ...valid,
    instrumentId: "egx:EGX30",
    message: "  upstream   HTTP 503  ",
  });
  assert.equal(pool.calls.length, 1);
  assert.match(pool.calls[0].text, /INSERT INTO data_quality_events/);
  assert.deepEqual([...pool.calls[0].params], [
    "trading-economics",
    "fetch_failure",
    "egx:EGX30",
    1234,
    "upstream HTTP 503",
    "trading-economics:fetch_failure:egx:EGX30",
  ]);
});

test("invalid inputs are dropped without any query", async () => {
  const bad = [
    { ...valid, kind: "not_a_kind" as DataQualityEventInput["kind"] },
    { ...valid, sourceId: "   " },
    { ...valid, message: "   " },
    null,
  ];
  for (const input of bad) {
    __resetDataQualityTelemetry();
    const pool = fakePool();
    await __recordWithPool(pool, input as DataQualityEventInput);
    assert.equal(pool.calls.length, 0, `dropped: ${JSON.stringify(input)?.slice(0, 80)}`);
  }
});

test("messages are whitespace-collapsed and capped at 300 characters", async () => {
  __resetDataQualityTelemetry();
  const pool = fakePool();
  await __recordWithPool(pool, { ...valid, message: `a ${"x".repeat(500)}` });
  assert.equal(pool.calls.length, 1);
  assert.equal(String(pool.calls[0].params[4]).length, 300);
  /* Out-of-range latencies are normalized, never stored as garbage. */
  __resetDataQualityTelemetry();
  const pool2 = fakePool();
  await __recordWithPool(pool2, { ...valid, latencyMs: -5 });
  assert.equal(pool2.calls[0].params[3], null);
  __resetDataQualityTelemetry();
  const pool3 = fakePool();
  await __recordWithPool(pool3, { ...valid, latencyMs: 9_999_999 });
  assert.equal(pool3.calls[0].params[3], 600_000);
});

test("a missing table breaks the circuit and silences further writes until reset", async () => {
  __resetDataQualityTelemetry();
  const pool = fakePool();
  pool.query = async (text: string, params: unknown[]) => {
    pool.calls.push({ text, params });
    throw new Error('relation "data_quality_events" does not exist');
  };
  await __recordWithPool(pool, valid);
  await __recordWithPool(pool, valid);
  assert.equal(pool.calls.length, 1, "the circuit suppresses the second write");
  __resetDataQualityTelemetry();
  await __recordWithPool(pool, valid);
  assert.equal(pool.calls.length, 2, "a reset re-arms the circuit");
});

test("other failures do not break the circuit and never throw", async () => {
  __resetDataQualityTelemetry();
  const pool = fakePool();
  pool.query = async (text: string, params: unknown[]) => {
    pool.calls.push({ text, params });
    throw new Error("connection terminated unexpectedly");
  };
  await __recordWithPool(pool, valid);
  await __recordWithPool(pool, valid);
  assert.equal(pool.calls.length, 2, "transient failures keep telemetry armed");
});

test("in-flight writes are capped so a stuck DB cannot pile up work", async () => {
  __resetDataQualityTelemetry();
  const started: Array<() => void> = [];
  const pool = {
    calls: 0,
    query: () =>
      new Promise<unknown>((resolve) => {
        pool.calls += 1;
        started.push(() => resolve({ rows: [] }));
      }),
  };
  for (let i = 0; i < 10; i += 1) void __recordWithPool(pool, valid);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(pool.calls, 8, "only 8 concurrent inserts are allowed");
  started.forEach((done) => done());
  await new Promise((r) => setTimeout(r, 20));
  __resetDataQualityTelemetry();
});
