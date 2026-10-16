# Database migrations

`0001_market_daily_ohlc` is a **pending, unexecuted** migration for licensed market-data daily snapshots.

It was intentionally added as SQL rather than run through `drizzle-kit push`: there is no verified isolated database connection in this workspace, and production databases must never be changed by an agent without an approved backup and deployment window.

## Safe execution sequence

1. Point `DATABASE_URL` at a verified **Preview/Test** database only.
2. Run and verify `node scripts/backup-db.mjs`; retain the backup outside the deployment artifact.
3. Review the `up` SQL and execute it through the approved migration runner.
4. Run the synthetic market-history test and a Preview smoke test.
5. Promote only after the provider contract, cache, scheduler, and monitoring are configured.

The paired `down` script is intentionally non-destructive: it renames the new table to an archive instead of dropping it. Revert application code first; restore the table name only if/when needed.
