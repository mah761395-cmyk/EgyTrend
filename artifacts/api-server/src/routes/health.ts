import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { currentMigrationReport, MIGRATION_IDS } from "../lib/db-migration-state";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

router.get("/health", (_req, res) => {
  res.json({ status: "ok", ts: Date.now() });
});

/**
 * Schema readiness.
 *
 * Answers one operational question: is the database the API is talking to
 * carrying every reviewed migration this build expects? It reports migration
 * ids and object names only — never credentials, never row data — and is the
 * evidence trail for how a drifted database was repaired (see
 * `applied[].missingBefore`).
 */
router.get("/health/db", (_req, res) => {
  const report = currentMigrationReport();
  res.setHeader("Cache-Control", "no-store");
  if (!report) {
    res.json({ status: "ok", checked: false, ready: false, expectedMigrations: MIGRATION_IDS.length });
    return;
  }
  res.json({
    status: "ok",
    checked: true,
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
  });
});

export default router;
