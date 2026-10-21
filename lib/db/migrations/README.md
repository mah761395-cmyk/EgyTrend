# Database migrations

## How these are applied today

The API checks the `_egytrend_schema_migrations` ledger at boot and applies any
reviewed `*.up.sql` that is not recorded yet, in file order:

- a full snapshot of the `public` schema is copied to `egytrend_backup_<UTC>`
  **before** the first change (restore with `INSERT INTO public.<table> SELECT *
  FROM "egytrend_backup_<UTC>".<table>`);
- each applied migration is recorded with its `checksum` and `missing_before`
  (the objects the database was actually missing), so drift stays provable;
- a PostgreSQL advisory lock (`843912608`) keeps concurrent instances from
  racing, and a failure is recorded and reported instead of crashing boot;
- `GET /api/health/db` reports `ready`, `pending`, `applied`, `failed` and the
  snapshot schema name;
- `DB_AUTO_MIGRATE=off` turns the runner into a read-only reporter.

This exists because deploying code whose required columns did not exist made
`POST /api/user/login` fail with an unhandled SQL error (HTTP 500).
`drizzle-kit push` is still never used, and nothing here drops tables or rows.

The manual, Preview/Test-only runner below remains available for a deliberate
single-migration run with an operator-supplied backup file.

## Pending migrations

`0001_market_daily_ohlc` through `0013_vip_onboarding_tour` were **pending, unexecuted** migrations at the time of writing.

They are intentionally SQL files rather than a `drizzle-kit push`: no verified isolated database connection exists in this workspace, and an agent must never change a shared or production database without an approved backup and deployment window.

- `0001_market_daily_ohlc` adds licensed-market daily snapshot storage.
- `0002_user_subscriptions` introduces the server-side VIP entitlement record. It backfills only existing VIP accounts with a recorded future expiry. Records with a missing legacy expiry are left untouched and use the temporary compatibility path until an operator verifies them; the migration never invents an expiry date.
- `0003_portfolio_positions` stores user-entered positions server-side. It never stores a market quote: all displayed market values remain runtime source/as-of data, and rollback archives the personal records.
- `0004_user_price_alerts` stores server-evaluated price/daily-change rules and their trigger provenance. Evaluation is inert until an approved server-to-server scheduler supplies `CRON_SECRET`; it ignores end-of-day, unknown, or stale quotes and sends email only to the alert owner's recorded address.
- `0005_subscription_plan_pricing` adds server-evaluated base/offer pricing, audience targeting, immutable payment-price snapshots and reversible pricing history. It never rewrites an existing payment request, subscription, or plan price; the rollback archives new offer/history tables and retains financial snapshot columns.
- `0006_user_calculator_scenarios` adds saved VIP calculator scenarios and explicit save/copy/export activity. Input/result JSON is server-validated and size bounded; a scenario is archived rather than deleted. Its rollback marks records archived and leaves the additive tables in place, so no financial scenario is destroyed.
- `0007_subscription_lifecycle` normalizes entitlement instants to UTC, gives each paid term a fresh cycle id, adds an optional per-term grace endpoint, server-authored notification CTAs, durable reminder/outbox state, and immutable lifecycle metric events. The only conversion interprets existing subscription timestamps as the API's documented UTC values; it does not manufacture expiry dates. Its rollback archives the new reminder/event tables and deliberately retains added columns and UTC semantics.
- `0008_admin_broadcasts` adds server-selected public announcements, validated image media, one durable display/interaction row per registered user and announcement, and audit-friendly admin preview records. It also adds explicit account-level marketing opt-in/opt-out timestamps; consent is not inferred from a recovery email and no campaign sender is introduced by this migration. The rollback archives broadcast tables and intentionally keeps consent evidence rather than deleting it.
- `0009_free_vip_trial` adds the configurable free-VIP trial claim/subscription and its durable message state. It does not enable a trial by itself; the feature remains disabled until an authorized admin enables it.
- `0010_referral_program` adds configurable referral snapshots, fraud-review signals, reward ledger rows, and automatic referral-coupon metadata. Its rollback drops referral history, so it must only be used after a verified backup and an explicit operator decision to discard that history.
- `0011_user_onboarding` adds an account-owned tour/checklist record. It contains only product-navigation progress; it never changes a subscription, payment, entitlement, or portfolio/alert record. Its rollback only removes that onboarding state.
- `0012_payment_tx_idempotency` adds a normalized, case-insensitive unique index for payment transfer references so concurrent application instances cannot create duplicate payment requests. It refuses to guess which pre-existing duplicate is valid; an operator must review those records before running it. Its rollback drops only the index and does not remove payment evidence.
- `0013_vip_onboarding_tour` adds display-state columns for the guided VIP welcome tour on the existing `user_onboarding` row (version, status and timestamps). It is shown once when an account first holds an active VIP entitlement and never grants, extends, or renews access. Its rollback removes only those tour columns.

## Safe execution sequence

1. Point `DATABASE_URL` at a verified **Preview/Test** database only.
2. Run and verify `node scripts/backup-db.mjs`; retain the backup outside the deployment artifact.
3. Review **both** paired SQL files. For Preview/Test only, use the guarded runner with an absolute verified backup path, for example:
   ```bash
   DATABASE_URL=... node scripts/run-db-migration.mjs \
     --environment preview --migration 0001_market_daily_ohlc \
     --direction up --backup /secure/path/egytrend.sql.gz --yes-apply
   ```
   The runner refuses `production`, requires a verified `pg_dump` archive, a matching `down` file, and an explicit confirmation. It never prints `DATABASE_URL`.
4. Run the synthetic lifecycle/history tests and a Preview smoke test.
5. Reconcile any legacy VIP rows with no expiry before promoting entitlement-only authorization.
6. Promote only after explicit approval for the production backup, migration, and deployment window. The built-in runner intentionally does **not** operate on production; use the approved operator process and record the backup/rollback evidence.

Review every paired `down` script before use. Most preserve a rollback archive or mark added records archived; `0010_referral_program.down.sql` is explicitly destructive to referral history and therefore requires a verified backup and an operator decision. Revert application code first; restore only after investigation.
