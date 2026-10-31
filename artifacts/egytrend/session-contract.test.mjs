/**
 * Contract test: the client never confuses the three auth failure modes.
 *   401 + /me still answers  -> the session is alive; the 401 was a transient
 *                               store hiccup → "server", keep U, no "log in".
 *   401 + /me also 401       -> the session really is gone → "login", wipe U.
 *   403 + signed in, not VIP -> subscription ended → "vip" (renew), not "login".
 *   403 + still VIP          -> transient server denial → "server".
 *   503                      -> server hiccup → "server".
 *
 * Also: boot tolerates transient 5xx on /me (short retries) so a serverless
 * cold start cannot read as "session ended" — while a definitive 401 stops
 * the retry loop immediately. The login session itself is a 7-day HttpOnly
 * cookie with a 7-day JWT (server-side sliding refresh at /me), so a valid
 * session survives navigation and page reloads for days, not minutes.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "index.html"), "utf8");

function functionBody(name) {
  let start = html.indexOf(`function ${name}(`);
  assert.ok(start !== -1, `index.html must define ${name}`);
  /* Keep an `async` prefix — dropping it turns the inner `await` into a
   * syntax error in the eval'd copy. */
  if (html.slice(Math.max(0, start - 6), start) === "async ") start -= 6;
  let i = html.indexOf("(", start);
  let pd = 0;
  for (; i < html.length; i += 1) {
    const ch = html[i];
    if (ch === "(") pd += 1;
    else if (ch === ")") {
      pd -= 1;
      if (pd === 0) break;
    }
  }
  let depth = 0;
  for (i = html.indexOf("{", i); i < html.length; i += 1) {
    const ch = html[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return html.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

function response(status, payload = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  };
}

function makeAuthHandlers(meSequence) {
  const calls = { me: 0, hdr: 0 };
  const fetchStub = async (url) => {
    assert.ok(String(url).startsWith("/api/"), `unexpected fetch ${url}`);
    const next = meSequence[Math.min(calls.me, meSequence.length - 1)];
    calls.me += 1;
    return typeof next === "function" ? next() : next;
  };
  const U = { plan: "free", phone: "0101234567" };
  /* The real app's setCurrentUser rebinds the same U the handler reads below;
     mutate the shared object so the eval'd copy sees the server's fresh plan. */
  const setCurrentUser = (freshUser) => { Object.assign(U, freshUser); };
  const renderHdrVip = () => { calls.hdr += 1; };
  const factory = new Function(
    "fetch",
    "setCurrentUser",
    "renderHdrVip",
    "U",
    `${functionBody("syncUserFromServer")}\n${functionBody("onAuthFailure")}\nreturn { onAuthFailure };`,
  );
  return { handlers: factory(fetchStub, setCurrentUser, renderHdrVip, U), calls, U };
}

test("401 with a just-verified session reads as transient server state, not 'session ended'", async () => {
  const { handlers, calls } = makeAuthHandlers([response(200, { status: "ok", user: { plan: "free" } })]);
  const kind = await handlers.onAuthFailure(401);
  assert.equal(kind, "server", "a live session must not be announced as dead");
  assert.equal(calls.me, 1, "the session was re-verified exactly once");
  assert.equal(calls.hdr, 0, "U was NOT wiped (no logout of a live session)");
});

test("401 where /me also says 401 is a genuinely dead session → login gate, U wiped", async () => {
  const { handlers, calls, U } = makeAuthHandlers([response(401, { status: "error", message: "login required" })]);
  const kind = await handlers.onAuthFailure(401);
  assert.equal(kind, "login");
  assert.equal(calls.hdr, 1, "the stale identity was cleared and the header re-rendered");
  assert.ok(U, "the parameter object still exists; the handler reassigned its binding");
});

test("403 for a signed-in non-VIP user is 'subscription ended', not 'session ended'", async () => {
  const { handlers } = makeAuthHandlers([response(200, { status: "ok", user: { plan: "free" } })]);
  const kind = await handlers.onAuthFailure(403);
  assert.equal(kind, "vip", "login session and VIP subscription stay separate states");
});

test("403 while still VIP is a transient server denial", async () => {
  const { handlers } = makeAuthHandlers([response(200, { status: "ok", user: { plan: "vip" } })]);
  const kind = await handlers.onAuthFailure(403);
  assert.equal(kind, "server");
});

test("503 is always the server state", async () => {
  const { handlers, calls } = makeAuthHandlers([response(401)]);
  const kind = await handlers.onAuthFailure(503);
  assert.equal(kind, "server");
  assert.equal(calls.me, 0, "no re-sync needed for an explicit server error");
});

test("boot retries transient 5xx on /me but stops at a definitive 401", () => {
  const code = functionBody("fetchUserMeWithRetry");
  const make = (sequence) => {
    const calls = { n: 0, waits: [] };
    const fetchStub = async () => sequence[Math.min(calls.n, sequence.length - 1)] || null;
    calls.n; // (counted via fetchStub below)
    const fetchCounting = async () => {
      const r = sequence[Math.min(calls.n, sequence.length - 1)] || null;
      calls.n += 1;
      return r;
    };
    const fakeSetTimeout = (fn, ms) => { calls.waits.push(ms); fn(); };
    const fetchUserMeWithRetry = new Function("fetch", "setTimeout", code + "\nreturn fetchUserMeWithRetry;")(fetchCounting, fakeSetTimeout);
    return { fetchUserMeWithRetry, calls };
  };
  return (async () => {
    const recovered = make([response(503), response(503), response(200, { status: "ok", user: { plan: "free" } })]);
    const r1 = await recovered.fetchUserMeWithRetry();
    assert.equal(r1.ok, true, "two hiccups then success → boot proceeds");
    assert.equal(recovered.calls.n, 3);
    assert.deepEqual(recovered.calls.waits, [1200, 1200], "bounded, short backoff between attempts");

    const definitive = make([response(401, { status: "error", message: "login required" })]);
    const r2 = await definitive.fetchUserMeWithRetry();
    assert.equal(r2.status, 401, "a definitive 401 stops the loop immediately");
    assert.equal(definitive.calls.n, 1);

    const exhausted = make([response(503)]);
    const r3 = await exhausted.fetchUserMeWithRetry();
    assert.equal(r3.status, 503, "retries exhausted → the caller decides (honest guest fallback)");
    assert.equal(exhausted.calls.n, 3);
  })();
});

test("the app boot path uses the retrying /me, and the session is a long-lived HttpOnly cookie", () => {
  assert.match(html, /const r=await fetchUserMeWithRetry\(\);/, "boot re-validates /me with transient-error retries");
  /* Server-side truth: 7-day JWT + 7-day cookie, sliding refresh while the
   * user is active — the session must never die after "a short time". */
  const server = readFileSync(join(here, "..", "api-server", "src", "lib", "userAuth.ts"), "utf8");
  assert.match(server, /expiresIn: "7d"/, "JWT lifetime is 7 days");
  const userRoute = readFileSync(join(here, "..", "api-server", "src", "routes", "user.ts"), "utf8");
  assert.match(userRoute, /sessionCookieOptions\(7 \* 24 \* 60 \* 60 \* 1000\)/, "cookie Max-Age is 7 days");
  assert.match(userRoute, /Sliding refresh/, "active sessions are re-minted while the user is working");
  assert.match(server, /httpOnly: true/, "session cookie is HttpOnly — the browser JS never sees the token");
  assert.match(server, /sameSite: "lax"/, "cookie is same-site");
  assert.match(server, /secure: process.env\["NODE_ENV"\] === "production"/, "cookie is secure in production");
});
