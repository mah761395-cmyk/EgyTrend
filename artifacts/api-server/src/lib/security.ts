/**
 * EgyTrend — shared security primitives.
 *
 * Why this file exists (audit 2026-10):
 *   1. Sessions were bearer tokens kept in localStorage by the SPA, so any XSS
 *      (or a malicious extension) could exfiltrate a 24h super-admin JWT.
 *      → sessions now live in httpOnly + SameSite cookies (never readable by JS).
 *   2. `cors()` with no options answered `Access-Control-Allow-Origin: *` on
 *      every API route, letting any website call the platform API.
 *      → allowlist of the platform's own origins + our Vercel previews.
 *   3. No security headers were sent at all.
 *      → HSTS / nosniff / frame-deny / referrer-policy / CSP / CORP below.
 *   4. Cookie auth is only safe with a CSRF guard: cross-site POSTs DO carry
 *      cookies. Any state-changing request that is authenticated *by cookie*
 *      must also come from an allowlisted Origin (browsers always send it;
 *      curl-style clients without cookies are unaffected).
 */
import type { Request, Response, NextFunction } from "express";

export const SESSION_COOKIE = "et_session"; // app (VIP) users
export const ADMIN_COOKIE = "et_admin"; // staff / admin panel

export const ONE_DAY_MS = 24 * 60 * 60 * 1000;
export const SEVEN_DAYS_MS = 7 * ONE_DAY_MS;

const isProd = process.env["NODE_ENV"] === "production";

/* ── Cookies ─────────────────────────────────────────────────────────────
 * httpOnly  → unreadable from JavaScript (XSS cannot steal the session)
 * secure    → HTTPS only in production (Vercel is always HTTPS)
 * sameSite  → "lax": not sent on cross-site POSTs (CSRF), still works for
 *             normal top-level navigations (e.g. a reset link).
 * A cookie is set for admin and user sessions separately so an admin can also
 * browse as a normal user without losing the panel session.
 */
function cookieOptions(maxAgeMs: number) {
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: "lax" as const,
    path: "/",
    maxAge: maxAgeMs,
  };
}

export function setSessionCookie(res: Response, name: string, token: string, maxAgeMs: number): void {
  res.cookie(name, token, cookieOptions(maxAgeMs));
}

export function clearSessionCookie(res: Response, name: string): void {
  res.clearCookie(name, {
    httpOnly: true,
    secure: isProd,
    sameSite: "lax" as const,
    path: "/",
  });
}

/* ── Origins ─────────────────────────────────────────────────────────────
 * Explicit allowlist. Preview deployments get their own hostname per commit,
 * so the project's own preview pattern is accepted as well (never a wildcard
 * over the whole vercel.app domain). */
const PREVIEW_RE = /^https:\/\/egy-trend-[a-z0-9-]+\.vercel\.app$/i;
const LOCALHOST_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

function defaultOrigins(): string[] {
  const list = ["https://egy-trend.vercel.app", "https://egytrend.com", "https://www.egytrend.com"];
  const base = process.env["APP_BASE_URL"];
  if (base) {
    try {
      list.push(new URL(base).origin);
    } catch {
      /* ignore malformed APP_BASE_URL — defaults still apply */
    }
  }
  return list;
}

export function allowedOrigins(): string[] {
  const fromEnv = (process.env["ALLOWED_ORIGINS"] || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return Array.from(new Set([...fromEnv, ...defaultOrigins()]));
}

/** No Origin header = same-origin fetch, curl, server-to-server → allowed. */
export function isAllowedOrigin(origin?: string | null): boolean {
  if (!origin || origin === "null") return true;
  if (allowedOrigins().includes(origin)) return true;
  if (process.env["ALLOW_VERCEL_PREVIEW"] !== "0" && PREVIEW_RE.test(origin)) return true;
  /* Local development only: the Vite dev server on :3000 talks to the API on
   * :8080 through its proxy; direct cross-port calls during testing are fine
   * locally but never in production. */
  if (!isProd && LOCALHOST_RE.test(origin)) return true;
  return false;
}

export const corsOptions = {
  origin(origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void): void {
    if (isAllowedOrigin(origin)) cb(null, true);
    else cb(new Error(`origin not allowed: ${origin}`));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "x-admin-token"],
  exposedHeaders: ["Retry-After"],
  maxAge: 600,
};

/* ── Security headers ────────────────────────────────────────────────────
 * The API only ever answers JSON/JS, so a locked-down CSP here is safe.
 * (The SPA's own CSP lives in vercel.json — Vercel serves index.html
 * directly, so Express never sees that request.) */
export function apiSecurityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=(), payment=()");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'",
  );
  if (isProd) {
    res.setHeader("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  }
  next();
}

/* ── CSRF guard for cookie-authenticated mutations ───────────────────────
 * Header-token clients cannot be CSRF'd (an attacker's page can't read the
 * token), so they are left untouched. Only requests that actually carry one
 * of our session cookies must prove a trusted Origin. */
export function requireSameOrigin(req: Request, res: Response, next: NextFunction): void {
  const method = req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    next();
    return;
  }
  const cookieHeader = req.header("cookie") || "";
  const cookieAuthed = cookieHeader.includes(`${SESSION_COOKIE}=`) || cookieHeader.includes(`${ADMIN_COOKIE}=`);
  if (!cookieAuthed) {
    next();
    return;
  }
  const origin = req.header("origin");
  if (origin) {
    if (isAllowedOrigin(origin)) {
      next();
      return;
    }
    res.status(403).json({ status: "error", message: "cross-origin request blocked" });
    return;
  }
  /* No Origin header on a cookie-authenticated mutation: only trust it when a
   * same-origin Referer corroborates it (old browsers / form posts). */
  const referer = req.header("referer") || "";
  try {
    if (referer && isAllowedOrigin(new URL(referer).origin)) {
      next();
      return;
    }
  } catch {
    /* fall through to the block below */
  }
  res.status(403).json({ status: "error", message: "missing or untrusted origin" });
}
