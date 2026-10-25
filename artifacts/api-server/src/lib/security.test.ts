/**
 * Regression tests for the session/CSRF hardening on the restored branch.
 * No database is touched: cookies, origin rules, CSRF decisions and token
 * extraction are all pure functions of the request.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

process.env["NODE_ENV"] = "test";
process.env["SESSION_SECRET"] = "test-only-session-secret-0123456789abcdef";

import {
  ADMIN_COOKIE,
  SESSION_COOKIE,
  clearSessionCookie,
  corsOptionsFor,
  isAllowedOrigin,
  isSameHost,
  requireSameOrigin,
  setSessionCookie,
} from "./security";

type Captured = { statusCode: number; body: unknown; headers: Record<string, string> };

function mockRes(): { res: any; out: Captured } {
  const out: Captured = { statusCode: 200, body: null, headers: {} };
  const res: any = {
    setHeader(name: string, value: string) {
      out.headers[name.toLowerCase()] = value;
    },
    status(code: number) {
      out.statusCode = code;
      return res;
    },
    json(body: unknown) {
      out.body = body;
      return res;
    },
    cookie(name: string, value: string, options: Record<string, unknown>) {
      out.headers[`cookie:${name}`] = JSON.stringify({ value, ...options });
    },
    clearCookie(name: string, options: Record<string, unknown>) {
      out.headers[`clear:${name}`] = JSON.stringify(options);
    },
  };
  return { res, out };
}

function mockReq(init: {
  method?: string;
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
}): any {
  const headers = Object.fromEntries(
    Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    method: init.method || "GET",
    headers,
    cookies: init.cookies || {},
    header(name: string) {
      return headers[name.toLowerCase()];
    },
  };
}

function nextRecorder(): { next: () => void; called: () => boolean } {
  let called = false;
  return { next: () => { called = true; }, called: () => called };
}

/* ── Session cookies ─────────────────────────────────────────────────── */

test("the session cookie is httpOnly, sameSite=lax and path=/, never script-readable", () => {
  const { res, out } = mockRes();
  setSessionCookie(res, SESSION_COOKIE, "jwt-value", 1000);
  const stored = JSON.parse(out.headers[`cookie:${SESSION_COOKIE}`]);
  assert.equal(stored.value, "jwt-value");
  assert.equal(stored.httpOnly, true);
  assert.equal(stored.sameSite, "lax");
  assert.equal(stored.path, "/");
  assert.equal(stored.maxAge, 1000);
  /* secure is off only because NODE_ENV=test; production must set it. */
  assert.equal(stored.secure, false);
});

test("logging out clears the cookie with the same scope", () => {
  const { res, out } = mockRes();
  clearSessionCookie(res, ADMIN_COOKIE);
  const cleared = JSON.parse(out.headers[`clear:${ADMIN_COOKIE}`]);
  assert.equal(cleared.path, "/");
  assert.equal(cleared.httpOnly, true);
});

/* ── CORS ────────────────────────────────────────────────────────────── */

test("the platform's own origin is allowed", () => {
  assert.equal(isAllowedOrigin("https://egy-trend.vercel.app"), true);
  assert.equal(isAllowedOrigin("https://egytrend.com"), true);
});

test("a foreign website is refused (the old bare cors() allowed every one)", () => {
  assert.equal(isAllowedOrigin("https://evil.example"), false);
  assert.equal(isAllowedOrigin("https://egy-trend.vercel.app.evil.example"), false);
});

test("preview deployments of this project are allowed, other vercel apps are not", () => {
  assert.equal(isAllowedOrigin("https://egy-trend-git-main-team.vercel.app"), true);
  assert.equal(isAllowedOrigin("https://someone-else.vercel.app"), false);
});

test("a request's own host is always allowed, even on an unlisted domain", () => {
  const req = mockReq({ headers: { host: "app.example.net" } });
  assert.equal(isSameHost("https://app.example.net", req), true);
  assert.equal(isSameHost("https://evil.example", req), false);
});

test("x-forwarded-host (Vercel proxy) is used for same-host checks", () => {
  const req = mockReq({ headers: { "x-forwarded-host": "egytrend.example", host: "10.0.0.1" } });
  assert.equal(isSameHost("https://egytrend.example", req), true);
});

test("the CORS delegate rejects a foreign origin and accepts the same host", () => {
  const req = mockReq({ headers: { host: "app.example.net" } });
  let options: any;
  (corsOptionsFor as any)(req, (_err: unknown, opts: unknown) => { options = opts; });

  let foreignMessage = "";
  options.origin("https://evil.example", (err: Error | null) => { foreignMessage = String(err?.message || ""); });
  assert.match(foreignMessage, /origin not allowed/);

  let allowed: boolean | undefined;
  options.origin("https://app.example.net", (err: Error | null, ok: boolean) => {
    assert.equal(err, null);
    allowed = ok;
  });
  assert.equal(allowed, true);
  assert.equal(options.credentials, true);
});

/* ── CSRF ────────────────────────────────────────────────────────────── */

