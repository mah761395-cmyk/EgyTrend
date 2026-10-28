# Data-quality monitoring — DB schema proposal (NOT executed)

Status: **APPROVED (2026-10-29, "continue to the end") and implemented in the
branch** — paired SQL migrations `0017_data_quality_events` (+ `0018` replay
column for the tour) are registered with the reviewed runner and will be
applied at the next approved deployment with the standard backup sequence.
Nothing has been applied to any database yet.
Scope decisions in force: monitoring = yes (B4); alerts = **logging only**, no
Telegram/email channels (B5); no env/external config changes now (B3);
`MARKET_SNAPSHOT_WRITES_ENABLED` stays off; no provider changes.

## 8. Implementation record (2026-10-29)

- `lib/db/migrations/0017_data_quality_events.{up,down}.sql` — exactly as
  proposed (additive-only table + 3 indexes).
- `lib/db/src/schema/data_quality.ts` — drizzle table definition (query side).
- `src/lib/market-data/quality.ts` — fire-and-forget writer with validation,
  8-in-flight cap, 10-minute circuit breaker while the 0017 migration is
  still pending on a given database; lazy, guarded db access so importers
  (http.ts, providers.ts, news.ts) work in unit tests without a database.
- Emission points wired: `fetch_failure` (http.ts, after retries exhausted),
  `parse_error` (http.ts, invalid JSON bodies), `sign_anomaly` (providers.ts,
  TradingEconomics direction-word vs signed-cell disagreement), `future_dated`
  (news.ts, count per feed parse).
- Admin read surface: `GET /api/health/data` in `src/routes/health.ts`
  (privileged-admin only, 24h/7d window, ≤200 events + ≤50 incident
  summaries) and a read-only "جودة البيانات" tab in `admin.html`.
- Tests: `src/lib/market-data/quality.test.ts` (unit: validation, circuit,
  concurrency cap) and `src/routes/health-data.e2e.test.ts` (auth + incident
  grouping + ordering/bounds).
- Still intentionally out (by approval): retention scheduling (would ride on
  an approved cron), alert channels of any kind, and all other event kinds
  (reserved in the schema, not emitted yet).

## 1. Why a table is needed (current state)

What exists today and its limits:

