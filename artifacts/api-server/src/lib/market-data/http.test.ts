import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_RETRY_WAIT_MS,
  parseRetryAfterMs,
  ProviderRateGate,
  ResilientHttpClient,
  safeUpstreamErrorSummary,
  UpstreamHttpError,
  type FetchLike,
} from "./http";

test("upstream error summaries never forward an API key or request URL", () => {
  const secret = "key-that-must-not-leak";
  const networkError = new Error(
    `fetch failed for https://vendor.example/quote?apikey=${secret}`,
  );
  const summary = safeUpstreamErrorSummary(networkError);
  assert.equal(summary, "upstream request failed");
  assert.ok(!summary.includes(secret));
  assert.ok(!summary.includes("https://"));

  const vendorError = new UpstreamHttpError(
    `vendor response mentioned ${secret}`,
    429,
  );
  assert.equal(safeUpstreamErrorSummary(vendorError), "upstream HTTP 429");

  const timeout = new Error(`aborted while using ${secret}`);
  timeout.name = "AbortError";
  assert.equal(safeUpstreamErrorSummary(timeout), "upstream timeout");
});

test("a 429 with a short Retry-After is honoured before the retry", async () => {
  let calls = 0;
  const fetcher: FetchLike = async () => {
    calls++;
    if (calls === 1) return new Response("rate limited", { status: 429, headers: { "retry-after": "1" } });
    return Response.json({ ok: true });
  };
  const client = new ResilientHttpClient(fetcher, new ProviderRateGate());
  const start = Date.now();
  const data = await client.getJson<{ ok: boolean }>("https://vendor.example/x", {
    providerId: "test",
    attempts: 2,
    minIntervalMs: 0,
  });
  const elapsed = Date.now() - start;
  assert.deepEqual(data, { ok: true });
  assert.equal(calls, 2);
  assert.ok(elapsed >= 900, `expected a ~1s Retry-After wait before retrying, got ${elapsed}ms`);
});

test("a 429 whose Retry-After exceeds the cap fails fast instead of blocking", async () => {
  let calls = 0;
  const fetcher: FetchLike = async () => {
    calls++;
    return new Response("rate limited", { status: 429, headers: { "retry-after": "999" } });
  };
  const client = new ResilientHttpClient(fetcher, new ProviderRateGate());
  const start = Date.now();
  await assert.rejects(
    () => client.getJson("https://vendor.example/x", { providerId: "test", attempts: 3, minIntervalMs: 0 }),
    (error: unknown) => error instanceof UpstreamHttpError && error.status === 429,
  );
  const elapsed = Date.now() - start;
  assert.equal(calls, 1, "no second attempt when the rate window is longer than the cap");
  assert.ok(elapsed < 2_000, `failed fast, got ${elapsed}ms`);
  assert.ok(MAX_RETRY_WAIT_MS < 60_000, "the cap must stay inside the serverless duration budget");
});

test("parseRetryAfterMs handles seconds, HTTP dates and garbage", () => {
  assert.equal(parseRetryAfterMs(null), undefined);
  assert.equal(parseRetryAfterMs(""), undefined);
  assert.equal(parseRetryAfterMs("30"), 30_000);
  assert.equal(parseRetryAfterMs("not-a-value"), undefined);
  const inFive = new Date(Date.now() + 5_000).toUTCString();
  const ms = parseRetryAfterMs(inFive);
  assert.ok(ms !== undefined && ms > 3_000 && ms <= 5_000, `http-date parse gave ${ms}`);
});
