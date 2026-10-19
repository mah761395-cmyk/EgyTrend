import express, { type Express, type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { apiSecurityHeaders, corsOptions, requireSameOrigin } from "./lib/security";

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
/* Security headers first so they are present on every response — including
 * error and 404 responses produced further down the chain. */
app.use(apiSecurityHeaders);
/* Origin allowlist (previously `cors()` = "*"): only the platform's own
 * origins and our preview deployments may call the API cross-origin, and
 * credentials are allowed for those, not for the world. */
app.use(cors(corsOptions));
app.use(cookieParser());
/* Bounded bodies: JSON payloads above this size can only be abuse, and the
 * default (100 MB per request) is a cheap memory-exhaustion vector. */
app.use(express.json({ limit: "300kb" }));
app.use(express.urlencoded({ extended: true, limit: "300kb" }));
/* CSRF: cookie-authenticated mutations must come from an allowlisted origin. */
app.use(requireSameOrigin);

app.use("/api", router);

/* Terminal error handler. A rejected CORS origin throws inside the cors
 * middleware: answering a clean 403 JSON is both correct and quieter than
 * Express's default HTML error page (which can expose a stack trace). Any
 * other unhandled error becomes an opaque 500 — never a stack to the client. */
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof Error && /origin not allowed/i.test(err.message)) {
    res.status(403).json({ status: "error", message: "origin not allowed" });
    return;
  }
  logger.error({ err }, "unhandled request error");
  res.status(500).json({ status: "error", message: "internal error" });
});

export default app;
