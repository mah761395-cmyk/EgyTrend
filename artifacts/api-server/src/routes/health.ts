import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { db, dataQualityEventsTable } from "@workspace/db";
import { desc, gte } from "drizzle-orm";
import { currentMigrationReport, MIGRATION_IDS, type MigrationReport } from "../lib/db-migration-state";
import { readMigrationStatus } from "../lib/db-migration-ledger";
import { logger } from "../lib/logger";
import { isActivePrivilegedAdmin } from "../lib/userAuth";

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

/* Detailed data-quality telemetry (approved proposal:
 * docs/data-quality-monitoring-plan.md). Admin-only read-only view of the
 * durable event log: the public /markets/health stays coarse and unauth'd,
 * while the drill-down (per-incident counts, samples, latency) requires the
 * privileged admin session. The table only ever stores sanitized summaries,
 * so this endpoint cannot leak keys, request URLs, or user data. */
router.get("/health/data", async (req, res) => {
  if (!(await isActivePrivilegedAdmin(req))) {
    res.status(403).json({ status: "forbidden", message: "admin_access_required" });
    return;
  }
  res.setHeader("Cache-Control", "no-store");
  const windowName = req.query.window === "7d" ? "7d" : "24h";
  const since = new Date(Date.now() - (windowName === "7d" ? 7 : 1) * 24 * 60 * 60 * 1000);
  try {
    const rows = await db
      .select()
      .from(dataQualityEventsTable)
      .where(gte(dataQualityEventsTable.recordedAt, since))
      .orderBy(desc(dataQualityEventsTable.recordedAt))
      .limit(200);
    const incidentMap = new Map<
      string,
      {
        incidentKey: string;
        sourceId: string;
        kind: string;
        count: number;
        firstSeenAt: string;
        lastSeenAt: string;
        sampleMessage: string;
      }
    >();
    for (const row of rows) {
      const key = row.incidentKey || `${row.sourceId}:${row.kind}`;
      const iso = row.recordedAt instanceof Date ? row.recordedAt.toISOString() : String(row.recordedAt);
      const entry = incidentMap.get(key);
      if (!entry) {
        incidentMap.set(key, {
          incidentKey: key,
          sourceId: row.sourceId,
          kind: row.kind,
          count: 1,
          firstSeenAt: iso,
          lastSeenAt: iso,
          sampleMessage: row.message,
        });
      } else {
        entry.count += 1;
        if (iso < entry.firstSeenAt) {
          entry.firstSeenAt = iso;
          entry.sampleMessage = row.message;
        }
        if (iso > entry.lastSeenAt) entry.lastSeenAt = iso;
      }
    }
    res.json({
      status: "ok",
      window: windowName,
      since: since.toISOString(),
      eventCount: rows.length,
      events: rows.map((row) => ({
        recordedAt: row.recordedAt instanceof Date ? row.recordedAt.toISOString() : String(row.recordedAt),
        sourceId: row.sourceId,
        kind: row.kind,
        instrumentId: row.instrumentId,
        latencyMs: row.latencyMs,
        message: row.message,
        incidentKey: row.incidentKey,
      })),
      incidents: [...incidentMap.values()].sort((a, b) => b.count - a.count).slice(0, 50),
    });
  } catch (error) {
    logger.warn({ err: error }, "health/data: telemetry query failed");
    res.status(503).json({ status: "unavailable", message: "data_quality_store_unavailable" });
  }
});

export default router;
