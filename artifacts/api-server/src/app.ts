import express, { type Express, type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { sqlStateOf } from "./lib/dbErrors";
import {
  allowedOriginsFromEnv,
  applyApiSecurityHeaders,
  isConfiguredOriginAllowed,
  originGuard,
  resolveTrustProxy,
} from "./lib/http-security";
import { sessionRevocationGuard } from "./lib/session-revocation";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
/* Behind Vercel one trusted proxy hop exposes the client address. On a direct
 * local/VPS process we do not trust arbitrary X-Forwarded-* headers unless the
 * operator explicitly configures TRUST_PROXY_HOPS. */
app.set("trust proxy", resolveTrustProxy(process.env["TRUST_PROXY_HOPS"], process.env["VERCEL"] === "1"));
app.disable("x-powered-by");

const allowedCorsOrigins = allowedOriginsFromEnv();
app.use(cors({
  origin(origin, callback) {
    // Same-origin traffic does not need CORS. Only explicitly configured
    // cross-origin frontends receive CORS response headers.
    callback(null, !origin || isConfiguredOriginAllowed(origin, allowedCorsOrigins));
  },
  credentials: true,
  methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-CSRF-Token"],
  maxAge: 600,
}));
app.use(applyApiSecurityHeaders);
app.use(originGuard(allowedCorsOrigins));
/* Bounded bodies: JSON payloads above this size can only be abuse, and the
 * default (100 MB per request) is a cheap memory-exhaustion vector. */
app.use(express.json({ limit: "300kb" }));
app.use(express.urlencoded({ extended: true, limit: "300kb" }));
app.use(cookieParser());
/* A token that was logged out, or invalidated by a password change, is stripped
 * from the request (and its cookie expired) before any route sees it, so every
 * endpoint treats it exactly like an anonymous request. */
app.use((req, res, next) => {
  void sessionRevocationGuard(req, res, next);
});

app.use("/api", router);

/* Terminal error handler.
 *
 * Without it, a rejected async route (for example a SQL error from a database
 * whose schema lags the code) fell through to Express's default handler, which
 * answers an HTML "Internal Server Error" page with HTTP 500 — no JSON body
 * for the SPA and nothing operationally useful in the logs. Every unexpected
 * failure now answers the same JSON shape the API uses everywhere else, and
 * the cause is logged server-side without leaking it to the caller. */
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof Error && /origin not allowed/i.test(err.message)) {
    res.status(403).json({ status: "error", message: "origin not allowed" });
    return;
  }
  /* The SQLSTATE names the failure class (for example 42703 =
   * undefined_column) without exposing SQL text or row values. A drift-related
   * 500 previously logged only {"type":"Error"}, which hid the cause. */
  logger.error({ err, sqlState: sqlStateOf(err) }, "unhandled request error");
  if (res.headersSent) return;
  res.status(500).json({ status: "error", message: "internal error" });
});

export default app;
