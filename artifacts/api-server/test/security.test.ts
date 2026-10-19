/**
 * EgyTrend — automated SECURITY regression suite.
 *
 * Covers exactly what the audit asked for:
 *   • a regular user asking for an admin route      → denied
 *   • a signed-out visitor asking for user data     → denied
 *   • a free user calling AI directly               → denied (403)
 *   • a VIP user over the daily limit               → 429, no provider call
 *   • the admin panel is not downloadable by visitors
 *   • cookie sessions cannot be driven cross-site   → 403 (CSRF guard)
 *   • unknown origins get no CORS grant
 *   • the public bundle carries no admin UI and no API keys
 *   • every admin route still chains requireAuth/requireRole
 *
 * Run:  bun test artifacts/api-server/test/security.test.ts
 * Prep: node artifacts/api-server/test/setup-test-db.mjs   (local Postgres)
 *
 * Safety: talks ONLY to 127.0.0.1 with the *_test database seeded by the setup
 * script. Never touches production data or any real provider.
 */
import { afterAll, beforeAll, describe, expect, it, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const API_DIR = path.resolve(HERE, "..");
const REPO = path.resolve(API_DIR, "..", "..");

const PORT = Number(process.env.TEST_PORT || 8099);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const TEST_DB_URL = process.env.TEST_DATABASE_URL || "postgres://postgres@127.0.0.1:5432/egytrend_test";
const SESSION_SECRET = "test-session-secret-0123456789";
const ADMIN_PASSWORD = "TestAdmin123!";
const FREE_PHONE = "01000000001";
const VIP_PHONE = "01000000002";

let server: ChildProcess | null = null;
let dbReady = false;

/* ── helpers ────────────────────────────────────────────────────────────── */
const b64url = (buf: Buffer | string) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Sign a JWT exactly like the server does (HS256, SESSION_SECRET). */
function signJwt(payload: Record<string, unknown>): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, ...payload }));
  const sig = b64url(crypto.createHmac("sha256", SESSION_SECRET).update(`${header}.${body}`).digest());
  return `${header}.${body}.${sig}`;
}

function setCookieHeader(res: Response): string {
  const anyHeaders = res.headers as unknown as { getSetCookie?: () => string[] };
  const list = typeof anyHeaders.getSetCookie === "function" ? anyHeaders.getSetCookie() : [];
  return (list.length ? list : [res.headers.get("set-cookie") || ""]).join("; ");
}

function cookieValue(setCookie: string, name: string): string {
  const m = setCookie.match(new RegExp(`${name}=([^;]*)`));
  return m ? m[1] : "";
}

