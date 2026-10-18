import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { currentMigrationReport, MIGRATION_IDS, type MigrationReport } from "../lib/db-migration-state";
import { readMigrationStatus } from "../lib/db-migration-ledger";
import { logger } from "../lib/logger";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

router.get("/health", (_req, res) => {
  res.json({ status: "ok", ts: Date.now() });
});

function payload(report: MigrationReport, source: "live" | "boot") {
  return {
    status: "ok",
    checked: true,
    source,
    ready: report.ready,
    autoApply: report.autoApply,
    expectedMigrations: MIGRATION_IDS.length,
    appliedCount: report.applied.length,
    pending: report.pending,
    failed: report.failed,
    backupSchema: report.backupSchema,
    applied: report.applied.map((row) => ({ id: row.id, appliedAt: row.appliedAt, missingBefore: row.missingBefore })),
    error: report.error,
    checkedAt: report.checkedAt,
  };
}

/**
 * Schema readiness.
 *
 * Answers one operational question: is the database this API is talking to
 * carrying every reviewed migration this build expects? It reports migration
 * ids and object names only — never credentials, never row data — and carries
 * the evidence trail of how a drifted database was repaired
 * (`applied[].missingBefore`).
 *
 * The answer is read live from the ledger: a warm serverless instance would
 * otherwise keep repeating the snapshot it took at boot, long after another
 * instance finished the migration.
 */
router.get("/health/db", async (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  let report: MigrationReport | null = null;
  let source: "live" | "boot" = "live";
  try {
    report = await readMigrationStatus();
  } catch (error) {
    logger.warn({ err: error }, "live schema check failed; answering with the boot report");
    report = currentMigrationReport();
    source = "boot";
  }
  if (!report) {
    res.json({ status: "ok", checked: false, ready: false, expectedMigrations: MIGRATION_IDS.length });
    return;
  }
  res.json(payload(report, source));
});

export default router;
