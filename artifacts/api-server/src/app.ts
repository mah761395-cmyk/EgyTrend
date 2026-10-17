import express, { type Express } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import {
  allowedOriginsFromEnv,
  applyApiSecurityHeaders,
  isConfiguredOriginAllowed,
  originGuard,
  resolveTrustProxy,
} from "./lib/http-security";

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

app.use("/api", router);

export default app;
