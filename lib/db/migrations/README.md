# Database migrations

`0001_market_daily_ohlc` and `0002_user_subscriptions` are **pending, unexecuted** migrations.

They are intentionally SQL files rather than a `drizzle-kit push`: no verified isolated database connection exists in this workspace, and an agent must never change a shared or production database without an approved backup and deployment window.

- `0001_market_daily_ohlc` adds licensed-market daily snapshot storage.
- `0002_user_subscriptions` introduces the server-side VIP entitlement record. It backfills only existing VIP accounts with a recorded future expiry. Records with a missing legacy expiry are left untouched and use the temporary compatibility path until an operator verifies them; the migration never invents an expiry date.

## Safe execution sequence

1. Point `DATABASE_URL` at a verified **Preview/Test** database only.
2. Run and verify `node scripts/backup-db.mjs`; retain the backup outside the deployment artifact.
3. Review the appropriate `up` SQL and execute it through the approved migration runner.
4. Run the synthetic lifecycle/history tests and a Preview smoke test.
5. Reconcile any legacy VIP rows with no expiry before promoting entitlement-only authorization.
6. Promote only after explicit approval for the production backup, migration, and deployment window.

Each paired `down` script is intentionally non-destructive: it renames the new table to a rollback archive instead of dropping it. Revert application code first; restore the table name only after investigation.