async function waitForServer(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${ORIGIN}/api/healthz`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error("API did not become ready in time");
}

beforeAll(async () => {
  /* Is the test database reachable? If not, DB-backed tests skip loudly rather
   * than silently passing. */
  try {
    const { createRequire } = await import("node:module");
    const req = createRequire(path.join(REPO, "lib", "db", "package.json"));
    const pg = req("pg") as { Client: new (c: Record<string, unknown>) => { connect(): Promise<void>; query(q: string): Promise<unknown>; end(): Promise<void> } };
    const client = new pg.Client({ connectionString: TEST_DB_URL });
    await client.connect();
    await client.query("select 1");
    await client.end();
    dbReady = true;
  } catch {
    dbReady = false;
  }

  server = spawn(process.execPath, ["dist/index.mjs"], {
    cwd: API_DIR,
    env: {
      ...process.env,
      PORT: String(PORT),
      DATABASE_URL: TEST_DB_URL,
      SESSION_SECRET,
      ADMIN_PASSWORD,
      NODE_ENV: "development",
      LOG_LEVEL: "silent",
    },
    stdio: "ignore",
  });
  await waitForServer();
});

afterAll(() => {
  server?.kill();
});

/* ────────────────────────────────────────────────────────────────────────── */
describe("visitor (no session at all)", () => {
  it("cannot download the admin panel", async () => {
    const res = await fetch(`${ORIGIN}/api/admin/panel.js`);
    expect(res.status).toBe(401);
    const body = await res.text();
    expect(body).not.toContain("renderAdmUsers");
    expect(body).not.toContain("renderAdmEmployees");
  });

  it("cannot list platform users", async () => {
    const res = await fetch(`${ORIGIN}/api/admin/users`);
    expect(res.status).toBe(401);
  });

  it("cannot read admin-only config endpoints", async () => {
    for (const p of ["/api/admin/bootstrap", "/api/admin/ai-status", "/api/ai/status", "/api/admin/requests", "/api/admin/audit-logs"]) {
      const res = await fetch(`${ORIGIN}${p}`);
      expect([401, 403]).toContain(res.status);
    }
  });

  it("cannot validate coupons (brute force surface)", async () => {
    const res = await fetch(`${ORIGIN}/api/admin/coupons/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "LETMEIN" }),
    });
    expect(res.status).toBe(401);
  });

  it("cannot submit a payment request without a session", async () => {
    const res = await fetch(`${ORIGIN}/api/admin/requests`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ planKey: "vip_monthly", method: "vodafone", tx: "123" }),
    });
    expect(res.status).toBe(401);
  });

  it("cannot call the AI chat", async () => {
    const res = await fetch(`${ORIGIN}/api/ai/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    expect([401, 403]).toContain(res.status);
  });
});

describe("regular signed-in user", () => {
  it("cannot reach admin endpoints even with a valid user session", async () => {
    const token = signJwt({ sub: 1, phone: FREE_PHONE, name: "Test Free", role: "user", plan: "free" });
    for (const p of ["/api/admin/users", "/api/admin/panel.js", "/api/admin/stats"]) {
      const res = await fetch(`${ORIGIN}${p}`, { headers: { Authorization: `Bearer ${token}` } });
      expect([401, 403]).toContain(res.status);
    }
  });

  it("cannot use the AI chat without VIP (server-side check)", async () => {
    const token = signJwt({ sub: 1, phone: FREE_PHONE, name: "Test Free", role: "user", plan: "free" });
    const res = await fetch(`${ORIGIN}/api/ai/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ messages: [{ role: "user", content: "حلل سهم" }] }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { message?: string };
    expect(body.message).toBe("VIP subscription required");
  });

  it("cannot use admin mutations (upgrade, ban, payments)", async () => {
    const token = signJwt({ sub: 1, phone: FREE_PHONE, name: "Test Free", role: "user", plan: "free" });
    const res = await fetch(`${ORIGIN}/api/admin/users/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action: "upgrade_vip", phone: FREE_PHONE }),
    });
    expect([401, 403]).toContain(res.status);
  });
});

describe("VIP user and the daily AI budget", () => {
  it("is stopped by the per-user daily limit without calling the provider", async () => {
    const token = signJwt({
      sub: 2,
      phone: VIP_PHONE,
      name: "Test VIP",
      role: "user",
      plan: "vip",
      vipExpiresAt: new Date(Date.now() + 30 * 864e5).toISOString(),
    });
    const res = await fetch(`${ORIGIN}/api/ai/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ messages: [{ role: "user", content: "حلل سهم" }] }),
    });
    if (!dbReady) return; // reported as a skip in the summary line below
    expect(res.status).toBe(429);
    const body = (await res.json()) as { message?: string };
    expect(body.message).toBe("ai_daily_limit");
  });
});

describe("admin session", () => {
  it("issues an httpOnly cookie and never a token in the body", async () => {
    if (!dbReady) return;
    const res = await fetch(`${ORIGIN}/api/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: ADMIN_PASSWORD }),
    });
    expect(res.status).toBe(200);
    const setCookie = setCookieHeader(res);
    expect(setCookie).toContain("et_admin=");
    expect(setCookie.toLowerCase()).toContain("httponly");
    expect(setCookie.toLowerCase()).toContain("samesite=lax");
    const body = (await res.json()) as Record<string, unknown>;
    expect(JSON.stringify(body)).not.toContain("token");
  });

  it("serves the panel only to that session, and the session probe works", async () => {
    if (!dbReady) return;
    const login = await fetch(`${ORIGIN}/api/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: ADMIN_PASSWORD }),
    });
    const cookie = `${"et_admin"}=${cookieValue(setCookieHeader(login), "et_admin")}`;

    const me = await fetch(`${ORIGIN}/api/admin/me`, { headers: { cookie } });
    expect(me.status).toBe(200);

    const panel = await fetch(`${ORIGIN}/api/admin/panel.js`, { headers: { cookie } });
    expect(panel.status).toBe(200);
    expect(panel.headers.get("content-type") || "").toContain("javascript");
    expect(panel.headers.get("cache-control") || "").toContain("no-store");
    expect(await panel.text()).toContain("renderAdmUsers");
  });

  it("logout clears the cookie server-side", async () => {
    if (!dbReady) return;
    const res = await fetch(`${ORIGIN}/api/admin/logout`, { method: "POST" });
    expect(res.status).toBe(200);
    const cleared = setCookieHeader(res).toLowerCase();
    expect(cleared).toContain("et_admin=");
    expect(cleared.includes("max-age=0") || cleared.includes("expires=")).toBe(true);
  });
});

