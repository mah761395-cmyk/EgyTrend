import crypto from "node:crypto";
import { Router, type IRouter, type Request, type Response } from "express";
import { logger } from "../lib/logger";
import {
  createSchemaBackup,
  shouldSkipBackup,
  BackupUnavailableError,
} from "../lib/db-backups";

/* Scheduled database backup entry point.
 *
 * Authorization mirrors the markets cron: either the shared cron secret
 * (x-cron-secret / Bearer, timing-safe) or the vercel-cron platform markers
 * (Vercel's scheduler issues a plain GET and cannot attach custom headers).
 * Unauthorized requests get a 404, matching the markets convention — the
 * endpoint's existence is not advertised.
 *
 * The job is safe under drift: it skips while a backup of any kind is
 * younger than BACKUP_MIN_INTERVAL_MS, so overlapping schedules cannot
 * double-spend snapshots. Environments without a real PostgreSQL pool
 * answer 503 and record nothing. */
const router: IRouter = Router();

function cronAuthorized(req: Request): boolean {
  const secret = (process.env["MARKET_SNAPSHOT_CRON_SECRET"] || "").trim();
  if (!secret) return false;
  const supplied = String(req.get("x-cron-secret") || req.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const a = Buffer.from(secret);
  const b = Buffer.from(supplied);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function vercelCronAuthorized(req: Request): boolean {
  const userAgent = String(req.get("user-agent") || "").toLowerCase();
  const schedule = String(req.get("x-vercel-cron-schedule") || "").trim();
  return userAgent.startsWith("vercel-cron") && schedule.length > 0;
}

async function runBackupJob(req: Request, res: Response): Promise<void> {
  try {
    const skip = await shouldSkipBackup();
    if (skip.skip) {
      res.json({ status: "ok", action: "skipped", reason: skip.reason });
      return;
    }
    const backup = await createSchemaBackup("cron", null);
    res.json({
      status: "ok",
      action: "created",
      schema: backup.schema,
      tableCount: backup.tableCount,
      verified: backup.verified,
    });
  } catch (e) {
    if (e instanceof BackupUnavailableError) {
      res.status(503).json({ status: "error", message: "backup_unavailable" });
      return;
    }
    logger.error({ err: e }, "cron backup job failed");
    res.status(500).json({ status: "error", message: "backup_failed" });
  }
}

router.get("/cron", (req: Request, res: Response) => {
  if (!vercelCronAuthorized(req)) {
    res.status(404).json({ status: "error", message: "not found" });
    return;
  }
  void runBackupJob(req, res);
});

router.post("/cron", (req: Request, res: Response) => {
  if (!cronAuthorized(req)) {
    res.status(404).json({ status: "error", message: "not found" });
    return;
  }
  void runBackupJob(req, res);
});

export default router;
