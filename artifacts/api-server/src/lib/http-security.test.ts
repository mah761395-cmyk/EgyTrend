import assert from "node:assert/strict";
import test from "node:test";
import {
  allowedOriginsFromEnv,
  isConfiguredOriginAllowed,
  isSameOriginRequest,
  isStateChangingMethod,
  normalizeOrigin,
  resolveTrustProxy,
} from "./http-security";

test("normalizes only http(s) origins", () => {
  assert.equal(normalizeOrigin("https://app.example.test/path?x=1"), "https://app.example.test");
  assert.equal(normalizeOrigin("javascript:alert(1)"), null);
  assert.equal(normalizeOrigin("not a url"), null);
  assert.equal(normalizeOrigin(null), null);
});

test("CORS allow-list ignores wildcard and includes explicit configured origins", () => {
  const allowed = allowedOriginsFromEnv({
    NODE_ENV: "production",
    CORS_ORIGINS: "https://app.example.test, *, https://staging.example.test/path",
    APP_BASE_URL: "https://web.example.test/",
  });
  assert.deepEqual([...allowed].sort(), [
    "https://app.example.test",
    "https://staging.example.test",
    "https://web.example.test",
  ]);
  assert.equal(isConfiguredOriginAllowed("https://app.example.test", allowed), true);
  assert.equal(isConfiguredOriginAllowed("https://attacker.example", allowed), false);
});

test("allows same-origin state changes but not a lookalike origin", () => {
  assert.equal(isSameOriginRequest("https://egytrend.example", "egytrend.example", "https"), true);
  assert.equal(isSameOriginRequest("https://egytrend.example.evil", "egytrend.example", "https"), false);
  assert.equal(isStateChangingMethod("GET"), false);
  assert.equal(isStateChangingMethod("OPTIONS"), false);
  assert.equal(isStateChangingMethod("POST"), true);
  assert.equal(isStateChangingMethod("delete"), true);
});

test("trusts proxy only when configured or on Vercel", () => {
  assert.equal(resolveTrustProxy(undefined, false), false);
  assert.equal(resolveTrustProxy(undefined, true), 1);
  assert.equal(resolveTrustProxy("2", false), 2);
  assert.equal(resolveTrustProxy("invalid", true), false);
});
