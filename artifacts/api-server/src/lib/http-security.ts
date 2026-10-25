import type { NextFunction, Request, Response } from "express";

const LOCAL_DEVELOPMENT_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:5000",
  "http://127.0.0.1:5000",
];

export function normalizeOrigin(value: string | undefined | null): string | null {
  if (!value || value === "null") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Explicit CORS allow-list. APP_BASE_URL is included as a convenience for a
 * separately hosted frontend; same-origin requests never need CORS headers.
 * A wildcard is intentionally ignored so a typo cannot silently reopen CORS.
 */
export function allowedOriginsFromEnv(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const values = [env["CORS_ORIGINS"] || "", env["APP_BASE_URL"] || ""]
    .flatMap((entry) => entry.split(","))
    .map((entry) => normalizeOrigin(entry.trim()))
    .filter((origin): origin is string => Boolean(origin));

  if (env["NODE_ENV"] !== "production") {
    values.push(...LOCAL_DEVELOPMENT_ORIGINS);
  }

  return new Set(values);
}

export function isConfiguredOriginAllowed(origin: string | undefined, allowed: ReadonlySet<string>): boolean {
  const normalized = normalizeOrigin(origin);
  return Boolean(normalized && allowed.has(normalized));
}

export function isSameOriginRequest(origin: string | undefined, host: string | undefined, protocol: string): boolean {
  const normalized = normalizeOrigin(origin);
  if (!normalized || !host) return false;
  return normalized === `${protocol === "https" ? "https" : "http"}://${host.toLowerCase()}`;
}

export function isStateChangingMethod(method: string | undefined): boolean {
  const normalized = (method || "GET").toUpperCase();
  return !["GET", "HEAD", "OPTIONS"].includes(normalized);
}

export function resolveTrustProxy(value: string | undefined, isVercel: boolean): number | false {
  if (value === undefined || value === "") return isVercel ? 1 : false;
  const hops = Number(value);
  return Number.isInteger(hops) && hops >= 0 ? hops : false;
}

export function originGuard(allowed: ReadonlySet<string>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!isStateChangingMethod(req.method)) {
      next();
      return;
    }

    // Non-browser clients (scheduled jobs, curl, health tooling) do not send
    // Origin. Browser state changes must be either same-origin or explicitly
    // configured, which provides CSRF protection for cookie-backed sessions.
    const origin = req.header("origin");
    if (!origin) {
      next();
      return;
    }

    const sameOrigin = isSameOriginRequest(origin, req.get("host"), req.protocol);
    if (sameOrigin || isConfiguredOriginAllowed(origin, allowed)) {
      next();
      return;
    }

    res.status(403).json({ status: "error", message: "origin is not allowed" });
  };
}

export function applyApiSecurityHeaders(req: Request, res: Response, next: NextFunction): void {
  res.setHeader("Content-Security-Policy", "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");

  // Auth, payment and admin responses can contain account metadata. Do not
  // permit an intermediary/browser cache to retain them.
  if (/^\/api\/(?:user|admin|payments|ai)(?:\/|$)/.test(req.path)) {
    res.setHeader("Cache-Control", "no-store");
  }

  const forwardedProto = req.header("x-forwarded-proto")?.split(",")[0]?.trim();
  if (process.env.NODE_ENV === "production" && (req.secure || forwardedProto === "https")) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
}
