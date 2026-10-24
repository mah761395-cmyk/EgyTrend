/**
 * EgyTrend — shared security primitives.
 *
 * Ported and narrowed from the reviewed work in 1687bd9:
 *   1. Sessions were bearer tokens kept in localStorage by the SPA, so any XSS
 *      (or a malicious extension) could exfiltrate a 24h admin JWT.
 *      → sessions now live in httpOnly + SameSite cookies, unreadable by JS.
 *   2. `cors()` with no options answered `Access-Control-Allow-Origin: *` on
 *      every API route, letting any website call the platform API.
 *      → explicit allowlist, plus the request's own host so the deployment
 *      keeps working on a domain that is not listed in the code.
 *   3. No security headers were sent at all.
 *      → nosniff / frame-deny / referrer-policy / CSP / CORP below.
 *   4. Cookie auth is only safe with a CSRF guard: cross-site POSTs DO carry
 *      cookies. Any state-changing request authenticated *by cookie* must also
 *      come from an allowed Origin. Bearer-header clients are unaffected.
 */
import type { CorsOptions, CorsOptionsDelegate } from "cors";
import type { Request, Response, NextFunction } from "express";

export const SESSION_COOKIE = "et_session"; // app (VIP) users
export const ADMIN_COOKIE = "et_admin"; // staff / admin panel

export const ONE_DAY_MS = 24 * 60 * 60 * 1000;
export const SEVEN_DAYS_MS = 7 * ONE_DAY_MS;

const isProd = process.env["NODE_ENV"] === "production";

/* ── Cookies ─────────────────────────────────────────────────────────────
 * httpOnly  → unreadable from JavaScript (XSS cannot steal the session)
 * secure    → HTTPS only in production
 * sameSite  → "lax": not sent on cross-site POSTs (CSRF), still sent on normal
 *             top-level navigations (e.g. an email reset link).
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
 * Explicit allowlist. Preview deployments get a new hostname per commit, so
 * the project's own preview pattern is accepted as well (never a wildcard
 * over the whole vercel.app domain). */
const PREVIEW_RE = /^https:\/\/egy-trend-[a-z0-9-]+\.vercel\.app$/i;
const LOOPBACK_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

function defaultOrigins(): string[] {
  const list = ["https://egy-trend.vercel.app", "https://egytrend.com", "https://www.egytrend.com"];
  const base = process.env["APP_BASE_URL"];
  if (base) {
    try {
      list.push(new URL(base).origin);
    } catch {
      /* malformed APP_BASE_URL — the defaults still apply */
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

/** No Origin header = same-origin fetch, curl, server-to-server → allowed as
 *  far as CORS is concerned; CSRF is handled separately for cookie requests. */
export function isAllowedOrigin(origin?: string | null): boolean {
  if (!origin || origin === "null") return true;
  if (allowedOrigins().includes(origin)) return true;
  if (process.env["ALLOW_VERCEL_PREVIEW"] !== "0" && PREVIEW_RE.test(origin)) return true;
  if (!isProd && LOOPBACK_RE.test(origin)) return true;
  return false;
}

/** The request's own origin. Vercel terminates TLS at its proxy, so the
 *  browser-facing host arrives in x-forwarded-host. */
function requestHost(req: Request): string {
  const forwarded = (req.header("x-forwarded-host") || "").split(",")[0]?.trim();
  return forwarded || req.header("host") || "";
}

/** True when the Origin belongs to the same site that served the request.
 *  This keeps cookie auth working on any deployment domain without an env
 *  change, while still rejecting a foreign site. */
export function isSameHost(origin: string, req: Request): boolean {
  try {
    const originHost = new URL(origin).host.toLowerCase();
    const host = requestHost(req).toLowerCase();
    return !!originHost && originHost === host;
  } catch {
    return false;
  }
}

const CORS_CONFIG: CorsOptions = {
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "x-admin-token", "x-device-id"],
  exposedHeaders: ["Retry-After"],
  maxAge: 600,
};

/** Per-request CORS decision: allowlisted origins, the deployment's own host,
 *  and — in development only — loopback. Everything else is refused. */
export const corsOptionsFor: CorsOptionsDelegate<Request> = (req, callback) => {
  callback(null, {
    ...CORS_CONFIG,
    origin(origin, done) {
      if (isAllowedOrigin(origin) || (origin && isSameHost(origin, req))) done(null, true);
      else done(new Error(`origin not allowed: ${origin}`));
    },
  });
};

/* ── Security headers ────────────────────────────────────────────────────
 * The API only ever answers JSON, so a locked-down CSP here is safe. The
 * SPA's own CSP is served with index.html, which Express never sees. */
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
 * Header-token clients cannot be CSRF'd (an attacker's page cannot read the
 * token), so they are left untouched. Only requests that actually carry one of
 * our session cookies must prove a trusted Origin. */
export function requireSameOrigin(req: Request, res: Response, next: NextFunction): void {
  const method = req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    next();
    return;
  }
  const cookieHeader = req.header("cookie") || "";
  const cookieAuthed =
    cookieHeader.includes(`${SESSION_COOKIE}=`) || cookieHeader.includes(`${ADMIN_COOKIE}=`);
  if (!cookieAuthed) {
    next();
    return;
  }
  const origin = req.header("origin");
  if (origin) {
    if (isAllowedOrigin(origin) || isSameHost(origin, req)) {
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
    const refererOrigin = new URL(referer).origin;
    if (referer && (isAllowedOrigin(refererOrigin) || isSameHost(refererOrigin, req))) {
      next();
      return;
    }
  } catch {
    /* fall through to the block below */
  }
  res.status(403).json({ status: "error", message: "missing or untrusted origin" });
}
