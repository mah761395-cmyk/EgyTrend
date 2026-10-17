import crypto from "node:crypto";
import { Router, type Request, type Response } from "express";
import { logger } from "../lib/logger";
import { runSubscriptionLifecycle } from "../lib/subscription-lifecycle";

const router = Router();

/**
 * Vercel sends `Authorization: Bearer ${CRON_SECRET}` for configured cron
 * invocations. The x-cron-secret compatibility header is retained for an
 * explicitly authorised non-Vercel scheduler; neither path is browser-facing.
 */
function cronAuthorized(req: Request): boolean {
  const configured = process.env["CRON_SECRET"];
  const authorization = String(req.header("authorization") || "");
  const supplied = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : String(req.header("x-cron-secret") || "");
  if (!configured || !supplied) return false;
  const expected = Buffer.from(configured);
  const actual = Buffer.from(supplied);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

async function run(req: Request, res: Response): Promise<void> {
  if (!process.env["CRON_SECRET"]) {
    res.status(503).json({ status: "error", message: "subscription lifecycle scheduler is not configured" });
    return;
  }
  if (!cronAuthorized(req)) {
    res.status(403).json({ status: "error", message: "forbidden" });
    return;
  }
  try {
    const result = await runSubscriptionLifecycle();
    /* Counts only: no phone, name, e-mail, content, or configured secret reaches logs. */
    logger.info({
      inspected: result.inspected,
      queued: result.queued,
      transitionedToExpired: result.transitionedToExpired,
      emailFailed: result.emailFailed,
    }, "subscription lifecycle complete");
    res.setHeader("Cache-Control", "no-store");
    res.json({ status: "ok", ...result, previews: undefined });
  } catch (error) {
    logger.error({ err: error }, "subscription lifecycle failed");
    res.status(503).json({ status: "error", message: "subscription lifecycle unavailable" });
  }
}

router.get("/internal/subscriptions/run", run);
router.post("/internal/subscriptions/run", run);

export default router;
