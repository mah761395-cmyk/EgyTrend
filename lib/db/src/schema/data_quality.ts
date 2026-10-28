import { index, integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Durable, bounded data-quality telemetry for market-data monitoring.
 * Anomaly-only rows (never successes): a provider failure, an empty response,
 * a plausibility reject, a future-dated feed item, a sign anomaly, or a parse
 * error. Contains no user data, no secrets, and no request URLs — the message
 * is a short, secret-free summary.
 *
 * See docs/data-quality-monitoring-plan.md for the approved proposal. The
 * accompanying SQL migration (0017) is applied through the reviewed runner,
 * not by drizzle-kit push.
 */
export const dataQualityEventsTable = pgTable(
  "data_quality_events",
  {
    id: serial("id").primaryKey(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
    sourceId: text("source_id").notNull(),
    kind: text("kind").notNull(),
    instrumentId: text("instrument_id"),
    latencyMs: integer("latency_ms"),
    message: text("message").notNull(),
    incidentKey: text("incident_key"),
  },
  (table) => [
    index("data_quality_events_recent_idx").on(table.recordedAt),
    index("data_quality_events_source_kind_idx").on(table.sourceId, table.kind, table.recordedAt),
  ],
);

export type DataQualityEvent = typeof dataQualityEventsTable.$inferSelect;