| Mechanism | Where | Limit |
|---|---|---|
| `ProviderHealthMonitor` (`src/lib/market-data/health.ts`) | per-provider `lastSuccessAt/lastFailureAt/consecutiveFailures/alertedAt` | stored in the **cache layer only**; production runs `cache.mode:"memory"` → **all history is lost on every restart/redeploy** |
| `GET /api/markets/health` | public endpoint, current state only | no history, no quality events, public |
| `freshness.ts` (PR #8) | per-quote live/closed/stale verdict | computed at read time, **not persisted** |
| `market_daily_ohlc` (0001) | persisted licensed OHLC snapshots | values only — no failure/quality record |
| `news.ts` future-date guard (this work) | future-dated RSS items treated as undated | silently corrected — **no trace left** |

Gaps: (a) no durable failure history across restarts; (b) no record of
*quality* anomalies (empty responses, plausibility rejects, future-dated data,
the TradingEconomics sign inversion that was found manually); (c) the public
health endpoint exposes internals with no detailed drill-down; (d) incident
semantics ("one alert per incident") currently live only in an in-memory
cooldown.

## 2. Proposed table — `0017_data_quality_events`

Numbering note: `0016` is reserved for the paused portfolio-transactions plan.
This is an **additive-only** table: it modifies no existing table, column,
index, or row.

### `0017_data_quality_events.up.sql` (proposed)

```sql
-- Persistent, bounded data-quality event log for market-data monitoring.
-- NOT auto-applied: apply after a verified backup and approved window,
-- exactly like 0001–0015 (see lib/db/migrations/README.md).
-- Additive only: creates one new table; touches nothing else.
-- Contains no user data, no secrets, no request URLs.

BEGIN;

CREATE TABLE IF NOT EXISTS data_quality_events (
  id bigserial PRIMARY KEY,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  source_id text NOT NULL
    CHECK (char_length(source_id) BETWEEN 1 AND 64),
  kind text NOT NULL CHECK (kind IN (
    'fetch_failure',      -- provider error/timeout (message = safe summary only)
    'empty_response',     -- provider answered but with no usable data
    'stale_data',         -- section-level staleness beyond tolerance
    'plausibility_reject',-- Zod/plausibility range rejected a quote
    'future_dated',       -- publisher date in the future (e.g. dostor RSS bug)
    'sign_anomaly',       -- direction/percentage sign inconsistency (TE EGX30 class)
    'parse_error'         -- feed/quote parse failure
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
```

### `0017_data_quality_events.down.sql` (proposed)

```sql
-- New telemetry-only table; dropping it loses event history, nothing else.
BEGIN;
DROP TABLE IF EXISTS data_quality_events;
COMMIT;
```

Field rules (enforced in code, kept tiny on purpose):

- `message` ≤ 300 chars, built from the existing
  `safeUpstreamErrorSummary` (already strips keys/URLs) — **no secrets, no
  user data, no request URLs, ever**.
- `incident_key` = `<source_id>:<kind>[:<instrument_id>]` — the unit of
  "one alert per incident" (B5 semantics, durable).
- No `detail jsonb` in v1: the bounded message covers the need; revisit only
  if a concrete bounded use case appears.

## 3. Proposed write path (code touchpoints — presented, not written)

1. **Fire-and-forget insert** — one small helper
   `recordDataQualityEvent(event)` in `src/lib/market-data/`:
   - `void …insert… .catch(() => logger.warn("data-quality: insert failed"))` —
     **never awaited on the request path, never throws into it**; a DB
     failure degrades to a log line (standing rule: save failures must not
     break the dashboard).
   - own statement timeout (~1.5 s) so a stuck DB can't pile up work.
2. **Emission points** (all already exist in code as error branches):
   - provider fetch error/timeout in `http.ts`/providers → `fetch_failure`
     (+ `latency_ms`);
   - provider answered empty → `empty_response`;
   - plausibility/Zod reject → `plausibility_reject`;
   - `future_dated`: RSS pubDate clamp (this work) and any future-dated quote;
   - `sign_anomaly`: the TradingEconomics EGX30 direction-word check.
3. **Successes are not logged** — the table is anomaly-only, which keeps the
   Hobby-size footprint tiny (see §5).

## 4. Proposed read surface (code — presented, not written)

- **Admin-protected** `GET /api/health/data?window=24h|7d` reusing the
  existing admin authentication (fixes the standing note that detailed health
  is currently public via `/api/markets/health`):
  - latest ≤ 200 events in the window (bounded, newest first),
  - per-source incident summary: incident_key, kind, count, first/last seen,
    suppressed-since (alert window).
- **Alerting = structured log line only** (B5): when an `incident_key` has no
  event in the last **6 h** (reusing the existing `ALERT_COOLDOWN_MS`
  concept), emit `logger.warn` with the incident summary; repeats within the
  window are `logger.debug`. No email, no Telegram, no webhook, no new env.
- **Admin UI**: one read-only panel in `admin.html` (markets/health section)
  listing the same summary. Read-only; no actions in v1.
- The existing **public** `/api/markets/health` response shape is **unchanged**.

## 5. Sizing & retention (Hobby plan)

- Write volume: anomalies only. Realistic worst case ≈ a few hundred rows/day
  (a provider fully down for a day ≈ 24 fetch cycles × configured sources,
  de-duplicated by the incident window for *alerting*; events themselves are
  small).
- 90-day retention keeps the table well under ~50 k rows — negligible for the
  free Postgres tier.
- Retention: `DELETE FROM data_quality_events WHERE recorded_at < now() -
  interval '90 days'` — **presented, not scheduled**: it would ride on an
  existing/future approved cron (Hobby = daily). No new cron, no new env
  variable in this proposal (B3).

## 6. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Write pressure on request path | fire-and-forget, own timeout, never awaited, DB-down → warn log only |
| Hobby DB size growth | anomaly-only rows, bounded columns, 90-day retention, no jsonb |
| Leak of secrets/PII in `message` | reuse `safeUpstreamErrorSummary`; CHECK-bounded length; code review of every emission point |
| Duplicate alert noise | durable `incident_key` + 6 h suppression window (one alert per incident) |
| Migration risk | additive-only; paired down file; standard 0001–0015 sequence (verified backup, approved window); registered in the inlined map **only when approved** |
| Scope creep (channels, schedules) | explicitly out: logging only, no cron/env changes now |

## 7. Execution prerequisites (only after explicit approval)

1. Write the paired `0017` SQL files and register the id in
   `src/lib/db-migrations.ts` (`SQL_BY_ID` + `MIGRATION_IDS`).
2. Add tests: event-shape validation, incident window (one-alert semantics),
   admin endpoint auth (401/403 for non-admin), fire-and-forget isolation
   (DB down ⇒ request still succeeds).
3. Follow `lib/db/migrations/README.md`: verified backup, approved window,
   Preview first, production only after explicit approval.

Until then: **no SQL files, no map registration, no code changes for this
item** — the proposal stops here.
