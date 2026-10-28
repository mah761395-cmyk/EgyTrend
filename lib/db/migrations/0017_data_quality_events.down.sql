-- New telemetry-only table: dropping it loses event history, nothing else.
BEGIN;
DROP TABLE IF EXISTS data_quality_events;
COMMIT;
