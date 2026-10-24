/**
 * Session revocation: logout kills one session, password change / disable kills
 * the subject's older sessions only, and the middleware turns a revoked token
 * into an anonymous request without changing any response shape.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import jwt from "jsonwebtoken";

process.env["SESSION_SECRET"] = "test-only-session-secret-0123456789abcdef";
process.env["AUTH_SHARED_SESSIONS"] = "0";

import {
  createMemoryRevocationStore,
  revokePresentedSession,
  sessionRef,
  sessionRevocationGuard,
} from "./session-revocation";
import { bearerToken, signUserToken, verifyUserToken } from "./userAuth";
import { SESSION_COOKIE } from "./security";

const SECRET = process.env["SESSION_SECRET"]!;

function userToken(overrides: Record<string, unknown> = {}, expiresIn: number | string = "7d"): string {
  return jwt.sign(
    { sub: 42, phone: "01012345678", name: "User", role: "user", plan: "free", ...overrides },
    SECRET,
    { expiresIn: expiresIn as number, jwtid: `jti-${Math.random().toString(36).slice(2)}` },
  );
}

function staffToken(role = "super_admin"): string {
  return jwt.sign({ sub: 3, name: "Staff", role, email: "s@e.eg" }, SECRET, {
    expiresIn: "1h",
    jwtid: `staff-${Math.random().toString(36).slice(2)}`,
  });
}

function mockReq(cookies: Record<string, string>, headers: Record<string, string> = {}) {
  return {
    method: "GET",
    cookies,
    headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
    header(name: string) {
      return (this.headers as Record<string, string>)[name.toLowerCase()];
    },
  } as any;
}

function mockRes() {
  const out = { cleared: [] as string[], headers: {} as Record<string, string> };
  const res: any = {
    setHeader(name: string, value: string) {
      out.headers[name.toLowerCase()] = value;
    },
    clearCookie(name: string) {
      out.cleared.push(name);
    },
  };
  return { res, out };
}

/* ── Store semantics ─────────────────────────────────────────────────────── */

test("revoking one session leaves the account's other sessions alive", async () => {
  const store = createMemoryRevocationStore();
  await store.revokeOne("user", 42, "session-a");
  assert.equal(await store.isRevoked("user", 42, "session-a", Date.now()), true);
  assert.equal(await store.isRevoked("user", 42, "session-b", Date.now()), false);
});

test("revoke-all kills sessions issued before it, not the fresh one", async () => {
  const store = createMemoryRevocationStore();
  const before = Date.now() - 60_000;
  await store.revokeAll("user", 42);
  assert.equal(await store.isRevoked("user", 42, "old", before), true);
  assert.equal(await store.isRevoked("user", 42, "new", Date.now() + 60_000), false);
});

test("revocation is scoped: one user never locks another, or the staff", async () => {
  const store = createMemoryRevocationStore();
  await store.revokeAll("user", 42);
  assert.equal(await store.isRevoked("user", 43, "x", 0), false);
  assert.equal(await store.isRevoked("admin", 42, "x", 0), false);
});

test("revokeAll keeps the earliest revocation even if called twice", async () => {
  const store = createMemoryRevocationStore();
  await store.revokeAll("user", 42);
  await store.revokeAll("user", 42);
  assert.equal(await store.isRevoked("user", 42, "any", Date.now() - 5_000), true);
});

/* ── Token validity ──────────────────────────────────────────────────────── */

test("a freshly signed session carries its own jti and is accepted", () => {
  const token = signUserToken({ sub: 1, phone: "01000000000", name: "A", role: "user", plan: "free" });
  const claims = verifyUserToken(token);
  assert.ok(claims);
  assert.equal(claims!.role, "user");
  assert.ok(typeof claims!.jti === "string" && claims!.jti.length > 0);
});

test("two logins produce two different session ids", () => {
  const a = verifyUserToken(signUserToken({ sub: 1, phone: "01000000000", name: "A", role: "user", plan: "free" }));
  const b = verifyUserToken(signUserToken({ sub: 1, phone: "01000000000", name: "A", role: "user", plan: "free" }));
  assert.notEqual(a!.jti, b!.jti);
});

test("an expired token is rejected", () => {
  assert.equal(verifyUserToken(userToken({}, -10)), null);
});

test("a forged signature is rejected", () => {
  const forged = jwt.sign({ sub: 1, phone: "01000000000", name: "A", role: "user", plan: "vip" }, "another-secret", {
    expiresIn: "7d",
    jwtid: "forged",
  });
  assert.equal(verifyUserToken(forged), null);
});

test("a token cannot be re-labelled: staff role inside a user token is refused", () => {
  assert.equal(verifyUserToken(userToken({ role: "super_admin" })), null);
  assert.equal(sessionRef("user", userToken({ role: "admin" })), null);
});

test("sessionRef only accepts ids and roles it can revoke", () => {
  const ref = sessionRef("user", userToken());
  assert.equal(ref?.subject, 42);
  assert.ok(ref?.jti);
  assert.equal(sessionRef("user", "not-a-token"), null);
  const staff = sessionRef("admin", staffToken("editor"));
  assert.equal(staff?.subject, 3);
});

