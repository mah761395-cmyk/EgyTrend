import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

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
app.use(cors());
/* Bounded bodies: JSON payloads above this size can only be abuse, and the
 * default (100 MB per request) is a cheap memory-exhaustion vector. */
app.use(express.json({ limit: "300kb" }));
app.use(express.urlencoded({ extended: true, limit: "300kb" }));

app.use("/api", router);

export default app;