test("safe methods never need an origin", () => {
  const { next, called } = nextRecorder();
  requireSameOrigin(mockReq({ method: "GET" }), mockRes().res, next);
  assert.equal(called(), true);
});

test("header-token clients are not affected by the CSRF guard", () => {
  const { next, called } = nextRecorder();
  requireSameOrigin(
    mockReq({ method: "POST", headers: { authorization: "Bearer abc" } }),
    mockRes().res,
    next,
  );
  assert.equal(called(), true);
});

test("a cookie-authenticated POST from a foreign origin is blocked", () => {
  const { res, out } = mockRes();
  const { next, called } = nextRecorder();
  requireSameOrigin(
    mockReq({
      method: "POST",
      cookies: { [SESSION_COOKIE]: "jwt" },
      headers: { cookie: `${SESSION_COOKIE}=jwt`, origin: "https://evil.example", host: "app.example.net" },
    }),
    res,
    next,
  );
  assert.equal(called(), false);
  assert.equal(out.statusCode, 403);
});

test("a cookie-authenticated POST from this site passes", () => {
  const { next, called } = nextRecorder();
  requireSameOrigin(
    mockReq({
      method: "POST",
      headers: { cookie: `${SESSION_COOKIE}=jwt`, origin: "https://app.example.net", host: "app.example.net" },
    }),
    mockRes().res,
    next,
  );
  assert.equal(called(), true);
});

test("a cookie POST with no Origin needs a same-site Referer, otherwise 403", () => {
  const blocked = mockRes();
  const first = nextRecorder();
  requireSameOrigin(
    mockReq({ method: "POST", headers: { cookie: `${ADMIN_COOKIE}=jwt`, host: "app.example.net" } }),
    blocked.res,
    first.next,
  );
  assert.equal(first.called(), false);
  assert.equal(blocked.out.statusCode, 403);

  const allowedRes = mockRes();
  const second = nextRecorder();
  requireSameOrigin(
    mockReq({
      method: "POST",
      headers: { cookie: `${ADMIN_COOKIE}=jwt`, host: "app.example.net", referer: "https://app.example.net/settings" },
    }),
    allowedRes.res,
    second.next,
  );
  assert.equal(second.called(), true);
});

/* ── Token extraction (cookie first, header second) ──────────────────── */

test("the user session comes from its own httpOnly cookie, not a header", async () => {
  const { currentUser, signUserToken, USER_SESSION_COOKIE } = await import("./userAuth");
  const token = signUserToken({ sub: 7, phone: "01000000000", name: "Test", role: "user", plan: "free" });
  const req = mockReq({
    cookies: { [USER_SESSION_COOKIE]: token },
    headers: { authorization: "Bearer attacker-supplied-value" },
  });
  assert.equal(currentUser(req)?.sub, 7, "the httpOnly cookie wins over a supplied header");
});

test("the admin session is read from its own cookie, and a user token never opens it", async () => {
  const {
    ADMIN_SESSION_COOKIE,
    USER_SESSION_COOKIE,
    adminSessionToken,
    currentAdminClaims,
    signUserToken,
  } = await import("./userAuth");
  /* Reuse the same signing path as admin.ts (role in the JWT). */
  const jwt = (await import("jsonwebtoken")).default;
  const secret = process.env["SESSION_SECRET"]!;
  const staff = jwt.sign({ sub: 3, name: "Editor", role: "editor", email: "e@example.com" }, secret, { expiresIn: "1h" });
  const req = mockReq({ cookies: { [ADMIN_SESSION_COOKIE]: staff } });
  assert.equal(adminSessionToken(req), staff);
  assert.equal(currentAdminClaims(req)?.role, "editor");

  const superAdmin = jwt.sign({ sub: 1, name: "Owner", role: "super_admin", email: "o@example.com" }, secret, { expiresIn: "1h" });
  assert.equal(currentAdminClaims(mockReq({ cookies: { [ADMIN_SESSION_COOKIE]: superAdmin } }))?.role, "super_admin");

  /* A normal app-user session can never be mistaken for a staff session. */
  const userToken = signUserToken({ sub: 9, phone: "01000000001", name: "User", role: "user", plan: "vip" });
  assert.equal(currentAdminClaims(mockReq({ cookies: { [ADMIN_SESSION_COOKIE]: userToken } })), null);
  assert.equal(currentAdminClaims(mockReq({ cookies: { [USER_SESSION_COOKIE]: userToken } })), null);
});

test("a token signed with another secret or with the wrong role is rejected", async () => {
  const { verifyUserToken } = await import("./userAuth");
  const jwt = (await import("jsonwebtoken")).default;
  const forged = jwt.sign({ sub: 1, phone: "01000000000", name: "X", role: "user", plan: "vip" }, "another-secret");
  assert.equal(verifyUserToken(forged), null);

  const wrongRole = jwt.sign({ sub: 1, phone: "01000000000", name: "X", role: "admin", plan: "vip" }, process.env["SESSION_SECRET"]!);
  assert.equal(verifyUserToken(wrongRole), null);
});