/* ── Logout revokes the presented session ───────────────────────────────── */

test("logging out revokes exactly the presented session", async () => {
  const token = userToken();
  assert.equal(await revokePresentedSession("user", token), true);
  const ref = sessionRef("user", token)!;
  assert.equal(await sessionRefRevoked(ref), true);
  /* A different session of the same user still works. */
  const other = userToken();
  assert.equal(await sessionRefRevoked(sessionRef("user", other)!), false);
});

/* ── Password change (the order matters) ─────────────────────────────────── */

test("the session minted after a password change survives the revocation", async () => {
  const { revokeAllSessions, isSessionRevoked } = await import("./session-revocation");
  const revokedAt = Date.now();
  await revokeAllSessions("user", 7);
  const fresh = signUserToken(
    { sub: 7, phone: "01000000000", name: "A", role: "user", plan: "free" },
    { issuedAfterMs: revokedAt },
  );
  const claims = verifyUserToken(fresh);
  assert.ok(claims, "the replacement session must be a valid token");
  assert.equal(await isSessionRevoked(sessionRef("user", fresh)!), false);
});

test("every session issued before a password change is revoked", async () => {
  const { revokeAllSessions, isSessionRevoked } = await import("./session-revocation");
  const old = signUserToken({ sub: 8, phone: "01000000000", name: "A", role: "user", plan: "free" });
  const oldRef = sessionRef("user", old)!;
  assert.equal(await isSessionRevoked(oldRef), false);
  await revokeAllSessions("user", 8);
  assert.equal(await isSessionRevoked(oldRef), true, "a stolen pre-change token must die");
  /* Unrelated accounts keep working. */
  const other = signUserToken({ sub: 9, phone: "01000000001", name: "B", role: "user", plan: "free" });
  assert.equal(await isSessionRevoked(sessionRef("user", other)!), false);
});

test("a replacement session is issued strictly after the revocation instant", () => {
  const revokedAt = 1_800_000_000_450; // 16:00:00.450 UTC
  const token = signUserToken(
    { sub: 1, phone: "01000000000", name: "A", role: "user", plan: "free" },
    { issuedAfterMs: revokedAt },
  );
  const claims = verifyUserToken(token)!;
  const issuedMs = Number(claims.iat) * 1000;
  assert.ok(issuedMs > revokedAt, `iat=${claims.iat}s must be after ${revokedAt}ms`);
});

test("a token without a jti (issued before this change) revokes the account's sessions", async () => {
  const legacy = jwt.sign({ sub: 99, phone: "01000000000", name: "Old", role: "user", plan: "free" }, SECRET, {
    expiresIn: "7d",
  });
  await revokePresentedSession("user", legacy);
  const ref = sessionRef("user", legacy)!;
  assert.equal(await sessionRefRevoked(ref), true);
});

test("an unverifiable token revokes nothing", async () => {
  assert.equal(await revokePresentedSession("user", "garbage"), false);
});

async function sessionRefRevoked(ref: ReturnType<typeof sessionRef>): Promise<boolean> {
  const { isSessionRevoked } = await import("./session-revocation");
  return isSessionRevoked(ref!);
}

/* ── Guard middleware ────────────────────────────────────────────────────── */

test("a valid cookie session passes the guard untouched", async () => {
  const token = userToken();
  const req = mockReq({ [SESSION_COOKIE]: token }, { authorization: `Bearer ${token}` });
  const { res, out } = mockRes();
  let nextCalled = false;
  await sessionRevocationGuard(req, res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);
  assert.equal(req.cookies[SESSION_COOKIE], token);
  assert.equal(verifyUserToken(bearerToken(req))?.sub, 42);
  assert.deepEqual(out.cleared, []);
});

test("a revoked cookie session is stripped to an anonymous request", async () => {
  const token = userToken();
  const req = mockReq({ [SESSION_COOKIE]: token }, { authorization: `Bearer ${token}` });
  const { res, out } = mockRes();
  await revokePresentedSession("user", token);
  await sessionRevocationGuard(req, res, () => {});
  assert.equal(bearerToken(req), "");
  assert.equal(verifyUserToken(bearerToken(req)), null);
  assert.deepEqual(out.cleared, [SESSION_COOKIE]);
});

test("a revoked staff cookie is stripped with its header fallbacks", async () => {
  const token = staffToken();
  const req = mockReq({ et_admin: token }, { "x-admin-token": token, authorization: `Bearer ${token}` });
  const { res, out } = mockRes();
  await revokePresentedSession("admin", token);
  await sessionRevocationGuard(req, res, () => {});
  assert.equal(req.headers["x-admin-token"], undefined);
  assert.equal(req.headers["authorization"], undefined);
  assert.deepEqual(out.cleared, ["et_admin"]);
});

test("an anonymous request is untouched and never queried", async () => {
  const req = mockReq({});
  const { res } = mockRes();
  let nextCalled = false;
  await sessionRevocationGuard(req, res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);
});
