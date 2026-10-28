import { logger } from "../logger";

/**
 * Durable, bounded data-quality telemetry (approved proposal:
 * docs/data-quality-monitoring-plan.md).
 *
 * Hard rules, by design:
 * - Fire-and-forget: this module never blocks a request path and never
 *   throws into it. A database failure degrades to a log line.
 * - Anomaly-only: successes are never written, so the table stays tiny.
 * - No secrets, no request URLs, no user data: messages are built from the
 *   same safe summaries the request layer already uses.
 * - One-alert-per-incident semantics live in the caller's log policy
 *   (incident_key groups the rows); the table keeps every event.
 *
 * Emission points wired in v1: fetch_failure (http.ts), sign_anomaly
 * (providers.ts, TradingEconomics EGX30 direction check), future_dated
 * (news.ts feed parsing). The remaining kinds are reserved in the schema.
 */

export const DATA_QUALITY_KINDS = [
  "fetch_failure",
  "empty_response",
  "stale_data",
  "plausibility_reject",
  "future_dated",
  "sign_anomaly",
  "parse_error",
] as const;

export type DataQualityKind = (typeof DATA_QUALITY_KINDS)[number];

export interface DataQualityEventInput {
  sourceId: string;
  kind: DataQualityKind;
  instrumentId?: string | null;
  latencyMs?: number | null;
  /** Bounded, secret-free summary (<=300 chars after trimming). */
  message: string;
}

type PoolLike = {
  query(text: string, params: Array<string | number | null>): Promise<unknown>;
};

const MAX_INFLIGHT = 8;
const MESSAGE_MAX = 300;
/** If the table does not exist yet (migration pending), stop retrying for a
 * while instead of adding a failed INSERT to every subsequent anomaly. */
const CIRCUIT_COOLDOWN_MS = 10 * 60 * 1000;

let inflight = 0;
let circuitBrokenUntil = 0;

/* The workspace db module refuses to load without a database (by design),
 * and the pool is null in isolated tests — so the connection is resolved
 * lazily and any failure is a no-op: telemetry must never break importers
 * or request paths. */
export function recordDataQualityEvent(input: DataQualityEventInput): void {
  try {
    void import("@workspace/db")
      .then((dbModule) => {
        const poolLike = (dbModule as { pool?: PoolLike | null }).pool;
        if (!poolLike) return undefined;
        return __recordWithPool(poolLike, input);
      })
      .catch(() => {
        /* No database available (isolated tests, DB down): silent no-op. */
      });
  } catch {
    /* Telemetry must never take a product path down with it. */
  }
}

/** Core implementation with an injectable pool so the validation, circuit
 * breaker and fire-and-forget behavior are unit-testable without a database. */
export async function __recordWithPool(poolLike: PoolLike, input: DataQualityEventInput): Promise<void> {
  try {
    const now = Date.now();
    if (now < circuitBrokenUntil || inflight >= MAX_INFLIGHT) return;
    if (!input || typeof input !== "object") return;
    const kind = (DATA_QUALITY_KINDS as readonly string[]).includes(input.kind)
      ? input.kind
      : null;
    if (!kind) return;
    const sourceId = String(input.sourceId ?? "").trim().slice(0, 64);
    if (!sourceId) return;
    const message = String(input.message ?? "").replace(/\s+/g, " ").trim().slice(0, MESSAGE_MAX);
    if (!message) return;
    const instrumentId = input.instrumentId ? String(input.instrumentId).slice(0, 64) : null;
    const latencyMs =
      typeof input.latencyMs === "number" && Number.isFinite(input.latencyMs) && input.latencyMs >= 0
        ? Math.min(Math.round(input.latencyMs), 600_000)
        : null;
    const incidentKey =
      (instrumentId ? `${sourceId}:${kind}:${instrumentId}` : `${sourceId}:${kind}`).slice(0, 128);

    inflight += 1;
    try {
      await poolLike.query("INSERT INTO data_quality_events (source_id, kind, instrument_id, latency_ms, message, incident_key) VALUES ($1, $2, $3, $4, $5, $6)", [
        sourceId,
        kind,
        instrumentId,
        latencyMs,
        message,
        incidentKey,
      ]);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (detail.includes("does not exist")) {
        /* The 0017 migration has not been applied to this database yet:
         * silence the circuit for a cooldown instead of logging on every
         * anomaly. */
        circuitBrokenUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
      } else {
        logger.warn({ sourceId, kind }, "data-quality: event insert failed");
      }
    } finally {
      inflight -= 1;
    }
  } catch {
    /* Telemetry must never take a product path down with it. */
  }
}

/** Test-only reset of the module's circuit/concurrency state. */
export function __resetDataQualityTelemetry(): void {
  inflight = 0;
  circuitBrokenUntil = 0;
}
