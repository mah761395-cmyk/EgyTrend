import assert from "node:assert/strict";
import test from "node:test";
import { safeUpstreamErrorSummary, UpstreamHttpError } from "./http";

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
