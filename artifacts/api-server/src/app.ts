import express, { type Express, type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { apiSecurityHeaders, corsOptionsFor, requireSameOrigin } from "./lib/security";
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
/* Behind a reverse proxy (Vercel's edge in production) the TCP peer is the
 * proxy itself, so without trusting the forwarded chain Express reports the
 * SAME address for every visitor. The AI route keys its per-client rate
 * limit on req.ip — a shared address collapses that into one global bucket
 * where a single busy client rate-limits everybody. Trust exactly one hop
 * (the platform proxy); override with TRUST_PROXY_HOPS if self-hosting. */
app.set("trust proxy", Number(process.env["TRUST_PROXY_HOPS"] || 1));
/* Allowlisted origins only (plus this deployment's own host). The old bare
 * `cors()` answered `*` on every route, so any website could call the API. */
app.use(cors(corsOptionsFor));
app.use(cookieParser());
app.use(apiSecurityHeaders);
/* Cookie-authenticated mutations must come from an allowed origin (CSRF). */
app.use(requireSameOrigin);
/* A revoked session (logout, password change, disabled account) is stripped
 * from the request before any route sees it, so every endpoint treats it as an
 * anonymous request without repeating the check. */
app.use((req, res, next) => {
  void sessionRevocationGuard(req, res, next);
});
/* Bounded bodies: JSON payloads above this size can only be abuse, and the
 * default (100 MB per request) is a cheap memory-exhaustion vector. */
app.use(express.json({ limit: "300kb" }));
app.use(express.urlencoded({ extended: true, limit: "300kb" }));

app.use("/api", router);

/* Terminal error handler. A rejected CORS origin throws inside the cors
 * middleware: a clean 403 JSON is correct and quieter than Express's default
 * HTML error page, which can expose a stack trace. Any other unhandled error
 * becomes an opaque 500 — never a stack to the client. */
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof Error && /origin not allowed/i.test(err.message)) {
    res.status(403).json({ status: "error", message: "origin not allowed" });
    return;
  }
  logger.error({ err }, "unhandled request error");
  res.status(500).json({ status: "error", message: "internal error" });
});

export default app;