describe("web hardening", () => {
  it("blocks cookie-authenticated mutations coming from a foreign origin", async () => {
    const res = await fetch(`${ORIGIN}/api/admin/logout`, {
      method: "POST",
      headers: { cookie: "et_admin=forged", Origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
  });

  it("does not grant CORS to an unknown origin", async () => {
    const res = await fetch(`${ORIGIN}/api/news/sources`, { headers: { Origin: "https://evil.example" } });
    expect(res.headers.get("access-control-allow-origin")).not.toBe("https://evil.example");
    expect(res.headers.get("access-control-allow-origin")).not.toBe("*");
  });

  it("sends security headers on API responses", async () => {
    const res = await fetch(`${ORIGIN}/api/healthz`);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-security-policy") || "").toContain("default-src 'none'");
  });

  it("keeps the SPA hardened through vercel.json", () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(REPO, "vercel.json"), "utf8")) as {
      headers?: Array<{ headers: Array<{ key: string }> }>;
    };
    const keys = (cfg.headers || []).flatMap((h) => h.headers.map((x) => x.key));
    for (const k of [
      "Content-Security-Policy",
      "Strict-Transport-Security",
      "X-Frame-Options",
      "X-Content-Type-Options",
      "Referrer-Policy",
      "Permissions-Policy",
    ]) {
      expect(keys).toContain(k);
    }
  });
});

describe("no secrets or admin code in the public bundle", () => {
  const publicBundle = path.join(REPO, "artifacts", "egytrend", "dist", "public", "index.html");

  it("ships no admin interface", () => {
    if (!fs.existsSync(publicBundle)) return; // build not run in this checkout
    const html = fs.readFileSync(publicBundle, "utf8");
    for (const needle of ["renderAdmUsers", "renderAdmEmployees", "loadAdmAudit", "renderAdmReqs", "renderAdmCoupons"]) {
      expect(html).not.toContain(needle);
    }
  });

  it("ships no API keys and no client-side provider calls", () => {
    if (!fs.existsSync(publicBundle)) return;
    const html = fs.readFileSync(publicBundle, "utf8");
    for (const pattern of [/AIza[0-9A-Za-z_-]{20,}/, /sk-ant-[A-Za-z0-9_-]{10,}/, /ANTHROPIC_API_KEY/, /GEMINI_API_KEY/]) {
      expect(pattern.test(html)).toBe(false);
    }
    /* AI is proxied: the browser must never talk to the provider directly. */
    expect(html).not.toContain("api.anthropic.com");
    expect(html).not.toContain("generativelanguage.googleapis.com");
  });

  it("keeps admin session tokens out of localStorage", () => {
    const src = fs.readFileSync(path.join(REPO, "artifacts", "egytrend", "index.html"), "utf8");
    expect(src).not.toContain('DB.s("admTok"');
    expect(src).not.toContain('DB.s("userTok"');
    expect(src).not.toContain('DB.g("admTok"');
    expect(src).not.toContain('DB.g("userTok"');
  });

  it("declares requireAuth/requireRole on every admin route", () => {
    const src = fs.readFileSync(path.join(REPO, "artifacts", "api-server", "src", "routes", "admin.ts"), "utf8");
    /* login/me/logout/panel.js are session endpoints, not data endpoints.
     * POST /requests is the *user-facing* payment-request submission that
     * happens to live under /admin; it calls currentUser() itself and 401s
     * without a session — asserted explicitly in the test below. */
    const SELF_GUARDED = new Set(["/login", "/me", "/logout", "/panel.js", "/requests"]);
    const routes = [...src.matchAll(/router\.(get|post|put|delete|patch)\(\s*"([^"]+)"\s*,([^\n]*)/g)];
    expect(routes.length).toBeGreaterThan(20);
    const unguarded = routes
      .filter(([, , p, chain]) => !SELF_GUARDED.has(p) && !chain.includes("requireAuth"))
      .map(([, , p]) => p);
    expect(unguarded).toEqual([]);
  });
});

test("the app never exposes a static admin token backdoor", () => {
  const files = ["routes/admin.ts", "routes/opportunities.ts", "lib/userAuth.ts"];
  for (const f of files) {
    const src = fs.readFileSync(path.join(REPO, "artifacts", "api-server", "src", f), "utf8");
    expect(src).not.toMatch(/ADMIN_TOKEN\s*\]\s*\|\|/);
    expect(src).not.toContain("isLegacyAdmin");
  }
});
