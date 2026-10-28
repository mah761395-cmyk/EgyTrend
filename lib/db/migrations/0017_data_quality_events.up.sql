-- Persistent, bounded data-quality event log for market-data monitoring.
-- NOT auto-applied: apply after a verified backup and approved window,
-- exactly like 0001–0016 (see lib/db/migrations/README.md).
-- Additive only: creates one new table; touches nothing else.
-- Contains no user data, no secrets, no request URLs.
-- Proposal: docs/data-quality-monitoring-plan.md (approved 2026-10-29).

BEGIN;

CREATE TABLE IF NOT EXISTS data_quality_events (
  id bigserial PRIMARY KEY,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  source_id text NOT NULL
    CHECK (char_length(source_id) BETWEEN 1 AND 64),
  kind text NOT NULL CHECK (kind IN (
    'fetch_failure',
    'empty_response',
    'stale_data',
    'plausibility_reject',
    'future_dated',
    'sign_anomaly',
    'parse_error'
  )),
  instrument_id text
    CHECK (instrument_id IS NULL OR char_length(instrument_id) <= 64),
  latency_ms integer
    CHECK (latency_ms IS NULL OR latency_ms BETWEEN 0 AND 600000),
  message text NOT NULL
    CHECK (char_length(message) BETWEEN 1 AND 300),
  incident_key text
    CHECK (incident_key IS NULL OR char_length(incident_key) <= 128)
);

CREATE INDEX IF NOT EXISTS data_quality_events_recent_idx
  ON data_quality_events (recorded_at DESC);
CREATE INDEX IF NOT EXISTS data_quality_events_source_kind_idx
  ON data_quality_events (source_id, kind, recorded_at DESC);
CREATE INDEX IF NOT EXISTS data_quality_events_incident_idx
  ON data_quality_events (incident_key, recorded_at DESC)
  WHERE incident_key IS NOT NULL;

COMMIT;
